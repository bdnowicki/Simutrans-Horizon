"""
The /api/team/* routes (contract T): access, validation, database reads and delegation to the runtime.

The bridge's Handler does the HTTP plumbing (host, cookie, X-Dashboard, Origin, same-origin, body limit, rate limit)
and calls TeamAPI.get / post / open_stream with the signed-in session; these return (HTTP status, JSON object) or the
opened stream. Only sessions of role player or admin bound to a company get through; everything they read or change
is of that company (the database filters by it).
"""

import threading
import time

from . import TeamError
from . import events as team_events
from . import roles
from .db import ACTIVE_RUN_STATES, QUESTION_STATES, TASK_STATES, PROJECT_STATES, valid_company

TEAM_ROLES = ("player", "admin")
MAX_TEXT = 4000          # characters of a chat message of the user
MAX_REASON = 1000        # characters of the reason of a rejection
MAX_ID = 2 ** 53 - 1
DEFAULT_PAGE = 50
MAX_PAGE = 100
SUMMARY = 200            # characters of a tool call or tool result in the chat
MAX_LIST = 200
# the shape of a POST body: the deepest answer is {"answer": {"q1": {"a": {"x": 1}}}} (depth 5); 32 KB of "[[[[..."
# would reach Python's recursion limit in later code, many small items cost time in every validation
MAX_DEPTH = 10
MAX_ITEMS = 2000
# chat messages per token: SEND_BURST at once, then one every SEND_EVERY seconds (each message may start a paid run
# and stays in the history: a script must not flood the chat or the database)
SEND_BURST = 10
SEND_EVERY = 3.0


def check_shape(value, max_depth=MAX_DEPTH, max_items=MAX_ITEMS):
    """TeamError(400) when a decoded JSON value nests deeper than max_depth or has more than max_items values."""
    count = 0
    stack = [(value, 1)]
    while stack:
        v, depth = stack.pop()
        count += 1
        if count > max_items:
            raise TeamError(400, "the request has too many values")
        if isinstance(v, (dict, list)):
            if depth >= max_depth:
                raise TeamError(400, "the request is nested too deeply")
            stack.extend((x, depth + 1) for x in (v.values() if isinstance(v, dict) else v))


class RateBuckets:
    """Token buckets by key (thread-safe): burst requests at once, then one per `every` seconds."""

    def __init__(self, burst, every, max_keys=10000):
        self.lock = threading.Lock()
        self.burst, self.every, self.max_keys = float(burst), float(every), max_keys
        self.items = {}   # key -> (level, monotonic time)

    def take(self, key):
        now = time.monotonic()
        with self.lock:
            if len(self.items) > self.max_keys:
                self.items.clear()
            level, stamp = self.items.get(key, (self.burst, now))
            level = min(self.burst, level + (now - stamp) / self.every)
            ok = level >= 1
            self.items[key] = (level - 1 if ok else level, now)
            return ok


GET_ARGS = {
    "state": (),
    "chat": ("agent", "before", "limit"),
    "tasks": ("state",),
    "projects": ("id", "state"),
    "questions": ("state",),
}
POST_ARGS = {
    "send": ("agent", "text"),
    "cancel": ("run_id",),
    "answer": ("question_id", "answer", "dismiss"),
    "approve": ("project_id",),
    "reject": ("project_id", "reason"),
}


def _short(text, n=SUMMARY):
    text = "" if text is None else str(text)
    return text if len(text) <= n else text[:n - 1] + "…"


def _id(value, name):
    """A positive integer id from JSON (int) or a query (ASCII digits: str.isdigit() also takes "²", which int()
    refuses, and "٣", which it reads as 3)."""
    if isinstance(value, str) and value.isascii() and value.isdigit() and len(value) <= 16:
        value = int(value)
    if type(value) is not int or not 0 < value <= MAX_ID:
        raise TeamError(400, "%s must be a positive integer" % name)
    return value


def _clean(text, name, max_len):
    """A string the database and the model can take: no NUL, no lone surrogates, at most max_len characters."""
    if not isinstance(text, str):
        raise TeamError(400, "%s must be a string" % name)
    if len(text) > max_len:
        raise TeamError(400, "%s is too long (at most %d characters)" % (name, max_len))
    if "\0" in text or any(0xD800 <= ord(c) <= 0xDFFF for c in text):
        raise TeamError(400, "%s contains an invalid character" % name)
    return text


