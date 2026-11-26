"""
Browser test of the Team tab (AI team) of the dashboard: Playwright for Python with headless Edge against the fake engine
and the bridge with a seeded team database (company 0 and some rows of company 2). Not part of the unittest discovery;
run it explicitly from the repository root:

    python tools/dashboard/tests/e2e_team.py [--shots DIR] [--keep]

The agent runtime may still be a stub (the team state says enabled=false, actions answer 503): the enabled path mocks
GET /api/team/state and the POST actions with page routes and injects team events through the bridge's hidden test
route POST /api/team/test_publish (--test-team). Ports: bridge 13387 (13388 for the markup run), fake engine 13394
(never the user's game on 13360). Screenshots (desktop and phone, light and dark) go to --shots (default: the system's
temporary directory). Exit code 0 when every check passed.
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import teamtestlib as tl  # noqa: E402  (also puts tools/dashboard on sys.path for `team`)
from team.db import TeamDB  # noqa: E402

BRIDGE_PORT = 13387
BRIDGE_PORT_MARKUP = 13388
ENGINE_PORT = 13394
ENV = {"DEEPSEEK_API_KEY": "fake-key", "DEEPSEEK_BASE_URL": "http://127.0.0.1:1"}
INIT = ("window.__csp=[];document.addEventListener('securitypolicyviolation',"
        "e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));"
        "try{localStorage.setItem('sdash.lang','LANG');}catch(e){}")
XSS_TEXT = ('<img src=x onerror="window.__xss=(window.__xss||0)+1"><script>window.__xss=2</script>'
            ' **pogrubione** [klik](javascript:alert(1)) <b onmouseover="window.__xss=3">b</b>')

results, problems = [], []


def norm(s):
    """Text without any spaces (Polish numbers group with no-break spaces)."""
    return re.sub(r"[\s  ]", "", s or "")


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(detail)[:900]), flush=True)
    if not cond:
        problems.append(name)
    return cond


# --- database ------------------------------------------------------------------------------------------------------

def seed(path):
    """Seeds the team database; returns the tokens and ids the checks use."""
    db = TeamDB(path)
    ids = {}
    ids["p1"], ids["tok_player"] = db.add_token("player", 0, "Gracz Ania")
    ids["p2"], ids["tok_player2"] = db.add_token("player", 0, "Gracz Bartek")
    ids["viewer"], ids["tok_viewer"] = db.add_token("viewer", None, "Widz")
    ids["c2"], ids["tok_c2"] = db.add_token("player", 2, "Firma druga")
    conv = {a: db.main_conversation(0, a) for a in ("coordinator", "analyst", "accountant", "designer", "engineer",
                                                   "logistician", "dispatcher", "fleet_manager")}
    # coordinator: 63 messages (two pages), the last ones with markdown, tools and a task of the coordinator
    for i in range(60):
        if i % 2 == 0:
            db.add_message(0, conv["coordinator"], "user", "Pytanie numer %d" % i,
                           author_token_id=ids["p1"] if i % 4 == 0 else ids["p2"])
        else:
            db.add_message(0, conv["coordinator"], "assistant", "Odpowiedź **%d**" % i)
    db.add_message(0, conv["coordinator"], "user", "Jak wygląda sieć linii? Pokaż tabelę.", author_token_id=ids["p1"])
    db.add_message(0, conv["coordinator"], "tool", "{\"lines\": 8}", tool_call_id="call_x",
                   meta={"summary": "lines_summary: 8 linii"})
    db.add_message(0, conv["coordinator"], "assistant",
                   "**Plan** dla sieci:\n\n- linia *A* — `101`\n- linia B\n  - odnoga B1\n\n1. pierwszy krok\n2. drugi krok\n\n"
                   "```\nkod: 1 < 2 && 3 > 2\n```\n\n| Linia | Zysk |\n|---|---:|\n| 101 | 1 200 |\n| 102 | -300 |\n\n"
                   "> cytat analityka\n\nWięcej: [dokumentacja](https://example.com/doc)",
                   meta={"tools": [{"name": "lines_summary", "summary": "8 linii"}, {"name": "finance", "summary": "rok 1950"}]})
    ids["coord_msgs"] = 63

    # analyst: choice (single, with descriptions), number with a range, text
    r_an = db.create_run(0, "analyst", conv["analyst"], state="waiting")
    db.add_message(0, conv["analyst"], "user", "Zaproponuj rozbudowę.", author_token_id=ids["p2"])
    ids["q_an"] = db.create_question(0, "analyst", r_an, conv["analyst"], {"tool_call_id": "call_an", "questions": [
        {"id": "q1", "type": "choice", "header": "Budżet", "text": "Ile **chcesz** wydać?", "multi": False,
         "allow_other": True, "options": [{"label": "Mało", "description": "do 100 000"},
                                          {"label": "Średnio", "description": "do 500 000"},
                                          {"label": "Dużo", "description": "bez limitu"}]},
        {"id": "q2", "type": "number", "header": "Linie", "text": "Ile nowych linii?", "min": 1, "max": 10},
        {"id": "q3", "type": "text", "header": "Uwagi", "text": "Coś jeszcze?"}]})
    db.add_message(0, conv["analyst"], "assistant", "Mam kilka pytań, zanim przygotuję scenariusze.",
                   meta={"question_id": ids["q_an"]})

    # designer: a working task, map questions (tile, A-B, area), a proposed project and a done one
    r_de = db.create_run(0, "designer", conv["designer"], state="waiting")
    ids["t_de"] = db.create_task(0, "coordinator", "designer", "Zaprojektuj połączenie Springfield–Capital",
                                 "Droga i przystanki", run_id=r_de, state="working")
    db.add_message(0, conv["designer"], "user", "Zaprojektuj połączenie Springfield–Capital", meta={"task_id": ids["t_de"],
                                                                                                 "from": "coordinator"})
    ids["q_de"] = db.create_question(0, "designer", r_de, conv["designer"], {"tool_call_id": "call_de", "questions": [
        {"id": "m1", "type": "map", "mode": "tile", "header": "Zajezdnia", "text": "Gdzie postawić zajezdnię?"},
        {"id": "m2", "type": "map", "mode": "ab", "header": "Trasa", "text": "Skąd dokąd ma biec droga?"},
        {"id": "m3", "type": "map", "mode": "area", "header": "Obszar", "text": "Jaki obszar obsłużyć?"}]})
    db.add_message(0, conv["designer"], "assistant", "Wskaż proszę miejsca na mapie.", meta={"question_id": ids["q_de"]})
    way = [[x, 30, 0] for x in range(20, 61)]
    ids["proj1"] = db.create_project(
        0, "designer", "Droga Springfield–Capital z przystankiem",
        "Nowa droga skraca dojazd o **12 pól**; przystanek przy ratuszu.",
        [{"type": "build_way", "from": [20, 30], "to": [60, 30], "way": "fake_road", "bridge": True},
         {"type": "build_station", "at": [60, 30], "building": "FakeStop"},
         {"type": "build_depot", "at": [20, 31], "building": "FakeRoadDepot"},
         {"type": "build_roadsign", "at": [40, 30], "sign": "fake_oneway"},
         {"type": "remove", "at": [45, 35]}],
        estimate={"total": 41500, "cash": 1000000, "cash_after": 958500, "maintenance_month": 905,
                  "items": [{"op": 0, "label": "fake_road x41", "cost": 20500}, {"op": 1, "label": "FakeStop", "cost": 3000},
                            {"op": 2, "label": "FakeRoadDepot", "cost": 6000}, {"op": 3, "label": "fake_oneway", "cost": 300},
                            {"op": 4, "label": "remove", "cost": 11700}],
                  "warnings": ["Na 40,30 potrzebny most (rzeka)."]},
        preview={"bbox": [20, 29, 60, 36], "items": [
            {"op": 0, "kind": "way", "waytype": "road", "tiles": way, "label": "fake_road"},
            {"op": 0, "kind": "bridge", "waytype": "road", "tiles": [[39, 30, 0], [40, 30, 0], [41, 30, 0]], "label": "bridge"},
            {"op": 1, "kind": "station", "tiles": [[60, 30, 0]], "label": "FakeStop"},
            {"op": 2, "kind": "depot", "tiles": [[20, 31, 0]], "label": "FakeRoadDepot"},
            {"op": 3, "kind": "roadsign", "tiles": [[40, 30, 0]], "label": "fake_oneway"},
            {"op": 4, "kind": "remove", "tiles": [[45, 35, 0]], "label": "remove"}]})
    db.add_message(0, conv["designer"], "tool", "{\"project_id\": %d}" % ids["proj1"], tool_call_id="call_p1",
                   meta={"project_id": ids["proj1"], "summary": "propose_project: projekt #%d" % ids["proj1"]})
    db.add_message(0, conv["designer"], "system_note", "Projekt #%d czeka na decyzję." % ids["proj1"],
                   meta={"project_id": ids["proj1"]})
    ids["proj2"] = db.create_project(
        0, "designer", "Przystanek przy elektrowni", "Obsługa pracowników.",
        [{"type": "build_station", "at": [30, 41], "building": "FakeStop"}],
        estimate={"total": 3000, "cash": 1000000, "cash_after": 997000, "maintenance_month": 40,
                  "items": [{"op": 0, "label": "FakeStop", "cost": 3000}], "warnings": []},
        preview={"bbox": [30, 41, 30, 41], "items": [{"op": 0, "kind": "station", "tiles": [[30, 41, 0]]}]}, state="done")
    db.update_project(0, ids["proj2"], report={"ops": [{"op": 0, "type": "build_station", "state": "done", "cost": 3100}],
                                                "actual_cost": 3100, "estimate": 3000}, approved_by=ids["p2"])
    db.add_message(0, conv["designer"], "system_note", "Projekt #%d zrealizowany." % ids["proj2"],
                   meta={"project_id": ids["proj2"]})

    # engineer: a failed project with a report
    ids["proj3"] = db.create_project(
        0, "engineer", "Bocznica do kopalni", "Węgiel koleją.",
        [{"type": "build_way", "from": [10, 20], "to": [10, 26], "way": "fake_track"},
         {"type": "build_station", "at": [10, 26], "building": "FakeStop"},
         {"type": "build_depot", "at": [11, 26], "building": "FakeTrainDepot"}],
        estimate={"total": 9000, "cash": 10000, "cash_after": 1000, "maintenance_month": 300, "items": [], "warnings": []},
        preview={"bbox": [10, 20, 11, 26], "items": [{"op": 0, "kind": "way", "tiles": [[10, y, 0] for y in range(20, 27)]}]},
        state="failed")
    db.update_project(0, ids["proj3"], approved_by=ids["p1"], report={
        "ops": [{"op": 0, "type": "build_way", "state": "done", "cost": 1000},
                {"op": 1, "type": "build_station", "state": "failed", "error": "Insufficient funds"},
                {"op": 2, "type": "build_depot", "state": "skipped"}],
        "actual_cost": 1000, "estimate": 9000, "stopped": "op 1 failed"})
    db.add_message(0, conv["engineer"], "system_note", "Projekt #%d przerwany: brak środków." % ids["proj3"],
                   meta={"project_id": ids["proj3"]})

    # logistician: object questions (line, station) and a multiple choice; a proposed line project
    r_lo = db.create_run(0, "logistician", conv["logistician"], state="waiting")
    ids["q_lo"] = db.create_question(0, "logistician", r_lo, conv["logistician"], {"tool_call_id": "call_lo", "questions": [
        {"id": "o1", "type": "object", "kind": "line", "header": "Linia", "text": "Którą linię zmienić?"},
        {"id": "o2", "type": "object", "kind": "station", "header": "Przystanek", "text": "Na którym przystanku?"},
        {"id": "c1", "type": "choice", "multi": True, "header": "Pory", "text": "Kiedy kursy?",
         "options": [{"label": "Rano", "description": "6–9"}, {"label": "Wieczorem"}]}]})
    db.add_message(0, conv["logistician"], "assistant", "Którą linię i przystanek mam zmienić?",
                   meta={"question_id": ids["q_lo"]})
    ids["proj4"] = db.create_project(
        0, "logistician", "Linia ekspresowa", "Szybkie połączenie z przesiadką.",
        [{"type": "create_line", "ref": "ex", "waytype": "road", "name": "Ekspres",
          "stops": [{"at": [20, 30], "load": 50, "wait": 2}, {"at": [60, 30]}, {"at": [60, 60]}]},
         {"type": "buy_convoy", "depot": [20, 31], "vehicles": ["Fake bus", "Mail trailer"], "count": 2, "line": "$ex"},
         {"type": "assign_line", "convoy": 7, "line": "$ex"}],
        estimate={"total": 66000, "cash": 1000000, "cash_after": 934000, "maintenance_month": 160, "items": [], "warnings": []},
        preview={"bbox": [20, 30, 60, 60], "items": [
            {"op": 0, "kind": "line", "tiles": [[20, 30, 0], [60, 30, 0], [60, 60, 0]]},
            {"op": 1, "kind": "convoy", "tiles": [[20, 31, 0]]}]})
    db.add_message(0, conv["logistician"], "tool", "{}", tool_call_id="call_p4",
                   meta={"project_id": ids["proj4"], "summary": "propose_project: projekt #%d" % ids["proj4"]})

    # dispatcher: a question to dismiss; fleet manager: an answered question
    r_di = db.create_run(0, "dispatcher", conv["dispatcher"], state="waiting")
    ids["q_di"] = db.create_question(0, "dispatcher", r_di, conv["dispatcher"], {"tool_call_id": "call_di", "questions": [
        {"id": "d1", "type": "choice", "text": "Wycofać stare autobusy?", "options": [{"label": "Tak"}, {"label": "Nie"}],
         "allow_other": False}]})
    db.add_message(0, conv["dispatcher"], "assistant", "Pytanie o flotę.", meta={"question_id": ids["q_di"]})
    r_fl = db.create_run(0, "fleet_manager", conv["fleet_manager"], state="done")
    ids["q_fl"] = db.create_question(0, "fleet_manager", r_fl, conv["fleet_manager"], {"tool_call_id": "call_fl", "questions": [
        {"id": "f1", "type": "choice", "text": "Kupić nowe autobusy?", "options": [{"label": "Tak"}, {"label": "Nie"}]}]})
    db.add_message(0, conv["fleet_manager"], "user", "Odnów flotę.", author_token_id=ids["p2"])
    db.add_message(0, conv["fleet_manager"], "assistant", "Zanim kupię:", meta={"question_id": ids["q_fl"]})
    db.answer_question(0, ids["q_fl"], {"f1": "Tak"}, ids["p2"])

    # accountant: model text with markup (must stay text); a rejected project with markup in the title
    db.add_message(0, conv["accountant"], "assistant", XSS_TEXT)
    ids["proj5"] = db.create_project(0, "designer", '<img src=x onerror="window.__xss=5">Odrzucony', XSS_TEXT,
                                     [{"type": "remove", "at": [1, 1]}], state="rejected")

    # tasks of the coordinator
    ids["t_an"] = db.create_task(0, "coordinator", "analyst", "Analiza zysków linii", state="done")
    db.update_task(0, ids["t_an"], result="**Zysk** wzrósł o 5%.")
    ids["t_lo"] = db.create_task(0, "coordinator", "logistician", "Nowa linia ekspresowa", run_id=r_lo, state="waiting")
    ids["t_fl"] = db.create_task(0, "coordinator", "fleet_manager", "Przegląd floty", state="cancelled")
    ids["t_open"] = db.create_task(0, "coordinator", "dispatcher", "Sprawdź korki w Shelbyville", state="open")

    # company 2: nothing of it may reach company 0
    c2 = db.main_conversation(2, "coordinator")
    db.add_message(2, c2, "user", "SECRET-COMPANY-2 wiadomość", author_token_id=ids["c2"])
    ids["proj_c2"] = db.create_project(2, "designer", "SECRET-COMPANY-2 projekt", "x", [], state="proposed")
    r_c2 = db.create_run(2, "designer", c2, state="waiting")
    db.create_question(2, "designer", r_c2, c2, {"questions": [{"id": "x", "type": "text", "text": "SECRET-COMPANY-2 pytanie"}]})
    db.create_task(2, "coordinator", "designer", "SECRET-COMPANY-2 zadanie")
    db.close()
    return ids


# --- browser helpers -------------------------------------------------------------------------------------------------

class Page:
    def __init__(self, browser, port, token, viewport=(1366, 860), lang="pl", scheme="light", hash_="", routes=None):
        self.ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, locale="pl-PL",
                                       color_scheme=scheme)
        self.ctx.add_init_script(INIT.replace("LANG", lang))
        if routes:
            routes(self.ctx)
        self.page = self.ctx.new_page()
        self.port = port
        self.console = []
        self.bad = []  # HTTP responses >= 400
        # (the sign-in page has no icon: the browser's own request of /favicon.ico gets a 404, not a fault of the page)
        self.page.on("console", lambda m: self.console.append("%s: %s" % (m.type, m.text))
                     if m.type in ("error", "warning") and "favicon.ico" not in (m.location or {}).get("url", "") else None)
        self.page.on("pageerror", lambda e: self.console.append("pageerror: %s" % e))
        self.page.on("response", lambda r: self.bad.append("%d %s" % (r.status, r.url)) if r.status >= 400 else None)
        # the token link signs in with a page that goes on to / (a meta refresh: a #hash of the link is not kept), so a
        # deep link is opened after signing in
        self.page.goto("http://127.0.0.1:%d/?token=%s" % (port, token))
        self.ready()
        if hash_:
            self.page.goto("about:blank")
            self.page.goto("http://127.0.0.1:%d/%s" % (port, hash_))
            self.ready()

    def ready(self):
        self.page.wait_for_function("() => window.__dash && window.__dash.S.session && window.__dash.S.poll && window.__dash.S.poll.world",
                                    timeout=30000)

    def js(self, expr, arg=None):
        return self.page.evaluate(expr, arg)

    def wait(self, expr, timeout=15.0, arg=None):
        end = time.time() + timeout
        while time.time() < end:
            try:
                v = self.page.evaluate(expr, arg)
            except Exception:  # navigation in progress
                v = None
            if v:
                return v
            self.page.wait_for_timeout(100)
        return None

    def publish(self, name, data):
        return self.js("""async ([n, d]) => {
            const r = await fetch('/api/team/test_publish', {method: 'POST', credentials: 'same-origin',
                headers: {'Content-Type': 'application/json', 'X-Dashboard': '1'}, body: JSON.stringify({name: n, data: d})});
            return r.status;
        }""", [name, data])

    def tab_team(self):
        self.page.locator("nav.tabs button.tab-team").click()
        self.wait("() => !!document.querySelector('.team')")

    def agent(self, a):
        self.page.locator(".team-agent[data-agent=%s]" % a).click()
        self.wait("(a) => window.__dash.S.ui.teamAgent === a && window.__team.chats.get(a) && window.__team.chats.get(a).loaded", arg=a)
        self.page.wait_for_timeout(150)

    def text(self, sel):
        loc = self.page.locator(sel)
        return loc.first.inner_text() if loc.count() else ""

    def tile_point(self, x, y, zoom=2):
        """Centres the 2D map on square (x, y) and returns the client point of its centre (the map was hidden behind
        another tab a moment ago: its size is read again first)."""
        self.page.wait_for_timeout(150)
        self.js("""([x, y, z]) => {
            const m = window.__dash.mapCtl.map;
            m.invalidateSize({pan: false});
            m.setView(L.latLng(-(y + 0.5), x + 0.5), z, {animate: false});
        }""", [x, y, zoom])
        return self.point_of(x, y)

    def point_of(self, x, y):
        """Client point of the centre of square (x, y) once the map stands still (two equal readings)."""
        last = None
        for _ in range(20):
            self.page.wait_for_timeout(120)
            pt = self.js("""([x, y]) => {
                const m = window.__dash.mapCtl.map;
                m.invalidateSize({pan: false});
                const p = m.latLngToContainerPoint(L.latLng(-(y + 0.5), x + 0.5));
                const r = m.getContainer().getBoundingClientRect();
                return [Math.round(r.left + p.x), Math.round(r.top + p.y)];
            }""", [x, y])
            if pt == last:
                return pt
            last = pt
        return last

    def shot(self, path):
        self.page.wait_for_timeout(250)
        self.page.screenshot(path=path)

    def errors(self):
        out = [c for c in self.console if c.startswith(("error", "pageerror"))]
        return out + (["HTTP " + b for b in self.bad] if out else [])

    def close(self):
        self.ctx.close()


class Mocks:
    """Routes of a browser context: the team state (enabled, or a reason) and the POST actions (recorded)."""

    def __init__(self):
        self.calls = []
        self.reason = None
        self.send_reply = {"message_id": 990001, "run_id": 777}

    def install(self, ctx):
        def state(route):
            resp = route.fetch()
            body = resp.json()
            if self.reason:
                body["enabled"] = False
                body["reason"] = self.reason
            else:
                body["enabled"] = True
                body.pop("reason", None)
            route.fulfill(response=resp, json=body)

        def action(route):
            req = route.request
            name = req.url.rsplit("/", 1)[1]
            try:
                body = req.post_data_json
            except Exception:
                body = None
            self.calls.append((name, body))
            if name == "send":
                reply = dict(self.send_reply)
            else:
                key = {"cancel": "run_id", "answer": "question_id", "approve": "project_id", "reject": "project_id"}[name]
                reply = {key: (body or {}).get(key), "accepted": True}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(reply))

        ctx.route("**/api/team/state", state)
        for n in ("send", "cancel", "answer", "approve", "reject"):
            ctx.route("**/api/team/" + n, action)

    def last(self, name):
        for n, b in reversed(self.calls):
            if n == name:
                return b
        return None


# --- the checks ------------------------------------------------------------------------------------------------------

def run_viewer(browser, ids):
    p = Page(browser, BRIDGE_PORT, ids["tok_viewer"], hash_="#team/coordinator")
    try:
        p.page.wait_for_timeout(800)
        check("viewer: no Team tab", p.page.locator("nav.tabs button.tab-team").count() == 0)
        check("viewer: session team false", p.js("() => window.__dash.S.session.team") is False)
        check("viewer: deep link #team stays on the map", p.js("() => window.__dash.S.ui.tab") == "map",
              p.js("() => window.__dash.S.ui.tab"))
        check("viewer: no team stream", p.js("() => window.__team.sse") == "idle", p.js("() => window.__team.sse"))
        check("viewer: no console errors", not p.errors(), p.errors())
    finally:
        p.close()


def run_disabled(browser, ids, shots):
    """Player while the agents cannot work (state mocked to the reason runtime_unavailable, whatever the runtime of the
    bridge says now): history, questions and projects are readable, the input is off and a banner tells why."""
    m = Mocks()
    m.reason = "runtime_unavailable"
    p = Page(browser, BRIDGE_PORT, ids["tok_player"], routes=m.install)
    try:
        check("player: Team tab shown", p.page.locator("nav.tabs button.tab-team").count() == 1)
        check("player: tab badge counts pending questions",
              p.wait("() => { const b = document.querySelector('.tab-team .tab-badge'); return b && b.textContent.trim(); }") == "4",
              p.js("() => { const b = document.querySelector('.tab-team .tab-badge'); return b && b.textContent; }"))
        p.tab_team()
        check("team: state loaded", p.wait("() => window.__team.loaded && window.__team.state"))
        check("team: team stream open", p.wait("() => window.__team.sse === 'open'"), p.js("() => window.__team.sse"))
        check("team: 8 agents listed", p.page.locator(".team-agent").count() == 8)
        names = p.page.locator(".team-agent-name").all_inner_texts()
        check("team: Polish agent names", names == ["Koordynator", "Analityk", "Księgowy", "Projektant", "Inżynier",
                                                    "Logistyk", "Dyspozytor", "Kierownik floty"], names)
        check("team: pending question badges", p.page.locator(".team-agent[data-agent=analyst] .qbadge").count() == 1
              and p.page.locator(".team-agent[data-agent=coordinator] .qbadge").count() == 0)
        banner = p.text(".team-banner")
        check("disabled: banner with reason runtime_unavailable", "nie są jeszcze dostępni" in banner, banner)
        check("disabled: input disabled", p.js("() => document.querySelector('.team-text').disabled") is True)
        check("disabled: send disabled", p.js("() => document.querySelector('.team-send').disabled") is True)
        # history + load older
        p.wait("() => window.__team.chats.get('coordinator') && window.__team.chats.get('coordinator').loaded")
        n1 = p.page.locator(".tmsgs > .tmsg").count()
        check("chat: first page of 50 messages", n1 == 50, n1)
        check("chat: load older button", p.page.locator(".team-load-older").count() == 1)
        p.page.locator(".team-load-older").click()
        check("chat: all messages after load older", p.wait("(n) => document.querySelectorAll('.tmsgs > .tmsg').length === n",
                                                             arg=ids["coord_msgs"]),
              p.page.locator(".tmsgs > .tmsg").count())
        check("chat: no load older at the start", p.page.locator(".team-load-older").count() == 0)
        authors = p.page.locator(".tmsg.user .tmsg-author").all_inner_texts()
        check("chat: author labels of user messages", "Gracz Ania" in authors and "Gracz Bartek" in authors, authors[:4])
        md = p.page.locator(".tmsg.assistant").last
        check("markdown: bold, list, nested list, ordered, code, table, quote",
              md.locator("strong").count() >= 1 and md.locator("ul ul li").count() == 1 and md.locator("ol li").count() == 2
              and md.locator("pre code").count() == 1 and md.locator("table.md-table td").count() == 4
              and md.locator("blockquote").count() == 1 and md.locator(".md-code").count() == 1,
              md.inner_html()[:600])
        check("markdown: links as plain text", md.locator("a").count() == 0 and "https://example.com/doc" in md.inner_text())
        check("chat: tool chips", md.locator(".tool-chip").count() == 2)
        check("chat: tool message summarised", "lines_summary: 8 linii" in p.text(".tmsg.tool"))
        check("isolation: nothing of company 2", "SECRET-COMPANY-2" not in p.page.content()
              and not p.js("(id) => window.__team.projects.has(id)", ids["proj_c2"]))
        check("disabled: no console errors", not p.errors(), p.errors())
        p.shot(os.path.join(shots, "team-disabled-desktop-light.png"))
    finally:
        p.close()


def run_enabled(browser, ids, shots):
    m = Mocks()
    p = Page(browser, BRIDGE_PORT, ids["tok_player"], routes=m.install)
    try:
        p.tab_team()
        check("enabled: state enabled (mocked)", p.wait("() => window.__team.state && window.__team.state.enabled === true"))
        check("enabled: no banner", p.page.locator(".team-banner").count() == 0)
        p.wait("() => window.__team.chats.get('coordinator') && window.__team.chats.get('coordinator').loaded")
        check("enabled: input enabled", p.js("() => document.querySelector('.team-text').disabled") is False)
        # usage counter
        usage = p.text(".team-usage")
        check("usage: counter shown", "$0" in usage or "0,00" in usage, usage)
        check("usage: reset time in the tooltip", "zeruje" in (p.page.locator(".team-usage").get_attribute("title") or ""))

        # streaming
        st = p.publish("team_run", {"run": 501, "agent": "coordinator", "state": "running", "phase": "thinking"})
        check("events: test_publish accepted", st == 200, st)
        check("stream: phase shown", p.wait("() => (document.querySelector('.team-run') || {}).textContent === 'myśli…'"),
              p.text(".team-run"))
        for piece in ("Analizuję ", "sieć ", "**linii**…"):
            p.publish("team_delta", {"agent": "coordinator", "run": 501, "text": piece, "reasoning": False})
        check("stream: streaming bubble text", p.wait("() => { const b = document.querySelector('.tmsg.streaming .tmsg-bubble');"
                                                       " return b && b.textContent.includes('Analizuję sieć linii'); }"),
              p.text(".tmsg.streaming"))
        check("stream: markdown while streaming", p.page.locator(".tmsg.streaming strong").count() == 1)
        check("stream: phase writing", p.wait("() => (document.querySelector('.team-run') || {}).textContent === 'pisze…'"))
        p.publish("team_tool", {"agent": "coordinator", "run": 501, "name": "lines_summary", "summary": "8 linii, 3 stratne"})
        check("stream: tool chip", p.wait("() => !!document.querySelector('.tmsg.streaming .tool-chip')"))
        p.publish("team_message", {"agent": "coordinator", "message": {"id": 990100, "role": "assistant",
                                                                       "content": "Gotowe: **8 linii**, 3 stratne.", "author": None,
                                                                       "created": "2026-11-26T12:00:00Z",
                                                                       "tools": [{"name": "lines_summary", "summary": "8 linii"}]}})
        check("stream: final message replaces the stream text",
              p.wait("() => { const ms = document.querySelectorAll('.tmsg[data-msg=\"990100\"]'); const s = document.querySelector('.tmsg.streaming .tmsg-bubble');"
                     " return ms.length === 1 && !s; }"))
        p.publish("team_run", {"run": 501, "agent": "coordinator", "state": "done"})
        check("stream: bubble gone after done", p.wait("() => !document.querySelector('.tmsg.streaming')"))
        check("stream: run state done", p.wait("() => (document.querySelector('.team-run') || {}).textContent === 'gotowe'"))

        # send: Shift+Enter makes a new line, Enter sends; cancel while the run is active
        box = p.page.locator(".team-text")
        box.click()
        p.page.keyboard.type("Linia pierwsza")
        p.page.keyboard.press("Shift+Enter")
        p.page.keyboard.type("Linia druga")
        check("send: Shift+Enter does not send", m.last("send") is None and "\n" in box.input_value(), box.input_value())
        cnt = p.text(".team-count")
        check("send: character counter", cnt.startswith(str(len("Linia pierwsza\nLinia druga"))), cnt)
        p.page.keyboard.press("Enter")
        check("send: Enter sends", p.wait("() => true") and wait_for(lambda: m.last("send") is not None))
        body = m.last("send")
        check("send: body", body == {"agent": "coordinator", "text": "Linia pierwsza\nLinia druga"}, body)
        check("send: input cleared", p.wait("() => document.querySelector('.team-text').value === ''"))
        check("send: run queued + cancel button", p.wait("() => !!document.querySelector('.team-cancel')"))
        p.page.locator(".team-cancel").click()
        check("cancel: POST with the run id", wait_for(lambda: m.last("cancel") == {"run_id": 777}), m.last("cancel"))
        p.publish("team_run", {"run": 777, "agent": "coordinator", "state": "cancelled"})
        check("cancel: button gone", p.wait("() => !document.querySelector('.team-cancel')"))
        check("send: 4000 limit", p.js("() => document.querySelector('.team-text').maxLength") == 4000)

        # unread dot
        p.publish("team_message", {"agent": "analyst", "message": {"id": 990200, "role": "assistant", "content": "Nowe dane.",
                                                                   "author": None, "created": "2026-11-26T12:01:00Z"}})
        check("unread: dot on another agent", p.wait("() => !!document.querySelector('.team-agent[data-agent=analyst] .unread-dot')"))
        check("unread: no dot on the open agent", p.page.locator(".team-agent[data-agent=coordinator] .unread-dot").count() == 0)
        p.shot(os.path.join(shots, "team-chat-desktop-light.png"))

        # questions: choice + number + text (analyst)
        p.agent("analyst")
        check("unread: dot gone when opened", p.page.locator(".team-agent[data-agent=analyst] .unread-dot").count() == 0)
        card = p.page.locator(".qcard[data-question=\"%d\"]" % ids["q_an"])
        check("question: card inline at its message", card.count() == 1 and p.page.locator(".tmsg .qcard").count() >= 1)
        check("question: recommended first", card.locator(".qopt").first.locator(".qrec").count() == 1)
        check("question: descriptions", "do 500 000" in card.inner_text())
        check("question: Other option", card.locator(".qopt.other").count() == 1)
        card.locator(".q-submit").click()
        check("question: validation messages", card.locator(".qerror").count() == 3, card.locator(".qerror").count())
        card.locator(".qopt").nth(1).click()
        card.locator(".qnum").fill("12")
        card.locator(".qtext").fill("Bez kolei")
        card.locator(".q-submit").click()
        check("question: number out of range refused", card.locator(".qerror").count() == 1 and m.last("answer") is None)
        card.locator(".qnum").fill("3")
        card.locator(".q-submit").click()
        check("question: answer sent", wait_for(lambda: m.last("answer") is not None))
        check("question: answer body", m.last("answer") == {"question_id": ids["q_an"], "answer": {"q1": "Średnio", "q2": 3,
                                                                                                    "q3": "Bez kolei"}},
              m.last("answer"))
        check("question: sent state", p.wait("(id) => (document.querySelector('.qcard[data-question=\"' + id + '\"]') || {}).textContent.includes('czekam')",
                                             arg=ids["q_an"]))
        p.publish("team_question", {"question": {"id": ids["q_an"], "agent": "analyst", "run_id": None, "state": "answered",
                                                 "payload": p.js("(id) => window.__team.questions.get(id).payload", ids["q_an"]),
                                                 "answer": {"q1": "Średnio", "q2": 3, "q3": "Bez kolei"}, "answered_by": ids["p1"],
                                                 "created": "2026-11-26T11:00:00Z", "answered": "2026-11-26T12:02:00Z"}})
        check("question: answered card shows answer and who", p.wait(
            "(id) => { const c = document.querySelector('.qcard[data-question=\"' + id + '\"]');"
            " return c && c.classList.contains('st-answered') && c.textContent.includes('Średnio') && c.textContent.includes('Gracz Ania'); }",
            arg=ids["q_an"]), p.text(".qcard[data-question=\"%d\"]" % ids["q_an"]))
        # "Other" with own text
        p.agent("fleet_manager")
        fl = p.page.locator(".qcard[data-question=\"%d\"]" % ids["q_fl"])
        check("question: answered in the history", fl.count() == 1 and "Tak" in fl.inner_text() and "Gracz Bartek" in fl.inner_text(),
              fl.inner_text() if fl.count() else "")

        # map picks (designer): tile, A-B, area cancelled with Escape, area
        p.agent("designer")
        dc = p.page.locator(".qcard[data-question=\"%d\"]" % ids["q_de"])
        check("map question: card", dc.count() == 1 and dc.locator(".q-pick").count() == 3)
        dc.locator(".q-pick").nth(0).click()
        check("map pick: switches to the map", p.wait("() => window.__dash.S.ui.tab === 'map'"))
        check("map pick: hint pill", p.wait("() => !!document.querySelector('.pick-hint')") and "Kliknij pole" in p.text(".pick-hint"),
              p.text(".pick-hint"))
        x, y = p.tile_point(104, 98, 3)
        p.page.wait_for_timeout(200)
        p.page.mouse.click(x, y)
        check("map pick tile: back to the Team tab", p.wait("() => window.__dash.S.ui.tab === 'team'"))
        v = p.wait("(id) => window.__team.drafts.get(id) && window.__team.drafts.get(id).values.m1", arg=ids["q_de"])
        check("map pick tile: value", v == {"x": 104, "y": 98}, v)
        check("map pick tile: value shown on the card", "pole 104,98" in p.text(".qcard[data-question=\"%d\"]" % ids["q_de"]))
        dc.locator(".q-pick").nth(1).click()
        p.wait("() => window.__dash.S.ui.tab === 'map' && !!document.querySelector('.pick-hint')")
        a = p.tile_point(100, 100, 3)
        b = p.point_of(106, 103)
        p.page.wait_for_timeout(200)
        p.page.mouse.click(*a)
        check("map pick ab: hint for point B", p.wait("() => (document.querySelector('.pick-hint') || {}).textContent.includes('punkt B')"),
              p.text(".pick-hint"))
        p.page.mouse.move(*b)
        p.page.wait_for_timeout(100)
        check("map pick ab: A marked while picking", p.js("() => window.__dash.mapCtl.pickInfo().points.length") == 1)
        p.page.mouse.click(*b)
        v = p.wait("(id) => window.__dash.S.ui.tab === 'team' && window.__team.drafts.get(id).values.m2", arg=ids["q_de"])
        check("map pick ab: value", v == {"a": {"x": 100, "y": 100}, "b": {"x": 106, "y": 103}}, v)
        dc.locator(".q-pick").nth(2).click()
        p.wait("() => window.__dash.S.ui.tab === 'map' && !!document.querySelector('.pick-hint')")
        p.page.keyboard.press("Escape")
        check("map pick: Escape cancels and returns", p.wait("() => window.__dash.S.ui.tab === 'team' && !window.__dash.mapCtl.pickInfo()"))
        check("map pick: Escape keeps the value empty", p.js("(id) => window.__team.drafts.get(id).values.m3 === undefined", ids["q_de"]))
        dc.locator(".q-pick").nth(2).click()
        p.wait("() => window.__dash.S.ui.tab === 'map' && !!document.querySelector('.pick-hint')")
        a = p.tile_point(90, 90, 2)
        b = p.point_of(97, 95)
        p.page.wait_for_timeout(200)
        p.page.mouse.click(*a)
        p.page.mouse.click(*b)
        v = p.wait("(id) => window.__dash.S.ui.tab === 'team' && window.__team.drafts.get(id).values.m3", arg=ids["q_de"])
        check("map pick area: value", v == {"x1": 90, "y1": 90, "x2": 97, "y2": 95}, v)
        dc.locator(".q-submit").click()
        check("map question: answer body", wait_for(lambda: (m.last("answer") or {}).get("question_id") == ids["q_de"])
              and m.last("answer")["answer"] == {"m1": {"x": 104, "y": 98}, "m2": {"a": {"x": 100, "y": 100}, "b": {"x": 106, "y": 103}},
                                                  "m3": {"x1": 90, "y1": 90, "x2": 97, "y2": 95}}, m.last("answer"))

        # project card (designer): ops, estimate, approve with confirmation, 2D plan, 3D ghosts
        pc = p.page.locator(".pcard[data-project=\"%d\"]" % ids["proj1"])
        check("project: card in the chat", pc.count() == 1)
        ops = pc.locator(".pops > li").all_inner_texts()
        check("project: readable ops", len(ops) == 5 and "Budowa: fake_road od 20,30 do 60,30" in ops[0]
              and "z mostami" in ops[0] and "Budowa stacji FakeStop na 60,30" in ops[1], ops)
        check("project: estimate figures", "958500" in norm(pc.inner_text()) and "905" in pc.inner_text(), pc.inner_text()[:500])
        check("project: warnings", pc.locator(".pwarn li").count() == 1)
        check("project: compact reference for the later note", p.page.locator(".pref").count() >= 1)
        p.shot(os.path.join(shots, "team-questions-project-desktop-light.png"))
        pc.locator(".p-approve").click()
        check("approve: confirmation step", pc.locator(".pconfirm").count() == 1 and m.last("approve") is None)
        pc.locator(".p-confirm").click()
        check("approve: POST", wait_for(lambda: m.last("approve") == {"project_id": ids["proj1"]}), m.last("approve"))
        check("approve: sent state", p.wait("(id) => (document.querySelector('.pcard[data-project=\"' + id + '\"]') || {}).textContent.includes('czekam na zespół')",
                                            arg=ids["proj1"]))
        proj = p.js("(id) => window.__team.projects.get(id)", ids["proj1"])
        proj = dict(proj, state="running")
        p.publish("team_project", {"project": proj})
        check("project: state badge follows the event", p.wait(
            "(id) => (document.querySelector('.pcard[data-project=\"' + id + '\"] .team-st') || {}).textContent === 'w realizacji'", arg=ids["proj1"]))
        rep = dict(proj, state="done", report={"ops": [{"op": i, "type": "x", "state": "done", "cost": 100} for i in range(4)]
                   + [{"op": 4, "type": "remove", "state": "failed", "error": "not owner"}], "actual_cost": 42000, "estimate": 41500})
        p.publish("team_project", {"project": rep})
        check("project: report per op", p.wait("(id) => document.querySelectorAll('.pcard[data-project=\"' + id + '\"] .pops li.op-done').length === 4",
                                               arg=ids["proj1"]) and "not owner" in pc.inner_text() and "42000" in norm(pc.inner_text()),
              pc.inner_text()[-400:])
        pc.locator("button", has_text="Pokaż na mapie").click()
        check("plan 2D: on the map", p.wait("(id) => window.__dash.S.ui.tab === 'map' && window.__dash.mapCtl.planInfo().id === id", arg=ids["proj1"]))
        info = p.wait("() => { const i = window.__dash.mapCtl.planInfo(); return i.drawn > 0 ? i : null; }")
        check("plan 2D: all items drawn", info and info["drawn"] == info["items"] == 6, info)
        check("plan 2D: badge", "Plan: Droga" in p.text(".plan-badge"))
        px = p.js("""() => { const c = document.querySelector('.leaflet-plan-pane canvas'); if (!c) return -1;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
            for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) n++; } return n; }""")
        check("plan 2D: pixels painted", px > 500, px)
        p.shot(os.path.join(shots, "plan-2d-desktop-light.png"))
        p.page.locator(".plan-badge .plan-clear").click()
        check("plan 2D: cleared", p.wait("() => window.__dash.mapCtl.planInfo().id === null && !document.querySelector('.plan-badge')"))
        p.tab_team()
        p.page.locator(".pcard[data-project=\"%d\"] button" % ids["proj1"], has_text="Pokaż w 3D").click()
        check("plan 3D: 3D tab", p.wait("() => window.__dash.S.ui.tab === 'view3d'"))
        g = p.wait("() => window.__view3d && window.__view3d.ghosts && window.__view3d.ghosts().boxes > 0 ? window.__view3d.ghosts() : null",
                   timeout=40)
        check("plan 3D: ghost layer built", g and g["boxes"] == 41 + 3 + 1 + 1 + 1 + 1 and g["kinds"].get("station") == 1, g)
        check("plan 3D: badge", p.wait("() => (document.querySelector('.v3d-ghosts') || {}).textContent.includes('Plan w 3D')"))
        p.page.wait_for_timeout(1500)
        p.shot(os.path.join(shots, "plan-3d-desktop-light.png"))
        p.page.locator(".v3d-ghosts .plan-clear").click()
        check("plan 3D: cleared", p.wait("() => window.__view3d.ghosts().boxes === 0 && !document.querySelector('.v3d-ghosts')"))

        # objects (logistician): list and map pick; multiple choice; reject with reason
        p.tab_team()
        p.agent("logistician")
        lc = p.page.locator(".qcard[data-question=\"%d\"]" % ids["q_lo"])
        lc.locator(".q-list").nth(0).click()
        rows = lc.locator(".qpicker-item")
        check("object list: own lines", rows.count() == 4, rows.count())
        lc.locator(".qpicker-search").fill("104")
        check("object list: search", lc.locator(".qpicker-item").count() == 1)
        lc.locator(".qpicker-item").first.click()
        v = p.js("(id) => window.__team.drafts.get(id).values.o1", ids["q_lo"])
        check("object list: value", v == {"kind": "line", "id": 104}, v)
        st = p.js("() => window.__dash.S.stations.stations.filter((s) => s.owner === 0)[0]")
        lc.locator(".q-pick").nth(1).click()
        p.wait("() => window.__dash.S.ui.tab === 'map' && !!document.querySelector('.pick-hint')")
        check("object pick: hint names the kind", "stacja" in p.text(".pick-hint"), p.text(".pick-hint"))
        x, y = p.tile_point(st["pos"]["x"], st["pos"]["y"], 3)
        p.page.wait_for_timeout(200)
        p.page.mouse.click(x, y)
        v = p.wait("(id) => window.__dash.S.ui.tab === 'team' && window.__team.drafts.get(id).values.o2", arg=ids["q_lo"])
        check("object pick on the map: station", v == {"kind": "station", "id": st["id"]}, v)
        opts = lc.locator(".qopt")
        opts.nth(0).click()
        opts.nth(1).click()
        lc.locator(".q-submit").click()
        check("object question: answer body", wait_for(lambda: (m.last("answer") or {}).get("question_id") == ids["q_lo"])
              and m.last("answer")["answer"] == {"o1": {"kind": "line", "id": 104}, "o2": {"kind": "station", "id": st["id"]},
                                                  "c1": ["Rano", "Wieczorem"]}, m.last("answer"))
        p4 = p.page.locator(".pcard[data-project=\"%d\"]" % ids["proj4"])
        ops4 = p4.locator(".pops > li").all_inner_texts()
        check("project: line ops with stops", len(ops4) == 3 and "Nowa linia Ekspres (road)" in ops4[0] and "min. załadunek 50 %" in ops4[0]
              and "Zakup 2 × Fake bus + Mail trailer w zajezdni 20,31" in ops4[1] and "«ex»" in ops4[1], ops4)
        p4.locator(".p-reject").click()
        p4.locator(".p-reason").fill("Za drogo")
        p4.locator(".p-reject-confirm").click()
        check("reject: POST with reason", wait_for(lambda: m.last("reject") == {"project_id": ids["proj4"], "reason": "Za drogo"}),
              m.last("reject"))

        # dismiss (dispatcher)
        p.agent("dispatcher")
        dq = p.page.locator(".qcard[data-question=\"%d\"]" % ids["q_di"])
        check("question: no Other when allow_other is false", dq.locator(".qopt.other").count() == 0)
        dq.locator(".q-dismiss").click()
        check("dismiss: POST", wait_for(lambda: m.last("answer") == {"question_id": ids["q_di"], "dismiss": True}), m.last("answer"))
        p.publish("team_question", {"question": {"id": ids["q_di"], "agent": "dispatcher", "state": "dismissed", "payload":
                                                 p.js("(id) => window.__team.questions.get(id).payload", ids["q_di"]),
                                                 "answer": None, "answered_by": ids["p2"], "created": None, "answered": None}})
        check("dismiss: card shows who dismissed", p.wait("(id) => { const c = document.querySelector('.qcard[data-question=\"' + id + '\"]');"
                                                          " return c && c.textContent.includes('Odrzucił(a): Gracz Bartek'); }", arg=ids["q_di"]),
              p.text(".qcard[data-question=\"%d\"]" % ids["q_di"]))

        # task board
        p.page.locator(".team-views button", has_text="Tablica").click()
        check("board: shown", p.wait("() => !!document.querySelector('.team-board')"))
        check("board: hash", p.js("() => location.hash") == "#team/board", p.js("() => location.hash"))
        check("board: tasks in columns", p.page.locator(".board-col.col-working .task").count() == 1
              and p.page.locator(".board-col.col-done .task").count() == 1 and p.page.locator(".board-col.col-open .task").count() == 1)
        check("board: from -> to agents", "Koordynator" in p.text(".board-col.col-working .task") and "Projektant" in p.text(".board-col.col-working .task"))
        check("board: question badge per task", p.page.locator(".board-col.col-waiting .task .qbadge").count() == 1)
        check("board: projects by state", p.page.locator(".plist-group").count() >= 3)
        p.shot(os.path.join(shots, "team-board-desktop-light.png"))
        p.page.locator(".plist-item", has_text="Bocznica").click()
        check("board: project view + hash", p.wait("(id) => location.hash === '#team/project/' + id", arg=ids["proj3"]))
        check("project view: failed report", "Insufficient funds" in p.text(".team-project") and "pominięto" in p.text(".team-project"))

        # disabled reasons
        for reason, text in (("no_engine_agent_mode", "-remote_control_agent"), ("no_api_key", "klucza API"),
                             ("over_limit", "limit kosztów")):
            m.reason = reason
            p.js("() => import('/js/team/state.js').then((mod) => mod.refreshState())")
            check("banner: reason " + reason, p.wait("(t) => (document.querySelector('.team-banner') || {}).textContent.includes(t)", arg=text),
                  p.text(".team-banner"))
        m.reason = None
        p.js("() => import('/js/team/state.js').then((mod) => mod.refreshState())")
        check("banner: gone again", p.wait("() => !document.querySelector('.team-banner')"))

        check("enabled: CSP clean", not p.js("() => window.__csp"), p.js("() => window.__csp"))
        check("enabled: no console errors", not p.errors(), p.errors())
    finally:
        p.close()


def run_links(browser, ids, shots):
    m = Mocks()
    p = Page(browser, BRIDGE_PORT, ids["tok_player2"], hash_="#team/project/%d" % ids["proj2"], routes=m.install)
    try:
        check("deep link: project opens the Team tab", p.wait("(id) => window.__dash.S.ui.tab === 'team' && window.__dash.S.ui.teamView === 'project'"
                                                              " && window.__dash.S.ui.teamProject === id", arg=ids["proj2"]))
        check("deep link: project card", p.wait("(id) => !!document.querySelector('.team-project .pcard[data-project=\"' + id + '\"]')", arg=ids["proj2"]))
        check("deep link: report shown", "3100" in norm(p.text(".team-project")), p.text(".team-project")[:300])
        p.page.goto("http://127.0.0.1:%d/#team/designer" % BRIDGE_PORT)
        check("deep link: hash change to an agent", p.wait("() => window.__dash.S.ui.tab === 'team' && window.__dash.S.ui.teamView === 'chat'"
                                                           " && window.__dash.S.ui.teamAgent === 'designer'"))
        check("deep link: agent row active", p.wait("() => !!document.querySelector('.team-agent.on[data-agent=designer]')"))
        p.page.locator("nav.tabs button.tab", has_text="Mapa").click()
        check("deep link: hash cleared when leaving the tab", p.wait("() => location.hash === ''"), p.js("() => location.hash"))
        p.page.goto("http://127.0.0.1:%d/#team/nobody" % BRIDGE_PORT)
        p.page.wait_for_timeout(300)
        check("deep link: unknown agent ignored", p.js("() => window.__dash.S.ui.tab") == "map")
        # dark desktop
        p.page.goto("http://127.0.0.1:%d/#team/board" % BRIDGE_PORT)
        p.wait("() => !!document.querySelector('.team-board')")
        check("links: no console errors", not p.errors(), p.errors())
    finally:
        p.close()
    e = Page(browser, BRIDGE_PORT, ids["tok_player"], lang="en", hash_="#team/analyst", routes=Mocks().install)
    try:
        e.wait("() => window.__team.chats.get('analyst') && window.__team.chats.get('analyst').loaded")
        check("english: tab label", e.text("nav.tabs button.tab-team").strip().endswith("Team"), e.text("nav.tabs button.tab-team"))
        names = e.page.locator(".team-agent-name").all_inner_texts()
        check("english: agent names", names[:2] == ["Coordinator", "Analyst"] and names[-1] == "Fleet manager", names)
        check("english: question card texts", "Send answer" in e.text(".qcard") and "recommended" in e.text(".qcard"), e.text(".qcard")[:300])
        check("english: no console errors", not e.errors(), e.errors())
    finally:
        e.close()
    for scheme in ("dark",):
        d = Page(browser, BRIDGE_PORT, ids["tok_player"], scheme=scheme, hash_="#team/designer", routes=Mocks().install)
        try:
            d.wait("() => window.__team.chats.get('designer') && window.__team.chats.get('designer').loaded")
            d.page.wait_for_timeout(400)
            d.shot(os.path.join(shots, "team-chat-desktop-%s.png" % scheme))
            d.page.locator(".team-views button", has_text="Tablica").click()
            d.wait("() => !!document.querySelector('.team-board')")
            d.shot(os.path.join(shots, "team-board-desktop-%s.png" % scheme))
            check("dark: no console errors", not d.errors(), d.errors())
        finally:
            d.close()


def run_phone(browser, ids, shots):
    for scheme in ("light", "dark"):
        p = Page(browser, BRIDGE_PORT, ids["tok_player"], viewport=(390, 844), scheme=scheme, hash_="#team/designer",
                 routes=Mocks().install)
        try:
            p.wait("() => window.__team.chats.get('designer') && window.__team.chats.get('designer').loaded")
            if scheme == "light":
                check("phone: agent selector instead of the list", p.page.locator(".team-agent-select select").count() == 1
                      and p.page.locator(".team-agents").count() == 0)
                over = p.js("() => document.documentElement.scrollWidth - window.innerWidth")
                check("phone: no horizontal overflow", over <= 0, over)
                p.page.locator(".team-agent-select select").select_option("analyst")
                check("phone: selector switches the agent", p.wait("() => window.__dash.S.ui.teamAgent === 'analyst'"))
                p.page.locator(".team-agent-select select").select_option("designer")
                p.wait("() => window.__team.chats.get('designer').loaded")
                inp = p.js("() => { const r = document.querySelector('.team-text').getBoundingClientRect(); return [r.width, r.bottom]; }")
                check("phone: input usable", inp[0] > 200 and inp[1] <= 844, inp)
            p.page.wait_for_timeout(300)
            p.shot(os.path.join(shots, "team-chat-phone-%s.png" % scheme))
            p.page.locator(".team-views button", has_text="Tablica").click()
            p.wait("() => !!document.querySelector('.team-board')")
            p.shot(os.path.join(shots, "team-board-phone-%s.png" % scheme))
            check("phone %s: no console errors" % scheme, not p.errors(), p.errors())
        finally:
            p.close()


def run_markup(browser, ids, shots):
    """Fake engine with HTML/script in every name: nothing may become an element."""
    p = Page(browser, BRIDGE_PORT_MARKUP, ids["tok_player"], routes=Mocks().install)
    try:
        p.tab_team()
        p.agent("accountant")
        txt = p.text(".tmsg.assistant .tmsg-bubble")
        check("xss: model text shown as text", "<img src=x" in txt and "<script>" in txt, txt)
        check("xss: bold still rendered", p.page.locator(".tmsg.assistant .tmsg-bubble strong").count() == 1)
        p.agent("logistician")
        lc = p.page.locator(".qcard[data-question=\"%d\"]" % ids["q_lo"])
        lc.locator(".q-list").nth(1).click()
        p.page.wait_for_timeout(300)
        check("xss: game names in the picker as text", "<img" in lc.locator(".qpicker-list").inner_text())
        lc.locator(".qpicker-item").first.click()
        p.page.locator(".team-views button", has_text="Tablica").click()
        p.wait("() => !!document.querySelector('.team-board')")
        check("xss: markup project title as text", "<img src=x" in p.text(".team-board"))
        p.page.locator(".plist-item", has_text="Odrzucony").click()
        p.wait("() => !!document.querySelector('.team-project .pcard')")
        p.page.wait_for_timeout(500)
        check("xss: no script ran", p.js("() => window.__xss") is None, p.js("() => window.__xss"))
        check("xss: no injected elements", p.js("() => document.querySelectorAll('.team img, .team script, .team b, .team svg:not(.icon)').length") == 0,
              p.js("() => Array.from(document.querySelectorAll('.team img, .team script, .team b, .team svg:not(.icon)')).map((e) => e.outerHTML).slice(0, 3)"))
        check("xss: CSP clean", not p.js("() => window.__csp"), p.js("() => window.__csp"))
        check("xss: no console errors", not p.errors(), p.errors())
    finally:
        p.close()


def wait_for(fn, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.1)
    return bool(fn())


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--shots", default=os.path.join(tempfile.gettempdir(), "e2e_team_shots"))
    ap.add_argument("--keep", action="store_true", help="keep the temporary directory (database, logs)")
    ap.add_argument("--only", default="", help="comma separated phases: viewer,disabled,enabled,links,phone,markup")
    args = ap.parse_args()
    only = set(filter(None, args.only.split(",")))
    os.makedirs(args.shots, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="e2e_team_")
    db = os.path.join(tmp, "team.sqlite")
    ids = seed(db)
    from playwright.sync_api import sync_playwright
    procs = []
    try:
        procs.append(tl.start_engine(tmp, ENGINE_PORT, "--players", "3", name="engine"))
        procs.append(tl.start_bridge(tmp, BRIDGE_PORT, ENGINE_PORT, "--db", db, "--test-team", env=ENV, name="bridge"))
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="msedge", headless=True, args=[
                "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"])
            try:
                for name, fn in (("viewer", lambda: run_viewer(browser, ids)),
                                 ("disabled", lambda: run_disabled(browser, ids, args.shots)),
                                 ("enabled", lambda: run_enabled(browser, ids, args.shots)),
                                 ("links", lambda: run_links(browser, ids, args.shots)),
                                 ("phone", lambda: run_phone(browser, ids, args.shots))):
                    if only and name not in only:
                        continue
                    try:
                        fn()
                    except Exception as e:  # a crash of one phase is a failed check, the others still run
                        check("phase %s ran without exception" % name, False, repr(e))
                if not only or "markup" in only:
                    for pr in procs:
                        pr.kill()
                    procs = []
                    procs.append(tl.start_engine(tmp, ENGINE_PORT, "--players", "3", "--markup", name="engine-markup"))
                    procs.append(tl.start_bridge(tmp, BRIDGE_PORT_MARKUP, ENGINE_PORT, "--db", db, "--test-team", env=ENV,
                                                 name="bridge-markup"))
                    try:
                        run_markup(browser, ids, args.shots)
                    except Exception as e:
                        check("phase markup ran without exception", False, repr(e))
            finally:
                browser.close()
    finally:
        for pr in procs:
            pr.kill()
        if args.keep:
            print("kept", tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    print("\n%d checks, %d failed%s" % (len(results), len(problems), (": " + ", ".join(problems)) if problems else ""))
    print("screenshots:", args.shots)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
