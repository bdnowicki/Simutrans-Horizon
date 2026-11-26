"""
SQLite store of the dashboard: the access tokens (sha256 hashes only) and the history of the AI team (conversations,
messages, runs, tasks, questions, projects), the daily usage of the language model and settings (contract T).

One connection is shared by all threads behind a lock (check_same_thread=False); a file database runs in WAL mode
with foreign keys on, an in-memory one (":memory:") lives as long as the process. Every method that reads or changes
company data takes the company and filters by it, so an id of another company's row is simply "not found": the
isolation of the companies is enforced here, not by the callers.

Timestamps are ISO-8601 UTC text ("2026-11-26T12:00:00Z"), JSON columns are text (decoded on reading).
"""

import contextlib
import hashlib
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time

SCHEMA_VERSION = 1

ROLES = ("viewer", "player", "admin")
TEAM_ROLES = ("player", "admin")   # roles bound to a company
PUBLIC_PLAYER = 1                  # the public service: never a company of a token
PLAYER_UNOWNED = 15                # companies are 0..14 (simconst.h)
MESSAGE_ROLES = ("user", "assistant", "tool", "system_note")
RUN_STATES = ("queued", "running", "waiting", "done", "failed", "cancelled", "interrupted")
ACTIVE_RUN_STATES = ("queued", "running", "waiting")
TASK_STATES = ("open", "working", "waiting", "done", "cancelled")
QUESTION_STATES = ("pending", "answered", "dismissed")
PROJECT_STATES = ("draft", "proposed", "approved", "running", "done", "failed", "rejected")
DEFAULT_SETTINGS = {"daily_limit_usd": "0.50"}   # company_limit_usd: not set (no share per company)
TOKEN_CHARS = re.compile(r"^[A-Za-z0-9_\-.~]+$")
MIN_TOKEN = 16
MAX_LABEL = 100
ENV_PREFIX = "SIMUTRANS_DASHBOARD_TOKEN_"
ENV_COMPANY = "SIMUTRANS_DASHBOARD_PLAYER_COMPANY"

_JSON_COLUMNS = ("tool_calls", "meta", "payload", "answer", "ops", "estimate", "preview", "report")


def utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def utc_day(t=None):
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() if t is None else t))


def next_utc_midnight(t=None):
    t = time.time() if t is None else t
    return time.strftime("%Y-%m-%dT00:00:00Z", time.gmtime((int(t) // 86400 + 1) * 86400))


def hash_token(token):
    return hashlib.sha256(token.encode("utf-8", "surrogatepass")).hexdigest()


def valid_company(company):
    return type(company) is int and 0 <= company < PLAYER_UNOWNED and company != PUBLIC_PLAYER


def check_role_company(role, company):
    """ValueError unless the pair is allowed: player and admin need a company (0..14, not 1 = public), a viewer
    has none."""
    if role not in ROLES:
        raise ValueError("role must be viewer, player or admin")
    if role in TEAM_ROLES:
        if not valid_company(company):
            raise ValueError("a %s token needs a company (0..%d, not %d = the public service)"
                             % (role, PLAYER_UNOWNED - 1, PUBLIC_PLAYER))
    elif company is not None:
        raise ValueError("a viewer token has no company")


def _company(company):
    if not valid_company(company):
        raise ValueError("invalid company %r" % (company,))
    return company


def _create_private(path):
    """Prepare a database file: its directory and the file itself readable by the owner only on POSIX (the file holds
    the token hashes and the team's history; SQLite gives its -wal and -shm files the mode of the database file, so
    the file is created with 0600 before SQLite opens it). A directory created here gets 0700; existing directories
    and files keep their modes. Windows keeps its ACLs (the user's profile). Returns True when the file is new."""
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, mode=0o700, exist_ok=True)   # the mode applies to the last directory
        if os.name != "nt":
            try:
                os.chmod(parent, 0o700)
            except OSError:
                pass
    if os.path.exists(path):
        return False
    if os.name != "nt":
        try:
            os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))   # SQLite takes an empty file
        except FileExistsError:
            return False   # created by another process meanwhile
        except OSError:
            pass           # SQLite creates it (and reports a real problem itself)
    return True