def _agent(value):
    if not roles.is_agent(value):
        raise TeamError(400, "unknown agent")
    return value


def present_message(row):
    """A message row as the chat shows it: tool calls and tool results summarised, reasoning never sent."""
    meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
    out = {"id": row["id"], "role": row["role"], "content": row.get("content") or "", "author": None,
           "created": row.get("created")}
    if row.get("author_token_id") is not None:
        out["author"] = {"token_id": row["author_token_id"], "label": row.get("author_label")}
    calls = row.get("tool_calls") if isinstance(row.get("tool_calls"), list) else []
    if row["role"] == "assistant" and (calls or isinstance(meta.get("tools"), list)):
        if isinstance(meta.get("tools"), list):
            tools = [t for t in meta["tools"] if isinstance(t, dict)]
        else:
            tools = []
            for c in calls:
                fn = c.get("function") if isinstance(c, dict) else None
                fn = fn if isinstance(fn, dict) else {}
                tools.append({"name": fn.get("name"), "summary": fn.get("arguments")})
        out["tools"] = [{"name": _short(t.get("name"), 64), "summary": _short(t.get("summary"))} for t in tools]
    if row["role"] == "tool":
        out["content"] = _short(meta.get("summary") or out["content"])
    for k in ("question_id", "project_id", "task_id"):
        if type(meta.get(k)) is int:
            out[k] = meta[k]
    # a task message (from the coordinator or a specialist) or a task result: who sent it
    if roles.is_agent(meta.get("from")):
        out["from"] = meta["from"]
    return out


def present_task(t):
    return {k: t.get(k) for k in ("id", "from_agent", "to_agent", "title", "body", "state", "result", "run_id",
                                  "created", "updated")}


def present_question(q):
    """A question as the browser shows it; answered_by_label: the label of the token that answered or dismissed it
    (rows of TeamDB.get_question / list_questions carry it; never the token itself)."""
    return {k: q.get(k) for k in ("id", "agent", "run_id", "payload", "state", "answer", "answered_by",
                                  "answered_by_label", "created", "answered")}


def present_project(p, full=True):
    """A project as the browser shows it (the preview only when full); approved_by_label: the label of the token that
    approved it (rows of TeamDB.get_project / list_projects carry it)."""
    keys = ("id", "agent", "title", "rationale", "ops", "estimate", "state", "approved_by", "approved_by_label",
            "report", "created", "updated")
    out = {k: p.get(k) for k in keys}
    if full:
        out["preview"] = p.get("preview")
    return out


def over_limit(usage):
    def num(v):
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    today, limit = num(usage.get("today_usd")), num(usage.get("limit_usd"))
    company, company_limit = num(usage.get("company_usd")), num(usage.get("company_limit_usd"))
    if limit is not None and today is not None and today >= limit:
        return True
    return company_limit is not None and company is not None and company >= company_limit


