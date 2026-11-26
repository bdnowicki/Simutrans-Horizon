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
and the poller polls less. The [3D view](#3d-view) adds two more while it is used (one for the heavy
`desc_list`/`scene3d`/`heights`, one for `vehicles3d`; each closes after 2 minutes without requests).
The game accepts 8 connections, shared with the MCP server and other tools.

The map is drawn from PNG tiles that the bridge makes from the game's minimap
([Map tiles](#get-tilesmodestepcxcypng)); only changed parts are loaded again. Games without the
map export get the map from `map` grids as before ([Older engines](#older-engines)). The 3D tab shows
the map in 3D, from a city block up to the whole map ([3D view in the browser](#3d-view-in-the-browser)).

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
| `--pak3d DIR` | directory of a pak 3D (models, textures, manifest of the 3D view) served under [`/pak3d/`](#static-files); default `$SIMUTRANS_DASHBOARD_PAK3D` (for Docker), else none. A path that is not a directory is logged and ignored |
| `--verbose` | log every request (by default only failed ones) |

Tokens are new random values (`secrets.token_urlsafe(16)`) at every start, unless set in the
environment: `SIMUTRANS_DASHBOARD_TOKEN_VIEWER`, `SIMUTRANS_DASHBOARD_TOKEN_PLAYER`,
`SIMUTRANS_DASHBOARD_TOKEN_ADMIN` (at least 16 characters of `A-Z a-z 0-9 - _ . ~`, all different;
the admin token only with `--enable-admin`). Ctrl+C stops the bridge. The game may start, stop or
load other worlds while the bridge runs; the bridge reconnects (1 to 10 s backoff).

## Roles

| Role | Read commands | Action commands |
|---|---|---|
| viewer | `ping status tile map players cities stations station convoys lines factories messages poll positions palette minimap map_changes labels finance line convoy line_route city factory supply_chain goods world_stats`, `factory_status` of the bridge, and the [3D view](#3d-view) reads `desc_list scene3d heights vehicles3d` | none |
| player | same | `view zoom pause fast_forward tool` |
| admin | same | player's + `cash` |

A game whose remote control is read only (`-remote_control_readonly`, from its greeting) accepts no actions,
or only `pause` and `fast_forward` with `-remote_control_time`: the bridge then offers and accepts only those
(`allowed.action` of the session, otherwise 403). On a dedicated server they pause and speed up the game for
all clients (see the commands `pause` and `fast_forward` in [tools/mcp](../mcp/README.md)).

Never available, whatever the role: `eval`, `screenshot`, `click`, `move`, `drag`, `wheel`,
`key`, `text`, `unlock_game`, `remove_password`, `tool_visibility`, `windows` and every command
not listed above. `tool` always acts as the active player of the game (`player`/`unowned` are
refused) and refuses `tool_lock_game`, `tool_generate_script` and the scripted tools.

## Sign in and sessions

* `GET /?token=T` checks the token and answers `200` with the session cookie
  `sdash_<port>=<id>; HttpOnly; SameSite=Strict; Path=/` (plus `Secure` when the request has
  `X-Forwarded-Proto: https`) and a short page that goes on to `/` by itself (`<meta http-equiv="refresh">`,
  which replaces the history entry, so the token leaves the address bar). Not a `302`: a link opened from
  another site or app (chat, mail) is a cross-site navigation, and browsers do not send a `SameSite=Strict`
  cookie on its redirect, so the redirected request would show the login page again.
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

All API answers are JSON (`application/json; charset=utf-8`, `Cache-Control: no-store`, except the
cached [3D view](#3d-view) replies). Errors of the bridge are `{"ok":false,"error":"<text>"}`. Replies of
1 KB and more are gzip compressed for clients that send `Accept-Encoding: gzip` (`Vary: Accept-Encoding`),
see [Compression](#compression).

| Status | Meaning |
|---|---|
| 200 | the game answered `"ok":true` |
| 304 | map tile, 3D chunk, `desc_list`, `heights` or `/pak3d/` file unchanged (`If-None-Match`) |
| 400 | the game answered `"ok":false` (reply passed on), or invalid arguments/JSON, or a `GET` with a body, or an invalid or repeated `Content-Length` |
| 401 | not signed in |
| 403 | command not allowed for the role, or a check of an action request failed, or a `GET` of `/api/` or `/tiles/` that the browser marks as made by another site (`Sec-Fetch-Site` other than `same-origin`/`none`; other clients send no such header) |
| 404 | no such page/file, map tile or 3D chunk outside of the map, the game has no map export, or `/pak3d/` without `--pak3d` |
| 411 / 413 / 415 | chunked body / body over 16 KB / wrong Content-Type of an action |
| 421 | the Host header is not one of the dashboard's names |
| 429 | rate limit (`Retry-After: 1`): 30 requests/s per session with bursts up to 60 (`scene3d` and `vehicles3d` have buckets of their own, see [3D view](#3d-view)), or more than 2 large requests at once, or the map exports of the browsers used up their share of the game's time (see below), or too many failed logins |
| 501 | the game has no 3D export: `{"ok":false,"error":"unsupported","detail":"..."}` |
| 502 | the game is not reachable |
| 503 | the game connection is busy for over 30 s, 64 event streams are open, too many 3D requests wait for their game connection or the game did not answer one within 30 s (`Retry-After: 1`), or the game is not ready (no world) |

### GET /api/session

```
{"role":"viewer|player|admin",
 "allowed":{"read":["ping","status",...],"action":["view","zoom","pause","fast_forward","tool"]},
 "game":{"connected":true,"missing":[],"events":true},
 "bridge":{"version":"0.1.0","game_port":13360},
 "view3d":{"supported":true,"pak3d":false}}
```

`game.missing`: see [Older engines](#older-engines). `game.events`: the event connection is
subscribed (false while it is not, e.g. with `--no-events` or a game without protocol 2).
`view3d.supported`: the game has the 3D export (`false`: hide the 3D tab, its requests answer 501;
`null`: not known yet, e.g. the game is not connected); the same news reaches the event stream as
`"3d"` in `game.missing`. `view3d.pak3d`: the bridge serves a pak 3D under `/pak3d/` (`--pak3d`).

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

### 3D view

The 3D view reads the 3D export of the game (tools/mcp/README.md, "3D export" and "Map changes for the
3D view") through the bridge, which caches it and keeps it away from the other game connections. The
replies are the game's replies unchanged (the zlib+base64 blocks as they are) plus `"ok":true`:

| Endpoint | Arguments | Kept by the bridge | Browser |
|---|---|---|---|
| `GET /api/desc_list` | `kinds` (optional, comma separated, any order: `buildings vehicles ways bridges tunnels trees signs wayobjs goods citycars pedestrians`) | until another world or a reconnect | `private, no-cache` + `ETag` |
| `GET /api/scene3d` | `cx`, `cy` (required), `size` `16`/`32`/`64` (default 64) | until `map_changes` reports its 64 × 64 cell | `private, no-cache` + `ETag` |
| `GET /api/heights` | `step` `1`/`2`/`4`/`8`/`16` (required), `x1 y1 x2 y2` (all or none; default the whole map) | as `scene3d`, but changed regions are fetched again at most every 10 s | `private, no-cache` + `ETag` |
| `GET /api/vehicles3d` | `x1 y1 x2 y2` (required, each side at most 256 squares), `extras` `0`/`1` | 100 ms, shared by all sessions | `no-store` |
| `GET /pak3d/<path>` | files of the `--pak3d` directory (manifest, models, textures, `LICENSES.md`) | not cached (read from disk, gzip kept in memory) | see [Static files](#static-files) |

```
GET /api/scene3d?cx=6&cy=7
-> 200 {"cx":6,"cy":7,"size":64,"x0":384,"y0":448,"w":64,"h":64,"rev":266,"desc_gen":1289098974,"water":-2,
        "season":2,"snowline":12,"rotation":0,"encoding":"zlib+base64","corners":"eJ..","ground":"eJ..","count":4332,
        "objs_layout":"x:u8,y:u8,z:i8,kind:u8,desc:i16,a:u16,b:u16,owner:i8","objs":"eJ..","t_us":1349,"ok":true}
   ETag: "s3-5f0c..."   Cache-Control: private, no-cache
```

* **Arguments** are decimal integers (at most 6 digits); any other argument (also the game's `objs` and
  `level`) gives 400. A chunk outside of the map gives 404 `chunk is outside of the map`. Regions need
  x1 ≤ x2, y1 ≤ y2, no negative values and a start inside the map (400 `region is outside of the map`);
  they are clipped at the east and south edge. `heights` regions of more than 66049 samples get 400
  before the game is asked. 503 while the game has no world.
* **ETag** = hash of the reply without `t_us` and `rev`, so a chunk fetched again with the same content
  keeps its ETag: `If-None-Match` gives 304 (the gzip form carries `"<tag>-gz"`, both match). A browser's
  `fetch()` revalidates such replies by itself and returns the cached body; compare the `ETag` header
  with the one of the geometry you have to skip rebuilding an unchanged chunk.
* **Changes.** While `scene3d` or `heights` are requested (and for 10 minutes after) or map tiles are, the
  poller follows `map_changes chunk=64` (when `poll.rev.map` changes, every 2 s while events are live,
  else every second; and every 10 s), drops the cached replies whose cells changed and then sends the SSE
  event `map_changes` with `cells` (64 × 64 cells = `scene3d` chunks of size 64; a chunk (cx, cy) of size s
  lies in cell (⌊cx·s/64⌋, ⌊cy·s/64⌋)). Load the chunks in `cells` again (all after `full` or a `snapshot`);
  the bridge then has them fresh already. A map change is only known to lie between two map gens: a cached
  reply made in that window is checked with one light `map_changes since=<its rev>` (pipelined by the
  poller, or at its next request) instead of being fetched again. That matters after the game starts its
  change tracking (after 2 minutes without `minimap`/`map_changes`/`scene3d`/`heights`/`poll`, or when no
  connection was left), which reports every cell once within some 0.3 s: on the NYC map 8 of 9 freshly
  loaded chunks were fetched again without the check, none with it.
* **Single flight**: concurrent requests for a reply that is not cached (or stale) share one game request.
* **`heights`** tolerates staleness (the far terrain): a cached region whose cells changed is served for
  10 s after it was fetched, then checked or fetched again (the ETag stays when the heights did not change;
  the game marks cells for every kind of change, not only terrain).
* **Limits.** `scene3d` has a bucket of its own per session like map tiles (60 requests/s, bursts up to
  120), `vehicles3d` one of 5/s with bursts up to 10 (429 `Retry-After: 1` beyond, other sessions are not
  affected); `desc_list` and `heights` count in the general 30/s. The heavy requests (`desc_list`,
  `scene3d`, `heights`) run on a game connection of their own, `vehicles3d` on another one, so neither
  delays the poller, the event connection, the other browser requests or each other. Each connection
  serves its requests in order (FIFO); at most 32 heavy and 8 `vehicles3d` requests wait, further ones get
  503 `Retry-After: 1` at once, and a request waits at most 30 s. The game answers at most one heavy
  request per frame, so chunks come one after the other (about 16 ms each on a laptop).
* **Memory**: chunks up to 64 MB (all 256 chunks of the NYC map take 4 MB), heights 8 MB, `desc_list`
  8 MB, `vehicles3d` 4 MB, least recently used first.
* **Older engines** (the server image before the 3D export): the bridge asks the game once per connection
  (`vehicles3d` of one square); without the commands `view3d.supported` is false in `/api/session`,
  `game.missing` contains `"3d"`, and the four endpoints answer 501 `{"ok":false,"error":"unsupported",
  "detail":"..."}` without asking the game again.

Measured on the NYC map (1024 × 1024, 2029, game paused, laptop, bridge and test client on the same
computer):

| Request | Cold (game) | Cached | Bytes (gzip) |
|---|---|---|---|
| `desc_list` | 76–78 ms | 3–14 ms | 375 KB (40 KB) |
| `scene3d`, the 9 chunks around (6, 7) | 14–44 ms each (median 16) | 1.4–2.1 ms | 6.4–13 KB each, 88 KB together (67 KB) |
| the same 9 at once (another area) | 110–142 ms for all (one per frame) | | |
| all 256 chunks one after the other | 4.1 s (median 11–15 ms, p95 30–42 ms) | | 1.69 MB gzip |
| `heights step=4` (whole map, 257 × 257) | 16–34 ms | 1.5–2.7 ms | 13 KB (9.9 KB) |
| `vehicles3d` 128 × 128 of Manhattan (435 cars) | 15–17 ms | 1.6–1.7 ms (within 100 ms) | 4.6 KB (3.5 KB) |
| the same with `extras=1` (2974 rows) | 15 ms | | 21.5 KB gzip |

A road built with the game's `tool` command was reported (SSE `map_changes` with its cell) after
0.3–0.7 s, and the chunk came again with the new road. Revalidating 9 unchanged chunks: 9 × 304. All 256
chunks loaded, then 0.93 game months at 8 times the normal speed (across a new year): 14 chunks had
changed and came back as 200, 242 as 304 (most without asking the game: the cells reported at the start
of the tracking were checked away), and a direct fetch of every chunk from the game afterwards matched
what the bridge served (no stale chunk). In another run of the same length 204 chunks changed.

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
| `pause` | `on`: bool (missing = toggle) | `{"paused":bool}`; in network games only on the server, for all clients |
| `fast_forward` | `on`: bool (missing = toggle) | `{"fast_forward":bool}`; in network games only on the server: 4× normal speed for all clients (`time_multiplier` 64) |
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
| `map_changes` | `{"gen":N,"full":bool,"chunks":[[cx,cy],..],"cells":[[cx,cy],..],"world_gen":N}` — map squares changed in these chunks of 256 × 256 squares (step 1 units, the map tiles) and in these cells of 64 × 64 squares (the `scene3d` chunks, see [3D view](#3d-view)); `full`: everything (chunks and cells empty); only while tiles or 3D chunks are requested, map export only |

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
  well (changes may have been missed); unchanged ones answer 304. The 3D view does the same with its
  chunks and `cells`.
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
| `3d` | no `desc_list`, `scene3d`, `heights`, `vehicles3d`: the [3D view](#3d-view) endpoints answer 501 `unsupported`, `view3d.supported` is false |

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

### 3D view in the browser

The tab "3D" shows the map in 3D with three.js (`web/vendor/three`). It is offered when the game has the
3D export (hidden when `/api/session` has `view3d.supported` false or `game.missing` contains `"3d"`);
three.js and the modules in `web/js/scene3d/` load only when the tab is opened, and leaving the tab frees
the renderer, the WebGL context and the worker again.

* **What it shows.** Around the point looked at, the map in chunks of 64 × 64 squares (`/api/scene3d`),
  built in a Web Worker and added one per frame, in a stylized low-poly look with flat colours: terrain
  with cliffs and water; ways with a look per way type (roads with sidewalks, highways, tracks with
  sleepers, trams, monorails, rivers, canals, runways), slopes, elevated ways, bridges with pillars, tunnel
  portals, overhead lines, signals, signs and power lines; stations, stops and depots; all other buildings
  generated from the pak's building list (see below); trees, fields and rocks; the moving vehicles (see
  below). Buildings, stations, depots and vehicles of a company carry its colour (the game's palette when the engine has `palette`: canopy roofs,
  stop signs, a band over depot doors, the roof rim of station buildings, headquarters). Everywhere else
  the far terrain: one coarse mesh of the whole map from
  `/api/heights` (step 4 for maps up to 1024 × 1024 squares, 8 on phones; larger maps or finer steps
  in regions of at most 66049 samples per request), textured from the minimap tiles of the `climates`
  and `forest` modes (one pixel per square up to a texture of 2048 pixels, 512 on phones) in the colours
  of the chunks, so that water, cities, roads, railways, stops, factories, fields and forests show from far
  away. The far terrain is not drawn where a chunk is shown (a mask of the shown chunks in its shader
  discards those squares), so the two never overlap or z-fight; it lies 0.08 units lower, so the seams
  show the cliffs of the chunks.
* **Generated buildings.** Every building of `/api/desc_list` except stations, extensions and depots gets
  a procedural model (`web/js/scene3d/gen/`): a form chosen by category and name keywords — city blocks
  with storeys, setbacks, crowns and spires for tall buildings, gable, hip, mansard or flat roofs (by
  climate and height) with water tanks, vents and antennas; large low-rise buildings as wings around a
  yard; industrial halls with saw-tooth roofs; factory sites with a hall, an office and features by
  recipe (chimneys, tanks, silos, distillation columns, cooling towers, headframes, piles, ...); wind
  turbines, solar fields, oil rigs; churches, cathedrals, mosques, towers, lighthouses, castles, parks,
  stadiums, monuments, town halls with a clock tower and company headquarters. The size comes from the
  desc: footprint and `height` (the drawn height in levels; `level` only picks a height within the range
  that a height of several image rows stands for), so towers stand where the game draws towers. Windows
  are drawn by the shader of the `building` material from a small per-vertex attribute (rows of
  windows by storey, no textures; they fade to an even tone when they get smaller than about two
  pixels). The seed of every random choice is the desc name, so a building looks the same everywhere;
  layouts turn the model towards the street like the game (layout 0 faces south, 1 east, 2 north, 3
  west). A model is generated once per desc and layout (headquarters also per owner) in the worker,
  cached, and its copies are merged into one mesh per chunk (one draw call; instancing repeated models
  was measured to cost more draw calls than it saves). A building larger than one square is drawn by the
  chunk that holds its north-west square (offset 0,0), once, also across chunk borders; the chunks it reaches
  into draw an extra copy ("overhang") that is shown only while that chunk is not, so a building at a chunk
  border does not lose its part when only the neighbour chunk is loaded. The rules —
  categories, keyword tables, palettes, roof choices, tower setbacks, factory recipes, tree shapes and
  crops — are in `web/js/scene3d/gen/rules.json` (format 1; the code has a default for every value). A
  pak 3D merges its own rules over them (objects key by key, arrays and values replaced) and draws selected
  objects with glTF models ([Pak 3D](#pak-3d-gltf-models)).
* **Trees, fields, rocks.** Trees are low-poly shapes per tree desc (conifer, broadleaf, birch, poplar or
  cypress, palm, cactus, shrub: by name keywords, else by the climates the tree grows in), at most 30
  triangles, scaled by the age class, with a small stable jitter of position, turn and size. The season is
  drawn by the tree shader (see "Seasons and snow"): broadleaf trees take autumn colours, are partly bare in
  winter (twig colour, the crown stays) and light in spring, conifers darken in winter. A shape with at least 96
  copies in a chunk is one instanced draw call (material per class: evergreen, broadleaf, none), fewer are
  merged into a tree mesh whose vertices carry the class, a random, the crown shade and the ground level
  (attribute `tree`). Where a square is smaller than 9
  pixels (zoomed out, or far away in the free camera) the trees switch to shapes of 4–10 triangles.
  Fields get the crop of the nearest factory in the chunk (grain, corn, cotton, pasture with fences,
  chicken pens, saplings) as a patch with rows; ground objects (the export does not say which) become
  rocks, bushes or cacti by the climate.
* **Loading.** Only chunks in view, nearest to the point looked at first, at most the chunk budget (30,
  phones 12), and only while a chunk is at least 192 pixels wide: zoomed out further only the far
  terrain is drawn. Chunks out of view stay in memory (48, phones 20) but are not drawn. A chunk named
  by `map_changes` is fetched again at once (an unchanged one answers 304); the far terrain at most
  every 10 s (the heights, which keep their ETag when unchanged, and the minimap tiles that cover the
  change).
* **Vehicles.** Every car of every convoy, and with the people button of the toolbar (on by default on
  computers, off on phones; local storage `sdash.v3dExtras`) city cars and pedestrians, from
  `/api/vehicles3d` for the squares in view plus a margin (at most 256 × 256 around the point looked at,
  snapped to multiples of 8 so that sessions share the bridge's cache). Requests start at least 205 ms apart
  (at most 5 per second, the bridge's limit), every 600 ms after three replies in which nothing moved, every
  second while the game is paused, at once when the view moves to other squares; none while a square is
  smaller than 5 pixels (city cars 10, pedestrians 32 pixels, in the free camera by their distance), while
  the page is hidden or the tab is left; a 429 waits for its `Retry-After`. The motion is snapshot
  interpolation: the game time comes from the replies (`ticks`; the rate from a window of replies, the
  freshest reply of the last second gives "now", since the bridge may answer from a cache up to 100 ms old),
  and the cars are drawn 450 ms in the past (longer, up to 1.2 s, while replies come later than that, e.g.
  in fast forward), between two samples of the same car (convoy id + index; city cars and pedestrians are
  matched to the previous one of the same kind and desc where it could be by now), along the path through
  the middles of the square edges they crossed (`dir`, `nx`/`ny`: no cut corners on curves and diagonal
  squares), with heights from `z` + `zoff` (slopes, bridges, flight altitude). A late reply lets the cars go
  on along their heading for at most 0.35 squares; the difference to the next sample fades out instead of
  jumping. Where the game places cars anew — a convoy turning round (direction reversed), leaving a depot
  (flag 2), driving into one (flag 3), or a car more than 2 squares (or 1.6 times what its speed allows) away
  from its last sample — the car waits at its old place until the new sample's time and then appears at the
  new one, never moving across; cars that drove into a depot vanish when their last sample is reached. Cars
  in a tunnel (flag 6, or not drawn by the game, flag 7, except aircraft in the air) are hidden from where
  they enter the square. A paused game freezes the cars where the game shows them. Headings turn at most
  about 690 degrees per second; convoy cars are drawn as the chord from their front to the next car's
  front (the game's positions are the fronts, the cars follow each other at their lengths), so trains bend
  along curves; road vehicles and city cars drive on the right hand lane (0.14 squares from the centre line:
  the pak images carry the lane, so the export does not), pedestrians on the sidewalk of their side;
  aircraft bank in turns.
* **Vehicle bodies.** Generated low-poly bodies (`web/js/scene3d/gen/vehicles.js`), one instanced draw
  call per body shape, rebuilt every frame: by way type, length (`length` in 1/16 square), power and
  freight — locomotives (steam, diesel or electric by name keywords, else by year and speed), multiple unit
  head cars with a cab and coaches, mail vans, and freight wagons by the goods category of their freight
  (box, reefer, tank, open hopper with a load, covered hopper, stake wagon with logs, steel coils,
  containers, car carrier); trams; monorail and maglev cars with noses on the head cars; buses, mail vans,
  trucks and trailers with the same loads; ships (tanker, bulk carrier, container ship, ferry, tug, barge;
  drawn twice their length); aircraft by capacity (propeller, regional, narrow and wide body with four
  engines, cargo, helicopter); city cars (sedan or van, coloured by colour words in their name) and
  pedestrians. A powered last car of a convoy faces backwards (push-pull, multiple units). The company
  colour paints the bodies through a per-vertex tint (windows, roofs, bogies and loads keep their colours).
  The rules — goods to load kinds, goods categories, name keywords, way type families, ship and aircraft
  sizes, city car colours — are in the `vehicles` section of `gen/rules.json` (a pak 3D may override them
  and draw selected vehicles with glTF models).
* **Controls.** Isometric camera (the default): drag (one finger) pans, wheel or pinch zooms (out to the whole
  map), two fingers also pan, Q/E or the buttons rotate by 90 degrees (the four views of the game). F or the
  eye button switches to the free camera (perspective): right drag or two fingers moved together turn it,
  drag pans, the wheel or a pinch zooms up to a view of the whole map from above, and Q/E turn it to the next
  of the four iso directions. Switching back to iso keeps the point looked at and takes the nearest iso
  direction. Keys (not while typing in a field): Q/E rotate, F iso/free, V follow the selected convoy (again:
  stop), L names on/off, + and - zoom, arrows pan, Escape stops following (and closes the quality panel or the
  authors page). A drag holds the ground: the point under the mouse or finger stays under it in both cameras
  (in the iso view also while a pinch zooms, around the middle of the fingers), and a fast drag glides on after the
  release and slows down like the 2D map; a press stops it. The camera code does this itself (`camera.js`);
  MapControls only zoom and turn. Toolbar (top right, in two columns on screens under 540 pixels high): rotate
  left/right, zoom in/out, iso/free, city cars and pedestrians, names, quality panel, and with a pak 3D the model
  authors. Camera
  mode, rotation and zoom are remembered per browser (local storage `sdash.v3dCamera`); the view starts
  where the 2D map is, or where the 3D view was when the tab is opened again. **Follow:** "Follow in 3D" in
  the convoy panel or the convoy's info card (or V for the selected convoy) opens the 3D tab and keeps the
  middle of the convoy at the centre, in the iso and the free camera (zoom and turning the free camera keep
  following; a pan, an arrow key, Escape, the locate button or the × of the badge stop it). The badge at
  the top shows the convoy's name; a convoy that is not among the fetched cars is looked for where the
  positions feed has it.
* **Clicks.** A click or tap selects like a click on the 2D map and shows the same info card ("Details"
  opens the panel, the locate button centres the 3D view): the station on the square (found from any of
  its squares with `station x= y=`), the factory (any square of its building; `factory x= y=` when the
  factory list does not know it), the city of a town hall, else the square itself (tile card). A press
  that moves more than 5 pixels (10 with a finger) is a drag and selects nothing, nor do pinches and
  right clicks. The ray follows the heights of the shown chunks and the tops of their buildings, bridges
  and elevated ways, so a tower in front of a square is hit first; on the far terrain only the positions
  in the station, factory and city lists count. The mouse highlights the square under it, the selected
  square is outlined in red. Like on the 2D map, a vehicle under the pointer comes first (within its drawn
  length plus 6 pixels, 14 with a finger; not when a building or hill in front is hit first): it selects its
  convoy (info card; its cars get a red outline) and opens the convoy panel (on phones only the info card).
  City cars and pedestrians cannot be clicked.
* **Day and night** (option of the quality panel, off by default: the dashboard cannot know whether the
  player's game shows day and night, which is a setting of each game client). Mirrors the game
  (`display/simview.cc`, `simgraph16.cc`): with the date shown in days (the default date format) a game day
  lasts `ticks_per_month` / days of the month; the half hour of the day gives the night level 0–4 of the game's
  table (night from 21:00 to 6:00, dusk 19:30–21:00, dawn 6:00–7:30), interpolated between half hours so it
  changes smoothly; the game darkens red and green by 0.75^level and blue by 0.83^level, the view scales its
  hemisphere light, sun and sky by the same factors. The sun swings from the left of the screen in the morning
  to the right in the evening and stands higher at noon (it stays at the upper left of the screen in all four
  rotations), at night it is a dim moon from the usual direction, and the shadows fade to a third. The game
  time is the poll's `ticks` (with `ticks_per_month` and the date), run on smoothly between polls at the rate
  of the last polls and frozen while paused. At night a share of the windows of generated buildings is lit
  (warm, some cool; per window from its cell, facade and building: the same windows every night, more of them
  as the night falls, up to 62 %), and the `night_emissive` materials of the pak 3D glow (buildings switch on
  one after the other by their place, vehicles and featured models always). Everything is shader uniforms
  (`web/js/scene3d/sky.js`, `ENV`): no geometry is built again; while the light changes the view draws at
  most every 33 ms (100 ms on the low profile). With the date shown as months only (one day per month in
  the game) the view's day is still a game day, so it runs faster than the game's.
* **Seasons and snow.** The season comes from the poll's month (the game's `month_to_season`: December–March
  winter, April–May spring, June–September summer, October–November autumn) and fades in over 1.5 s in the
  tree shader. Snow lies where the game draws it: on the ground of squares at or above the snowline
  (`snowline` of the `scene3d` replies; the game moves it with the season), as white on flat and sloped ground
  (not on cliffs), a thinner layer on ways, on station roofs and decks, on the roofs of buildings whose ground is
  above the snowline (generated buildings carry their ground level in the window attribute, models their copy's
  base), on the crowns of trees and on the far terrain; arctic land is white anyway. The bridge keeps chunk
  replies until their squares change, with the snowline of their time, so the newest reply (map revision) wins,
  and after every new month the worker asks for one 16 × 16 chunk at a place that changes each month (rarely in
  the bridge's cache) to learn the current snowline. A new season or snowline is a uniform change: no chunk is
  fetched or built again (pak 3D models with `{season}` variants still switch only when their chunk is fetched).
* **Labels** (the tag button of the toolbar or L; on by default). The names of the cities at their town halls
  (largest first, bigger type over 50 000 citizens) and, from 28 pixels per square, of the stations (most waiting
  first) float over the view (CSS2DRenderer, `web/js/scene3d/labels.js`): a fixed pool of 128 elements is placed
  only when the camera, the city or station list or the loaded ground changed, each label where it does not
  overlap one already placed (a box from the length of its name, stations with a wider margin), the rest hidden
  (placing takes 0.2–0.5 ms).
  Names are text nodes; the labels take no clicks.
* **Shadows** (on by default on the medium and high profiles, off on low and on phones). One shadow map of the
  sun (2048², medium 1024²) fitted every frame to the ground under the screen corners in the sun's view (at most
  140 squares from the point looked at), its size in steps of 15 % and its centre snapped to whole texels so the
  shadows do not shimmer while panning; they fade out zoomed far out (under 10 pixels per square) and at night.
  Buildings, stations, trees, models and vehicles cast shadows; everything receives them. Switching them
  compiles the materials again (a short hitch).
* **Quality panel** (the sliders button of the toolbar; Escape closes it). Quality profile: automatic (low on
  phones, else high) or fixed low, medium or high; shadows; detail distance (near, normal, far: the pixel
  thresholds of the model LODs × 0.7 / 1 / 1.5, the chunk budget × their square root); trees (the profile's
  density or 25–100 %); names; day and night; city cars and pedestrians. Saved per browser (local storage
  `sdash.v3dQuality`, `sdash.v3dExtras`); a new profile or tree density builds the view anew (the camera stays),
  the rest applies at once.
* **Requirements.** WebGL 2 (without it the tab shows a message; a lost graphics context shows an error, opening
  the tab again starts anew), ES modules and module workers; current Chrome, Edge, Firefox and Safari have them.
* **Privacy and security.** The 3D view talks only to the bridge (the endpoints below, behind the session; no
  CDN, fonts or other servers) and keeps its settings in the browser's local storage (`sdash.v3dCamera`,
  `sdash.v3dQuality`, `sdash.v3dExtras`). Names from the game and texts of a pak 3D (manifest, `LICENSES.md`)
  are only ever text nodes. The one change of the content security policy for it is `connect-src 'self' blob:`
  (was `'self'`): GLTFLoader loads the textures embedded in `.glb` files through `blob:` URLs that the page made
  itself (see [Pak 3D](#pak-3d-gltf-models)); `script-src`, `img-src` and the rest are unchanged (the worker is
  a module file of the dashboard), no `worker-src`, no `wasm-unsafe-eval`. The viewer role can use the 3D view
  fully; its requests have rate limits and queues of their own ([3D view](#3d-view)).
* **Quality profiles.** High (computers): antialiasing, pixel ratio up to 2, 30 chunks (48 kept), far terrain
  of 257 × 257 samples with a texture of up to 2048 pixels, all trees, shadows with a 2048² map. Medium:
  antialiasing, pixel ratio up to 1.5, 20 chunks (32 kept), 193 × 193 samples, 1024 pixels, three quarters of the
  trees, shadows 1024². Low (phones: coarse pointer and a screen side under 820 pixels): no antialiasing, pixel
  ratio up to 1.5, 12 chunks (20 kept), half of the trees, 129 × 129 samples, 512 pixels, no shadows
  (`PROFILES` in `web/js/scene3d/config.js`). With the automatic profile the view adapts: when drawing takes
  more than 37 ms per frame (median over 2.5 s, at least 45 frames in a row, while the view moves) it lowers the
  pixel ratio and the chunk budget, halves the shadow map, then drops the shadows, up to three levels; after two
  such windows in a row under 20 ms it goes up a level again (not sooner than 10 s after going down, 60 s when
  going up had just made it slow again; `window.__view3d.info().adapt`). Fixed profiles do not adapt.
* **Phones and tablets.** The automatic profile picks low on phones (coarse pointer and a screen side under 820
  pixels; tablets get high and adapt like computers). Touch: one finger pans, a pinch zooms, two fingers pan
  (iso) or turn the free camera, a tap selects (a vehicle only opens its info card, not the full-screen panel),
  a touch held longer than 0.6 s selects nothing, and the browser's context menu and text selection are held
  off on the view. The hint line (it speaks of the mouse) is hidden on touch screens. The start of the view is
  split into short tasks for slow phones: each shader program is built in a task of its own before the first
  chunk arrives (also its uniforms, which three.js would read on first use), the far terrain's mesh, programs
  and texture upload come in separate tasks, and new vehicle body shapes are generated for at most 6 ms per
  frame (the rest in the next frames).
* **Endpoints.** `/api/desc_list?kinds=buildings,ways,trees,bridges,tunnels,signs,wayobjs` (once),
  `/js/scene3d/gen/rules.json` (the generator rules, once), `/api/heights?step=16` (the height range), `/api/heights?step=4|8[&x1&y1&x2&y2]` (far terrain), `/api/scene3d?cx&cy`,
  `/api/scene3d?cx&cy&size=16` (the snowline probe, once per game month; the game time, the month and the
  city and station lists of the labels come from the dashboard's feeds),
  `/tiles/climates|forest/<step>/<cx>/<cy>.png` (far texture), `/api/station?x&y` and
  `/api/factory?x&y&history=0` (clicks), `/api/desc_list?kinds=vehicles,goods,citycars,pedestrians` (once,
  the vehicle bodies), `/api/vehicles3d?x1&y1&x2&y2[&extras=1]` (vehicles), the requests of the info card,
  and the SSE events `map_changes` and `snapshot`; with a pak 3D (`/api/session` → `view3d.pak3d`) also
  `/pak3d/manifest.json`, its rules and generator files, the model files (each fetched by the worker to check
  it and once more by GLTFLoader, which the browser answers from its cache after a 304) and `/pak3d/LICENSES.md`
  (authors page). Without a pak 3D nothing under `/pak3d/` is requested and GLTFLoader is not loaded.
* **Ways across chunk borders.** A diagonal (the game's chain of curve squares) that crosses a chunk border
  needs to know the neighbour square: the worker remembers the ways on the border squares of every chunk it
  built; a neighbour chunk not built yet is guessed from the other end of the square (a diagonal that came in
  goes on), so diagonals stay straight lines over the border either way.
* **Docks.** A dock square on the water has no deck (ships lie there), only a quay edge with bollards on its
  land side; the land square keeps the pier with its crane, shelter or hopper.
* **Limitations.** glTF models only for buildings, vehicles, trees and signs (ways, bridges, tunnels and
  overhead lines stay generated); a click resolves to a vehicle or a square, not to another object on it;
  the far terrain shows heights every 4 squares (8 on phones) and the minimap colours of one pixel per square;
  no street lights or vehicle lights at night; the shadow of an animated model part stays in its rest pose.
  Vehicles: only within 256 × 256 squares
  around the point looked at; cars far beyond the
  drawn time (a reply later than 0.35 squares of driving) slide back to their path; between samples
  more than a square apart (fast forward) the path between the two edge middles is straight; a car's
  height follows its samples, not the ramp profile; pedestrians walk on the centre line of the sidewalk.

Measured on the NYC map (1024 × 1024, game paused, headless Edge 1600 × 900 at pixel ratio 1, frames not
capped; one frame = drawing plus reading one pixel back, so the GPU time is included; p50 / p95):

| View (Midtown) | Intel Arc (integrated) | RTX 4060 laptop | Phone proxy: 390 × 844, CPU 4× slower, phone profile | Triangles / draw calls (computer) |
|---|---|---|---|---|
| iso, default zoom (8 chunks) | 8.0 / 9.1 ms | 1.8 / 2.5 ms | 5.1 / 6.7 ms (7 chunks, 496 k triangles) | 849 k / 71 |
| iso, whole map (far terrain only) | 3.7 / 14.8 ms | 0.6 / 0.8 ms | 1.7 / 2.7 ms (34 k triangles) | 133 k / 2 |
| iso, 3.2 pixels per square (30 chunks + far) | 8.6 / 11.3 ms | 2.9 / 3.7 ms | 16.0 / 21.7 ms (12 chunks, 907 k triangles) | 2.19 M / 282 |
| free camera | 7.2 / 10.3 ms | 1.9 / 2.5 ms | 7.4 / 10.3 ms | 1.06 M / 95 |

The densest forest (8400 trees per chunk) zoomed out to 3.2 pixels per square: 1.5 M triangles, Arc 7.4 /
16.2 ms (4.0 M and 11.9 / 37.5 ms without the low detail trees). The JS heap stays at 30–90 MB. The
worker builds a dense Manhattan chunk (about 1900 buildings) in 9–18 ms once its models are cached (median
of the shown chunks 9.5 ms); the first chunks also generate their models (all 5164 models of pak128 take
about 0.2 s in all, each once per worker), so the first ones take up to 80–110 ms in the worker. A chunk is
added on the main thread in 0.4–1 ms (phone proxy 2–3.5 ms); the far terrain takes 20 ms (phone proxy
50 ms) on the main thread, its shader compiles in the background (`compileAsync`). The first view is ready
0.8–1.8 s after the tab is opened. After opening the tab no main thread task took more than 100 ms on the
computer outside the measurements (none over 50 ms in the F7 run with the game running).

Phones and tablets, measured with the game running (vehicles) on the NYC map, Manhattan, iso at the default zoom,
headless Edge on the integrated Intel Arc at the browser's normal frame rate (60 per second), CPU throttled
through CDP (frame = time between two frames, p50 / p95; longest task = main thread task after the first frame):

| Device proxy | Profile | First chunk / view ready | Longest task | Frame | Pan; pinch (frame p50 / p95) | JS heap, GPU memory (estimate) |
|---|---|---|---|---|---|---|
| phone 390 × 844, 3×, CPU 4× | low (pixel ratio 1.5, 7 chunks, 0.70 M triangles, 59 draw calls, 250–290 cars) | 1.5 / 1.7 s | 61 ms (before F7b: 117 ms) | 16.7 / 17.3 ms | 16.7 / 16.8 ms; 16.7 / 16.8 ms | 51 MB, 30 MB |
| phone, CPU 6× | low | 2.2 / 2.9 s | 102–123 ms (before: 194–216 ms) | 16.7 / 19–20 ms | 16.7 / 17–33 ms; 16.7 / 33 ms | 49 MB, 30 MB |
| tablet 820 × 1180, 2×, CPU 4× | high (pixel ratio 2, shadows, 1.35 M triangles, 120 draw calls, 890 cars) | 1.2 / 2.6 s | 127 ms | 16.7 / 30 ms | 16.7 / 33 ms; 16.7 / 33 ms | 80 MB, 157 MB |
| tablet, CPU 6× | high | 2.0 / 3.9 s | 113 ms | 26 / 41 ms | 33 / 50 ms; 33 / 67 ms | 87 MB, 157 MB |
| computer 1600 × 900 | high | 0.7 / 1.1 s | none over 50 ms | 16.7 / 16.8 ms | | 77 MB, 91 MB |

The view itself is created in one task before its first frame (WebGL context, renderer, layers): 130 ms on the
phone proxy at 4×, 200–340 ms at 6×. The GPU estimate (`window.__view3d.gpuMemory()`) adds up the buffers and
textures of the scene, the shadow map and the drawing buffer (with 4× multisampling when antialiased: most of
the tablet's 157 MB).

Vehicles, measured the same way with the game running (normal speed unless noted; Midtown, iso, default zoom;
frame = time between two frames drawn without a cap, render = drawing plus reading one pixel back; p50 / p95):

| Case | Frame | Render | Instances (cars drawn) | Vehicle update per frame (main thread) |
|---|---|---|---|---|
| Intel Arc, city cars on (the computer default) | 3.4 / 21 ms | 8.1 / 9.8 ms | 1175 (690 convoy cars, 486 city cars), 64 k triangles | 1.3 / 2.2 ms |
| Intel Arc, city cars off | 3.1 / 25 ms | 7.6 / 9.3 ms | 701 | 0.9 / 1.5 ms |
| Intel Arc, fast forward (14 000–20 000 ticks/s) | 3.4 / 11 ms | 7.5 / 8.6 ms | 885 | 1.5 / 2.4 ms |
| Intel Arc, free camera following a train | 3.0 / 7.5 ms | 7.6 / 9.3 ms | | |
| Intel Arc, game paused (cars still, frames only on change) | 1.0 / 4.3 ms | 7.8 / 9.5 ms | | |
| Phone proxy, city cars off (the phone default) | 4.7 / 10.8 ms | 8.7 / 11.2 ms | 263 | 0.5 / 0.9 ms |
| Phone proxy, city cars on | 3.2 / 6.8 ms | 5.1 / 6.4 ms | 525 | 1.0 / 1.7 ms |

A reply (690 convoy cars and 490 city cars, 256 × 256 squares at most) costs 1.8 / 2.9 ms on the main thread to
apply (plus its JSON and the inflating of its block, which waits on the browser's stream), 4.7 requests per second
are made, none was refused (429). The p95 of the uncapped frames comes from the instance buffers uploaded every
frame at 300 frames per second: the GPU backs up, which also shows as main thread tasks of 50–90 ms about once a
second; with vsync (a normal browser) there were none over 50 ms in 12 s windows, with or without vehicles. With the
free camera over Manhattan and city cars on, up to about 2900 instances, 1.6 / 3 ms per frame. The motion of 41
cars over 6 s (61 000 frame steps): every step within 3.5 times what the car's speed allows (plus the fading
correction after a late reply), the largest at 0.36 of that; in fast forward at most 1.01 (vehicles start and stop
between two samples there).

Shadows, labels and day and night, measured on the NYC map (Midtown, iso at 26 pixels per square, labels on, game
paused, headless Edge 1600 × 1000 at pixel ratio 1, Intel Arc integrated; render = drawing plus reading one pixel
back, p50 / p95): with shadows 13.7 / 15.7 ms (1.35 M triangles with the shadow pass, 174 draw calls), without
9.9 / 11.9 ms (0.85 M, 97); with vsync both draw at 60 frames per second. Placing the labels takes 0.2–0.5 ms
when the camera moved (none otherwise); day and night and a new season are uniform updates (no geometry); an
animated model off screen forces no frames.

#### Pak 3D (glTF models)

A pak 3D (format, conventions, Blender export and the tools `check_pak3d.py` and `coverage.py`:
[tools/pak3d/README.md](../pak3d/README.md)) is a directory that the bridge serves with `--pak3d DIR`, e.g. a clone
of the [Simutrans-Horizon pak 3D](https://github.com/bdnowicki/simutrans-horizon-pak3d) for pak128. The 3D view
reads it when `/api/session` says `view3d.pak3d: true`:

* **Manifest.** `/pak3d/manifest.json` (format 1) is checked in the browser (`web/js/scene3d/pak.js`, the same
  rules as `tools/pak3d/pak3dlib.py`). Unknown fields are logged as console warnings and ignored; any other
  problem ignores the whole pak and shows its first problems once at the top left of the 3D tab (as text; closed
  with ×, not shown again in that page), and everything is generated. A directory without `manifest.json` (404)
  is no pak. The pak's `rules` and `generators` are merged over `gen/rules.json` before the worker and the vehicle
  bodies start, so they also drive the generated buildings, trees and vehicles.
* **Matching.** Each building, tree and sign of a chunk (worker) and each vehicle, city car and pedestrian
  (vehicle layer) looks up the entries of its kind by the untranslated desc name: exact names first, then
  patterns (`*`, `?`) in file order, with the filters `type climate waytype size system freight`; `{season}` and
  `{climate}` in a model path take the chunk's season and the square's climate (vehicles: summer, temperate).
  Entries bound to a place (`at`) are looked up first, by the building's square with offset 0,0, and only there.
* **Checks.** The worker fetches each model file once and reads its glTF JSON (`pakplace.js`): triangles,
  bounds after the node transforms, embedded texture sizes (PNG/JPEG/WebP headers), cameras, lights,
  extensions that need decoders; a model over the limits (buildings 5 000 triangles, featured 30 000; vehicles
  3 000; trees 500; signs 1 000; textures 1024², featured 2048²) is logged and its objects are generated. The
  main thread checks again after GLTFLoader decoded it (external textures); a model that fails there is
  reported to the worker, which builds the chunks with it again, generated.
* **Placing.** Buildings: one copy at the square with offset 0,0, origin at the middle of the footprint of the
  layout, turned by the layout (layout 0 as modelled, front +Z; 1, 2, 3 by 90° steps), at the ground height of
  that square; all squares of the building skip the generator (also stations and depots). A place (`at`): one
  copy over its whole footprint at the height of the building on its north-west square, turned with the map
  (the place is given for rotation 0; the worker turns it with the chunk's `rotation` and the map size from the
  status, like `koord::rotate90`, and the model by one layout step back per turn); every matching building in the
  footprint skips the generator; the copy belongs to the chunk of the north-west square (a chunk east or south of
  it holding part of the footprint draws an overhang copy while that one is not shown). Trees: the tree's
  place, turn and size jitter of the generated trees, the density setting of phones, `scale_by_age`. Signs:
  where the generated post stands, turned towards the vehicles. Picking uses the top of the model's bounds.
  Vehicles: the car's middle, along the interpolated heading (pitch and roll like the generated bodies), at
  model size; while a model loads or when it fails, the generated body.
* **Drawing** (`pakmodels.js`). A model's nodes are baked into one geometry per material (scaled by
  1/`units.tile`). Copies are instanced: one InstancedMesh per material, all sharing the instance matrices (the
  layout turn is in the matrix), gathered per model and LOD level across all shown chunks into one batch (a model
  with more than 4096 copies gets a batch per chunk); the vehicles fill their batches every frame. Materials
  named `player1`/`player2` (and those of `player_color`) get the first/second company colour of the owner as
  instance colour (`palette` colours when the engine has them), the material's own colour without owner;
  `night_emissive` is dark by day and glows at night (day and night option: buildings one after the other by the
  place of the copy, with a little variation of brightness; vehicles and featured models always). The LOD follows
  the model's size on the screen with thresholds per kind (LOD 1, 2, 3 below: buildings 120, 40, 12 pixels; trees
  64, 22, 7; signs 48, 16, 5; vehicles 44, 15, 5; city cars 30, 10, 4; pedestrians 22, 8, 3), times the detail
  distance setting: a car half a square long shows its LOD 0 from about 88 pixels per square. Building and tree
  models get snow on their upward faces in winter (above the snowline). A building that reaches into a
  neighbour chunk gets an overhang copy there, shown while its own chunk is not. **Animations:** a model with
  animation clips keeps its nodes as separate parts (not merged), each with its node transform as a shader
  uniform; an AnimationMixer per model plays all clips in a loop, the same for all copies, and runs only while
  a batch of the model was drawn in the last 0.4 s (paused off screen, so an animated model off screen forces no
  frames). Before a loaded model is drawn, its shader programs (one per PBR material variant) and textures are
  prepared one per task, so the first frame with it does not stall (on the NYC map the Empire State Building of
  the pak repository took two tasks of 465 and 645 ms on the Intel Arc before, none over 70 ms after). GLTFLoader
  (vendored) is imported only with a pak;
  leaving the tab disposes geometries, materials, textures (ImageBitmaps closed) and batches.
* **Model authors.** With a pak loaded, the ⓘ button of the 3D toolbar shows its name, version, licence and
  author and the rows of its `LICENSES.md` (file, author, licence, source and notes), all as text.
* **Content security policy.** The CSP of every response now has `connect-src 'self' blob:` instead of
  `connect-src 'self'` — the one deliberate change for the 3D view. GLTFLoader turns each texture embedded in a
  `.glb` into a `blob:` URL of the page and loads it with `fetch()` (ImageBitmapLoader), which `connect-src`
  governs; without it every embedded texture fails. A `blob:` URL can only be made by the page itself from data it
  already has, so this opens no way to other servers (`default-src`, `script-src` and `img-src` are unchanged; no
  `wasm-unsafe-eval`, no `worker-src`: the Draco, meshopt and KTX2 decoders are not used).
* **Hooks** (tests): `window.__view3d.info().pak` (state, entries, warnings, cache: loaded models with triangles
  and textures, failures; layer: copies per model, batches, draw calls, overhang copies shown), `info().anim`
  (animated models: clips, time, updates, running), `pakCopies(path)` and `pakVehicleCopies(path)` (instance
  matrices and colours). The 3D view as a whole: `info()` with `sky` (day/night level, half hour, season and its
  weights, snowline), `labels`, `shadows`, `settings`, `profile`, `overhang`; `setSettings(s)`, `setLevel(n)`,
  `continuous(on)`, `pixels(x0, y0, x1, y1)` (draws and reads a rectangle: lit windows), `rayDown(x, z)`,
  `gpuMemory()` (bytes: buffers, textures, shadow map, drawing buffer); `info().pick.longPresses` counts the
  touches held too long to be a tap.

Measured with the test pak of `tools/pak3d` (3 models: a textured tower, a locomotive, trees) on the NYC map,
Midtown at the default zoom: 52 towers and 1263 trees on 8 chunks drawn in 2 batches (6 draw calls, 28 k
triangles), render 6.3 / 7.6 ms (Intel Arc, p50 / p95), the three models loaded and converted in 80–100 ms.

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
| `/vendor/...`, `/img/...` | libraries, images | `private, max-age=3600` + `ETag` |
| `/tiles/...` | map tiles made by the bridge (see above) | `private, no-cache` + `ETag` |
| `/pak3d/...` | files of the `--pak3d` directory | `private, no-cache` + `ETag`; names with a content hash (`name.<8–64 hex digits>.ext`, e.g. `tree.3f2a9c1b.glb`) `private, max-age=31536000, immutable` |

Everything except the login page and `/login.css` needs a session (401 otherwise); like `/api/` and
`/tiles/`, `/pak3d/` also refuses requests that the browser marks as coming from another site (403). The
models are not secret, but a session keeps the rule simple and the bridge no file server for anyone who
can reach the port. Types: `.html`, `.js`/`.mjs` (`text/javascript`), `.css`, `.png`, `.svg`, `.json`,
`.woff2`, `.ico`, `.txt`/`.md` (text), `.glb` (`model/gltf-binary`), `.gltf` (`model/gltf+json`), `.bin`
(`application/octet-stream`), `.webp`, `.ktx2` (`image/ktx2`), `.jpg`/`.jpeg`, others
`application/octet-stream`. Paths with `..`, hidden names, `\` or `:` are refused. `/pak3d/` serves only
`.json .glb .gltf .bin .png .webp .ktx2 .jpg .jpeg .txt .md` (404 for other types, directories and
without `--pak3d`); links in the directory may point to other files in it, not out of it nor to hidden
names (e.g. into `.git` of a cloned pak 3D repository). The `ETag` of a file is made of its modification
time and size (304 for `If-None-Match`). Files over 32 MB are streamed.

### Compression

Static files of the types `.html .js .mjs .css .svg .json .txt .md .map .gltf .glb .bin` from 1 KB to
32 MB and API replies (JSON) of 1 KB and more are sent gzip compressed (`Content-Encoding: gzip`,
`Vary: Accept-Encoding`) when the request accepts it (`Accept-Encoding: gzip`, browsers always do). The
bridge keeps the compressed static files in memory (up to 64 MB, by path, modification time and size;
files that do not shrink by 10 % are sent as they are) and the compressed 3D replies with their cache
entry; other replies are compressed per request. Images (`.png .jpg .webp .ktx2`, compressed already),
the login page and the event stream (`/api/events`) are never compressed. The bodies carry no secrets
(tokens and session ids are only in the URL of the sign-in link and in cookies), so compression gives
attacks like BREACH nothing to find. Measured: three.js 0.187 with the addons of the 3D view 2.36 MB →
476 KB, `desc_list` of pak128
375 KB → 40 KB, a `map` region of 128 × 128 of the fake engine 17 KB → 0.3 KB; `scene3d` chunks shrink
by about a quarter (their blocks are zlib compressed already, gzip takes back part of the base64).

Every response has these headers, and none for CORS:

```
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

For the page this means: scripts and styles only from files of the dashboard (no inline
`<script>`, no `style="..."` attributes or `<style>` elements, no `eval`/`new Function`, no CDN);
setting `element.style.*` from JavaScript is fine; images may also be `data:` and `blob:` URLs, and
`fetch()` may read `blob:` URLs the page made (the textures embedded in glTF models, see
[Pak 3D](#pak-3d-gltf-models)).

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
* The 3D requests are checked before the game is asked (integer arguments, region sizes, chunks inside
  the map), run on game connections of their own with bounded queues (503 beyond) and per-session rate
  limits, so a viewer cannot slow down the poller or other browsers with them.

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
`world_stats` and `factories links=1` with synthetic data, the 3D export `desc_list`, `scene3d`,
`heights`, `vehicles3d` in the block layouts of the game for the synthetic map) for working on the
dashboard without Simutrans:

```
python tools/dashboard/dev/fake_engine.py --port 13399              # current protocol (2, events, map and 3D export)
python tools/dashboard/dev/fake_engine.py --port 13399 --no-events  # protocol 1 only
python tools/dashboard/dev/fake_engine.py --port 13399 --no-3d      # without the 3D export (the previous server image)
python tools/dashboard/dev/fake_engine.py --port 13399 --no-map     # without the map export (and the 3D export)
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
[h=]` (a road: a map change for `map_changes`, also in `scene3d`), `fake_legs [shift=N]` (the convoys of
every line drive the next legs of their schedule), `fake_schedule` (`poll.rev.schedules` + 1),
`fake_event topic= data=` (an event with any JSON data, e.g. of an unexpected shape), `fake_stats
[reset=1]` (how often `desc_list`, `scene3d`, `heights`, `vehicles3d` were asked: cache tests),
`fake_time [month=1-12]&[day=]&[hour=0-24]` (jump to that time of the current year: day and night, seasons;
the `scene3d` season and snowline follow the game's formulas with a winter snowline of 3 and a summer one of 9).
`--delay-3d S` makes every 3D request take S seconds more (queue and single flight tests). The 3D export
of the fake has heights in 16 × 16 blocks, the river as water, the roads as ways, trees, a few
buildings (one of 2 × 2 squares), a stop building on the square of every station, a 2 × 2 factory
building at every factory and a 2 × 2 town hall at every city (picking tests; `tile` names the station of
a square) and two cars per convoy; the first four convoys of a world drive scripted routes, smooth in game
time (vehicle tests): a train of 4 cars on a loop around squares 99–131 × 66–80 with a tunnel in squares
108–116 of its south side, a push-pull shuttle of 3 cars on squares 100–112 of row 90 that turns round at
both ends (its cars placed anew, as in the game), a bus with a trailer that leaves a depot at (104, 96),
drives round a block and enters the depot again, and an aircraft circling (116, 74) at 5 levels; the fifth
is a ship loading at a 2 × 1 dock on the river squares 88–89 of row 104; a 2 × 2 office stands over the corner of
four chunks (squares 127–128 × 127–128: overhang tests); with
`extras=1` city cars drive along the road rows and pedestrians walk along the road columns. Every fake line has a
schedule (the first one with a waypoint); `line_route all=1` returns the legs of at most two convoys
per line, moving on every quarter month, so routes fill in bit by bit as in the game. The fake world
has 6 cities (one name with markup characters, to check that names are shown as text) and 13
factories (one without goods) with 10 supply links; storage, histories and which links are active
change every month. With `--old` only the lists answer (cities without ids, factories without links).
`--month-seconds` sets the length of a game month
(default 20 s), `--size WxH` the world size (default 256x256; the statistics modes of the fake
minimap change their colours every month).
