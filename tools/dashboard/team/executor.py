"""
The executor of approved projects (contract R2 "Projects"): deterministic bridge code, not the language model, carries
out the operations of a project one after the other through the engine's agent commands, for the company of the
project only, and writes the report itself.

Money rules in code (the model is never trusted with them):
  rule 15  before the start a fresh cash read minus estimate.total must not be below 0, else the project fails with
           "not enough money" and nothing is done;
  rule 14  the first operation that fails stops the project; the ones after it are skipped (no rollback: the report
           says what was done and what was not, the author may propose a correction);
  overrun  the project stops as soon as the money spent exceeds estimate.total by more than 20 % (also between the
           convoys of one buy_convoy).

Every operation is verified. Single player: the engine runs the tool at once and its reply tells (errors are error
replies; new line and convoy ids come with the reply). Network game: the reply is only {"pending": true}, the tool
goes through the server, so the executor reads the game again (tiles, depot, lines, line, convoy) until the change is
visible, at most VERIFY_TIMEOUT seconds, else the operation failed. New ids come from a before/after comparison of the
company's lines or of the depot's convoys.

The cost of an operation is the change of "new vehicles" + "construction" of the running month in the company's
finance (month changes are handled); only when the finance read is not available the cash difference is used (it
also moves with income and maintenance, the report says so). The money spent ("actual_cost") counts purchases and
construction; money received from sales is reported as "income" and never offsets the overrun rule.

One project per company runs at a time, each in its own thread. A thread never dies silently: an unexpected error
fails the project with the error in the report. Projects left approved or running by an earlier process are failed
by recover() ("interrupted by a restart"); they are never resumed automatically.
"""

import re
import sys
import threading
import time
import traceback

from . import TeamError
from . import projects as P
from .api import present_message, present_project
from .db import utc_now
from .engine import is_pending

VERIFY_TIMEOUT = 20.0     # s: a change of a network game must show up within this time
POLL = 0.25               # s between the reads of a verification
COMPANIES = tuple(c for c in range(15) if c != 1)
TYPE_HINT = re.compile(r"needs type (\d)|line type (\d)")


class OpFailed(Exception):
    """An operation did not work (the text goes into the report); result: what it did before it failed."""

    def __init__(self, message, result=None):
        super().__init__(message)
        self.result = result


def _log(text):
    try:
        print("team executor: %s" % text, file=sys.stderr, flush=True)
    except Exception:
        pass


def _fmt(value):
    return "%.0f" % (value or 0)


