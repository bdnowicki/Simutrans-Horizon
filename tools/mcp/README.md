# Simutrans MCP server

`simutrans_mcp.py` is an [MCP](https://modelcontextprotocol.io) server that lets AI agents such as
Claude Code read and play Simutrans. Every result is JSON: the game state, the map as character
grids, players, cities, stations, convoys, lines, factories and the open windows with their GUI
elements. Input works through game tools at map coordinates, GUI clicks by element text, mouse,
keyboard and the complete Squirrel scripting API. It only needs Python 3.8+ (standard library).

```
Claude Code  --stdio/MCP-->  simutrans_mcp.py  --TCP 127.0.0.1:13360-->  Simutrans (-remote_control)
```

## Game side

Start Simutrans with `-remote_control [port]` (default port 13360). The game then accepts
commands on 127.0.0.1 only and executes them on the main thread between two frames
(see `src/simutrans/network/remote_control.h` for the line protocol). Example:

```
"Simutrans SDL2 Nightly.exe" -set_basedir C:/simutrans -objects pak128/ -remote_control
```

Requests are served in the running game and in modal dialogs (e.g. the welcome screen), not
during loading screens or the initial pakset selection, so pass `-objects`.

`-remote_control_readonly [port]` (alone, or together with `-remote_control [port]`) accepts only
commands that read the game and the windows (`ping`, `status`, `windows`, `tile`, `tile_at`,
`screen_pos`, `messages`, `map`, `players`, `cities`, `stations`, `station`, `convoys`, `lines`,
`factories`, `positions`, `poll`, `toolbars`, `subscribe`, `unsubscribe`, `palette`, `minimap`, `map_changes`,
`labels`, `finance`, `line`, `convoy`, `line_route`, `city`, `factory`, `supply_chain`, `goods`,
`world_stats`). Every other command, including `eval`, `tool`,
`screenshot`, GUI input, `view`, `zoom`, `pause` and `tool_visibility`, gets
`{"ok":false,"error":"read-only remote control"}`. Most MCP tools that act on the game then fail.

### Protocol notes

* The greeting `HELLO simutrans-remote 1` must arrive within 5 seconds of connecting. The reply is
  `{"ok":true,"protocol":1,"read_only":false}`. `HELLO simutrans-remote 2` works the same way
  (reply `"protocol":2`) and also allows events (see [Events](#events-protocol-2)); a protocol 1
  connection never gets event lines. The MCP server uses protocol 1; the
  [browser dashboard](../dashboard/README.md) in tools/dashboard uses protocol 2 (events, map export,
  detail commands) and falls back to polling with protocol 1 games.
* At most 8 connections at the same time; further ones are closed right away.
* Requests can be pipelined: replies come in the order of the requests. `rid=<text>` in a request
  is echoed as `"rid":"<text>"` in its reply (also in error replies); the command does not see it.
* A request whose decoded keys or values contain a NUL character (`%00`) is refused with
  `{"ok":false,"error":"arguments must not contain NUL characters"}`.
* The game executes requests between two frames, round-robin over the connections: one request per
  connection and frame, more while about 8 ms of the frame are left. A single request is not
  interrupted, so a large `map` or `eval` still takes its time.
* Replies are sent without blocking the game. The next request of a connection is executed only
  after its previous reply has been sent completely, so a client that does not read its replies
  only stops itself. A connection is closed when a reply would leave more than 32 MB unsent, when
  not a single byte of its replies could be sent for 60 seconds, or when more than 8 MB of its
  requests wait unexecuted. A request line may be up to 4 MB long.

### All commands

`<command> <url-encoded k=v&k=v>`. "read" commands only read the game and the windows and are
accepted with `-remote_control_readonly`; "action" commands change the game, the GUI, the time or
files and are refused there. Commands marked with a section are described below.

| command | kind | arguments, remarks |
| --- | --- | --- |
| `ping` | read | `{"pong":true}` |
| `status` | read | date, speed, money, selected tool, view, open windows; `components=0`, `max_elements=N` |
| `windows` | read | the open windows with their elements; `components=0`, `max_elements=N` (default 300) |
| `click` | action | `x y [button=left\|right\|middle] [count=1-3]` (screen position) |
| `move` | action | `x y` mouse position |
| `drag` | action | `x1 y1 x2 y2 [button] [steps=1-100]` |
| `wheel` | action | `x y [dir=up\|down] [count=1-20]` |
| `key` | action | `key=<name or character> [count=1-50]` |
| `text` | action | `text=<string>` typed into the focused text field; see below |
| `screenshot` | action | `path=<file> [x y w h] [scale=1-8]`; refuses network paths |
| `view` | action | `x y [z]` center the view on a tile |
| `zoom` | action | `[dir=in\|out] [count=1-10]` |
| `pause`, `fast_forward` | action | `[on=0\|1]` (toggle if missing); not in network games |
| `eval` | action | `code=<Squirrel> [reset=1] [unowned=1] [ops= owner= max_size=]`; the scripted tools are refused (see Security) |
| `cash` | action | `amount=<credits> [player=N]` |
| `tool` | action | build or remove tool at map positions, see below |
| `tool_visibility` | action | `tool= visibility=show\|hide\|default [waytype= param=]`, or `clear=1`; see Tool visibility |
| `unlock_game`, `remove_password` | action | see Tool visibility; single player only |
| `tile_at`, `screen_pos` | read | conversion between screen position and tile |
| `tile` | read | `x y [z]` everything on one tile |
| `map` | read | `x y w h [layers= features=]` character grids (`map_view`) |
| `players` | read | paging as below |
| `cities`, `stations`, `convoys`, `lines`, `factories` | read | paging, see below |
| `station`, `line`, `convoy`, `city`, `factory`, `finance`, `line_route`, `supply_chain`, `goods`, `world_stats` | read | see Details and histories |
| `toolbars` | read | `[toolbar=N]` the toolbars with shown and hidden tools |
| `messages`, `positions`, `poll` | read | see Commands for dashboards and tools |
| `palette`, `minimap`, `map_changes`, `labels` | read | see Map export |
| `subscribe`, `unsubscribe` | read | see Events (protocol 2); they only change the connection |

The text input is queued: every `text` request keeps its text until the game has processed it.
When 1024 texts or 16 MB of text are already waiting, the request fails with
`too many texts are waiting for the game to process them, retry later`; retry after a frame.

### Commands for dashboards and tools

Replies are one JSON line with `"ok":true` (or `"ok":false,"error":"..."`). Dates are
`{"year":Y,"month":M}` (month 1-12), positions `{"x":X,"y":Y,"z":Z}` or `null`.

`poll` (read) is small and fast (about 400 bytes) for frequent polling:

```
{"ticks":N,"date":{..},"month_progress":0.952,"ticks_per_month":N,"paused":bool,"ff":bool,"mult":N,
 "player":{"nr":N,"name":"..","cash":credits} | null,"msg_seq":N,
 "counts":{"convoys":N,"lines":N,"halts":N,"factories":N,"cities":N,"players":N},
 "rev":{"objects":N,"schedules":N,"map":N},"world":{"gen":N,"size_x":N,"size_y":N,"rotation":N}}
```

`player` is the active player, `msg_seq` the seq of the newest message, `mult` the time multiplier.
`rev.objects` is a checksum of the convoy, line and station ids and the number of cities: it
changes when such objects are added or removed. `rev.schedules` is the schedule counter of the game
(0-255, wraps). `rev.map` is the map gen of [`map_changes`](#map-export) (it changes with every
recorded map change, another world and a rotation; changes are recorded only while the map is
tracked, see there). `world.gen` changes whenever a world is loaded or created (all object ids may
have changed): refetch everything then.

`messages [count=N] [since=SEQ]` (read): messages of the message center. Every message has a
sequence number: the oldest message of the world has seq 1, the newest seq = the number of
messages; the list is replaced when a world is loaded or created. Item:
`{"seq":N,"text":"..","type":N,"type_name":"..","player":N,"date":{..},"pos":{..}|null}` with
`type_name` one of `general ai city problems industry chat new_vehicle full warnings traffic_jams
scenario chat_common chat_company chat_private` and `player` -1 if the message belongs to nobody.
Without `since`: the newest `count` messages (default 20, max 500), newest first, reply
`{"seq":<newest seq>,"messages":[...]}`. With `since`: the messages with seq > since, oldest first,
at most `count` (default 100, max 500; if more are new, the newest of them and `"truncated":true`),
reply `{"seq":N,"messages":[...],"truncated":bool,"reset":bool}`. `reset` is true if `since` is
larger than the newest seq (another world was loaded): the reply then holds the newest `count`
messages, oldest first, and replaces the client's list.

`positions [owner=N] [x1= y1= x2= y2=]` (read): all convoys on the map in compact rows (convoys in
a depot are left out), optionally only those of one owner or with the front vehicle in a region
(inclusive):

```
{"cols":["id","x","y","z","state","owner","line","load"],
 "states":["in_depot","edit_schedule","routing",...],
 "rows":[[12,395,433,0,6,0,1,54],...]}
```

x, y, z is the tile of the front vehicle, `state` an index into `states` (the names `convoys`
reports), `line` the line id or 0, `load` the payload of all vehicles in percent of their capacity
(0 without capacity).

Paging of `stations`, `convoys`, `lines`, `factories` and `cities`: `offset=N` skips the first N
objects (counted after the filters: `owner`, or the region of `factories`), `limit=N` returns at
most N objects (default 200, cities 100; `limit=0` returns all), `fields=summary` returns only the
main fields. The replies have `"total":<objects after the filters>,"offset":N,"truncated":bool`
(`truncated`: more objects follow after this page). Summary fields:

* stations: `id`, `name`, `owner`, `pos`
* convoys: `id`, `name`, `owner`, `pos`, `line` (line id or 0), `state`
* lines: `id`, `name`, `owner`, `convoys` (number of convoys); lines have no position
* factories: `name`, `type`, `pos`
* cities: `id`, `name`, `townhall` (`{"x","y"}`), `citizens`

Every city (also without `fields=summary`) has an `id`: its index in the city list of the world
(the index the game uses itself, e.g. to rename a city). Cities are saved and loaded in this order,
so the id stays the same across save/load and network joins; new cities get the next id, and only
when a city is removed the ids of the cities after it go down by one (`rev.objects` of `poll`
changes then). `cities` is sorted by citizens, not by id.

`factories links=1`: `suppliers` and `consumers` of every factory become arrays of the positions
of its suppliers and consumers, `[{"x":X,"y":Y},...]` (the `pos` of these factories, without z),
instead of their numbers; also with `fields=summary` (for drawing supply links on a map). Without
`links` the output stays as it is.

`tool tool=<tool> x= y= [z=] [x2= y2= [z2=]] [param=<text>] [player=N] [ctrl=1] [shift=1]` (action)
applies a build or remove tool at map positions, exactly like `command_x(<tool>).work(...)` of the
script API: one position for one-click tools (e.g. `tool_remover`), start and end for two-click
tools (e.g. `tool_build_way` with `param=<way name>`). z defaults to the ground height. `<tool>` is
a script name (`tool_remover tool_raise_land tool_lower_land tool_setslope tool_restoreslope
tool_set_marker tool_clear_reservation tool_build_transformer tool_add_city tool_change_city_size
tool_plant_tree tool_build_groundobj tool_build_way tool_build_bridge tool_build_tunnel
tool_remove_way tool_build_wayobj tool_build_station tool_build_roadsign tool_build_depot
tool_build_house tool_land_chain tool_city_chain tool_build_factory tool_link_factory
tool_headquarter tool_lock_game tool_add_citycar tool_forest tool_stop_mover tool_make_stop_public
tool_remove_wayobj tool_buy_house tool_build_cityroad tool_change_water_height tool_set_climate
tool_rotate_building tool_merge_stop tool_set_owner`, case does not matter), an engine name like
`TOOL_BUILD_WAY` or `general_tool[14]`, or the numeric id including the general tool flag 0x1000
(`4110` or `0x100e`). Only these general tools work; dialogs, simple tools and the scripted tools
(`tool_exec_script`, `tool_exec_two_click_script`) are refused. `player` defaults to the active
player; a player protected by a password is refused (unlock it in the game first). Scenario rules
apply as for the player. `ctrl=1`/`shift=1` act as if the key was held. Replies: `{"result":null}`
when the tool worked, `{"ok":false,"error":"<text of the game>"}` when it did not (a tool that fails
without a text gives `the tool did not work here (no reason given)`). In network games the tool
goes to the server like a click and the reply is `{"pending":true}`; a refusal then shows up in the
game.

### Details and histories

Read commands for the detail views of a dashboard: the content of the finance, line, convoy,
station, city, factory, goods list and city list (world chart) windows, and the supply chains.
Values are converted like these windows show them: money in credits (the game
keeps 1/100 credits), percentages in %, costs negative. Histories are tables
`{"columns":[names],"rows":[[values],...]}`: row 0 is the running month (or year), then older ones,
like the charts of the game. Each of these commands takes at most about 1 ms on the NYC map (1183
convoys, 3108 stations; most well below); nothing is searched or computed that the game does not
already keep, and they change nothing, so they also work in network games.

`finance [player=N] [tt=all|road|rail|ship|monorail|maglev|tram|narrowgauge|air|other|powerline]
[period=both|month|year]` (read): the finance window of a player (default the active one) for one
transport type (default `all`):

```
{"player":N,"name":"..","tt":"all","date":{..},
 "columns":["transported","delivered","revenue","running_costs","maintenance","toll","operating_profit",
            "new_vehicles","construction","profit","cash","assets","margin","net_wealth"],
 "month":[[14 values],...],"year":[[14 values],...],
 "maintenance_per_month":credits,"overdrawn_months":N,"tt_list":["all","road","rail",...]}
```

`month` has up to 25 rows (row 0 = the running month, `date`), `year` up to 25 rows (row 0 = the
running year); empty rows from before the start of the game are left out. `transported` and
`delivered` count passengers, mail and goods together, `toll` is toll received plus toll paid,
`profit` the gross profit (operating profit minus new vehicles and construction), `assets` the value
of the vehicles, `margin` the operating profit in % of the revenue. `cash` and `net_wealth` are
company wide, the same for every `tt` (as in the window). `maintenance_per_month` is the current
monthly infrastructure maintenance of `tt` (negative, "This month" in the window),
`overdrawn_months` the number of months with negative cash. `tt_list` are the transport types the
window offers (those with any data). The game updates the sums of the running month only when the
finance window draws; the command computes them like the window, on a copy of the statistics.

`line id=N [history=1]` (read):

```
{"line":{"id","name","owner","type","convoys":<count>,"withdraw":bool,"this_month":{..},"last_month":{..}},
 "goods":["Passengers","Mail"],"convoys":[ids],"capacity":N,"load":N,
 "schedule":[{"pos":{..},"halt":id|null,"name":"..","wait_for_load":0-100,"waiting":N},...],
 "history":{"columns":["free_capacity","transported","revenue","operation","toll","profit","convoys",
                       "distance","max_speed"],"rows":[[9 values] x 12]}}
```

`line` has the fields of `lines` (its stops are in `schedule`). `goods` are the goods categories of
the line (as the game names them), `capacity` and `load` the current capacity and load of all its
convoys (like the line window). Schedule entries: `halt` is null for a depot or waypoint (`name` is
then the game's text for "Depot" / "Waypoint", a depot also has `"depot":true`); `wait_for_load`
is the minimum load in %, with `max_wait_ticks` when a maximum waiting time is set; entries with
departure times have `departures_per_month` and `departure_ticks` (the first departure, in ticks
after the start of a month) instead. `waiting` is the amount waiting at the halt in the goods
categories of the line, for all destinations. `history=1` adds the chart of the line window
(12 months): money in credits, `distance` in squares, `max_speed` in km/h, `free_capacity` the free
places when convoys left a stop.

`convoy id=N [history=1]` (read):

```
{"convoy":{<the fields of convoys>,"power_kw","weight_t","empty_weight_t","running_cost_per_km","value",
           "odometer_km","speedbonus_kmh","loading_limit","length_tiles","withdraw","no_load",
           "home_depot":{..}|null,"route":{"index":N,"length":N}},
 "vehicles":[{"name","built":{"year","month"},"age_months","value","capacity","load","goods","unit",
              "speed_kmh","power_kw","weight_t","running_cost_per_km","fixed_cost_per_month","retired"},...],
 "schedule":{"current":i,"entries":[<entries as in line, without waiting>]},
 "freight":[{"goods","amount","unit","destination":".."|null,"destination_id","via","via_id","factory"},...],
 "history":{"columns":["free_capacity","transported","revenue","operation","profit","distance",
                       "max_speed","toll"],"rows":[[8 values] x 12]}}
```

The convoy fields are those of the convoy window and its details tab: `weight_t` is the weight the
window shows, `value` the resale value, `route` the position of the front vehicle (`index`) on the
route of its current leg (`length` squares). Per vehicle: `goods` is the goods category it carries
(left out without capacity), `value` the resale value, `weight_t` its weight with the load,
`retired` true when it is out of production. `freight` is the loaded cargo joined per goods,
destination halt and next transfer halt (`via`, only when it is not the destination), largest
first; `factory` is the destination factory of goods for a factory. `history=1` adds the chart of
the convoy window (12 months, units as for lines).

`line_route id=<line> [all=1]` or `line_route convoy=<id>` (read): the route a convoy drives, as a
polyline of the squares where it turns (straight runs are left out):

```
{"line":N,"convoy":id,"leg":true,"from":{"halt":id|null,"name":"..","pos":[x,y]},"to":{..},
 "length":<squares>,"index":N,"points":[[x,y],...]}
```

A convoy only knows the route of the leg to its next stop (while loading: the leg it came), so
`leg` is always true and `from`/`to` are the ends of that leg (`name` only for halts). `index` is
the position of the front vehicle on the route (0..`length`). For a line the first convoy with a
route is taken; without one the reply is `{"line":N,"convoy":null,"points":[],"reason":".."}`
(likewise `"convoy":id,"state":"..","points":[]` for a convoy in a depot or without route).
`all=1` (lines only) gives the legs of all convoys of the line, one per different start and end:
`{"line":N,"legs":[<objects as above, without "line">],"stops":N,"covered":N}`; `covered` counts
the schedule entries at the end of a leg, so `covered` = `stops` means the legs cover the whole
route of the line. No route is searched for this: the routes are those the convoys drive.

`station id=N` (or `x= y=`) (read) replies `station`, `this_month`, `last_month` and `tiles` as
before, plus:

* `"capacity":{"passengers":N,"mail":N,"goods":N,"separate":bool}`: the storage capacity of the
  station window; unless `separate` (the setting for separate halt capacities) all three are the
  same total.
* `history=1`: `"history"` with the columns `happy unhappy no_route waiting arrived departed convoys
  walked` (the chart of the station window, 12 months).
* `waiting=goods`: `"waiting_by_goods":[{"goods","amount","unit","class"}]`, every goods type with
  something waiting; `class` (`passengers`, `mail` or `goods`) is the storage it uses.
* `waiting=next`: `"waiting_by_next":[{"halt","name","goods","amount"}]` per next transfer halt and
  goods type, largest first, and `"waiting_other":N`, the amount waiting for a halt that is no
  direct connection any more. `waiting=goods,next` gives both.
* `lines=1`: `"lines":[{"id","name","owner","type"}]` (the lines serving the station) and
  `"lineless_convoys":[{"id","name","owner"}]`.
* `departures=N` (1-100): the departure board of the station window,
  `"departures":[{"convoy","line","halt","name","ticks","time"}]` (`halt` = the next stop) and
  `"arrivals":[...]` (`halt` = the previous stop), soonest first, at most N each, and
  `"ticks_per_month"`. `ticks` count from now, `time` is the text of the board (`now`, `18:00h`,
  `+2 13:00h`, in the game language and date format), `line` is 0 for a convoy without line. The
  times are the estimates of the board (without its smoothing over several updates).

`city id=N | name=<name> | x= y= [history=month|year|none]` (read): the city window. `id` is the
`id` of `cities` (see there), `name` the exact name (else the first city with this name in any
case), `x`/`y` any square within the city limits (the city nearest to it if several overlap):

```
{"city":{<the fields of cities>,"center":{"x","y"},"growth":0.4,"unemployed":N,"homeless":N,"allow_growth":bool},
 "history":{"columns":["citizens","growth","buildings","citycars","passengers_transported",
                       "passengers_walked","passengers_generated","mail_transported","mail_walked",
                       "mail_generated","goods_supplied","goods_needed"],"rows":[[12 values] x 12]},
 "period":"month"}
```

`city` has the fields of `cities` (`id`, `name`, `townhall`, `area` with the corners x1,y1 (top
left) and x2,y2 (bottom right) of the city limits, `citizens`, `growth_this_month`, `buildings`,
`last_month`) and the rest of the window: `growth` is the smoothed growth the window shows after the
citizens ("186962 (0.4)"), `homeless` and `unemployed` can be negative (more homes or jobs than
people), `allow_growth` the checkbox "Allow city growth". `history` is the chart of the window
(default the months, `history=year` the years, `history=none` leaves it out; 12 rows, row 0 = the
running month or year), unconverted counts like the chart; `goods_supplied`/`goods_needed` are the
chart's "Arrived"/"Goods": how often the shops had goods / were checked.

`factory x= y= [history=0]` (read): the factory window of the factory at a square of its building
or of one of its fields:

```
{"factory":{<the fields of factories>,"owner":N,"size":{"x","y"},"status":"good",
            "base_production":N,"production_per_minute":1052.86,"productivity":225,
            "boost":{"electric":100,"passengers":21,"mail":4},"max_boost":{"electric":100,"passengers":50,"mail":20},
            "power":{"mw":-399,"last_month_mw":-398,"producer":false,"transformer":true,"demand_mw":400},
            "fields":N,"min_fields":N},
 "suppliers":[{"x","y","name","active"},...],"consumers":[{"x","y","name","active"},...],
 "halts":[{"id","name","owner"},...],"cities":[{"id","name","passengers","mail"},...],
 "history":{"columns":["production","power","boost_electric","boost_passengers","boost_mail",
                       "passengers_generated","passengers_departed","passengers_arrived",
                       "mail_generated","mail_departed","mail_arrived"],"rows":[[11 values] x 12]}}
```

`factory` has the fields of an entry of `factories` (`name`, `type`, `pos`, `production`,
`inputs`, `outputs`, `suppliers` and `consumers` as numbers) plus: `owner` (-1 for nobody), `size`
of the building in squares (as rotated), `status` (`good`, `medium`, `bad`, `inactive`,
`nothing`: the colour of the status bar), `production` per day and `production_per_minute` as the
first line of the window ("Max. prod. 8.984/day, Produces: 1052.86 units/minute"),
`base_production` without boosts, `productivity` = 100 + the boosts in %, `boost` the current
boosts and `max_boost` the largest possible boosts in %. `power` in MW like the "Power (MW)" chart:
`mw` the current power (produced positive, consumed negative) and `last_month_mw` the average of last
month; a power plant also has `generation_mw` (what it offers to the net), a factory that needs
power `demand_mw`; `transformer` tells whether a transformer is connected. Each slot of `inputs`
and `outputs` additionally has `factor` (consumption/production per unit of production in %, the
"%" in the window), `name` (internal goods name), `category` (translated), inputs under the
setting "maximum in transit" also `max_transit`, and `history`: the goods chart of the slot (12 rows;
inputs `["storage","received","consumed","in_transit"]`, outputs `["storage","delivered","produced"]`,
in the units of the window; `in_transit` is not converted, also in the window). `storage`/`max` and
the history are in the units of the factory window, like `factories`.

`suppliers` and `consumers` are the lists of the "Connections" tab in its order: position and name
of the other factory, `active` (shown grey in the window when false) = goods went this way recently.
`halts` are the "Connected stops" (the stops whose catchment covers the factory). `cities` are the
cities that send commuters and mail to the factory (the city list of the "Connections" tab), with
the passenger and mail numbers shown there (the supply of the city this month, reset at every month
change). `history` is the "Production/Boost" chart, converted like the chart: power in
MW, boosts in %. `history=0` leaves out `history` and the slot histories.

`supply_chain [goods=<name>]` (read): all factories as nodes and their supply links as edges, for
drawing the supply chains:

```
{"nodes":[{"pos":{"x","y","z"},"name":"..","type":".."},...],
 "edges":[[from,to,"<goods>",active],...]}
```

`from` and `to` are indices into `nodes` (supplier, consumer); there is one edge per goods type
that the supplier produces and the consumer accepts (`<goods>` is the translated goods name, like
`goods` in `inputs`/`outputs`), `active` as in `factory`. `goods` (internal or translated name, case
does not matter; see `goods`) keeps only the factories that produce or consume this goods type and
the edges with it; the reply then also has `"goods":"<translated name>"`. The edges come from the
consumer lists of the factories, the same links as `factories links=1`.

`goods` (read): all goods types of the pakset, like the goods list window:

```
{"goods":[{"index":N,"name":"Passagiere","translated":"Passengers","unit":"..","category":"..","catg":0,
           "catg_index":0,"color_index":62,"color":[205,101,230],"value":4.67,"speed_bonus":18,
           "weight":85,"used":true},...]}
```

`index` is the goods index of the game (0 passengers, 1 mail; the internal "None" is left out),
`name` the internal name (used in `supply_chain goods=`), `translated` the name in the game language
(used everywhere else), `unit` the translated unit, `category` the translated category of the goods
list ("Special freight" when `catg` is 0: special freight only goes with vehicles for exactly this
goods type; goods with the same `catg_index` can share vehicles). `color` is the colour of the goods
in the game (rgb) and `color_index` its index in the 256 colours of `palette`; both are null without
graphics (dedicated server). `value` is the revenue per unit for 100 squares at the average speed,
in credits (what the goods list shows when it opens), `speed_bonus` in %, `weight` in kg per unit,
`used` whether a factory of this world produces or consumes it (passengers and mail always true).

`world_stats [period=month|year]` (read): the chart of the city list window (world statistics):

```
{"period":"month","date":{..},
 "columns":["citizens","growth","towns","factories","convoys","citycars","passenger_ratio",
            "passengers_generated","mail_ratio","mail_generated","goods_ratio","goods_transported"],
 "rows":[[12 values] x 12]}
```

12 rows of months (default) or years, row 0 = the running month or year. The ratios are in %
(`passenger_ratio`: passengers that could start their journey, `mail_ratio` likewise, `goods_ratio`:
how often the shops had goods), `goods_transported` counts the goods (not passengers and mail)
transported by all players, `citycars` the private cars generated. The game computes the running
month/year only at the month change and when the city list window draws; the command computes it
the same way (without changing the game), so row 0 is always current.

On the NYC map (86 cities, 205 factories) `city`, `factory`, `goods` and `world_stats` take
0.1-0.3 ms (1-4 KB, `goods` 8 KB), `supply_chain` about 0.5 ms (21 KB), `factories limit=0
links=1` about 1 ms (60 KB, 28 KB with `fields=summary`).

### Map export

For drawing the map in a browser: the colours of the in-game minimap as one palette index per
square, compressed, plus change tracking so that only changed areas are fetched again. All four
commands are read commands.

`palette [builtin=1]` (read): the 256 colour palette (the day colours the minimap uses) and what is
needed to draw and explain the samples:

```
{"source":"renderer"|"builtin","colors":[[r,g,b],...256],
 "players":[{"nr":N,"name":"..","color1":N,"color2":N,"minimap_color":N},...],
 "height_colors":[36 indices],"severity_colors":[10 indices],
 "maximumheight":N,"minimumheight":N,"groundwater":N,"rotation":N}
```

Indices 0-223 are the special colours (8 shades per colour, player colours are 8 consecutive
indices starting at `color1`/`color2`), 224-238 the day light colours, 239-255 black. Without
graphics (dedicated server) the renderer knows no colours; the game then sends a built-in copy of
the same palette (`"source":"builtin"`, `builtin=1` forces it). `minimap_color` (= `color1`+3) is the
colour of the player's stations, ways and buildings in the `owner`, `passengers` and `mail` modes.
`height_colors` is the height table of the terrain: 0-4 water (deepest first, 4 = at the water
level), 5-35 land; a square of height h gets entry 4 + ceil((h-w)*31/maximumheight) above the water
level w and 4 - (w-h) at or below it (clamped to 0-35). `severity_colors` go from low to high (traffic, freight, speed,
power, level).

`minimap [x= y= w= h=] [step=1|2|4|8|16] [mode=terrain] [contour=0] [vehicles=1] [level=1-9]`
(read): the minimap of a region (default the whole map), clipped to the map. One byte per sample
(the palette index), row after row, zlib compressed (RFC 1950, e.g. Python `zlib.decompress`,
browser `new DecompressionStream("deflate")`) and base64 encoded. With `step` > 1 the top left
square of every step x step block is sampled (as the zoomed out minimap does). At most 1048576
samples per request (e.g. the whole 1024x1024 map at step 1, 4096x4096 at step 4).

```
{"region":{"x","y","w","h"},"step":N,"mode":"terrain","encoding":"zlib+base64",
 "width":<samples per row>,"height":<rows>,"gen":N,"data":"eJzt..."}
```

The colours are those of the in-game minimap in the normal (not underground) view, without the
overlays it draws on top (city limits, lines, stations, factory connections, legends). `vehicles=1`
paints convoys yellow like the minimap (default off: a dashboard draws convoys itself, and they do
not count as map changes). `contour=0` is the minimap option "hide contours". `level` is the zlib
level (default 6). Modes:

| mode | colours |
| --- | --- |
| `terrain` | the default minimap: height, water, ways (road grey, rail, canal, runway), stations red, bridges, tunnels, elevated ways, power lines, buildings grey, factories and their fields in the factory colour |
| `owner` | stations, ways and buildings in the owner's `minimap_color` (unowned ways orange), the rest as terrain |
| `traffic` / `freight` | ways by convoys / goods of last month on a log scale up to the largest value of the map (`"max"` in the reply) |
| `passengers` / `mail` | squares covered by a connected station in the owner's colour |
| `tracks` | rail: white, electrified red, with signal or sign yellow |
| `speed` | ways by speed limit (severity scale up to 450 km/h) |
| `power` | power lines by demand/supply of their net |
| `forest` | trees green |
| `level` | city buildings by level up to the largest level of the map (`"max"`) |
| `climates` | empty land in the colour of its climate |

The maxima of `traffic`, `freight` and `level` are computed over the whole map (the in-game
minimap keeps the largest value it has seen since it was opened, so its scale can differ a little).
`terrain` and `owner` come from the colours kept for the change tracking and cost about 5 ms per
512x512 (25 KB on the NYC map); the other modes are computed and take 13-22 ms per 512x512.

`map_changes since=<gen> [chunk=256]` (read): which areas changed since a map gen (the `gen` of a
`minimap` or of an earlier `map_changes` reply, or `rev.map` of `poll`):

```
{"gen":N,"full":bool,"chunk":256,"chunks":[[cx,cy],...],"rotation":N,"world_gen":N,"size_x":N,"size_y":N}
```

`chunks` are the chunks (squares cx*chunk .. cx*chunk+chunk-1, likewise y) with a change after
`since`; refetch them and remember `gen`. `chunk` is a power of 2 from 64 to 4096. `full` is true
(and `chunks` empty) when `since` is unknown (0, larger than the newest gen, or older than the start
of the tracking): another world, a rotation, a new map size, or the tracking was stopped; then
fetch the whole map again.

The tracking starts with the first `minimap` or `map_changes` request (one pass over the map, about
40 ms on a 1024x1024 map; 2 bytes per square) and stops when no connection is left or for 2 minutes
neither `minimap`, `map_changes` nor `poll` came. While it runs, every square that the game redraws
on the minimap (built or removed ways, buildings, stations, terraforming, city growth, ...) is
compared with its kept `terrain` and `owner` colours and counts as changed only if one of them
changed, so moving vehicles never do. A background re-check of all squares (65536 squares per
second, about 16 s for 1024x1024) also finds changes that the game does not redraw (e.g. a new
owner). Not tracked: the other modes change with the monthly statistics (`traffic`, `freight`,
`power`), with trees or connections; fetch them again when the month changes (event `month`) or
when needed. Seasons and snow do not change minimap colours.

`labels` (read): all labels (map markers) of the world:
`{"labels":[{"pos":{"x","y","z"},"text":"..","owner":N},...]}` (`owner` -1 for nobody).

### Events (protocol 2)

A connection greeted with `HELLO simutrans-remote 2` can subscribe topics. The game then also sends
event lines, which have an `"event"` key and no `"ok"` key:

```
{"event":"<topic>","seq":N,"date":{"year":Y,"month":M},"data":{...}}
```

Event lines come only between whole replies (never inside one), so a client reads lines and sorts
them by the `"event"` key; replies keep the order of the requests. `seq` counts all events of the
game (all topics and connections), so a connection sees gaps, but its events always come in
increasing `seq`. `date` is the game month when the event happened.

`subscribe topics=<list> [interval=<ms>] [player=<nr>]` (read) adds topics (comma separated, or
`all`) and replies `{"topics":[<all subscribed>],"seq":<newest event seq>,"interval":N,"player":N}`.
Events of a topic come only from after the reply: read the current state with the normal commands
after subscribing and apply the events from then on. `interval` (default 1000, 250 to 3600000 ms)
and `player` (cash events of one player only, `-1` or `all` = every player) apply to all topics of
the connection and stay until given again. `unsubscribe [topics=<list>|all]` (read, default all)
removes topics and replies `{"topics":[<still subscribed>],"seq":N}`; undelivered events of the
removed topics are dropped. Both commands fail on a protocol 1 connection.

| topic | when | `data` |
| --- | --- | --- |
| `messages` | every new message | the item of `messages since=`: `{"seq","text","type","type_name","player","date","pos"}` |
| `month` | a new month began | `{"date":{..},"year_changed":bool}` |
| `world` | a world was loaded or created, or is closed | `{"event":"loaded"\|"created"\|"closed","gen":N,"size_x":N,"size_y":N}` |
| `status` | pause, fast forward, time multiplier or active player changed | `{"paused":bool,"ff":bool,"mult":N,"player":N}` |
| `cash` | cash or net wealth of a player changed | `{"player":N,"cash":credits,"net_wealth":credits}`, one event per player |
| `convoys` | convoys changed their state, were added or removed | `{"changes":[[id,state,previous state],..],"added":[id,..],"removed":[id,..],"states":[..]}` |
| `arrivals` | convoys arrived at stops | `{"items":[[convoy id,halt id],..]}`, plus `"dropped":N` if more than 8192 arrived |

`messages`, `month` and `world` come at once (in the next frame). `status` is compared every frame
and sent at most once per interval. `cash`, `convoys` and `arrivals` are compared or collected once
per interval: one event per interval (cash: per player) with the changes since the last one, so in
fast forward intermediate states are left out. `convoys` covers all convoys including those in a
depot; `state` is an index into `states` (the same list as in `positions`). `world` `gen` is the
`world.gen` of `poll`: after `closed` (with the old gen) and `loaded`/`created` (new gen) all ids
may have changed and the message list was replaced, so refetch everything. Loading a game gives
`closed` and then `loaded`; the watchers of the other topics start again with the new world without
reporting differences.

Events are kept in a ring of the last 2048 events (at most 4 MB) until every connection got them,
and passed to a connection only while less than 1 MB of its output waits unsent, at most 256 per
frame. A connection that falls behind (does not read, or a burst of more than 2048 events, e.g.
thousands of messages from one script) loses the oldest events and then gets
`{"event":"overflow","seq":N,"date":{..},"data":{"lost":K}}`: K events for this connection up to seq N
were dropped; the events after it follow normally. Resync with the normal commands. As for replies,
a connection is closed when not a single byte could be sent to it for 60 seconds.

The game records events only while some connection subscribed a topic; the recording does not
change the game, so events also work in network games and on a dedicated server.

## Register in Claude Code

```
claude mcp add simutrans --scope local \
  -e SIMUTRANS_EXE="C:/path/Simutrans SDL2 Nightly.exe" \
  -e SIMUTRANS_ARGS="-set_basedir C:/path/simutrans -objects pak128/" \
  -- python C:/path/tools/mcp/simutrans_mcp.py
```

`SIMUTRANS_EXE` / `SIMUTRANS_ARGS` are only used by the `launch_game` tool;
`SIMUTRANS_REMOTE_PORT` changes the port.

## Tools

| Tool | Result (JSON) |
|---|---|
| `game_status` | date, speed, money, selected tool, view, open windows with buttons/labels/tabs/text fields |
| `map_view` | map grids for the visible area or a region, plus the cities, stations, factories, convoys, depots and labels in it |
| `tile_info` | grounds, ways, buildings, vehicles, owner, station and city of one tile |
| `players` | cash, net wealth, monthly revenue/costs/profit, transported cargo, number of lines/convoys/stations |
| `cities` | size, area, growth, last month's passenger/mail/goods service |
| `stations`, `station_details` | owner, position, accepted and waiting cargo, happy/unhappy passengers |
| `convoys` | position, state, speed, load, line, next stop, profit |
| `lines` | stops, convoys, profit, transported vs capacity |
| `factories` | production, input/output storage in the units of the factory window, this and last month's production/consumption, suppliers/consumers |
| `messages` | message center (incl. scenario messages) |
| `toolbars` | the toolbars with the tools they show and the tools they hide, with the reason; see below |
| `ui_elements`, `tile_to_screen`, `screen_to_tile` | GUI elements and coordinate conversion |
| `run_squirrel` | any query or action through the scripting API |
| `screenshot` | PNG image of the game window, of one open window (by title) or of a screen region; see below |
| `use_tool` | apply a game tool exactly at map coordinates (build way, station, depot, remove, ...) with the command `tool`; also in network games |
| `change_cash` | add money to (or take it from) a player's bank account, like `book_cash()` of scenario scripts |
| `set_tool_visibility` | hide a toolbar tool, or show a tool that the scenario forbids; see below |
| `unlock_game` | lift the "Lock game" lock of a map so the player can be changed; see below |
| `remove_password` | remove the password of a player, by default the public player; see below |
| `click_element`, `click`, `drag`, `move_mouse`, `scroll_wheel`, `press_key`, `type_text` | GUI input; the result lists the open windows afterwards |
| `center_view`, `zoom`, `set_pause`, `set_fast_forward`, `wait`, `launch_game` | view, time and process control |

### Map grids

`map_view` returns one string per map row y (first string = `region.y`), one character per
tile x (first character = `region.x`):

* `terrain`: `.` empty land, `T` trees, `o` rocks, `~` water, `f` factory field, `R` road, `=` rail,
  `t` tram, `n` narrow gauge, `m` monorail, `g` maglev, `w` canal, `a` runway/taxiway, `X` crossing,
  `P` power line, `B` bridge, `E` elevated way, `U` tunnel entrance, `S` station, `D` depot,
  `F` factory, `C` city hall, `h`/`c`/`i` residential/commercial/industrial building,
  `A` attraction/monument, `Q` headquarters, `b` other building
* `height`: z = `height_base` + digit (`0-9a-zA-Z`); `groundwater` is the sea level
* `owner`: `.` nobody, `0-9a-f` player number (1 = public service)
* `slope`: `.` flat, `n` `s` `e` `w` ramp in that direction, `*` other slope

### Screenshots

The JSON tools come first: `map_view` and `tile_info` give exact tiles and coordinates and cost
far fewer tokens than an image, `ui_elements` lists the content of windows. The tool descriptions
and the server instructions tell the agent so. `screenshot` is for what JSON does not show:
graphics, charts, the layout of a window, a visual check of a result.

The game writes the PNG to a temporary file, the MCP server returns it as an image and deletes
the file, so the game and the MCP server must run on the same computer. `scale` divides width and
height; by default it is the smallest scale that keeps the longer side within 1568 px, the size
Claude looks at (so 1 for most windows, 2 for a Full HD screen). Images over 4 MB are refused with
a hint to use a higher scale. The server version of Simutrans has no screen and cannot take
screenshots.

### Tool visibility

`toolbars` lists every toolbar with the tools it shows and the configured tools it does not show,
with the reason: `forbidden by scenario`, `not available (timeline)` or `hidden by rule`. Tools
are named as in `menuconf.tab` (`simple_tool[5]`) and by their constant (`TOOL_SWITCH_PLAYER`).

`set_tool_visibility` sets a rule for a tool, optionally only for one waytype or one parameter
(a descriptor name):

* `hide` leaves the tool out of all toolbars; its keyboard shortcut still works.
* `show` lifts a scenario ban on the tool: the button is back and the tool works. Scenario rules
  for map areas still apply. Single player only.
* `default` removes the rule; `clear` removes all rules.

Examples: `tool=TOOL_SWITCH_PLAYER visibility=show` brings back the "Change player" button, which
every scenario forbids (`simutrans/script/scenario_base.nut`). `tool=TOOL_BUILD_WAY waytype=air
visibility=show` allows taxiways and runways when a scenario forbids them. Rules are not saved and
last until the game is closed.

A map author can also lock the map with "Lock game" (the public player gets a password and changing
the player is switched off; the game then says "This game is locked"). `unlock_game` switches
changing the player on again, in single player games only. Unlike the visibility rules this is a
setting of the map and is saved with the game; the public player keeps its password, so acting as
the public player still asks for it. `remove_password` removes the password of a player (by default
the public player), like the server command "unlock company"; single player only, saved with the
game.

## Security

The port is bound to 127.0.0.1 and every connection must start with the line
`HELLO simutrans-remote 1` (or `2`), so web pages cannot talk to it through HTTP requests.
Any local program that connects can control the game and run Squirrel code, so only enable
`-remote_control` when you need it. The script engine of `eval` has no `system`, `remove`, `rename`
and `getenv` (removed from the Squirrel system library), so scripts cannot start programs or change
files; `include()` still loads `.nut` scripts. `command_x` refuses the scripted tools there
(`tool_exec_script`, `tool_exec_two_click_script`), which would load a `tool.nut` from any
directory with the full system library. `screenshot` refuses network paths (`\\host\...`,
`//host/...`, `\??\...`). `-remote_control_readonly` allows only reading commands.
