"""
The AI team of the dashboard: DeepSeek backed specialists that analyse and (after the user's approval) change the
game for ONE company, the company the session's token is bound to.

Modules (stdlib only):
  db       SQLite store: tokens, conversations, messages, runs, tasks, questions, projects, usage, settings
  events   per-company event streams (SSE) with their own ring buffers
  roles    the registry of the agents (ids and default models)
  engine   the engine agent commands and a helper that binds engine calls to one company
  runtime  the agent runtime (TeamRuntime); the stub of round R1 is replaced in round R2
  api      the /api/team/* routes (access, validation, delegation to the runtime)

The bridge (simutrans_dashboard.py) only wires these together.
"""


class TeamError(Exception):
    """A request the team cannot serve: status is the HTTP status for the browser (400, 403, 404, 409, 413, 503),
    reason an optional machine readable code (e.g. "runtime_unavailable", "over_limit")."""

    def __init__(self, status, message, reason=None):
        super().__init__(message)
        self.status = int(status)
        self.message = str(message)
        self.reason = reason

    def body(self):
        out = {"ok": False, "error": self.message}
        if self.reason:
            out["reason"] = self.reason
        return out