class _Run:
    """The execution of one project: engine access, verification, money snapshots, refs."""

    def __init__(self, ex, company, project, engine):
        self.ex = ex
        self.company = company
        self.project = project
        self.engine = engine
        est = project.get("estimate") if isinstance(project.get("estimate"), dict) else {}
        self.total = P.money(est.get("total"))
        self.limit = self.total * P.OVERRUN
        self.plans = est.get("plans") if isinstance(est.get("plans"), dict) else {}
        self.refs = {}            # ref name -> (kind, id)
        self.line_types = {}      # line id -> line type (lines created by this project)
        self.spent = 0.0          # money spent by the finished ops
        self.income = 0.0
        self.sources = set()      # "finance" / "cash": how costs were measured
        self.op_snap = None
        self.started = None

    # -- engine access

    def stopping(self):
        if self.ex._stop.is_set():
            raise OpFailed("stopped: the dashboard is shutting down (the last change may still happen in the game)")

    def send(self, command, args):
        """A change: the reply (single player {"result": null, ...}, network {"pending": true}); OpFailed when the
        game refused or did not answer."""
        self.stopping()
        r = P.call(self.engine, command, args)
        e = P.error_of(r)
        if e:
            if P.unreachable(r):
                raise OpFailed("the game did not answer: %s" % e)
            raise OpFailed("%s refused: %s" % (command, e))
        return r

    def read(self, command, args):
        """A read: the reply, or None when it failed (verifications retry)."""
        r = P.call(self.engine, command, args)
        return None if P.error_of(r) else r

    def gone(self, command, args):
        """True when the game answers that the object does not exist (not when it does not answer)."""
        r = P.call(self.engine, command, args)
        return bool(P.error_of(r)) and not P.unreachable(r)

    def wait(self, check, what):
        """Polls check() until it returns a true value (returned), at most VERIFY_TIMEOUT seconds."""
        end = time.monotonic() + self.ex.verify_timeout
        while True:
            self.stopping()
            value = check()
            if value:
                return value
            if time.monotonic() >= end:
                raise OpFailed("the change did not show up in the game within %.0f s: %s"
                               % (self.ex.verify_timeout, what))
            if self.ex._stop.wait(self.ex.poll_interval):
                self.stopping()

    # -- money

    def snapshot(self):
        """The company's money state: finance (new vehicles + construction of the running month, month index, cash)
        or, without a usable finance read, cash only. None when nothing could be read."""
        r = P.call(self.engine, "finance", {"player": self.company, "period": "month"})
        if not P.error_of(r):
            cols = r.get("columns") if isinstance(r.get("columns"), list) else []
            rows = r.get("month") if isinstance(r.get("month"), list) else []
            date = r.get("date") if isinstance(r.get("date"), dict) else {}
            if "new_vehicles" in cols and "construction" in cols and rows and isinstance(rows[0], list) \
                    and type(date.get("year")) is int and type(date.get("month")) is int:
                iv, ic = cols.index("new_vehicles"), cols.index("construction")
                icash = cols.index("cash") if "cash" in cols else None

                def nvc(row):
                    try:
                        return float(row[iv]) + float(row[ic])
                    except (IndexError, TypeError, ValueError):
                        return None
                m0 = nvc(rows[0])
                if m0 is not None:
                    snap = {"src": "finance", "month": date["year"] * 12 + date["month"], "m0": m0,
                            "m1": nvc(rows[1]) if len(rows) > 1 and isinstance(rows[1], list) else None}
                    if icash is not None:
                        try:
                            snap["cash"] = float(rows[0][icash])
                        except (IndexError, TypeError, ValueError):
                            pass
                    return snap
        cash, e = P.company_cash(self.engine, self.company)
        return None if e else {"src": "cash", "cash": cash}

    def spent_between(self, s0, s1):
        """Money spent between two snapshots (negative: received), or None when it cannot be told."""
        if s0 is None or s1 is None:
            return None
        if s0["src"] == "finance" and s1["src"] == "finance":
            if s1["month"] == s0["month"]:
                self.sources.add("finance")
                return -(s1["m0"] - s0["m0"])
            if s1["month"] == s0["month"] + 1 and s1["m1"] is not None:
                # a new month began in between: the rest of the old month plus the new month so far
                self.sources.add("finance")
                return -((s1["m1"] - s0["m0"]) + s1["m0"])
        if "cash" in s0 and "cash" in s1:
            self.sources.add("cash")
            return s0["cash"] - s1["cash"]
        return None

    def spent_now(self):
        """Money spent since the current op began (0 when unknown)."""
        v = self.spent_between(self.op_snap, self.snapshot())
        return v or 0.0

    def check_budget(self, partial):
        """Between the steps of one op: stop when the money spent so far exceeds the limit."""
        v = self.spent_between(self.op_snap, self.snapshot())
        if v is None:
            raise OpFailed("stopped: the cost could not be measured", partial)
        if self.spent + max(0.0, v) > self.limit + 0.01:
            raise OpFailed(self.overrun_text(self.spent + max(0.0, v)), partial)

    def overrun_text(self, spent):
        return ("stopped: the actual cost %s exceeds the estimate %s by more than %d %%"
                % (_fmt(spent), _fmt(self.total), round((P.OVERRUN - 1) * 100)))

    # -- reads used by the ops

    def resolve(self, value, kind):
        if isinstance(value, int):
            return value
        ref = self.refs.get(value[1:]) if isinstance(value, str) else None
        if not ref or ref[0] != kind:
            raise OpFailed("%s %s is not known (the op that creates it did not run)" % (kind, value))
        return ref[1]

    def count(self, pos, types=None):
        """Objects (of some types) on a square, all grounds, without moving things; None when unreadable."""
        r = self.read("tile", {"x": pos[0], "y": pos[1]})
        if r is None:
            return None
        return sum(1 for o in P.tile_objects(r) if types is None or o[1] in types)

    def halt_at(self, pos):
        r = self.read("tile", {"x": pos[0], "y": pos[1]})
        if r is None:
            return None
        return any(isinstance(g, dict) and g.get("halt") is not None for g in r.get("grounds") or ())

    def resolve_stops(self, stops):
        """Stops with z: the given one, else the height of the stop's ground (a halt, else a way) from the game."""
        out = []
        for s in stops:
            at = list(s["at"])
            if len(at) == 2:
                r = self.read("tile", {"x": at[0], "y": at[1]})
                z = P.ground_z(r, prefer_halt=True) if r else None
                if z is None:
                    raise OpFailed("cannot read the square %s of a stop" % P.pos_text(at))
                at.append(z)
            out.append(dict(s, at=at))
        return out

    def line_ids(self):
        r = self.read("lines", {"owner": self.company, "fields": "summary", "limit": 0})
        if r is None or not isinstance(r.get("lines"), list):
            return None
        return {ln["id"] for ln in r["lines"] if isinstance(ln, dict) and type(ln.get("id")) is int
                and ln.get("owner", self.company) == self.company}

    def line_read(self, lid):
        r = self.read("line", {"id": lid})
        return r if r and isinstance(r.get("line"), dict) else None

    def depot_convoys(self, depot):
        r = self.read("depot", P.pos_args(depot))
        if r is None or not isinstance(r.get("convoys"), list):
            return None
        return {c["id"]: c for c in r["convoys"] if isinstance(c, dict) and type(c.get("id")) is int}

    def convoy_read(self, cid):
        r = self.read("convoy", {"id": cid})
        return r.get("convoy") if r and isinstance(r.get("convoy"), dict) else None

    # -- the operations (return a result dict, raise OpFailed)

    def op_build_way(self, i, op):
        plan = self.plans.get(str(i))
        if not isinstance(plan, dict) or not plan.get("param"):
            raise OpFailed("the plan of this way is missing (propose the project again)")
        a, b = plan["from"], plan["to"]
        args = dict(P.pos_args(a), **P.pos_args(b, "2"))
        args.update(tool="tool_build_way", param=plan["param"])
        samples = plan.get("samples") or [a, b]
        before = {tuple(p): self.count(p, P.WAYISH) for p in samples}
        r = self.send("agent_tool", args)
        if is_pending(r):
            empty = [p for p, c in before.items() if c == 0]

            def check():
                if empty:
                    return all((self.count(p, P.WAYISH) or 0) > 0 for p in empty)
                if (plan.get("cost") or 0) <= 0:
                    return True  # the whole route existed: nothing to build
                if any(c is not None and (self.count(p, P.WAYISH) or 0) > c for p, c in before.items()):
                    return True
                return self.spent_now() > 0
            self.wait(check, "the way from %s to %s" % (P.pos_text(a), P.pos_text(b)))
        return {"squares": plan.get("length")}

    def op_build_station(self, i, op):
        at = op["at"]
        param = op["building"] + ("," + str(op["rotation"]) if "rotation" in op else "")
        halt0, n0 = self.halt_at(at), self.count(at, ("building",))
        r = self.send("agent_tool", dict(P.pos_args(at), tool="tool_build_station", param=param))
        if is_pending(r):
            def check():
                n = self.count(at, ("building",))
                return (n0 is not None and n is not None and n > n0) or (halt0 is False and self.halt_at(at))
            self.wait(check, "the station at %s" % P.pos_text(at))
        return {"at": at}

    def op_build_depot(self, i, op):
        at = op["at"]
        r = self.send("agent_tool", dict(P.pos_args(at), tool="tool_build_depot", param=op["building"]))
        if is_pending(r):
            def check():
                d = self.read("depot", P.pos_args(at))
                return d is not None and d.get("owner") == self.company
            self.wait(check, "the depot at %s" % P.pos_text(at))
        return {"at": at}

    def op_build_roadsign(self, i, op):
        at = op["at"]
        n0 = self.count(at, ("roadsign", "signal"))
        r = self.send("agent_tool", dict(P.pos_args(at), tool="tool_build_roadsign", param=op["sign"]))
        if is_pending(r):
            def check():
                n = self.count(at, ("roadsign", "signal"))
                return n0 is not None and n is not None and n > n0
            self.wait(check, "the sign at %s" % P.pos_text(at))
        return {"at": at}

    def op_build_wayobj(self, i, op):
        a, b = op["from"], op["to"]
        before = {tuple(p): self.count(p, ("wayobj",)) for p in (a, b)}
        args = dict(P.pos_args(a), **P.pos_args(b, "2"))
        args.update(tool="tool_build_wayobj", param=op["wayobj"])
        r = self.send("agent_tool", args)
        if is_pending(r):
            def check():
                if any(c is not None and (self.count(p, ("wayobj",)) or 0) > c for p, c in before.items()):
                    return True
                return self.spent_now() > 0
            self.wait(check, "the way objects from %s to %s" % (P.pos_text(a), P.pos_text(b)))
        return {}

    def op_remove(self, i, op):
        at = op["at"]
        n0 = self.count(at)
        args = dict(P.pos_args(at), tool="tool_remover")
        if op.get("kind"):
            args["param"] = P.REMOVE_KINDS[op["kind"]]
        r = self.send("agent_tool", args)
        if is_pending(r):
            def check():
                n = self.count(at)
                return n0 is not None and n is not None and n < n0
            self.wait(check, "the removal at %s" % P.pos_text(at))
        return {}

    def op_remove_way(self, i, op):
        a, b = op["from"], op["to"]
        before = {tuple(p): self.count(p, P.WAYISH) for p in (a, b)}
        args = dict(P.pos_args(a), **P.pos_args(b, "2"))
        args.update(tool="tool_remove_way", param=str(P.REMOVE_WAYTYPES[op["waytype"]]))
        r = self.send("agent_tool", args)
        if is_pending(r):
            def check():
                for p, c in before.items():
                    n = self.count(p, P.WAYISH) if c is not None else None
                    if n is not None and n < c:
                        return True
                return False
            self.wait(check, "the removal of the way from %s to %s" % (P.pos_text(a), P.pos_text(b)))
        return {}

    def _same_stops(self, line_reply, stops):
        """The line's schedule has these stops (x, y in order, doubled neighbours dropped like the game) and
        loads."""
        want = []
        for s in stops:
            key = (s["at"][0], s["at"][1], s.get("load", 0))
            if not want or want[-1][:2] != key[:2]:
                want.append(key)
        have = []
        for e in line_reply.get("schedule") or ():
            if isinstance(e, dict) and isinstance(e.get("pos"), dict):
                have.append((e["pos"].get("x"), e["pos"].get("y"), e.get("wait_for_load", 0)))
        return have == want

    def op_create_line(self, i, op):
        lt = P.LINE_TYPES[op["waytype"]]
        stops = self.resolve_stops(op["stops"])
        before = self.line_ids()
        r = self.send("line_op", {"op": "c", "waytype": lt, "schedule": P.schedule_text(lt, stops)})
        lid = r.get("line") if type(r.get("line")) is int else None
        if lid is None:
            if not is_pending(r):
                raise OpFailed("the game did not tell the id of the new line")
            if before is None:
                raise OpFailed("cannot read the lines of the company")

            def check():
                now = self.line_ids()
                if now is None:
                    return None
                new = sorted(now - before)
                if len(new) > 1:
                    # someone else of the company made a line at the same time: the one with our stops
                    new = [n for n in new if (lambda lr: lr is not None and self._same_stops(lr, stops))(
                        self.line_read(n))]
                    if len(new) != 1:
                        raise OpFailed("several new lines appeared at once; cannot tell which one is the new line")
                return new[0] if new else None
            lid = self.wait(check, "the new line")
        self.refs[op["ref"]] = ("line", lid)
        self.line_types[lid] = lt
        result = {"line": lid}
        if op.get("name"):
            try:
                r = self.send("line_op", {"op": "r", "line": lid, "name": op["name"]})
                if is_pending(r):
                    self.wait(lambda: (lambda lr: lr is not None and lr["line"].get("name") == op["name"])(
                        self.line_read(lid)), "the name of line %d" % lid)
            except OpFailed as e:
                raise OpFailed("line %d was created, but %s" % (lid, e), result)
        return result

    def op_set_line_schedule(self, i, op):
        lid = self.resolve(op["line"], "line")
        stops = self.resolve_stops(op["stops"])
        lt = self.line_types.get(lid)
        if lt is None:
            lr = self.line_read(lid)
            lt = P.linetype_from_name(lr["line"].get("type")) if lr else None
        lt = lt or 1
        try:
            r = self.send("line_op", {"op": "g", "line": lid, "schedule": P.schedule_text(lt, stops)})
        except OpFailed as e:
            # the line type is not readable in every language: the engine names the type it needs
            m = TYPE_HINT.search(str(e))
            needed = int(m.group(1) or m.group(2)) if m else None
            if not needed or needed == lt:
                raise
            lt = needed
            r = self.send("line_op", {"op": "g", "line": lid, "schedule": P.schedule_text(lt, stops)})
        if is_pending(r):
            self.wait(lambda: (lambda lr: lr is not None and self._same_stops(lr, stops))(self.line_read(lid)),
                      "the schedule of line %d" % lid)
        return {"line": lid}

    def op_delete_line(self, i, op):
        lid = self.resolve(op["line"], "line")
        r = self.send("line_op", {"op": "d", "line": lid})
        if is_pending(r):
            self.wait(lambda: self.gone("line", {"id": lid}), "the deletion of line %d" % lid)
        return {"line": lid}

    def buy_one(self, depot, vehicles, line, start):
        """One convoy of these vehicles in a depot (optionally on a line and started): its id. OpFailed.result
        names the convoy when it was made but not finished."""
        dargs = P.pos_args(depot)
        where = "the depot at %s" % P.pos_text(depot)
        before = self.depot_convoys(depot)
        if before is None:
            raise OpFailed("cannot read %s" % where)
        r = self.send("depot_op", dict(dargs, op="a", convoy=0, vehicle=vehicles[0]))
        cid = r.get("convoy") if type(r.get("convoy")) is int else None
        if cid is None:
            if not is_pending(r):
                raise OpFailed("the game did not tell the id of the new convoy")

            def check():
                now = self.depot_convoys(depot)
                if now is None:
                    return None
                new = [c for k, c in now.items() if k not in before]
                if len(new) > 1:
                    new = [c for c in new if (c.get("vehicles") or [None])[0] == vehicles[0]]
                    if len(new) != 1:
                        raise OpFailed("several new convoys appeared in %s at once" % where)
                return new[0]["id"] if new else None
            cid = self.wait(check, "the new convoy in %s" % where)
        partial = {"convoy": cid, "left_in_depot": True}

        def current():
            now = self.depot_convoys(depot)
            if now is None:
                return None
            if cid not in now:
                raise OpFailed("convoy %d is not in %s any more" % (cid, where), partial)
            return list(now[cid].get("vehicles") or [])
        try:
            have = self.wait(current, "the vehicles of convoy %d" % cid)
            while True:
                if have != vehicles[:len(have)]:
                    raise OpFailed("the depot made convoy %d of %s instead of %s" % (cid, have, vehicles), partial)
                if len(have) >= len(vehicles):
                    break
                n = len(have)
                self.send("depot_op", dict(dargs, op="a", convoy=cid, vehicle=vehicles[n]))
                have = self.wait(lambda: (lambda v: v if v is not None and len(v) > n else None)(current()),
                                 "vehicle %d of convoy %d" % (n + 1, cid))
            if line is not None:
                r = self.send("convoy_op", {"convoy": cid, "op": "l", "line": line})
                if is_pending(r):
                    self.wait(lambda: (lambda now: now is not None and cid in now
                                       and now[cid].get("line") == line)(self.depot_convoys(depot)),
                              "convoy %d on line %d" % (cid, line))
            if start:
                r = self.send("depot_op", dict(dargs, op="b", convoy=cid))
                if is_pending(r):
                    self.wait(lambda: (lambda now: now is not None and cid not in now)(self.depot_convoys(depot)),
                              "convoy %d leaving %s" % (cid, where))
        except OpFailed as e:
            raise OpFailed(str(e), e.result or partial)
        return cid

    def op_buy_convoy(self, i, op):
        line = self.resolve(op["line"], "line") if op.get("line") is not None else None
        start = bool(op.get("start", line is not None))
        bought = []
        count = op.get("count", 1)
        for k in range(count):
            try:
                bought.append(self.buy_one(op["depot"], op["vehicles"], line, start))
            except OpFailed as e:
                result = {"convoys": bought}
                if isinstance(e.result, dict) and e.result.get("convoy"):
                    result["unfinished"] = e.result["convoy"]
                raise OpFailed(str(e), result)
            if k < count - 1:
                self.check_budget({"convoys": bought})
        if op.get("ref"):
            self.refs[op["ref"]] = ("convoy", bought[0])
        return {"convoys": bought}

    def op_assign_line(self, i, op):
        cid = self.resolve(op["convoy"], "convoy")
        lid = self.resolve(op["line"], "line")
        r = self.send("convoy_op", {"convoy": cid, "op": "l", "line": lid})
        if is_pending(r):
            self.wait(lambda: (lambda c: c is not None and P.line_id_of(c.get("line")) == lid)(self.convoy_read(cid)),
                      "convoy %d on line %d" % (cid, lid))
        return {"convoy": cid, "line": lid}

    def withdraw(self, cid, on):
        """Sets withdraw of a convoy; "sold" when the game sold it at once (empty convoys), "unchanged", or
        "withdrawn"/"kept"."""
        r = self.send("convoy_op", {"convoy": cid, "op": "w", "withdraw": 1 if on else 0})
        if r.get("changed") is False:
            return "unchanged"
        state = {"v": "withdrawn" if on else "kept"}
        if is_pending(r):
            def check():
                c = self.convoy_read(cid)
                if c is None:
                    if on and self.gone("convoy", {"id": cid}):
                        state["v"] = "sold"
                        return True
                    return None
                return c.get("withdraw") is on
            self.wait(check, "the withdrawal of convoy %d" % cid)
        return state["v"]

    def op_withdraw(self, i, op):
        cid = self.resolve(op["convoy"], "convoy")
        return {"convoy": cid, "withdraw": self.withdraw(cid, op.get("on", True))}

    def sell(self, cid):
        self.send("convoy_op", {"convoy": cid, "op": "x"})
        # a convoy outside a depot is sold by the game at its next step (self destruct), also in single player
        # where the reply comes at once: wait until it is gone, so that the money of the sale is in the finance
        # read that measures the op (else the report shows no income)
        self.wait(lambda: self.gone("convoy", {"id": cid}), "the sale of convoy %d" % cid)

    def op_sell(self, i, op):
        cid = self.resolve(op["convoy"], "convoy")
        self.sell(cid)
        return {"sold": cid}

    def op_replace_convoy(self, i, op):
        old = self.resolve(op["convoy"], "convoy")
        plan = self.plans.get(str(i))
        if not isinstance(plan, dict) or not plan.get("depot") or not plan.get("line"):
            raise OpFailed("the plan of this replacement is missing (propose the project again)")
        conv = self.convoy_read(old)
        if conv is None or conv.get("owner") != self.company:
            raise OpFailed("convoy %d is not a convoy of the company any more" % old)
        result = {"replaced": old}
        try:
            result["convoy"] = self.buy_one(plan["depot"], op["vehicles"], plan["line"], True)
        except OpFailed as e:
            if isinstance(e.result, dict) and e.result.get("convoy"):
                result["unfinished"] = e.result["convoy"]
            raise OpFailed(str(e), result)
        conv = self.convoy_read(old)
        try:
            if conv is not None and conv.get("state") == "in_depot":
                self.sell(old)
                result["old"] = "sold"
            else:
                result["old"] = self.withdraw(old, True)
        except OpFailed as e:
            raise OpFailed("the new convoy %d runs, but the old one: %s" % (result["convoy"], e), result)
        return result


