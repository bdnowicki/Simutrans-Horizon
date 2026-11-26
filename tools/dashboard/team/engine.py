"""
Engine agent commands (contract E) as the team sees them.

The bridge never proxies these commands from a browser; only the team runtime calls them, through the bridge's own
team connection (App.team_engine: engine(command, args) -> reply dict). Every command except `estimate` (and the read
`depot`) acts for a company given as player=N: company_engine() binds an engine callable to the session's company so
a runtime cannot act for another company by mistake.
"""

from . import TeamError

# change the game (or compute a dry run) for player=N; refused by an engine without agent mode
AGENT_COMMANDS = ("agent_tool", "depot_op", "line_op", "convoy_op", "plan_way", "estimate")
# reads that only the team uses (the browser has no need for them)
AGENT_READS = ("depot",)
# commands that need player=N (all agent commands but estimate)
PLAYER_COMMANDS = ("agent_tool", "depot_op", "line_op", "convoy_op", "plan_way")
# commands whose success in a network game is only {"pending": true}: verify by reading the game again
CHANGING_COMMANDS = ("agent_tool", "depot_op", "line_op", "convoy_op")

PUBLIC_PLAYER = 1
PLAYER_UNOWNED = 15


def company_engine(engine, company):
    """engine(command, args) -> reply, bound to one company: player= is set to the company for the commands that
    take it, a different player= raises TeamError(403). Other commands pass unchanged."""
    if type(company) is not int or not 0 <= company < PLAYER_UNOWNED or company == PUBLIC_PLAYER:
        raise ValueError("invalid company %r" % (company,))

    def call(command, args=None):
        args = dict(args or {})
        if command in PLAYER_COMMANDS:
            given = args.get("player")
            if given is not None and str(given) != str(company):
                raise TeamError(403, "agents act only for their own company")
            args["player"] = company
        elif "player" in args and command in AGENT_COMMANDS + AGENT_READS:
            raise TeamError(400, "%s takes no player" % command)
        return engine(command, args)
    return call


def is_pending(reply):
    """True for the reply of a change that went to the server of a network game (not yet applied)."""
    return isinstance(reply, dict) and reply.get("pending") is True
