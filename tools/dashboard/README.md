# Simutrans dashboard

`simutrans_dashboard.py` is a small HTTP server that shows a running Simutrans-Horizon game in the
browser: it serves the dashboard page from `web/` and an HTTP API with live updates through
Server-Sent Events (SSE). It needs only Python 3.10+ (standard library) and talks to the game
through the remote control port (`-remote_control`, see [tools/mcp/README.md](../mcp/README.md)).

```
browser(s) --HTTP/SSE 127.0.0.1:13380--> simutrans_dashboard.py --TCP 127.0.0.1:13360--> Simutrans (-remote_control)
```

The bridge uses three game connections: a poller that reads the game periodically and sends the
changes to every browser, one for requests of the browsers (one request at a time), and one that
subscribes the events of the game (protocol 2, see [Events](#events-of-the-game)): new messages,
pause and speed, cash, convoy states, arrivals and the new month then reach the browsers at once
and the poller polls less. The game accepts 8 connections, shared with the MCP server and other
tools.

The map is drawn from PNG tiles that the bridge makes from the game's minimap
([Map tiles](#get-tilesmodestepcxcypng)); only changed parts are loaded again. Games without the
map export get the map from `map` grids as before ([Older engines](#older-engines)).

Lines, convoys, stations, cities and factories open a detail panel with the content of the game's
windows (schedule, vehicles, freight, waiting goods, departures, storage, suppliers and consumers,
charts), the finances tab shows the monthly and yearly history of the game's finance window, and the
world tab the world statistics, the goods and tables of all cities and factories
([Detail panels](#detail-panels-and-histories)). The route of a line is drawn from the legs its convoys
drive, which the bridge merges over time ([line routes](#get-apiline_routeid)); the supply chains between
the factories can be drawn on the map in the colours of their goods.

## Start

```
"Simutrans SDL2 Nightly.exe" -objects pak128/ -remote_control
python tools/dashboard/simutrans_dashboard.py
```

The bridge prints one link per role; open one in the browser:

```
Simutrans dashboard 0.1.0 on http://127.0.0.1:13380/ (game port 13360)
  viewer http://127.0.0.1:13380/?token=...
  player http://127.0.0.1:13380/?token=...
```

| Option | Meaning |
|---|---|
| `--game-port N` | remote control port of the game (default `$SIMUTRANS_REMOTE_PORT` or 13360) |
| `--port N` | HTTP port (default 13380) |
| `--bind ADDR` | address to listen on (default 127.0.0.1); read [Deployment](#deployment) first |
| `--allowed-host NAME` | further Host name to answer to, e.g. a tunnel hostname, with or without port (repeatable) |
| `--enable-admin` | also create an admin token (adds `cash`) |
| `--no-events` | do not subscribe the events of the game, only poll (as with games without protocol 2) |
| `--verbose` | log every request (by default only failed ones) |

Tokens are new random values (`secrets.token_urlsafe(16)`) at every start, unless set in the
environment: `SIMUTRANS_DASHBOARD_TOKEN_VIEWER`, `SIMUTRANS_DASHBOARD_TOKEN_PLAYER`,
`SIMUTRANS_DASHBOARD_TOKEN_ADMIN` (at least 16 characters of `A-Z a-z 0-9 - _ . ~`, all different;
the admin token only with `--enable-admin`). Ctrl+C stops the bridge. The game may start, stop or
load other worlds while the bridge runs; the bridge reconnects (1 to 10 s backoff).

## Roles

| Role | Read commands | Action commands |
|---|---|---|
| viewer | `ping status tile map players cities stations station convoys lines factories messages poll positions palette minimap map_changes labels finance line convoy line_route city factory supply_chain goods world_stats`, and `factory_status` of the bridge | none |
| player | same | `view zoom pause fast_forward tool` |
| admin | same | player's + `cash` |

Never available, whatever the role: `eval`, `screenshot`, `click`, `move`, `drag`, `wheel`,
`key`, `text`, `unlock_game`, `remove_password`, `tool_visibility`, `windows` and every command
not listed above. `tool` always acts as the active player of the game (`player`/`unowned` are
refused) and refuses `tool_lock_game`, `tool_generate_script` and the scripted tools.

## Sign in and sessions

* `GET /?token=T` checks the token and answers `302 Location: /` with the session cookie
  `sdash_<port>=<id>; HttpOnly; SameSite=Strict; Path=/` (plus `Secure` when the request has
  `X-Forwarded-Proto: https`). The token leaves the address bar with the redirect.
* `GET /` without a valid session shows a login page (built into the bridge, styled by
  `/login.css`) whose form posts `token` to `POST /login` (`application/x-www-form-urlencoded`,
  answer `303 Location: /` + cookie). A wrong token gives the login page with status 401.
* After 5 failed logins within a minute from one IP address, logins from it (also with a right
  token) get 429 until those failures are a minute old.
* Sign-ins that the browser marks as made by another site get 403 and count as no failure:
  `GET /?token=` with `Sec-Fetch-Dest` other than `document` (an `<img>` or `<iframe>` of another
  page), `POST /login` with `Sec-Fetch-Site` other than `same-origin`/`none`. So other pages can
  neither lock the login out nor sign the browser in quietly.
* Sessions live in the memory of the bridge (lost when it stops) and expire after 12 hours without
  a request; an open event stream counts as activity (it checks its session every 5 s and ends when
  the session is gone). Signing in again replaces the session and ends its event streams. At most
  1000 sessions: when full, the least recently used session of the same role goes first (so signing
  in again and again with the viewer token signs out no player or admin).
* `POST /api/logout` (with the headers of an action, see below, body may be empty) ends the session
  and its event streams at once: `{"ok":true}` and an expiring cookie.
* Requests from the same computer are not trusted more than others (proxies).

## HTTP API

All API answers are JSON (`application/json; charset=utf-8`, `Cache-Control: no-store`). Errors of
the bridge are `{"ok":false,"error":"<text>"}`.

| Status | Meaning |
|---|---|
| 200 | the game answered `"ok":true` |
| 304 | map tile unchanged (`If-None-Match`) |
| 400 | the game answered `"ok":false` (reply passed on), or invalid arguments/JSON, or a `GET` with a body, or an invalid or repeated `Content-Length` |
| 401 | not signed in |
| 403 | command not allowed for the role, or a check of an action request failed, or a `GET` of `/api/` or `/tiles/` that the browser marks as made by another site (`Sec-Fetch-Site` other than `same-origin`/`none`; other clients send no such header) |
| 404 | no such page/file, map tile outside of the map, or the game has no map export |
| 411 / 413 / 415 | chunked body / body over 16 KB / wrong Content-Type of an action |
| 421 | the Host header is not one of the dashboard's names |
| 429 | rate limit (`Retry-After: 1`): 30 requests/s per session with bursts up to 60, or more than 2 large requests at once, or the map exports of the browsers used up their share of the game's time (see below), or too many failed logins |
| 502 | the game is not reachable |
| 503 | the game connection is busy for over 30 s, or 64 event streams are open |

### GET /api/session

```
{"role":"viewer|player|admin",
 "allowed":{"read":["ping","status",...],"action":["view","zoom","pause","fast_forward","tool"]},
 "game":{"connected":true,"missing":[],"events":true},
 "bridge":{"version":"0.1.0","game_port":13360}}
```

`game.missing`: see [Older engines](#older-engines). `game.events`: the event connection is
subscribed (false while it is not, e.g. with `--no-events` or a game without protocol 2).

### GET /api/&lt;command&gt;?&lt;arguments&gt;

Read commands only. The query arguments go to the game unchanged (the bridge re-encodes them) and
the reply comes back as the game sent it, with `"ok"`:

```
GET /api/convoys?owner=0&limit=0&fields=summary
-> 200 {"convoys":[{"id":12,"name":"..","owner":0,"pos":{"x":1,"y":2,"z":0},"line":3,"state":"driving"},...],
        "truncated":false,"total":145,"offset":0,"ok":true}
GET /api/tile          -> 400 {"ok":false,"error":"missing tile coordinates x,y"}
```

The commands and their arguments are documented in [tools/mcp/README.md](../mcp/README.md) and
`src/simutrans/network/remote_control.cc`. In short:

| Command | Arguments |
|---|---|
| `ping`, `players`, `poll` | none |
| `status` | `components=1`, `max_elements=N` (window contents) |
| `tile` | `x`, `y` |
| `map` | `x`, `y`, `w`, `h` (default 32, h=w), `max_size` (default 96, at most 512), `layers=terrain,height,owner,slope`, `features=0/1`; without x,y the visible area |
| `cities` | `limit` (default 100, 0 = all), `offset`, `fields=summary` |
| `stations`, `convoys`, `lines` | `owner`, `limit` (default 200, 0 = all), `offset`, `fields=summary` |
| `station` | `id` or `x`, `y` |
| `factories` | `x1 y1 x2 y2` (region), `limit`, `offset`, `fields=summary`, `links=1` (suppliers/consumers as positions) |
| `messages` | `count`, `since` |
| `positions` | `owner`, `x1 y1 x2 y2` |
| `palette` | `builtin=1` |
| `minimap` | `x y w h` (default the whole map), `step=1/2/4/8/16`, `mode`, `contour=0`, `vehicles=1`, `level` |
| `map_changes` | `since`, `chunk` (power of 2, 64–4096) |
| `labels` | none |
| `finance` | `player`, `tt=all/road/rail/...`, `period=both/month/year` |
| `line`, `convoy` | `id`, `history=1` |
| `line_route` | `id` (merged by the bridge, see [below](#get-apiline_routeid)) or `convoy` |
| `station` (extras) | `history=1`, `waiting=goods,next`, `lines=1`, `departures=N` |
| `city` | `id` (or `name`, or `x`, `y`), `history=month/year/none` |
| `factory` | `x`, `y` (any square of the factory), `history=0` |
| `supply_chain` | `goods` (internal or translated name) |
| `goods`, `world_stats` | none; `world_stats`: `period=month/year` |
| `factory_status` | none; made by the bridge, see [below](#get-apifactory_status) |

The detail commands (`finance`, `line`, `convoy`, `line_route`, the `station` extras, `city`,
`factory`, `supply_chain`, `goods`, `world_stats`) are described in tools/mcp/README.md, "Details
and histories"; engines without them answer 400 `unknown command`. The bridge passes them on
unchanged, except `line_route` with `id`; `goods` and `supply_chain` also come with the event stream
([feeds](#get-apievents-server-sent-events)). The frontend uses all of them; a command an engine answers
with `unknown command` is not asked again until the next `snapshot` (e.g. after a reconnect).

Argument names must match `[a-z][a-z0-9_]{0,31}`, values have at most 512 characters and no NUL
character or lone surrogate (the game reads many values as C strings, where `4124\0` would be a tool
number), the query at most 4096; `rid` is dropped. `map` regions are limited to 512 × 512 tiles (`w*h` ≤ 262144,
`max_size` ≤ 512; pass `max_size=512` for regions larger than 96 tiles). Large requests (`map`,
`minimap` without `w`/`h` or with more than 262144 samples, and `stations`/`convoys`/`lines` with
`limit=0` or above 1000) run at most two at a time, the third gets 429. All browser requests share
one game connection, so keep large requests rare: the event stream already carries the lists
(summaries), and the map is better loaded as [tiles](#get-tilesmodestepcxcypng).

The map exports run inside a frame of the game: a `minimap` of the whole NYC map (1024 × 1024) in a
statistics mode with `level=9` takes about 0.2 s, and a browser asking for it in a loop brought the
game from about 60 to 5 answered requests per second. So `map`, `minimap` and the map tiles the bridge
has to fetch may take at most 0.25 s of round-trip time per second together (all browsers, bursts up
to 2 s); beyond that they get 429 (`Retry-After: 1`) until the share has filled up again. Normal use
(the tiles of the whole map, the detailed map regions one at a time) stays far below.

### GET /api/line_route?id=

A convoy knows only the route of the leg to its next stop, so the game's `line_route id=N all=1`
returns just the legs the convoys of a line drive right now. The bridge keeps them per line and merges
the legs of later requests, keyed by the schedule step they belong to (the halts at both ends, or the
square for waypoints and depots), so the route of a line fills in while it is viewed. With `id` (and
without `convoy`) the reply is the merged route:

```
GET /api/line_route?id=1
-> 200 {"line":1,"merged":true,
        "legs":[{"convoy":2,"from":{"halt":34,"name":"..","pos":[389,429]},"to":{"halt":35,"name":"..","pos":[395,432]},
                 "length":9,"points":[[389,429],[395,429],[395,432]],"seen":1795374895.2,"from_index":10,"to_index":11},...],
        "missing":[[0,1],[1,2],...],"stops":20,"pairs":20,"covered":4,"complete":false,
        "schedule":[{"halt":7,"name":"..","pos":[398,423]},...,{"halt":null,"name":"Depot","pos":[468,401],"depot":true}],
        "fetched":1795374895.2,"ok":true}
```

* A step is a pair of consecutive schedule entries i → i+1 (the last one → the first), left out when
  both are the same stop; `pairs` counts them, `covered` those with a known leg. `legs` are the known
  steps in schedule order (`from_index`/`to_index` = schedule entries, `points` = the corners of the
  route as the game sends them, `seen` = unix time of the request that saw the leg, `convoy` = the
  convoy that drove it). `missing` are the steps without a leg yet; `complete` is true when every step
  has one. `schedule` has the stops (`pos` = [x, y] of the schedule entry), so a client can draw missing
  steps as straight lines. Legs of no step (e.g. a trip to a depot) are not returned.
* The legs are fetched again (`line id=` + `line_route id= all=1`, about 1 ms each in the game) when
  the cached ones are older than 30 s; requests in between get the cache (`fetched` = unix time of the
  last fetch). So a line is refreshed at most every 30 s, and only while someone requests it (the
  dashboard asks every 15 s while a line is highlighted and legs are missing, every 60 s when the route
  is complete).
* Measured on the NYC map (22 lines, game paused): a refresh takes 28 ms median (43 ms max; two game
  requests, each waiting for a frame), a cached answer 3 ms; replies are 0.3–6 KB.
* The cache (at most 64 lines) is dropped when another world is loaded, on a reconnect, and when
  `poll.rev.schedules` (the schedule counter of the game) changes; a changed schedule of the line also
  starts its route over.
* `line_route?convoy=<id>` (the leg one convoy drives now) and requests without `id` go to the game
  unchanged; `id` must be an integer (400 otherwise). Errors of the game (e.g. `no line with this id`)
  are passed on with 400, an engine without `line_route` answers 400 `unknown command`.

### GET /api/factory_status

The status of a factory (the colour of the game's status bar), its productivity and the stops that
serve it are only in the factory window, not in `factories`. For the factories table the bridge asks
the game for the window of every factory (`factory x= y= history=0`, all of them sent at once on the
request connection, so the game answers many per frame) and returns the main fields:

```
GET /api/factory_status
-> 200 {"factories":[{"x":399,"y":827,"status":"good","productivity":225,"production_per_minute":1052.86,
                      "base_production":2000,"owner":1,"halts":1,"cities":5},...],
        "date":{"year":1974,"month":10},"fetched":1795374895.2,"ok":true}
```

* `x`, `y` = `pos` of the factory in `factories`; `status` one of `good medium bad inactive nothing`,
  `halts`/`cities` the numbers of connected stops and cities, the rest as in `factory`. A factory that
  went away since the list is left out.
* The answer is shared by all browsers: it is fetched again when it is older than 30 s, at a new game
  month and for another world (`fetched` = unix time of the fetch). It counts as a large request (at most
  two at a time).
* Measured on the NYC map (205 factories, game paused): 39 ms for a fetch (the game needs about 8 ms for
  the 205 windows), 15–20 ms for a cached answer; 29 KB.
* An engine without `factory` answers 400 `unknown command` (the table then has no status column data).

### GET /tiles/&lt;mode&gt;/&lt;step&gt;/&lt;cx&gt;/&lt;cy&gt;.png

One chunk of the game's minimap as an 8-bit palette PNG of 256 × 256 pixels: pixel (i, j) is the
colour of map square (cx·256·step + i·step, cy·256·step + j·step) as the in-game minimap shows it
(the top left square of every step × step block). The colours are those of the game's `palette`
(the PLTE holds only the colours used); pixels beyond the map edge are transparent (`tRNS`).

* `mode`: `terrain owner traffic freight passengers mail tracks speed power forest level climates`
  (see `minimap` in tools/mcp/README.md), else 400.
* `step`: `1 2 4 8 16`, else 400. `cx`, `cy`: chunk numbers; a chunk that starts outside of the map
  gives 404. The query (e.g. `?v=3.0.1`) is ignored: the frontend puts a version there to load a
  changed tile again.
* Same session rules as `/api/` (401 without), an own rate limit of 60 tiles/s per session with
  bursts up to 120 (429 `Retry-After: 1`), 404 when the game has no map export, 503 while the game
  is not ready.
* Answer: `Content-Type: image/png`, `Cache-Control: private, no-cache`, `ETag` (hash of the PNG);
  `If-None-Match` with that ETag gives 304 without a body.

The bridge fetches `minimap` for a tile on the request connection when it is not cached, and keeps
the PNGs (up to 48 MB). A cached tile stays valid until `map_changes` names one of the chunks it
covers (all modes), until the next game month (all modes except `terrain` and `owner`, whose colours
the game's change tracking covers), or until another world, a rotation, a full reload of the map or
a reconnect. Requesting tiles makes the bridge follow the map changes (for 10 minutes after the
last tile request): when `poll.rev.map` changes (and every 10 s) it asks `map_changes since=<last
gen> chunk=256` and sends the SSE event `map_changes`.

Measured on the NYC map (1024 × 1024, game paused): the whole map at step 1 is 16 tiles of 3.7 KB
on average (59 KB; the `map` grids of the older map path are 147 KB per 256 × 256 region); a tile
not cached takes 4–8 ms (the game needs 4–6 ms for the `minimap` of 256 × 256), a cached one or a
304 0.3 ms. The browser shows the whole map 0.22 s after the snapshot (0.93 s after opening the
page) with an empty bridge cache, 0.06 s when the bridge has the tiles; a road built with
`POST /api/tool` was on the screen 0.6–1.2 s later (at most about 2.3 s: the poll interval while
events are live is 2 s).

### POST /api/&lt;command&gt;

Action commands, by role. Requirements: the session cookie, `Content-Type: application/json`,
the header `X-Dashboard: 1`, an `Origin` header of one of the dashboard's names (browsers send it
with every `fetch` POST) and, if present, `Sec-Fetch-Site: same-origin`. The body is a JSON object
of arguments: strings, numbers, booleans (`true` → `1`, `false` → `0`); `null` leaves the argument
out; unknown arguments give 400.

```js
const r = await fetch("/api/pause", {method: "POST",
  headers: {"Content-Type": "application/json", "X-Dashboard": "1"},
  body: JSON.stringify({on: true})});
const reply = await r.json();          // {"paused":true,"ok":true}
```

| Command | Body | Reply (`"ok":true` plus) |
|---|---|---|
| `view` | `x`, `y`, `z`? | `{"center":{"x","y","z"}}` (moves the game window's view) |
| `zoom` | `dir`: `"in"`/`"out"`, `count`: 1–10 | `{"zoom_index","tile_raster_width"}` |
| `pause` | `on`: bool (missing = toggle) | `{"paused":bool}`; not in network games |
| `fast_forward` | `on`: bool (missing = toggle) | `{"fast_forward":bool}`; not in network games |
| `tool` | `tool`, `x`, `y`, `z`?, `x2`?, `y2`?, `z2`?, `param`?, `ctrl`?, `shift`? | `{"result":null}`, or in network games `{"pending":true}`; a refusal of the game is 400 `{"ok":false,"error":"<text>"}` |
| `cash` (admin) | `amount`, `player`?, `confirm`: **true** (required) | `{"player","name","amount","cash_before","cash","steps"}` (+ `"pending":true` in network games) |

`tool`: names like `tool_build_way`, `TOOL_BUILD_WAY`, `general_tool[14]` or numeric ids, see the
`tool` command in tools/mcp/README.md. `player` and `unowned` give 400; `tool_lock_game`,
`tool_generate_script`, `tool_exec_script` and `tool_exec_two_click_script` give 403 in every
spelling.

### GET /api/events (Server-Sent Events)

One stream per browser tab (`new EventSource("/api/events")`), `text/event-stream`,
`Cache-Control: no-store`, `X-Accel-Buffering: no`, chunked HTTP/1.1. Every event has
`id: <number>`, `event: <type>` and one `data:` line with JSON. Ids are large numbers (they start
at the bridge's start time in ms) that grow by 1 per broadcast event. The first event carries
`retry: 3000` (reconnect after 3 s). A comment line `: hb` comes after 25 s without data.

A stream starts with `hello`, then `snapshot` (or, on a resume, the missed events). After that the
bridge sends a feed only when its content changed:

| Event | data |
|---|---|
| `hello` | `{"role":"viewer","bridge_version":"0.1.0"}` |
| `snapshot` | `{"poll","players","positions","messages","lines","convoys","stations","factories","cities","palette","goods","supply_chain","game"}` — each part as in its own event (`positions` with `full:true`, `messages` the list), `null` if not known yet or not supported |
| `poll` | reply of `poll` (without `ok`): ticks, date, month_progress, ticks_per_month, paused, ff, mult, player {nr,name,cash}, msg_seq, counts, rev, world {gen,size_x,size_y,rotation}; also sent at once with the new `paused`/`ff`/`mult` after a `pause`/`fast_forward` action and on status and cash events of the game (`ticks` and `date` then stay those of the last poll) |
| `positions` | `{"full":bool,"cols":["id","x","y","z","state","owner","line","load"],"states":[..names..],"rows":[[12,395,433,0,6,0,1,54],...],"del":[ids]}` |
| `messages` | `{"messages":[...new, oldest first],"reset":bool,"truncated":bool}` |
| `players` | reply of `players`: `{"active_player":N,"players":[...]}` |
| `lines` | reply of `lines limit=0 fields=summary`: `{"lines":[{"id","name","owner","convoys"}],"total","offset","truncated"}` |
| `convoys` | reply of `convoys limit=0 fields=summary`: `{"convoys":[{"id","name","owner","pos","line","state"}],...}` (`line` = line id or 0) |
| `stations` | reply of `stations limit=0 fields=summary`: `{"stations":[{"id","name","owner","pos"}],...}` |
| `factories` | reply of `factories limit=0` (full: production, inputs, outputs, ...) |
| `cities` | reply of `cities limit=0` (full: citizens, area, last_month, ...) |
| `goods` | reply of `goods`: `{"goods":[{"index","name","translated","unit","category","color":[r,g,b]|null,"value","speed_bonus","weight","used",...}]}` — the goods types with their colours; `null` with engines without it |
| `supply_chain` | reply of `supply_chain`: `{"nodes":[{"pos","name","type"}],"edges":[[from,to,"<goods>",active],..]}` — all factories and their supply links (`<goods>` = `translated` of `goods`); `null` with engines without it |
| `game` | `{"connected":bool,"error":"<text>"|null,"missing":[...],"events":bool}` |
| `world` | `{"gen":N}` — another world was loaded; drop everything tied to object ids, a `snapshot` follows |
| `month` | `{"date":{"year","month"},"year_changed":bool}` — a new game month began (the month event of the game, or without events the date of a poll) |
| `convoy_states` | `{"changes":[[id,state,previous state],..],"added":[ids],"removed":[ids],"states":[..names..]}` — convoys that changed their state, were added or removed (also in depots), at most one per second; events only |
| `arrivals` | `{"items":[[convoy id,halt id],..],"dropped":N}` — convoys that arrived at stops since the last `arrivals`, at most one per second, at most 4096 items (`dropped`: further ones); events only |
| `palette` | reply of `palette`: `{"source","colors":[[r,g,b] x256],"players":[{"nr","name","color1","color2","minimap_color"}],"height_colors","severity_colors","maximumheight","minimumheight","groundwater","rotation"}`; the colours of the map tiles and of the players (`minimap_color` is an index into `colors`); map export only |
| `map_changes` | `{"gen":N,"full":bool,"chunks":[[cx,cy],..],"world_gen":N}` — map squares changed in these chunks of 256 × 256 squares (step 1 units); `full`: everything (chunks empty); only while tiles are requested, map export only |

Message items: `{"seq","text","type","type_name","player","date":{"year","month"},"pos":{x,y,z}|null}`.
`text` may contain line breaks and any characters: render it with `textContent`.

Client rules:

* `snapshot` replaces the whole state (also after a reconnect of the game, which sends no `world`).
* `poll`, `players`, `lines`, `convoys`, `stations`, `factories`, `cities`, `goods`, `supply_chain`: replace
  that part.
* `positions`: `full` → replace the row table; otherwise set every row of `rows` by its id
  (`row[0]`) and delete the ids in `del`. `state` is an index into `states`.
* `messages`: `reset` → replace the list, otherwise append. The snapshot holds the last 100.
* `convoy_states`: `state` is an index into its `states` (the same names as in `positions`); set
  the state of the convoy in the positions rows and the convoy list. `positions` and `convoys`
  keep carrying the states as well, so a client may ignore `convoy_states` (and `arrivals`).
* `month`: may come before the `poll` with the new date. Tiles of the statistics modes (all except
  `terrain` and `owner`) show the new month's numbers: load them again.
* `map_changes`: load the tiles again that cover one of `chunks` (a tile at step s covers the chunks
  cx·s … cx·s+s−1, likewise y), all tiles when `full`. After a `snapshot` load all tiles again as
  well (changes may have been missed); unchanged ones answer 304.
* `palette`: replace the colours (players may have got other colours, new players).
* `game.connected` false: the game is not reachable (`error` says why); `error` with connected true:
  the game answers but has no world loaded.

Resume: EventSource sends `Last-Event-ID` when it reconnects. If the bridge still has the missed
events (the last 500), the stream starts with `hello` (id = Last-Event-ID) and those events; else
with `hello` and a new `snapshot`. A client that falls more than 2000 events behind is
disconnected and resumes the same way.

Polling (per game, shared by all browsers): `poll` and `positions` every second, `players` every
5 s, `messages` when `poll.msg_seq` changes, `lines`/`convoys` every 15 s, `stations`,
`factories`, `cities` every 30 s, `supply_chain` every 60 s, `goods` every 10 minutes (each only while
the game knows the command); a new month refetches players, lines, convoys, cities, factories,
`supply_chain` and `goods`, a change of `poll.rev.objects` refetches convoys, lines and stations (at
most every 5 s). While the events of the game are subscribed: `poll` every 2 s, `positions` every second,
`players` every 15 s, `lines`/`convoys` every 30 s (and after added or removed convoys),
`messages` only to fill gaps, the rest as above. In both cases `palette` every 60 s and at a new
month, and `map_changes` as described under [map tiles](#get-tilesmodestepcxcypng) (only while
browsers request tiles). Measured on the NYC map (1024², 145 convoys):
the bridge needs 0.1 % of one CPU core, paused or running; the event stream carries about
7.5 KB/s while the game runs.

### Events of the game

With a game that speaks protocol 2 (tools/mcp/README.md, "Events (protocol 2)") the bridge keeps
a third connection that subscribes `messages,month,world,status,cash,convoys,arrivals` with an
interval of 1000 ms:

* `messages` events are appended at once; the bridge fetches `messages since=` only at start, after
  a reconnect, when a message is missing in between (e.g. after `overflow`), or when two polls
  count more messages than arrived.
* `status` (pause, fast forward, multiplier) updates the cached `poll` and sends it at once; the
  game sends at most one status event per second, so a second change within a second arrives up
  to a second later. Actions of the dashboard (`pause`, `fast_forward`) update `poll` from their
  reply in any case.
* `cash` updates `poll.player.cash` and `players` (cash, net_wealth).
* `month` is passed on and refetches players, lines, convoys, cities, factories, `supply_chain` and
  `goods` (the browsers get the new supply links with the active flags of the new month).
* `world` (`loaded`/`created` with a new gen) resets everything like a new `world.gen` of `poll`.
* `convoys` is passed on as `convoy_states` (and updates the cached convoy list), `arrivals` as
  `arrivals` (collected, at most one per second).
* `overflow` (the game dropped events for the bridge) refetches messages, poll, players, convoys
  and lines.

The event connection reconnects with a backoff of 1 to 10 s and fetches what may have changed
since; meanwhile, and with games that close the connection on `HELLO simutrans-remote 2`
(protocol 1 only; checked again when the game restarts and every 5 minutes), the bridge polls as
described above. Measured on the NYC map against the polling-only bridge (pause → SSE `poll`):
pause by the dashboard 390 ms → 6 ms, pause in the game 503 ms (max 846) → 2 ms; requests to
the game 151 → 103 per minute while the game runs (146 → 103 while paused).

### Older engines

The bridge works with games built before the events, `poll`, `positions`, `messages since=` and
paging commands existed; `game.missing` (and `/api/session`) then lists what is missing:

| missing | Effect |
|---|---|
| `events` | protocol 1 only: everything is polled (see above), no `convoy_states` and `arrivals` events; `month` comes from the poll date |
| `poll` | `poll` is made from `status` and has `"source":"status"`; `month_progress`, `ticks_per_month`, `msg_seq`, `rev`, `world.gen` and the counts of lines, halts, factories, players are `null` |
| `positions` | no live positions: `snapshot.positions` is `null`, no `positions` events |
| `messages_since` | messages every 5 s, new ones found by comparing lists; `seq` is counted by the bridge, `type_name` derived from `type` |
| `paging` | lists are fetched completely and reduced to the summary fields by the bridge |
| `map_export` | no `palette`, `minimap`, `map_changes`, `labels`: `snapshot.palette` is `null`, `/tiles/` answers 404, no `map_changes` events; the frontend draws the map from `map` grids at every zoom (refreshed every month), uses its own player colours and has no map modes |

`game.missing` does not list the detail commands: the frontend notices `unknown command` (400) when
it asks and falls back (see [Detail panels](#detail-panels-and-histories)). The `goods` and
`supply_chain` feeds stay `null` with such engines (the bridge asks once per connection).

Read requests of the browser are passed on as they are (`GET /api/poll` then answers 400
`unknown command`).

The map tiles need an engine with the map export of tools/mcp/README.md ("Map export": `palette`,
`minimap`, `map_changes`, `labels`, and `poll.rev.map`); the statistics modes follow the month
from the `month` event (protocol 2) or, without events, from the poll date.

### Map in the browser

* Zoom ≤ 0: tiles at step 2^−zoom (zoom −4 = step 16); zoom 0–2: the step 1 tiles scaled up
  (pixelated). From zoom 2.5 the `terrain` mode draws the detailed map from `map` grids (256 × 256
  regions, loaded when shown) over the tiles; regions named by `map_changes` are loaded again when
  in view. The other modes show the tiles at every zoom.
* The layer panel picks the mode (12 minimap modes, English/Polish) and shows a legend where it
  helps (heights and ways, players, the severity scale of traffic/freight/speed/power/level, tracks,
  forests, climates). Player colours (stations, convoys, legends) come from `palette.players`.
* Markers come from `labels` (loaded with the world, after `map_changes` at most every 15 s).
* A stop pulses briefly when `arrivals` names it (only on the map tab, zoom ≥ −1; drawing 500 pulses
  over 3000 stations takes 0.5 ms).
* A highlighted line (map layer panel, or an open line panel) shows its route: the legs from
  [`/api/line_route?id=`](#get-apiline_routeid) solid in the line's colour, the steps without a known
  leg as straight dashed lines (dimmer), and the stops numbered in schedule order. With an older bridge
  or engine all steps are straight dashed lines. While a convoy panel is open, the leg that convoy
  drives now is drawn in blue with a dot at its end (`line_route?convoy=`, every 10 s).
* City names and factory markers can be clicked (info card → Details); the limits of the selected
  city are drawn as a dashed rectangle. The layer "Supply chains" draws the supply links between the
  factories ([details](#detail-panels-and-histories)).

## Detail panels and histories

* **Panels.** A row of the lines, convoys, cities or factories table, a convoy, station, factory or city
  name on the map (info card → Details), and every link between panels (stops of a schedule, convoys of
  a line, lines of a station, departures, suppliers and consumers, stops and cities of a factory) open a
  detail panel: beside the views on wide screens (420 px, 360 px below 1100 px), a full-screen sheet with
  a back button on phones (≤ 720 px). The panel follows the URL hash (`#line/12`, `#convoy/81`,
  `#station/46`, `#city/8`, `#factory/399,827` = the position of the factory): a reload or a shared
  link restores it, the browser's back button goes back through the panels, and closing it returns to
  the page without a hash. Another world closes it.
* **Line** (`line id= history=1`, every 10 s): profit, revenue, transported, use; capacity and load;
  route status; the schedule with the amount waiting at each stop and conditions (minimum load,
  departures); the convoys with state and load; the 12-month chart of the line window (money,
  transport, convoys, distance, top speed). Opening it highlights the line on the map; "Show on map"
  fits the map to the route.
* **Convoy** (`convoy id= history=1`, every 5 s): state, speed, load, profit; the current leg; details
  (power, weight, costs, value, odometer, home depot); vehicles (load, age, value, out of production);
  the schedule with the next entry marked; freight by destination and next transfer; 12-month chart.
  "Locate on map" selects and centres it.
* **Station** (`station id= history=1 waiting=goods,next lines=1 departures=12`, every 10 s): storage
  per kind against its capacity, waiting by goods and by next stop, lines and convoys without line,
  departure and arrival board, this/last month, 12-month chart (passengers, goods, convoys).
* **City** (`city id= history=month`, every 30 s and at a new month; `history=year` while years are
  shown): citizens and the growth of this month, growth rate, buildings, unemployed and homeless
  (negative numbers of the game shown as free jobs or homes), passengers and mail of last month
  (generated, transported, walked, share), shops supplied, "growth stopped". The chart has the 12
  columns of the city window by months or years in groups of one unit (passengers, mail, citizens,
  growth, buildings, goods in shops, city cars; the passenger chart first); a click on a legend entry
  hides or shows that line, and every chart switches to a table. "Locate on map" fits the map to the
  city; the city limits are drawn while the city is selected or its panel is open.
* **Factory** (`factory x= y=`, every 10 s and at a new month): status (with its name, not colour
  alone), productivity, maximum production per day and units per minute, power (offered by a power
  plant, or used of the demand with the transformer), fields; boosts against their maximum; every input
  and output with a storage bar in the units of the game, in transit, received/consumed or
  produced/delivered this and last month; suppliers and consumers (the goods of each link from
  `supply_chain`, "no recent deliveries" for inactive links, a link to their panel and a locate
  button), the stops that serve it (station panels), the cities that send workers and mail (city
  panels), the production/boost chart and the chart of each goods slot. "Locate on map" selects it,
  "Show links" fits the map to it and its partners; while the panel is open its supply links are
  emphasised on the map (also with the supply layer off).
* **World tab**: three views. *Overview* (`world_stats`, every 60 s and at a new month, months or
  years): tiles of the last complete month (or year) against the one before (citizens and the other
  stock values against the end of the last period; the growth as a difference, the shares in
  percentage points) and charts of citizens, growth, shares transported (passengers, mail, shops
  supplied), passengers and mail generated, goods transported, convoys and city cars, or one table of
  all 12 columns; below, the goods with their colours, unit, category, value, speed bonus and weight
  (by default only those used in the world). *Cities* (the `cities` feed): name, citizens, growth this
  month, buildings, passengers/mail carried and shops supplied last month, position; search and sort.
  *Factories* (the `factories` feed and [`factory_status`](#get-apifactory_status), every 30 s while
  shown and at a new month): name with a status dot, status, type, production, productivity, input and
  output stock, suppliers, consumers, served by a stop, position; search, filters by type (the factory
  name of each type with the count) and status, sort.
* **Supply chains on the map** (layer panel → "Supply chains", the `supply_chain` feed): a line from
  each supplier to each consumer per goods type in the goods colour of the game (`goods.color`), an
  arrow towards the consumer from zoom −1.5, links between the same two factories side by side;
  inactive links (no goods went that way recently) dashed and dimmer. The layer panel lists the goods
  on the links with their colours. The links of the factory whose panel is open (or the selected
  factory) are drawn wider with a casing, the others dimmer. One canvas path per colour: drawing the
  175 links of the NYC map takes well under a millisecond.
* **Map clicks**: a city name selects the city (info card with citizens, shares and Details), a
  factory marker the factory (status, productivity, storage, Details).
* **Finances** (`finance player= tt=`, every 20 s and at every new game month): player and transport
  type (the types of `tt_list`), months or years. The tiles show the last complete month (or year)
  with the change against the one before (▲/▼; costs compare their size, so more costs is ▲ in red)
  and the running month so far; cash, net wealth and the vehicle value compare the current value with
  the end of the last month. Charts: revenue and costs, profit, cash and net wealth, transported.
* **Charts** (uPlot) follow the theme (colours from CSS variables, rebuilt when the theme or the
  language changes) and the language; the hover legend shows the values. Flow charts show complete
  months (years) only, because the running period is still partial; cash and net wealth go up to
  today. Every panel chart can be switched to a table of the same numbers, including the running
  month. One unit per chart (no second axis).
* **Older engines** (no `finance`, `line`, `convoy`, `line_route`, station extras, `city`, `factory`,
  `supply_chain`, `goods`, `world_stats`; or an older bridge without them): the finances tab shows the
  tiles from `players` and the cash sampled during the session, panels show what the list commands
  know (stops and profit of a line, the convoy list entry, citizens and last month of a city, storage
  of a factory) with a note, routes are straight dashed lines; the world overview shows citizens,
  towns and factories from the lists, the factories table has no status, the supply layer says it
  needs a newer game, and cities without ids (engines before them) open no panel (a row selects the
  city on the map).

## Static files

| Path | File in `web/` | Cache |
|---|---|---|
| `/`, `/index.html` | `index.html` | `no-store` |
| `/app.js`, `/style.css` | `app.js`, `style.css` | `no-store` |
| `/js/...` | further modules of the app | `no-store` |
| `/vendor/...`, `/img/...` | libraries, images | `private, max-age=3600` |
| `/tiles/...` | map tiles made by the bridge (see above) | `private, no-cache` + `ETag` |

Everything except the login page and `/login.css` needs a session (401 otherwise). Types:
`.html`, `.js`/`.mjs` (`text/javascript`), `.css`, `.png`, `.svg`, `.json`, `.woff2`, `.ico`,
`.txt`/`.md` (text), others `application/octet-stream`. Paths with `..`, hidden names, `\` or `:`
are refused.

Every response has these headers, and none for CORS:

```
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

For the page this means: scripts and styles only from files of the dashboard (no inline
`<script>`, no `style="..."` attributes or `<style>` elements, no `eval`/`new Function`, no CDN);
setting `element.style.*` from JavaScript is fine; images may also be `data:` and `blob:` URLs.

## Security

* The bridge listens on 127.0.0.1 unless `--bind` says otherwise. The Host header must be
  `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, the `--bind` address with the port, or an
  `--allowed-host` name (421 otherwise), which stops DNS rebinding.
* Tokens are compared in constant time and replaced in the log by `token=***`. The session id is a
  new random 256-bit value per sign-in; the cookie is HttpOnly and SameSite=Strict.
* Action requests need `X-Dashboard: 1` (forces a CORS preflight that the bridge never allows),
  JSON and an allowed `Origin`, so other web sites cannot trigger them. Reads (`/api/`, `/tiles/`)
  that the browser marks as coming from another site get 403: SameSite cookies also go to pages on
  other ports of the same host, which could otherwise start large requests or event streams.
* The bridge forwards only the commands of the role tables above; arguments are checked and
  re-encoded, so a request cannot inject further commands, and values with NUL characters are refused.
* Request framing is strict: a `GET` with a body, chunked bodies (`POST`: 411) and missing, repeated
  or odd `Content-Length` values are refused and the connection closed, so no bytes are left over to
  be read as another request behind a proxy that reuses connections.
* At most 256 connections at once, and 32 from one address other than the loopback (a proxy or
  tunnel there carries all users); further ones are closed at once. Every connection holds a thread.

## Deployment

* **This computer:** the default. Open the printed link.
* **LAN:** `--bind <LAN address>` (or `--bind 0.0.0.0 --allowed-host <LAN address>`) and a firewall
  rule for private networks only. Plain HTTP is readable in the network: use the viewer token there
  and keep the admin token off.
* **Internet:** do not open the port. Use a tunnel or a reverse proxy with TLS and an access
  check in front (e.g. Cloudflare Tunnel to `http://127.0.0.1:13380` with Cloudflare Access) and
  start the bridge with `--allowed-host <public hostname>`. The proxy must pass the Host header
  (or set it to an allowed name), must not buffer or compress `/api/events` (Apache:
  `ProxyPass ... flushpackets=on`, nginx honours `X-Accel-Buffering: no`) and should allow idle
  connections of at least 30 s (heartbeat 25 s). Behind a proxy all clients share the proxy's
  address, so the login limit counts their failures together.
* **Limits that stay:** anyone who can reach the port can hold up to 256 connections (32 per
  address) open without signing in, which blocks others until they time out (60 s without data), so
  do not open the port beyond the LAN. A token holder can use the game connection fully: a viewer can
  keep the map exports at their limit (a quarter of the game's time, single requests stall the game
  for up to about 0.25 s; other browsers then get 429 for them) and sign in again and again (other
  viewers' sessions go first); the player token has the building rights of the active player.
  Tokens from the environment must be random. A `/?token=` link stays in the browser history (use
  the login form on shared computers), and cookies are per host name, not per port: other web
  servers on the same host name (e.g. another program on 127.0.0.1) get the session cookie when the
  browser visits them. The game's remote control port has no
  authentication of its own: every program on this computer can use it, including `eval`. For a
  dashboard that only shows the game, start the game with `-remote_control_readonly`, so that the game
  itself refuses every action (pause, tool, cash and also `eval`).

## Development

`dev/fake_engine.py` imitates the remote control of a running game (convoys move, messages appear,
time passes, protocol 2 with all event topics, the map export with a synthetic map, the detail commands
`finance`, `line`, `convoy`, `line_route`, `station`, `city`, `factory`, `supply_chain`, `goods`,
`world_stats` and `factories links=1` with synthetic data) for working on the dashboard without
Simutrans:

```
python tools/dashboard/dev/fake_engine.py --port 13399              # current protocol (2, events, map export)
python tools/dashboard/dev/fake_engine.py --port 13399 --no-events  # protocol 1 only
python tools/dashboard/dev/fake_engine.py --port 13399 --no-map     # without the map export
python tools/dashboard/dev/fake_engine.py --port 13399 --old        # also without poll/positions/since/paging/map export
python tools/dashboard/dev/fake_engine.py --port 13399 --markup     # every name and message carries HTML with script
python tools/dashboard/simutrans_dashboard.py --game-port 13399
```

With `--markup` every player, city, factory, line, convoy, station and goods name, every message and
the labels end with `<img src=x onerror=...><svg onload=...>` that set `window.__xss`: the page must
show them as text, so `window.__xss` stays undefined.

Test-only commands, sent straight to the fake engine: `fake_reload` (another world: `world.gen`
+1, new ids, messages reset, `world` events), `fake_message text=...`, `fake_burst n=N` (N
messages at once), `fake_remove_convoy [id=]`, `fake_set_state id= state=N`, `fake_overflow
drop=K` (the next K events of every subscriber are lost, then `overflow`), `fake_build x= y= [w=]
[h=]` (a road: a map change for `map_changes`), `fake_legs [shift=N]` (the convoys of every line drive
the next legs of their schedule), `fake_schedule` (`poll.rev.schedules` + 1), `fake_event topic=
data=` (an event with any JSON data, e.g. of an unexpected shape). Every fake line has a
schedule (the first one with a waypoint); `line_route all=1` returns the legs of at most two convoys
per line, moving on every quarter month, so routes fill in bit by bit as in the game. The fake world
has 6 cities (one name with markup characters, to check that names are shown as text) and 13
factories (one without goods) with 10 supply links; storage, histories and which links are active
change every month. With `--old` only the lists answer (cities without ids, factories without links).
`--month-seconds` sets the length of a game month
(default 20 s), `--size WxH` the world size (default 256x256; the statistics modes of the fake
minimap change their colours every month).