class Executor:
    """Carries out approved projects. engine_for(company) -> company-bound engine callable; feed: the bridge's feed
    getter (kept for callers; the money rules use fresh reads only)."""

    def __init__(self, db, events, engine_for, feed=None, verify_timeout=VERIFY_TIMEOUT, poll_interval=POLL):
        self.db = db
        self.events = events
        self.engine_for = engine_for
        self.feed = feed
        self.verify_timeout = float(verify_timeout)
        self.poll_interval = float(poll_interval)
        self.lock = threading.Lock()
        self.threads = {}         # company -> worker thread
        self._stop = threading.Event()

    # -- interface

    def busy(self, company):
        with self.lock:
            th = self.threads.get(company)
            return bool(th and th.is_alive())

    def approve(self, company, project_id, token_id):
        """proposed -> approved (409 otherwise, also while another project of the company is approved or running),
        then the project runs in its own thread. Raises TeamError (404 for another company's project)."""
        with self.lock:
            if self._stop.is_set():
                raise TeamError(503, "the dashboard is shutting down")
            p = self.db.get_project(company, project_id)
            if p is None:
                raise TeamError(404, "no such project")
            if p["state"] != "proposed":
                raise TeamError(409, "the project is %s" % p["state"])
            th = self.threads.get(company)
            if (th and th.is_alive()) or self.db.list_projects(company, ("approved", "running"), 1):
                raise TeamError(409, "another project of the company is being carried out; approve this one when "
                                     "it has finished")
            if not self.db.update_project(company, project_id, expect=("proposed",), state="approved",
                                          approved_by=token_id):
                raise TeamError(409, "the project is not proposed any more")
            self._publish(company, project_id)
            th = threading.Thread(target=self._worker, args=(company, project_id),
                                  name="team-project-%d" % project_id, daemon=True)
            self.threads[company] = th
            th.start()

    def reject(self, company, project_id, reason, token_id):
        """draft/proposed -> rejected; the reason goes into the report and a note into the author's chat."""
        with self.lock:
            p = self.db.get_project(company, project_id)
            if p is None:
                raise TeamError(404, "no such project")
            if p["state"] not in ("draft", "proposed"):
                raise TeamError(409, "the project is %s" % p["state"])
            est = p.get("estimate") if isinstance(p.get("estimate"), dict) else {}
            report = {"ops": [], "actual_cost": 0.0, "estimate": P.money(est.get("total")),
                      "stopped": "rejected by the user" + (": %s" % reason if reason else ""),
                      "rejected": {"reason": reason, "by": token_id, "at": utc_now()}}
            if not self.db.update_project(company, project_id, expect=("draft", "proposed"), state="rejected",
                                          report=report):
                raise TeamError(409, "the project is not proposed any more")
        self._publish(company, project_id)
        self._note(company, p, 'The user rejected project #%d "%s"%s.'
                   % (project_id, p["title"], (": " + reason) if reason else " (no reason given)"))

    def recover(self):
        """At start: projects left approved or running by an earlier process fail with "interrupted by a restart";
        the operation that was running then is reported as unknown. Never resumes. Returns how many."""
        n = 0
        for company in COMPANIES:
            for p in self.db.list_projects(company, ("approved", "running"), 1000):
                try:
                    if self._recover_one(company, p):
                        n += 1
                except Exception as e:
                    _log("recovering project %s failed: %s" % (p.get("id"), e))
        return n

    def shutdown(self, timeout=10.0):
        """Stops the workers between two reads (their projects fail with "the dashboard was stopped")."""
        self._stop.set()
        with self.lock:
            threads = list(self.threads.values())
        end = time.monotonic() + timeout
        for th in threads:
            th.join(max(0.0, end - time.monotonic()))

    # -- internals

    def _publish(self, company, project_id):
        try:
            row = self.db.get_project(company, project_id)
            if row is not None:
                self.events.publish(company, "team_project", {"project": present_project(row, full=False)})
        except Exception as e:
            _log("publishing project %s failed: %s" % (project_id, e))

    def _note(self, company, project, text):
        """A system note with the result in the chat of the project's author (the model reads it next time)."""
        try:
            conv = self.db.main_conversation(company, project["agent"])
            msg = self.db.add_message(company, conv, "system_note", text, meta={"project_id": project["id"]})
            self.events.publish(company, "team_message", {"agent": project["agent"], "message": present_message(msg)})
        except Exception as e:
            _log("note for project %s failed: %s" % (project.get("id"), e))

    def _recover_one(self, company, p):
        ops = p.get("ops") if isinstance(p.get("ops"), list) else []
        report = dict(p["report"]) if isinstance(p.get("report"), dict) else {}
        entries = [e for e in report.get("ops") or () if isinstance(e, dict)]
        seen = {e.get("op") for e in entries}
        unknown = p["state"] == "running"
        for i, op in enumerate(ops):
            if i in seen:
                continue
            t = op.get("type") if isinstance(op, dict) else None
            if unknown:
                entries.append({"op": i, "type": t, "state": "failed",
                                "error": "interrupted by a restart: it may or may not have been carried out; check "
                                         "the game"})
                unknown = False
            else:
                entries.append({"op": i, "type": t, "state": "skipped"})
        est = p.get("estimate") if isinstance(p.get("estimate"), dict) else {}
        report.update(ops=entries, stopped="interrupted by a restart", finished=utc_now())
        report.setdefault("actual_cost", 0.0)
        report.setdefault("estimate", P.money(est.get("total")))
        if not self.db.update_project(company, p["id"], expect=("approved", "running"), state="failed",
                                      report=report):
            return False
        self._publish(company, p["id"])
        done = sum(1 for e in entries if e.get("state") == "done")
        self._note(company, p, 'Project #%d "%s" was interrupted by a restart of the dashboard: %d of %d operations '
                               'were done%s. It is not continued automatically.'
                   % (p["id"], p["title"], done, len(ops),
                      "; the operation running then may or may not have happened, check the game"
                      if p["state"] == "running" else ""))
        return True

    def _worker(self, company, project_id):
        project = None
        run = None
        entries = []
        try:
            project = self.db.get_project(company, project_id)
            if project is None:
                return
            engine = self.engine_for(company)
            run = _Run(self, company, project, engine)
            self._execute(run, entries)
        except Exception as e:  # never die silently: fail the project with the error
            _log("project %d of company %d: %s\n%s" % (project_id, company, e, traceback.format_exc(limit=8)))
            try:
                self._finish(company, project or {"id": project_id, "agent": None, "title": "", "ops": []}, run,
                             entries, "internal error: %s: %s" % (type(e).__name__, e), ("approved", "running"))
            except Exception as e2:
                _log("project %d could not be failed: %s" % (project_id, e2))
        finally:
            with self.lock:
                if self.threads.get(company) is threading.current_thread():
                    del self.threads[company]

    def _report(self, project, run, entries, stopped, final):
        ops = project.get("ops") if isinstance(project.get("ops"), list) else []
        seen = {e["op"] for e in entries}
        all_entries = list(entries)
        if final:
            for i, op in enumerate(ops):
                if i not in seen:
                    all_entries.append({"op": i, "type": op.get("type") if isinstance(op, dict) else None,
                                        "state": "skipped"})
        est = project.get("estimate") if isinstance(project.get("estimate"), dict) else {}
        report = {"ops": all_entries, "actual_cost": P.money(run.spent if run else 0.0),
                  "estimate": P.money(est.get("total")), "income": P.money(run.income if run else 0.0),
                  "cost_source": ("cash" if run and "cash" in run.sources else "finance")}
        if getattr(run, "started", None):
            report["started"] = run.started
        if final:
            report["finished"] = utc_now()
        if stopped:
            report["stopped"] = stopped
        return report

    def _finish(self, company, project, run, entries, stopped, expect):
        """Final state, report, note and events of a project."""
        pid = project["id"]
        ops = project.get("ops") if isinstance(project.get("ops"), list) else []
        report = self._report(project, run, entries, stopped, True)
        done = sum(1 for e in report["ops"] if e.get("state") == "done")
        state = "done" if not stopped and done == len(ops) else "failed"
        if not self.db.update_project(company, pid, expect=expect, state=state, report=report):
            return
        self._publish(company, pid)
        if project.get("agent"):
            self._note(company, project, self._summary(project, report, state))

    def _summary(self, project, report, state):
        n = len(project.get("ops") or [])
        done = sum(1 for e in report["ops"] if e.get("state") == "done")
        new_lines, new_convoys = [], []
        for e in report["ops"]:
            res = e.get("result") if isinstance(e.get("result"), dict) else {}
            if e.get("type") == "create_line" and res.get("line"):
                new_lines.append(res["line"])
            new_convoys.extend(c for c in res.get("convoys") or () if type(c) is int)
            if e.get("type") == "replace_convoy" and type(res.get("convoy")) is int:
                new_convoys.append(res["convoy"])
            if type(res.get("unfinished")) is int:
                new_convoys.append(res["unfinished"])
        made = ""
        if new_lines:
            made += " New line%s: %s." % ("s" if len(new_lines) > 1 else "", ", ".join(map(str, new_lines)))
        if new_convoys:
            made += " New convoy%s: %s." % ("s" if len(new_convoys) > 1 else "", ", ".join(map(str, new_convoys)))
        money = "cost %s (estimate %s)" % (_fmt(report["actual_cost"]), _fmt(report["estimate"]))
        if report.get("income"):
            money += ", income %s" % _fmt(report["income"])
        if state == "done":
            return 'Project #%d "%s" was carried out: all %d operations done; %s.%s' % (
                project["id"], project["title"], n, money, made)
        why = str(report.get("stopped") or "an operation failed")
        if why.startswith("stopped: "):
            why = why[len("stopped: "):]
        return 'Project #%d "%s" stopped: %s. %d of %d operations done; %s.%s' % (
            project["id"], project["title"], why, done, n, money, made)

    def _save_progress(self, company, project, run, entries):
        report = self._report(project, run, entries, None, False)
        if self.db.update_project(company, project["id"], expect=("running",), report=report):
            self._publish(company, project["id"])

    def _execute(self, run, entries):
        company, project = run.company, run.project
        pid = project["id"]
        ops = project.get("ops") if isinstance(project.get("ops"), list) else []
        run.started = utc_now()
        # rule 15: a fresh cash read, before anything is done
        cash, e = P.company_cash(run.engine, company)
        if e:
            self._finish(company, project, run, entries, "cannot read the cash of the company: %s" % e,
                         ("approved",))
            return
        if cash - run.total < 0:
            self._finish(company, project, run, entries, "not enough money: cash %s, estimate %s (cash minus the "
                         "estimate must not go below 0)" % (_fmt(cash), _fmt(run.total)), ("approved",))
            return
        if not self.db.update_project(company, pid, expect=("approved",), state="running",
                                      report=self._report(project, run, entries, None, False)):
            return  # rejected or recovered meanwhile
        self._publish(company, pid)
        stopped = None
        for i, op in enumerate(ops):
            if self._stop.is_set():
                stopped = "the dashboard was stopped"
                break
            t = op.get("type") if isinstance(op, dict) else None
            handler = getattr(run, "op_" + str(t), None)
            entry = {"op": i, "type": t}
            if handler is None:
                entry.update(state="failed", error="unknown op type")
                entries.append(entry)
                stopped = "ops[%d] failed: unknown op type" % i
                break
            snap0 = run.snapshot()
            if snap0 is None:
                entry.update(state="failed", error="cannot read the money of the company before the operation")
                entries.append(entry)
                stopped = "ops[%d] (%s) failed: %s" % (i, t, entry["error"])
                break
            run.op_snap = snap0
            result, error = None, None
            try:
                result = handler(i, op)
            except OpFailed as ex:
                error, result = str(ex), ex.result
            except TeamError as ex:
                error = ex.message
            except Exception as ex:  # a bug or an unexpected reply: this op failed, its effect is unknown
                _log("ops[%d] of project %d: %s\n%s" % (i, pid, ex, traceback.format_exc(limit=8)))
                error = "internal error: %s: %s (the change may have happened, check the game)" % (
                    type(ex).__name__, ex)
            entry["state"] = "failed" if error else "done"
            if error:
                entry["error"] = error
            if result:
                entry["result"] = result
            cost = run.spent_between(snap0, run.snapshot())
            if cost is None:
                # without the cost the money rules cannot be kept: stop rather than guess
                entry["cost"] = None
                entries.append(entry)
                stopped = ("ops[%d] (%s) failed: %s" % (i, t, error)) if error else \
                    "the cost of ops[%d] (%s) could not be measured" % (i, t)
                break
            entry["cost"] = P.money(cost)
            if cost > 0:
                run.spent += cost
            else:
                run.income += -cost
            entries.append(entry)
            if error:
                stopped = error if error.startswith("stopped:") else "ops[%d] (%s) failed: %s" % (i, t, error)
                break
            if run.spent > run.limit + 0.01:
                stopped = run.overrun_text(run.spent)
                break
            self._save_progress(company, project, run, entries)
        self._finish(company, project, run, entries, stopped, ("running",))
