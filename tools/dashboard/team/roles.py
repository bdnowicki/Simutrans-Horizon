"""
Registry of the team's agents. The ids are API values (routes, database rows, events); display names come from the
frontend i18n.

Every agent has a default model (pro for the coordinator, the analyst and the designer, flash for the others), a
limit of completion tokens per model call, the tools it may call (team.tools) and the project operation types it may
propose (team.projects.ROLE_OPS; the read-only roles and the coordinator propose nothing). Model and max_tokens can
be overridden per agent in the settings table of the database (keys model_<agent>, max_tokens_<agent>), the
bridge's --team-model option writes them.

The system prompt of an agent = prompts/base.md + prompts/<agent>.md with a few placeholders filled in (company
number, the agent's operation types, the tool limits). Only the company NUMBER goes into the prompt: the company's
name is typed by a player, i.e. game data that may only reach the model inside tool results (prompt injection).
"""

import os
import re
import threading

PRO = "deepseek-v4-pro"
FLASH = "deepseek-flash"
MODELS = (FLASH, PRO)
MODEL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$")

# tool sets (names of team.tools); the read tools every working specialist has
READ_TOOLS = ("game_overview", "finance", "list_lines", "line_details", "list_convoys", "convoy_details",
              "list_stations", "station_details", "list_factories", "factory_details", "supply_chain", "list_cities",
              "recent_messages", "map_area", "tile_info", "catalog", "estimate", "plan_way", "depot_info")
SPECIALIST_TOOLS = ("ask_user", "ask_coordinator")
COORDINATOR_TOOLS = ("game_overview", "finance", "list_lines", "list_convoys", "list_stations", "list_factories",
                     "list_cities", "recent_messages", "delegate", "list_tasks", "close_task", "ask_user")
ACCOUNTANT_TOOLS = ("game_overview", "finance", "list_lines", "line_details", "list_convoys", "convoy_details",
                    "list_stations", "station_details", "catalog", "estimate", "recent_messages", "depot_info")

# ordered: the coordinator first, the order of the agent list in /api/team/state
AGENTS = [
    {"id": "coordinator", "model": PRO, "max_tokens": 8192, "tools": COORDINATOR_TOOLS},
    {"id": "analyst", "model": PRO, "max_tokens": 16384, "tools": READ_TOOLS + SPECIALIST_TOOLS},
    {"id": "accountant", "model": FLASH, "max_tokens": 8192, "tools": ACCOUNTANT_TOOLS + SPECIALIST_TOOLS},
    {"id": "designer", "model": PRO, "max_tokens": 16384, "tools": READ_TOOLS + ("propose_project",) + SPECIALIST_TOOLS},
    {"id": "engineer", "model": FLASH, "max_tokens": 8192, "tools": READ_TOOLS + ("propose_project",) + SPECIALIST_TOOLS},
    {"id": "logistician", "model": FLASH, "max_tokens": 8192,
     "tools": READ_TOOLS + ("propose_project",) + SPECIALIST_TOOLS},
    {"id": "dispatcher", "model": FLASH, "max_tokens": 8192,
     "tools": READ_TOOLS + ("propose_project",) + SPECIALIST_TOOLS},
    {"id": "fleet_manager", "model": FLASH, "max_tokens": 8192,
     "tools": READ_TOOLS + ("propose_project",) + SPECIALIST_TOOLS},
]

AGENT_IDS = tuple(a["id"] for a in AGENTS)
SPECIALISTS = tuple(a for a in AGENT_IDS if a != "coordinator")
MIN_TOKENS, MAX_TOKENS = 1024, 65536

# project operation types per role, used when team/projects.py is not there (contract R2, "Projects"); the real
# table is projects.ROLE_OPS
_INFRA = frozenset(("build_way", "build_station", "build_depot", "build_roadsign", "build_wayobj", "remove",
                    "remove_way"))
FALLBACK_ROLE_OPS = {
    "designer": _INFRA,
    "engineer": _INFRA,
    "logistician": frozenset(("create_line", "set_line_schedule", "delete_line", "buy_convoy", "assign_line")),
    "dispatcher": frozenset(("buy_convoy", "assign_line", "withdraw", "set_line_schedule")),
    "fleet_manager": frozenset(("buy_convoy", "replace_convoy", "sell", "withdraw")),
    "analyst": frozenset(), "accountant": frozenset(), "coordinator": frozenset(),
}

PROMPT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts")
_prompt_lock = threading.Lock()
_prompt_cache = {}


def get(agent_id):
    """The registry entry of an agent id, or None."""
    for a in AGENTS:
        if a["id"] == agent_id:
            return a
    return None


def is_agent(agent_id):
    return isinstance(agent_id, str) and agent_id in AGENT_IDS


def projects_module():
    """team.projects when it is there (round R2, workstream C2), else None."""
    try:
        from . import projects
    except ImportError:
        return None
    except Exception:  # a broken module must not take the runtime down: the agents then propose nothing
        return None
    return projects


def role_ops(agent_id):
    """frozenset of the project operation types the agent may propose."""
    p = projects_module()
    table = getattr(p, "ROLE_OPS", None) if p is not None else None
    if isinstance(table, dict):
        return frozenset(table.get(agent_id) or ())
    return FALLBACK_ROLE_OPS.get(agent_id, frozenset())


def tools_of(agent_id):
    """Names of the tools of an agent (propose_project only while it has operation types)."""
    a = get(agent_id)
    if a is None:
        return ()
    return tuple(t for t in a["tools"] if t != "propose_project" or role_ops(agent_id))


def model_for(agent_id, db=None):
    """The model of an agent: settings model_<agent> when set and well-formed, else the default."""
    a = get(agent_id)
    if a is None:
        raise ValueError("unknown agent %r" % (agent_id,))
    if db is not None:
        try:
            v = db.get_setting("model_" + agent_id)
        except Exception:
            v = None
        if isinstance(v, str) and MODEL_NAME.match(v.strip()):
            return v.strip()
    return a["model"]


def max_tokens_for(agent_id, db=None):
    a = get(agent_id)
    if a is None:
        raise ValueError("unknown agent %r" % (agent_id,))
    if db is not None:
        try:
            v = int(db.get_setting("max_tokens_" + agent_id) or 0)
        except Exception:  # not a number, or the database failed: the default
            v = 0
        if MIN_TOKENS <= v <= MAX_TOKENS:
            return v
    return a["max_tokens"]


def _read_prompt(name):
    with _prompt_lock:
        text = _prompt_cache.get(name)
        if text is None:
            with open(os.path.join(PROMPT_DIR, name + ".md"), encoding="utf-8") as f:
                text = f.read()
            _prompt_cache[name] = text
        return text


def system_prompt(agent_id, company, limits):
    """The system prompt of an agent working for company number `company`. limits: {"tool_calls", "depth",
    "questions"}. Stable for an agent and company (DeepSeek caches the common prefix of requests)."""
    if get(agent_id) is None:
        raise ValueError("unknown agent %r" % (agent_id,))
    ops = sorted(role_ops(agent_id))
    values = {
        "agent": agent_id,
        "company": str(int(company)),
        "ops": ", ".join(ops) if ops else "none (you cannot propose changes)",
        "tool_calls": str(limits.get("tool_calls", 25)),
        "depth": str(limits.get("depth", 3)),
        "specialists": ", ".join(SPECIALISTS),
    }
    text = _read_prompt("base").rstrip() + "\n\n" + _read_prompt(agent_id).rstrip() + "\n"
    return re.sub(r"\{\{(\w+)\}\}", lambda m: values.get(m.group(1), m.group(0)), text)