def _finite(value):
    """value with NaN and the infinities replaced by None (JSON has no such numbers)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value


def json_text(value):
    """Compact JSON text that browsers can parse: NaN and the infinities (which json.dumps would write as the
    non-JSON words NaN and Infinity, breaking JSON.parse of a whole reply or event) become null."""
    try:
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    except ValueError:
        return json.dumps(_finite(value), separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _dumps(value):
    return None if value is None else json_text(value)


def _row(row):
    if row is None:
        return None
    out = dict(row)
    for k in _JSON_COLUMNS:
        if k in out and isinstance(out[k], str):
            try:
                out[k] = json.loads(out[k])
            except ValueError:
                pass  # written by hand or by a broken migration: keep the text
    return out


def env_tokens(environ, enable_admin):
    """The tokens given in the environment as [(role, token)] (validated like before the database: at least 16
    characters of A-Z a-z 0-9 - _ . ~, all different). ValueError with a message for the user otherwise."""
    roles = ["viewer", "player"] + (["admin"] if enable_admin else [])
    out = []
    for role in roles:
        name = ENV_PREFIX + role.upper()
        token = (environ.get(name) or "").strip()
        if not token:
            continue
        if len(token) < MIN_TOKEN or not TOKEN_CHARS.match(token):
            raise ValueError("%s must have at least %d characters (letters, digits, - _ . ~)" % (name, MIN_TOKEN))
        out.append((role, token))
    if len({t for _, t in out}) != len(out):
        raise ValueError("the dashboard tokens of the roles must differ")
    return out


def env_player_company(environ):
    """The company of the player and admin tokens taken from the environment (default 0)."""
    text = (environ.get(ENV_COMPANY) or "").strip()
    if not text:
        return 0
    try:
        company = int(text, 10)
    except ValueError:
        company = None
    if not valid_company(company):
        raise ValueError("%s must be a company number 0..%d other than %d (the public service)"
                         % (ENV_COMPANY, PLAYER_UNOWNED - 1, PUBLIC_PLAYER))
    return company


# --- schema ------------------------------------------------------------------------------------------------------

def _execute_script(conn, script):
    """The statements of a script one by one (executescript would COMMIT the migration's transaction first)."""
    for statement in script.split(";"):
        if statement.strip():
            conn.execute(statement)


def _migrate_v1(conn):
    _execute_script(conn, """
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  company INTEGER,
  label TEXT,
  created TEXT NOT NULL,
  revoked TEXT
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  company INTEGER NOT NULL,
  agent TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  created TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_main ON conversations(company, agent) WHERE task_id IS NULL;
CREATE INDEX IF NOT EXISTS conversations_task ON conversations(company, task_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  author_token_id INTEGER REFERENCES tokens(id),
  content TEXT NOT NULL DEFAULT '',
  reasoning_content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  meta TEXT,
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  company INTEGER NOT NULL,
  agent TEXT NOT NULL,
  conversation_id INTEGER REFERENCES conversations(id),
  state TEXT NOT NULL,
  parent_run INTEGER REFERENCES runs(id),
  depth INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_state ON runs(company, state);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  company INTEGER NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  result TEXT,
  run_id INTEGER REFERENCES runs(id),
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_company ON tasks(company, id);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  company INTEGER NOT NULL,
  agent TEXT NOT NULL,
  run_id INTEGER REFERENCES runs(id),
  conversation_id INTEGER REFERENCES conversations(id),
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  answer TEXT,
  answered_by INTEGER REFERENCES tokens(id),
  created TEXT NOT NULL,
  answered TEXT
);
CREATE INDEX IF NOT EXISTS questions_company ON questions(company, state);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  company INTEGER NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  ops TEXT NOT NULL,
  estimate TEXT,
  preview TEXT,
  state TEXT NOT NULL,
  approved_by INTEGER REFERENCES tokens(id),
  report TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_company ON projects(company, id);
CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,
  company INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_hit INTEGER NOT NULL DEFAULT 0,
  prompt_miss INTEGER NOT NULL DEFAULT 0,
  completion INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, company, model)
);
""")


# version -> function(connection) that brings the schema from version-1 to version; later rounds append here (e.g.
# 2: ALTER TABLE ... ADD COLUMN ...) and raise SCHEMA_VERSION. A migration runs inside one transaction.
MIGRATIONS = {1: _migrate_v1}


class TeamDB:
    """The store. path None or ":memory:" keeps everything in memory (gone at the end of the process)."""

    def __init__(self, path=None):
        self.memory = path in (None, "", ":memory:")
        self.path = ":memory:" if self.memory else os.path.abspath(path)
        self.lock = threading.RLock()
        created = False
        if not self.memory:
            created = _create_private(self.path)
        # autocommit (isolation_level None): one statement is one transaction, several use self.tx()
        self.conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None, timeout=10)
        self.conn.row_factory = sqlite3.Row
        try:
            self.conn.execute("PRAGMA foreign_keys=ON")
            self.conn.execute("PRAGMA busy_timeout=10000")
            if not self.memory:
                self.conn.execute("PRAGMA journal_mode=WAL")
                self.conn.execute("PRAGMA synchronous=NORMAL")
                if created and os.name != "nt":
                    try:
                        os.chmod(self.path, 0o600)  # token hashes and the team's history: the owner only
                    except OSError:
                        pass
            self.migrate()
        except Exception:
            self.conn.close()
            raise

    def close(self):
        with self.lock:
            try:
                self.conn.close()
            except sqlite3.Error:
                pass

    @contextlib.contextmanager
    def tx(self):
        """One transaction (BEGIN IMMEDIATE: other processes such as the token CLI wait for it)."""
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            self.conn.execute("COMMIT")

    def _all(self, sql, args=()):
        with self.lock:
            return [_row(r) for r in self.conn.execute(sql, args).fetchall()]

    def _one(self, sql, args=()):
        with self.lock:
            return _row(self.conn.execute(sql, args).fetchone())

    def _run(self, sql, args=()):
        """(lastrowid, rowcount) of one changing statement."""
        with self.lock:
            cur = self.conn.execute(sql, args)
            return cur.lastrowid, cur.rowcount

    # -- schema

    def schema_version(self):
        with self.lock:
            have = self.conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").fetchone()
            if not have:
                return 0
            row = self.conn.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone()
        try:
            return int(row[0]) if row else 0
        except (TypeError, ValueError):
            return 0

    def migrate(self):
        """Bring the schema to SCHEMA_VERSION (idempotent). A database of a newer bridge is refused rather than
        changed."""
        with self.lock:
            current = self.schema_version()
            if current > SCHEMA_VERSION:
                raise RuntimeError("the database %s has schema version %d, newer than this bridge (%d)"
                                   % (self.path, current, SCHEMA_VERSION))
            for version in range(current + 1, SCHEMA_VERSION + 1):
                with self.tx() as conn:
                    MIGRATIONS[version](conn)
                    conn.execute("INSERT INTO settings(key, value) VALUES('schema_version', ?) "
                                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(version),))
            with self.tx() as conn:
                for k, v in DEFAULT_SETTINGS.items():
                    conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)", (k, v))

    # -- settings

    def get_setting(self, key, default=None):
        row = self._one("SELECT value FROM settings WHERE key=?", (key,))
        return default if row is None or row["value"] is None else row["value"]

    def set_setting(self, key, value):
        self._run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  (key, None if value is None else str(value)))

    def limits(self):
        """(daily limit in USD for all companies, limit per company in USD or None)."""
        def num(text):
            try:
                return float(text)
            except (TypeError, ValueError):
                return None
        daily = num(self.get_setting("daily_limit_usd", DEFAULT_SETTINGS["daily_limit_usd"]))
        return (num(DEFAULT_SETTINGS["daily_limit_usd"]) if daily is None else daily,
                num(self.get_setting("company_limit_usd")))

    # -- tokens

    def token_count(self):
        return self._one("SELECT COUNT(*) AS n FROM tokens")["n"]

    def import_token(self, role, token, company=None, label=None):
        """Store a token given in plain text (the environment tokens): only its hash is kept. Returns the id."""
        check_role_company(role, company)
        if len(token) < MIN_TOKEN:
            raise ValueError("a token needs at least %d characters" % MIN_TOKEN)
        rowid, _ = self._run("INSERT INTO tokens(hash, role, company, label, created) VALUES(?, ?, ?, ?, ?)",
                             (hash_token(token), role, company, _label(label), utc_now()))
        return rowid

    def add_token(self, role, company=None, label=None):
        """A new random token: (id, token). The token is shown once; only its hash is stored."""
        check_role_company(role, company)
        token = secrets.token_urlsafe(24)
        return self.import_token(role, token, company, label), token

    def import_tokens_if_empty(self, pairs, company):
        """Store [(role, token)] when the table holds no token yet (in one transaction, so two bridges starting at
        once import only once). Player and admin get `company`. Returns the ids, or None when tokens existed."""
        with self.tx() as conn:
            if conn.execute("SELECT COUNT(*) FROM tokens").fetchone()[0]:
                return None
            ids = []
            for role, token in pairs:
                c = company if role in TEAM_ROLES else None
                check_role_company(role, c)
                cur = conn.execute("INSERT INTO tokens(hash, role, company, label, created) VALUES(?, ?, ?, ?, ?)",
                                   (hash_token(token), role, c, "env " + role, utc_now()))
                ids.append(cur.lastrowid)
            return ids

    def list_tokens(self):
        """Every token without hash: id, role, company, label, created, revoked."""
        return self._all("SELECT id, role, company, label, created, revoked FROM tokens ORDER BY id")

    def revoke_token(self, token_id):
        """True when the token was active and is revoked now."""
        _, n = self._run("UPDATE tokens SET revoked=? WHERE id=? AND revoked IS NULL", (utc_now(), int(token_id)))
        return n == 1

    def lookup_token(self, token):
        """The active token with this value: {id, role, company, label}, or None."""
        if not isinstance(token, str) or not token or len(token) > 512:
            return None
        return self._one("SELECT id, role, company, label FROM tokens WHERE hash=? AND revoked IS NULL",
                         (hash_token(token),))

    def token_active(self, token_id):
        row = self._one("SELECT revoked FROM tokens WHERE id=?", (token_id,))
        return row is not None and row["revoked"] is None

    def token_labels(self, ids):
        ids = [i for i in set(ids) if type(i) is int]
        if not ids:
            return {}
        rows = self._all("SELECT id, label FROM tokens WHERE id IN (%s)" % ",".join("?" * len(ids)), ids)
        return {r["id"]: r["label"] for r in rows}

    # -- conversations and messages

    def find_main_conversation(self, company, agent):
        """id of the main conversation of (company, agent), or None (nothing is created)."""
        row = self._one("SELECT id FROM conversations WHERE company=? AND agent=? AND task_id IS NULL",
                        (_company(company), agent))
        return row["id"] if row else None

    def main_conversation(self, company, agent):
        """id of the main conversation of (company, agent), created when missing."""
        _company(company)
        _text(agent, "agent", 64)
        with self.tx() as conn:
            row = conn.execute("SELECT id FROM conversations WHERE company=? AND agent=? AND task_id IS NULL",
                               (company, agent)).fetchone()
            if row:
                return row[0]
            return conn.execute("INSERT INTO conversations(company, agent, task_id, created) VALUES(?, ?, NULL, ?)",
                                (company, agent, utc_now())).lastrowid

    def create_conversation(self, company, agent, task_id):
        """A conversation of a task (the main conversations come from main_conversation)."""
        _company(company)
        _text(agent, "agent", 64)
        if self.get_task(company, task_id) is None:
            raise ValueError("no task %r of company %d" % (task_id, company))
        rowid, _ = self._run("INSERT INTO conversations(company, agent, task_id, created) VALUES(?, ?, ?, ?)",
                             (company, agent, task_id, utc_now()))
        return rowid

    def get_conversation(self, company, conversation_id):
        return self._one("SELECT * FROM conversations WHERE id=? AND company=?", (conversation_id, _company(company)))

    def task_conversations(self, company, task_id):
        return self._all("SELECT * FROM conversations WHERE company=? AND task_id=? ORDER BY id",
                         (_company(company), task_id))

    def add_message(self, company, conversation_id, role, content, author_token_id=None, reasoning_content=None,
                    tool_calls=None, tool_call_id=None, meta=None):
        """Append a message to a conversation of the company; returns the stored row (dict)."""
        if role not in MESSAGE_ROLES:
            raise ValueError("invalid message role %r" % (role,))
        if self.get_conversation(company, conversation_id) is None:
            raise ValueError("no conversation %r of company %d" % (conversation_id, company))
        rowid, _ = self._run(
            "INSERT INTO messages(conversation_id, role, author_token_id, content, reasoning_content, tool_calls, "
            "tool_call_id, meta, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (conversation_id, role, author_token_id, content or "", reasoning_content, _dumps(tool_calls),
             tool_call_id, _dumps(meta), utc_now()))
        return self.get_message(company, rowid)

    def get_message(self, company, message_id):
        return self._one("SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id "
                         "WHERE m.id=? AND c.company=?", (message_id, _company(company)))

    def set_message_meta(self, company, message_id, meta):
        """Replace the meta (JSON) of a message of the company; True when found."""
        if self.get_message(company, message_id) is None:
            return False
        self._run("UPDATE messages SET meta=? WHERE id=?", (_dumps(meta), message_id))
        return True

    def conversation_messages(self, company, conversation_id, after=None, limit=None):
        """Messages of a conversation of the company, oldest first, with everything (reasoning, tool calls): the
        history the runtime sends to the model. [] for a conversation of another company."""
        if self.get_conversation(company, conversation_id) is None:
            return []
        sql = "SELECT * FROM messages WHERE conversation_id=?"
        args = [conversation_id]
        if after is not None:
            sql += " AND id>?"
            args.append(int(after))
        sql += " ORDER BY id"
        if limit is not None:
            sql += " LIMIT ?"
            args.append(int(limit))
        return self._all(sql, args)

    def messages_page(self, company, conversation_id, before=None, limit=50):
        """(messages oldest first, more): the newest `limit` messages (below `before`) of a conversation of the
        company with "author_label" added; more = older messages exist."""
        if self.get_conversation(company, conversation_id) is None:
            return [], False
        sql = ("SELECT m.*, t.label AS author_label FROM messages m LEFT JOIN tokens t ON t.id = m.author_token_id "
               "WHERE m.conversation_id=?")
        args = [conversation_id]
        if before is not None:
            sql += " AND m.id<?"
            args.append(int(before))
        sql += " ORDER BY m.id DESC LIMIT ?"
        args.append(int(limit) + 1)
        rows = self._all(sql, args)
        more = len(rows) > limit
        rows = rows[:limit]
        rows.reverse()
        return rows, more

    def last_message_id(self, company, conversation_id):
        row = self._one("SELECT MAX(m.id) AS id FROM messages m JOIN conversations c ON c.id = m.conversation_id "
                        "WHERE c.id=? AND c.company=?", (conversation_id, _company(company)))
        return row["id"] if row else None

    # -- runs

    def create_run(self, company, agent, conversation_id, parent_run=None, depth=0, state="queued"):
        _company(company)
        if state not in RUN_STATES:
            raise ValueError("invalid run state %r" % (state,))
        if conversation_id is not None and self.get_conversation(company, conversation_id) is None:
            raise ValueError("no conversation %r of company %d" % (conversation_id, company))
        if parent_run is not None and self.get_run(company, parent_run) is None:
            raise ValueError("no run %r of company %d" % (parent_run, company))
        now = utc_now()
        rowid, _ = self._run("INSERT INTO runs(company, agent, conversation_id, state, parent_run, depth, created, "
                             "updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                             (company, agent, conversation_id, state, parent_run, int(depth), now, now))
        return rowid

    def get_run(self, company, run_id):
        return self._one("SELECT * FROM runs WHERE id=? AND company=?", (run_id, _company(company)))

    def set_run_state(self, company, run_id, state, error=None, expect=None):
        """Change the state of a run of the company (only from one of `expect` when given); True when changed."""
        if state not in RUN_STATES:
            raise ValueError("invalid run state %r" % (state,))
        sql = "UPDATE runs SET state=?, error=?, updated=? WHERE id=? AND company=?"
        args = [state, error, utc_now(), run_id, _company(company)]
        if expect:
            sql += " AND state IN (%s)" % ",".join("?" * len(expect))
            args.extend(expect)
        _, n = self._run(sql, args)
        return n == 1

    def list_runs(self, company, states=None, agent=None, limit=100):
        sql = "SELECT * FROM runs WHERE company=?"
        args = [_company(company)]
        if states:
            sql += " AND state IN (%s)" % ",".join("?" * len(states))
            args.extend(states)
        if agent is not None:
            sql += " AND agent=?"
            args.append(agent)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(int(limit))
        return self._all(sql, args)

    def busy_agents(self, company):
        """Agents of the company with a queued or running run."""
        rows = self._all("SELECT DISTINCT agent FROM runs WHERE company=? AND state IN ('queued', 'running')",
                         (_company(company),))
        return {r["agent"] for r in rows}

    _ACTIVE_RANK = {"running": 0, "waiting": 1, "queued": 2}

    def active_runs(self, company):
        """The active run of each agent of the company: {agent: {"id", "state"}}. Of several active runs of an agent
        the running one, else the waiting one, else the oldest queued one (the next to run)."""
        rows = self._all("SELECT id, agent, state FROM runs WHERE company=? AND state IN ('queued', 'running', "
                         "'waiting') ORDER BY id", (_company(company),))
        out = {}
        for r in rows:
            cur = out.get(r["agent"])
            if cur is None or self._ACTIVE_RANK[r["state"]] < self._ACTIVE_RANK[cur["state"]]:
                out[r["agent"]] = {"id": r["id"], "state": r["state"]}
        return out

    def interrupt_runs(self):
        """At start: runs left queued or running by an earlier process become interrupted (waiting runs wait for an
        answer of the user and survive). Returns how many."""
        _, n = self._run("UPDATE runs SET state='interrupted', updated=? WHERE state IN ('queued', 'running')",
                         (utc_now(),))
        return n

    # -- tasks

    def create_task(self, company, from_agent, to_agent, title, body="", run_id=None, state="open"):
        _company(company)
        if state not in TASK_STATES:
            raise ValueError("invalid task state %r" % (state,))
        if run_id is not None and self.get_run(company, run_id) is None:
            raise ValueError("no run %r of company %d" % (run_id, company))
        now = utc_now()
        rowid, _ = self._run("INSERT INTO tasks(company, from_agent, to_agent, title, body, state, run_id, created, "
                             "updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                             (company, from_agent, to_agent, title, body or "", state, run_id, now, now))
        return rowid

    def get_task(self, company, task_id):
        return self._one("SELECT * FROM tasks WHERE id=? AND company=?", (task_id, _company(company)))

    def update_task(self, company, task_id, state=None, result=None, run_id=None, expect=None):
        """Change state/result/run of a task of the company (state only from one of `expect`); True when changed."""
        sets, args = ["updated=?"], [utc_now()]
        if state is not None:
            if state not in TASK_STATES:
                raise ValueError("invalid task state %r" % (state,))
            sets.append("state=?")
            args.append(state)
        if result is not None:
            sets.append("result=?")
            args.append(result)
        if run_id is not None:
            if self.get_run(company, run_id) is None:
                raise ValueError("no run %r of company %d" % (run_id, company))
            sets.append("run_id=?")
            args.append(run_id)
        sql = "UPDATE tasks SET %s WHERE id=? AND company=?" % ", ".join(sets)
        args += [task_id, _company(company)]
        if expect:
            sql += " AND state IN (%s)" % ",".join("?" * len(expect))
            args.extend(expect)
        _, n = self._run(sql, args)
        return n == 1

    def list_tasks(self, company, states=None, limit=200):
        """Tasks of the company, newest first."""
        sql = "SELECT * FROM tasks WHERE company=?"
        args = [_company(company)]
        if states:
            sql += " AND state IN (%s)" % ",".join("?" * len(states))
            args.extend(states)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(int(limit))
        return self._all(sql, args)

    # -- questions

    def create_question(self, company, agent, run_id, conversation_id, payload):
        _company(company)
        if run_id is not None and self.get_run(company, run_id) is None:
            raise ValueError("no run %r of company %d" % (run_id, company))
        if conversation_id is not None and self.get_conversation(company, conversation_id) is None:
            raise ValueError("no conversation %r of company %d" % (conversation_id, company))
        rowid, _ = self._run("INSERT INTO questions(company, agent, run_id, conversation_id, payload, state, created) "
                             "VALUES(?, ?, ?, ?, ?, 'pending', ?)",
                             (company, agent, run_id, conversation_id, _dumps(payload), utc_now()))
        return rowid

    # questions and projects carry the label of the token that answered / approved them (never the token itself)
    _QUESTION_SELECT = ("SELECT q.*, t.label AS answered_by_label FROM questions q "
                        "LEFT JOIN tokens t ON t.id = q.answered_by WHERE q.company=?")
    _PROJECT_SELECT = ("SELECT p.*, t.label AS approved_by_label FROM projects p "
                       "LEFT JOIN tokens t ON t.id = p.approved_by WHERE p.company=?")

    def get_question(self, company, question_id):
        return self._one(self._QUESTION_SELECT + " AND q.id=?", (_company(company), question_id))

    def answer_question(self, company, question_id, answer, token_id):
        """pending -> answered with the answer (JSON) and who gave it; True when changed (False: not pending)."""
        _, n = self._run("UPDATE questions SET state='answered', answer=?, answered_by=?, answered=? "
                         "WHERE id=? AND company=? AND state='pending'",
                         (_dumps(answer), token_id, utc_now(), question_id, _company(company)))
        return n == 1

    def dismiss_question(self, company, question_id, token_id):
        _, n = self._run("UPDATE questions SET state='dismissed', answered_by=?, answered=? "
                         "WHERE id=? AND company=? AND state='pending'",
                         (token_id, utc_now(), question_id, _company(company)))
        return n == 1

    def list_questions(self, company, state=None, limit=200):
        """Questions of the company, newest first."""
        sql = self._QUESTION_SELECT
        args = [_company(company)]
        if state is not None:
            sql += " AND q.state=?"
            args.append(state)
        sql += " ORDER BY q.id DESC LIMIT ?"
        args.append(int(limit))
        return self._all(sql, args)

    def pending_question_counts(self, company):
        rows = self._all("SELECT agent, COUNT(*) AS n FROM questions WHERE company=? AND state='pending' "
                         "GROUP BY agent", (_company(company),))
        return {r["agent"]: r["n"] for r in rows}

    # -- projects

    def create_project(self, company, agent, title, rationale, ops, estimate=None, preview=None, state="proposed"):
        _company(company)
        if state not in PROJECT_STATES:
            raise ValueError("invalid project state %r" % (state,))
        now = utc_now()
        rowid, _ = self._run("INSERT INTO projects(company, agent, title, rationale, ops, estimate, preview, state, "
                             "created, updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                             (company, agent, title, rationale or "", _dumps(ops if ops is not None else []),
                              _dumps(estimate), _dumps(preview), state, now, now))
        return rowid

    def get_project(self, company, project_id):
        return self._one(self._PROJECT_SELECT + " AND p.id=?", (_company(company), project_id))

    _PROJECT_FIELDS = ("title", "rationale", "ops", "estimate", "preview", "state", "approved_by", "report")

    def update_project(self, company, project_id, expect=None, **fields):
        """Change fields of a project of the company (only while its state is one of `expect` when given); True
        when changed. JSON fields (ops, estimate, preview, report) take Python values."""
        sets, args = ["updated=?"], [utc_now()]
        for k, v in fields.items():
            if k not in self._PROJECT_FIELDS:
                raise ValueError("unknown project field %r" % (k,))
            if k == "state" and v not in PROJECT_STATES:
                raise ValueError("invalid project state %r" % (v,))
            sets.append("%s=?" % k)
            args.append(_dumps(v) if k in _JSON_COLUMNS else v)
        sql = "UPDATE projects SET %s WHERE id=? AND company=?" % ", ".join(sets)
        args += [project_id, _company(company)]
        if expect:
            sql += " AND state IN (%s)" % ",".join("?" * len(expect))
            args.extend(expect)
        _, n = self._run(sql, args)
        return n == 1

    def list_projects(self, company, states=None, limit=200):
        """Projects of the company, newest first."""
        sql = self._PROJECT_SELECT
        args = [_company(company)]
        if states:
            sql += " AND p.state IN (%s)" % ",".join("?" * len(states))
            args.extend(states)
        sql += " ORDER BY p.id DESC LIMIT ?"
        args.append(int(limit))
        return self._all(sql, args)

    # -- usage

    def add_usage(self, company, model, prompt_hit, prompt_miss, completion, usd, day=None):
        """Add the tokens and cost of one model call to the day's counters of the company."""
        self._run("INSERT INTO usage(day, company, model, prompt_hit, prompt_miss, completion, usd) "
                  "VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day, company, model) DO UPDATE SET "
                  "prompt_hit=prompt_hit+excluded.prompt_hit, prompt_miss=prompt_miss+excluded.prompt_miss, "
                  "completion=completion+excluded.completion, usd=usd+excluded.usd",
                  (day or utc_day(), _company(company), str(model), int(prompt_hit), int(prompt_miss),
                   int(completion), float(usd)))

    def usage_usd(self, day=None, company=None):
        """USD spent on a day (default today, UTC) by all companies or by one."""
        sql = "SELECT COALESCE(SUM(usd), 0) AS usd FROM usage WHERE day=?"
        args = [day or utc_day()]
        if company is not None:
            sql += " AND company=?"
            args.append(_company(company))
        return float(self._one(sql, args)["usd"])

    def usage_rows(self, day=None, company=None):
        sql = "SELECT * FROM usage WHERE day=?"
        args = [day or utc_day()]
        if company is not None:
            sql += " AND company=?"
            args.append(_company(company))
        return self._all(sql + " ORDER BY company, model", args)

    def usage_summary(self, company):
        """The usage part of /api/team/state: today_usd (all companies), limit_usd, company_usd,
        company_limit_usd (None: no share), resets_at (next UTC midnight)."""
        daily, per_company = self.limits()
        return {"today_usd": round(self.usage_usd(), 6), "limit_usd": daily,
                "company_usd": round(self.usage_usd(company=company), 6), "company_limit_usd": per_company,
                "resets_at": next_utc_midnight()}


def _label(label):
    if label is None:
        return None
    label = str(label).strip()
    if len(label) > MAX_LABEL or any(ord(c) < 32 for c in label):
        raise ValueError("a label has at most %d characters and no control characters" % MAX_LABEL)
    return label or None


def _text(value, name, max_len):
    if not isinstance(value, str) or not value or len(value) > max_len:
        raise ValueError("invalid %s" % name)
    return value