class TeamAPI:
    """company_name(nr) -> str or None; engine_agent() -> bool (the game allows agent commands); has_api_key() ->
    bool. test_publish: the hidden route POST /api/team/test_publish {name, data} publishes an event to the caller's
    own company (automated tests only, bridge flag --test-team)."""

    def __init__(self, db, events, runtime, company_name, engine_agent, has_api_key, test_publish=False,
                 send_limit=(SEND_BURST, SEND_EVERY)):
        self.db = db
        self.events = events
        self.runtime = runtime
        self.company_name = company_name
        self.engine_agent = engine_agent
        self.has_api_key = has_api_key
        self.test_publish = test_publish
        # (burst, seconds per message) of chat messages per token
        self.send_buckets = RateBuckets(*send_limit)

    @staticmethod
    def allowed(sess):
        """The session may use the team: role player or admin and bound to a company."""
        return sess is not None and sess.role in TEAM_ROLES and valid_company(getattr(sess, "company", None))

    def _check(self, sess):
        if not self.allowed(sess):
            raise TeamError(403, "the AI team is only available to players of a company")

    def status(self, company):
        """(enabled, reason or None, runtime state) of the team of a company."""
        enabled, reason = True, None
        if not self.engine_agent():
            enabled, reason = False, "no_engine_agent_mode"
        elif not self.has_api_key():
            enabled, reason = False, "no_api_key"
        else:
            ok, why = self.runtime.available()
            if not ok:
                enabled, reason = False, why or "runtime_unavailable"
        state = self.runtime.state(company) or {}
        if enabled and state.get("enabled") is False:
            enabled, reason = False, state.get("reason") or "runtime_unavailable"
        if enabled and over_limit(state.get("usage") or {}):
            enabled, reason = False, "over_limit"
        return enabled, reason, state

    # -- dispatch

    def get(self, sess, name, args):
        """(status, body) of GET /api/team/<name> (args: validated query arguments, strings)."""
        try:
            self._check(sess)
            if name not in GET_ARGS:
                raise TeamError(404, "no such team route")
            for k in args:
                if k not in GET_ARGS[name]:
                    raise TeamError(400, "unknown argument: %s" % k)
            return 200, getattr(self, "_get_" + name)(sess, args)
        except TeamError as e:
            return e.status, e.body()

    def post(self, sess, name, body):
        """(status, body) of POST /api/team/<name> (body: a JSON object)."""
        try:
            self._check(sess)
            if name == "test_publish" and self.test_publish:
                return 200, self._post_test_publish(sess, body)
            if name not in POST_ARGS:
                raise TeamError(404, "no such team route")
            check_shape(body)
            for k in body:
                if k not in POST_ARGS[name]:
                    raise TeamError(400, "unknown argument: %s" % k)
            return 200, getattr(self, "_post_" + name)(sess, body)
        except TeamError as e:
            return e.status, e.body()

    def open_stream(self, sess, last_id):
        """(client, first chunk) of GET /api/team/events, or (None, (status, body))."""
        if not self.allowed(sess):
            return None, (403, {"ok": False, "error": "the AI team is only available to players of a company"})
        client, first = self.events.subscribe(sess.company, sess.sid, last_id, getattr(sess, "token_id", None))
        if client is None:
            if first == team_events.PER_TOKEN:
                return None, (429, {"ok": False, "error": "too many team event streams of this token (close other "
                                                          "tabs)"})
            return None, (503, {"ok": False, "error": "too many event streams"})
        return client, first

    # -- reads

    def _get_state(self, sess, args):
        company = sess.company
        enabled, reason, state = self.status(company)
        body = {"company": {"nr": company, "name": self.company_name(company)}, "enabled": enabled}
        if reason:
            body["reason"] = reason
        # run / run_state: the active run of each agent from the database (the running one, else the waiting one,
        # else the next queued one), so a page loaded later can cancel it; null without one
        active = self.db.active_runs(company)
        agents = []
        for a in state.get("agents") or []:
            a = dict(a) if isinstance(a, dict) else {}
            run = active.get(a.get("id"))
            a["run"] = run["id"] if run else None
            a["run_state"] = run["state"] if run else None
            agents.append(a)
        body["agents"] = agents
        body["usage"] = state.get("usage") or {}
        return body

    def _get_chat(self, sess, args):
        agent = _agent(args.get("agent"))
        before = _id(args["before"], "before") if "before" in args else None
        limit = DEFAULT_PAGE
        if "limit" in args:
            limit = _id(args["limit"], "limit")
            if limit > MAX_PAGE:
                raise TeamError(400, "limit must be at most %d" % MAX_PAGE)
        conv = self.db.find_main_conversation(sess.company, agent)
        if conv is None:
            return {"agent": agent, "messages": [], "more": False}
        rows, more = self.db.messages_page(sess.company, conv, before, limit)
        return {"agent": agent, "messages": [present_message(r) for r in rows], "more": more}

    def _get_tasks(self, sess, args):
        states = None
        if "state" in args:
            if args["state"] not in TASK_STATES:
                raise TeamError(400, "state must be one of " + ", ".join(TASK_STATES))
            states = (args["state"],)
        return {"tasks": [present_task(t) for t in self.db.list_tasks(sess.company, states, MAX_LIST)]}

    def _get_projects(self, sess, args):
        if "id" in args:
            p = self.db.get_project(sess.company, _id(args["id"], "id"))
            if p is None:
                raise TeamError(404, "no such project")
            return {"project": present_project(p)}
        states = None
        if "state" in args:
            if args["state"] not in PROJECT_STATES:
                raise TeamError(400, "state must be one of " + ", ".join(PROJECT_STATES))
            states = (args["state"],)
        return {"projects": [present_project(p, full=False)
                             for p in self.db.list_projects(sess.company, states, MAX_LIST)]}

    def _get_questions(self, sess, args):
        state = args.get("state")
        if state is not None and state not in QUESTION_STATES:
            raise TeamError(400, "state must be one of " + ", ".join(QUESTION_STATES))
        return {"questions": [present_question(q) for q in self.db.list_questions(sess.company, state, MAX_LIST)]}

    # -- actions

    def _post_send(self, sess, body):
        company = sess.company
        agent = _agent(body.get("agent"))
        text = _clean(body.get("text"), "text", MAX_TEXT).strip()
        if not text:
            raise TeamError(400, "text must not be empty")
        enabled, reason, _ = self.status(company)
        if not enabled:
            # refused before anything is stored: nothing waits for a runtime that cannot answer
            raise TeamError(503, "the AI team is not available", reason)
        if not self.send_buckets.take(sess.token_id):
            raise TeamError(429, "too many messages; wait a few seconds", "rate_limit")
        conv = self.db.main_conversation(company, agent)
        msg = self.db.add_message(company, conv, "user", text, author_token_id=sess.token_id)
        msg["author_label"] = self.db.token_labels([sess.token_id]).get(sess.token_id)
        self.events.publish(company, "team_message", {"agent": agent, "message": present_message(msg)})
        run_id = self.runtime.start_run(company, agent, conv, sess.token_id)
        return {"message_id": msg["id"], "run_id": run_id}

    def _post_cancel(self, sess, body):
        run_id = _id(body.get("run_id"), "run_id")
        run = self.db.get_run(sess.company, run_id)
        if run is None:
            raise TeamError(404, "no such run")
        if run["state"] not in ACTIVE_RUN_STATES:
            raise TeamError(409, "the run is not active (%s)" % run["state"])
        self.runtime.cancel(sess.company, run_id, sess.token_id)
        return {"run_id": run_id, "accepted": True}

    def _post_answer(self, sess, body):
        qid = _id(body.get("question_id"), "question_id")
        dismiss = body.get("dismiss", False)
        if not isinstance(dismiss, bool):
            raise TeamError(400, "dismiss must be true or false")
        if dismiss and "answer" in body:
            raise TeamError(400, "give an answer or dismiss, not both")
        if not dismiss and body.get("answer") is None:
            raise TeamError(400, "answer is missing")
        q = self.db.get_question(sess.company, qid)
        if q is None:
            raise TeamError(404, "no such question")
        if q["state"] != "pending":
            raise TeamError(409, "the question is %s already" % q["state"])
        self.runtime.answer(sess.company, qid, None if dismiss else body["answer"], dismiss, sess.token_id)
        return {"question_id": qid, "accepted": True}

    def _project(self, sess, body, states):
        pid = _id(body.get("project_id"), "project_id")
        p = self.db.get_project(sess.company, pid)
        if p is None:
            raise TeamError(404, "no such project")
        if p["state"] not in states:
            raise TeamError(409, "the project is %s" % p["state"])
        return pid

    def _post_approve(self, sess, body):
        pid = self._project(sess, body, ("proposed",))
        self.runtime.approve(sess.company, pid, sess.token_id)
        return {"project_id": pid, "accepted": True}

    def _post_reject(self, sess, body):
        reason = body.get("reason")
        if reason is not None:
            reason = _clean(reason, "reason", MAX_REASON).strip() or None
        pid = self._project(sess, body, ("draft", "proposed"))
        self.runtime.reject(sess.company, pid, reason, sess.token_id)
        return {"project_id": pid, "accepted": True}

    def _post_test_publish(self, sess, body):
        name = body.get("name")
        if not isinstance(name, str):
            raise TeamError(400, "name must be a string")
        try:
            eid = self.events.publish(sess.company, name, body.get("data"))
        except ValueError as e:
            raise TeamError(400, str(e))
        return {"id": eid}
