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
`world_stats`, `desc_list`, `scene3d`, `heights`, `vehicles3d`). Every other command, including `eval`, `tool`,
`screenshot`, GUI input, `view`, `zoom`, `pause` and `tool_visibility`, gets
`{"ok":false,"error":"read-only remote control"}`. Most MCP tools that act on the game then fail.
With `-remote_control_time` as well, the time commands `pause` and `fast_forward` are accepted too
(e.g. a dedicated server whose dashboard may pause and speed up the game for all clients).
With `-remote_control_agent` as well, the [agent commands](#agent-commands) are accepted too
(`agent_tool`, `depot_op`, `line_op`, `convoy_op`, `plan_way`, `estimate`): allow-listed changes for
one company, e.g. for the AI team of the dashboard on a dedicated server. Without the option they get
`{"ok":false,"error":"read-only remote control: agent commands need -remote_control_agent"}`. A full
`-remote_control` accepts them anyway.

### Protocol notes

* The greeting `HELLO simutrans-remote 1` must arrive within 5 seconds of connecting. The reply is
  `{"ok":true,"protocol":1,"read_only":false,"time_control":true,"agent":true}` (`time_control`: `pause`
  and `fast_forward` are accepted; `agent`: the agent commands are accepted). `HELLO simutrans-remote 2`
  works the same way
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
  connection and frame, more until about 4 ms of the frame are used. A single request is not
  interrupted, so a large `map` or `eval` still takes its time.
* Heavy commands ("read, heavy" below: `scene3d`, `desc_list`, `heights`, `vehicles3d` with
  `extras=1`, about 1-3 ms each, and `plan_way`, a route search) run at most one per frame, and only within the first millisecond of the frame's request work. A connection whose next
  request is heavy waits for a later frame; its later requests wait behind it (replies keep their
  order), the other connections go on. The first connection changes with every frame, so every
  connection gets its turn. A burst of `scene3d` requests is thus spread over frames, one chunk per
  frame; a client that wants other replies meanwhile uses a second connection.
* Replies are sent without blocking the game. The next request of a connection is executed only
  after its previous reply has been sent completely, so a client that does not read its replies
  only stops itself. A connection is closed when a reply would leave more than 32 MB unsent, when
  not a single byte of its replies could be sent for 60 seconds, or when more than 8 MB of its
  requests wait unexecuted. A request line may be up to 4 MB long.

### All commands

`<command> <url-encoded k=v&k=v>`. "read" commands only read the game and the windows and are
accepted with `-remote_control_readonly`; "action" commands change the game, the GUI, the time or
files and are refused there; "agent" commands are accepted there only with `-remote_control_agent`.
Commands marked with a section are described below.

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
| `pause`, `fast_forward` | action | `[on=0\|1]` (toggle if missing). In network games only on the server, for all clients: `pause` stops the server's steps, so its clients wait; `fast_forward` sets the time multiplier to 4× normal (64) with the speed tool of the public player, which every client applies at the same step, and `fast_forward`/`ff` in `status` and `poll` then mean a multiplier above normal. A client that joins resumes the game and resets the speed to normal, as Simutrans does. A network client refuses both |
| `eval` | action | `code=<Squirrel> [reset=1] [unowned=1] [ops= owner= max_size=]`; the scripted tools are refused (see Security) |
| `cash` | action | `amount=<credits> [player=N]` |
| `tool` | action | build or remove tool at map positions, see below |
| `tool_visibility` | action | `tool= visibility=show\|hide\|default [waytype= param=]`, or `clear=1`; see Tool visibility |
| `unlock_game`, `remove_password` | action | see Tool visibility; single player only |
| `tile_at`, `screen_pos` | read | conversion between screen position and tile |
| `tile` | read | `x y` everything on one tile: grounds and their objects, ways with their directions (see below) |
| `map` | read | `x y w h [layers= features=]` character grids (`map_view`) |
| `players` | read | paging as below |
| `cities`, `stations`, `convoys`, `lines`, `factories` | read | paging, see below |
| `station`, `line`, `convoy`, `city`, `factory`, `finance`, `line_route`, `supply_chain`, `goods`, `world_stats` | read | see Details and histories |
| `toolbars` | read | `[toolbar=N]` the toolbars with shown and hidden tools |
| `messages`, `positions`, `poll` | read | see Commands for dashboards and tools |
| `palette`, `minimap`, `map_changes`, `labels` | read | see Map export |
| `desc_list`, `scene3d`, `heights` | read, heavy | see 3D export |
| `vehicles3d` | read (heavy with `extras=1`) | see 3D export |
| `subscribe`, `unsubscribe` | read | see Events (protocol 2); they only change the connection |
| `depot` | read | `x y [z]` a depot with its convoys and stored vehicles, see Agent commands |
| `agent_tool`, `depot_op`, `line_op`, `convoy_op` | agent | changes for one company, see Agent commands |
| `plan_way` | agent, heavy | dry run of way building, see Agent commands |
| `estimate` | agent | prices of ways, buildings and vehicles, see Agent commands |

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
when the tool worked, `{"ok":false,"error":"<text of the game>"}` when it did not: the tool's own
reason, translated into the game's language and on one line (e.g. a rail signal on a switch: `You
cannot place rail signals here.`; a tool that fails without a text gives `the tool did not work here
(no reason given)`, or `the tool cannot work at x,y,z (it gave no reason)`). The tool is checked
before anything is sent: when one position cannot do anything there, the reply is the tool's reason;
`this tool needs a second position x2,y2: one click at x,y,z only sets the start ...` comes only from
two-click tools for which that click would just set the start (way objects, way removal, the tunnel
tool underground; `x2,y2 = x,y` works for one square). Two positions where the first click already
does the work give `First click has side effects (one click at x,y already does the work: leave out
x2,y2)`. These checks only ask the tool (`is_valid_pos`) and leave no start marker or preview behind,
so nothing changes on a network server alone. In network games the tool goes to the server like a
click and the reply is `{"pending":true}`; a refusal then shows up in the game.

`tile x= y=` (read): every ground of the square from the bottom up, `{"grounds":[{"pos":{"x","y","z"},
"type":"<ground>","surface":bool,"water":bool,"slope":N,"text":"<label>"?,"halt":"<stop>"?,
"objects":[{"type":"way","name":"..","owner":N},...]}],"city"|"nearest_city":{"name","citizens"}}`
(`owner` -1 = nobody, 1 = the public player). Ways (`type` `way`) also have `desc` (the pak name),
`waytype` (`road`, `track`, `tram`, `water`, `monorail`, `maglev`, `narrowgauge`, `air`,
`powerline`) and `dirs`, the directions the way connects to, as letters in the order n e s w:
`"ew"` or `"ns"` straight, `"ne"` a curve, `"esw"` or `"nesw"` a switch or crossing, `"w"` a dead end,
`""` none (unmasked: one-way signs and signals hide nothing). Signs and signals (`roadsign`,
`signal`; their `name` is only `Roadsign`/`Signal`) and way objects (`wayobj`) have `desc`, `waytype`
and `dirs` too: the directions a sign or signal stands for (a new signal on straight track `"ew"`,
a click on it turns it to `"e"`, then `"w"`, then `"ew"` again; a traffic light the open directions
of its phase), the directions of an overhead line. The game puts rail signals and one-way signs only
on squares whose way has exactly two directions (no switches, crossings or dead ends), traffic lights
only on junctions of three or four, never a signal and a road sign on the same square.

### Agent commands

The agent commands let a trusted program, the AI team of the [dashboard](../dashboard/README.md),
change the game for ONE company through a few allow-listed operations. They are accepted with
`-remote_control`, and with `-remote_control_readonly` only together with `-remote_control_agent`
(a dedicated server). The program that may connect to the port is the authorization: the tools are
sent like the tools of scenario scripts (`WFL_SCRIPT | WFL_NO_CHK`), so a company protected by a
password acts in single player and on a network server. On a network client the server does not
trust these flags: a company that is locked on that client is refused with
`... is protected by a password on this client ...` (companies the client has unlocked work).

Common rules (all but `estimate`):

* `player=N` is required: refused when missing (`player=N is required`), not a number, no such
  company, `N` 15 or higher, and for the public player 1 (`agents cannot act as the public player`).
* Every object an agent uses, changes or removes must belong to company N (depots, convoys, lines,
  removed objects); objects of nobody (cities, nature), of the public player or of other companies
  are refused. The engine's change tools check owners only in network games, so the commands check
  them themselves.
* The scenario rules apply as to a human player: the commands check what the flags would skip
  (`is_tool_allowed` for the tool, `is_work_allowed_here` at the positions, `is_schedule_allowed`
  for schedules) and refuse with the scenario's message (`Forbidden by scenario` without one).
* Replies: single player `{"result":null,...}` when it worked; network game `{"pending":true}` (the
  tool goes through the server, read the game again to see the result). Nothing opens a dialog,
  except the short message the game shows when a convoy is sent to a depot. Money values are credits
  like `cash` of `players`. Way building and purchases do not check the money of the company.

`agent_tool tool=<name|id> x= y= [z=] [x2= y2= [z2=]] [param=] [ctrl=1] [shift=1] player=N` works like
`tool`, but only for `tool_build_way`, `tool_build_bridge`, `tool_build_tunnel`, `tool_build_wayobj`,
`tool_build_station`, `tool_build_roadsign`, `tool_build_depot`, `tool_remove_way`,
`tool_remove_wayobj` and `tool_remover`; every other tool gets `... is not allowed for agents ...`.
The build tools need the name of an object that is available now (`param` of `tool_build_way`:
`<way>[,[a][k][s][t][,<max length>,<bridge>[,<tunnel>]]]`, `s` = straight; `tool_build_station`:
`<name>[,<rotation>]`). A tool that refuses answers as with `tool`: with its own reason, translated and
on one line (`tool_build_roadsign` with one position on a switch: `You cannot place rail signals
here.`), checked before anything is sent, without any change of the game on this machine (a network
server); "needs a second position" only for two-click tools whose one click would just set a start.
`tool_build_roadsign` with one position puts up (or turns, see `tile`) one sign; two positions place
signs along the route. Before a removal the command predicts everything the tool would remove and
refuses with `cannot remove <what> '<name>' at x,y,z: it belongs to <owner>` unless all of it
belongs to the company: the remover takes one thing per click in the game's order (a marker, a city
car - then refused, try again -, a powerline, a sign, the stop building, a way object, a whole bridge,
a whole tunnel with all its squares (`ctrl=1`: also branches), a depot, a building, other objects,
then one way); `tool_remove_way` (`param=<waytype>`: 1 road, 2 track and tram, 3 water, 5 monorail,
6 maglev, 8 narrow gauge, 16 air) takes the ways along the route and the signs, way objects, stops and
tunnels of that waytype on them, and whole bridges that start on the route; `tool_remove_wayobj`
(`param=<waytype>`) takes or shortens the way objects along the route. Removal on crossings with the
remover, powerline bridges and tunnels, and routes through depots are refused; when the prediction is
unsure the command refuses.

`depot x= y= [z=]` (read): `{"pos":[x,y,z],"owner":N,"waytype":"road","name":"<depot>",
"max_convoy_length":N,"convoys":[{"id":N,"name":"..","vehicles":["<vehicle>",...],"line":<id>|null}],
"stored":["<vehicle>",...]}`; without z the depot on any ground of the square.

`depot_op player=N x= y= [z=] op=<a|i|b|d|v|s> convoy=<id> vehicle=<name>`: `a`/`i` append/insert
`vehicle` (with the vehicles it must be coupled with, which the depot buys together) to `convoy`,
`convoy=0` makes a new convoy (single player: the reply has `"convoy":<id>`); `b` starts the convoy
(it needs a schedule), `d` disassembles it into the depot, `v` sells it, `s` sells the stored vehicle
`vehicle`. The depot and the convoy belong to the company and the convoy is in this depot; the
vehicle fits the depot's waytype, is available now (not future, not obsolete), can be coupled (as
the depot window allows) and the convoy does not get too long. The depot tool of the game fails
without a message, so all this is checked before.

`line_op player=N op=c waytype=<1..8|road|rail|water|air|monorail|tram|maglev|narrowgauge>
[schedule=<text>]` creates a line (single player: `"line":<id>`; without a schedule an empty one);
`op=g line= schedule=` sets its schedule, `op=d line=` deletes it, `op=w line= withdraw=0|1` withdraws
its convoys (refused for a line without convoys), `op=r line= name=` renames it. Not offered: trim
and unite, which change convoys of all companies.

`convoy_op player=N convoy=<id> op=l line=<id>` puts the convoy on the line (the schedule type must
fit), `op=g schedule=<text>` gives it an own schedule, `op=x` sells it, `op=d` sends it to the nearest
depot, `op=w withdraw=0|1` sets withdraw (the game toggles it; when the convoy already has the value
nothing is sent and the reply has `"changed":false`). As in the game, a withdrawn empty convoy is
sold at once; a convoy standing in a depot is not withdrawn (refused).

Schedules are the engine's text `<current stop>|<type>|<x>,<y>,<z>,<min load>,<wait>|...|`, types
1 road, 2 train, 3 ship, 4 air, 5 monorail, 6 tram, 7 maglev, 8 narrow gauge, e.g.
`0|1|10,20,0,0,0|30,40,1,50,0|`. They are checked: the type, every stop on an existing ground where
this kind of vehicle can stop and that the company may use (no ways or depots of other companies,
only stops it may use, as the schedule window checks), minimum load 0..100, at least two different
stops, the scenario. The game reads the text as given (it drops doubled stops).

`plan_way player=N way=<way name> x= y= [z=] x2= y2= [z2=] [bridge=<name>] [tunnel=<name>]
[straight=1]` is a dry run of `tool_build_way` with the company as builder: the route the way builder
finds and its price, computed in this game only (never sent to the server, never changes anything):
`{"ok":true,"tiles":[[x,y,z],...],"length":N,"cost":<credits>,"bridges":[[[x,y,z],[x,y,z]],...],
"tunnels":[...],"param":"<param of agent_tool tool_build_way that builds it>"}` (bridges and tunnels:
start and end of the new ones) or `{"ok":false,"error":"<text>","reason":"<text>"}` (the same text
in both keys). The cost is the
game's estimate (the one the way tool shows while dragging).

`estimate kind=<way|bridge|tunnel|wayobj|roadsign|station|depot|vehicle> name=<name> [count=N]
[length=N] [size=XxY]` (no player needed, changes nothing): `{"kind","name","price","maintenance",
"count","total","available"}` with the price per unit (way, way object, bridge, tunnel: per square,
total = price × length × count; station: per square, total = price × X × Y × count, `size` defaults
to the building's size; depot, sign, vehicle: per piece) and the maintenance per unit and month.
Vehicles add `running_cost` (per km), `fixed_cost` (per month), `power`, `speed`, `capacity`,
`freight`, `waytype`, `intro_year`, `obsolete`.

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

The tracking starts with the first `minimap`, `map_changes`, `scene3d` or `heights` request (2 bytes
per square) and stops when no connection is left or for 2 minutes neither `minimap`, `map_changes`,
`scene3d`, `heights` nor `poll` came. Taking the colours of all squares (about 40 ms on a 1024x1024 map) is spread over the
next frames, one 64x64 cell after the other, up to about 4 ms per frame (the NYC map: 10 frames); a
`minimap` with `step=1` and a `scene3d` take the cells they cover at once, a `minimap` with a larger
step computes the colours of cells not taken yet (slower, like the other modes). A cell counts as
changed when its colours are taken, so right after the start `map_changes` may report areas once
that did not change. While it runs, every square that the game redraws
on the minimap (built or removed ways, buildings, stations, terraforming, city growth, ...) is
compared with its kept `terrain` and `owner` colours and counts as changed only if one of them
changed, so moving vehicles never do. A background re-check of all squares (65536 squares per
second, about 16 s for 1024x1024, at most 8192 per frame) also finds changes that the game does not redraw (e.g. a new
owner). Changes that keep the minimap colours (a city building replaced by another one, a road
extended, a sign added, a tree planted, ...) are reported by the engine itself, see
[Map changes for the 3D view](#map-changes-for-the-3d-view). Not tracked: the other modes change with the monthly statistics (`traffic`, `freight`,
`power`), with trees or connections; fetch them again when the month changes (event `month`) or
when needed. Seasons and snow do not change minimap colours.

`labels` (read): all labels (map markers) of the world:
`{"labels":[{"pos":{"x","y","z"},"text":"..","owner":N},...]}` (`owner` -1 for nobody).

### 3D export

For a 3D view of the map: a catalogue of the pak objects (`desc_list`), the content of map chunks
(`scene3d`), which refers to the objects by their index in the catalogue, the terrain heights of large
areas for a far terrain (`heights`) and the moving vehicles (`vehicles3d`). All are read commands;
`desc_list`, `scene3d`, `heights` and `vehicles3d extras=1` are heavy (at most one per frame, see
Protocol notes).

`desc_list [kinds=<list>]` (read, heavy): the objects of the loaded pakset, `kinds` is a comma
separated subset of `buildings,vehicles,ways,bridges,tunnels,trees,signs,wayobjs,goods,citycars,pedestrians`
(default all; an unknown kind is an error). Only the requested lists are in the reply:

```
{"pakset":"pak128/","gen":N,
 "buildings":[{"i":0,"name":"..","type":"res","size":[x,y],"layouts":N,"level":N,"height":N,"climates":N,
               "waytype":null,"enables":N,"intro":year,"retire":year},...],
 "vehicles":[{"i","name","waytype","length":N,"freight":"..","capacity":N,"power":N,"speed":N,"intro","retire"}],
 "ways":[{"i","name","waytype","system":"flat","speed":N}],
 "bridges":[{"i","name","waytype","speed":N,"pillars":N}],
 "tunnels":[{"i","name","waytype","speed":N}],
 "trees":[{"i","name","climates":N}],
 "signs":[{"i","name","waytype","flags":N,"traffic_light":bool}],
 "wayobjs":[{"i","name","waytype","speed":N,"overhead":bool}],
 "goods":[{"i","name","color":N,"catg":N}],
 "citycars":[{"i","name","speed":N,"intro","retire"}],
 "pedestrians":[{"i","name","intro","retire"}],
 "t_us":N}
```

* `name` is the untranslated pak name (stable key, e.g. for a model manifest). Every list is sorted
  by name (byte order) and `i` is the position in it; `trees` are in the engine's tree order (also by
  name), `i` = tree id. `scene3d` `desc` values are these `i`.
* `gen` identifies the catalogue: a 32-bit FNV-1a hash of all lists (independent of `kinds`). The
  pakset is loaded only at the start, so the catalogue never changes while the game runs; the same
  pakset files give the same `gen`, also after a restart, another pakset (or other addons) another
  `gen`. Cache the lists by `gen`; `scene3d` replies carry it as `desc_gen`, so a client notices when
  its cached lists are not the ones the indices refer to.
* `waytype`: `road`, `track`, `water`, `overheadline`, `monorail`, `maglev`, `tram`, `narrowgauge`,
  `air`, `powerline`, `other`, or null for none.
* buildings: `type` `res`/`com`/`ind` (city buildings), `cur` (attraction), `mon` (monument), `tow`
  (town hall), `hq` (headquarters), `stop` (station building, dock), `ext` (station extension),
  `depot`, `factory`, `other` (e.g. the foundation of elevated ways). `size` is the size of layout 0
  (layouts 1 and 3 swap x and y), `layouts` the number of layouts (rotations). `height` is the
  clearance in height levels (tallest tile; use it for the height of a building, not `level`, which
  is the size class: up to 200 on the NYC map). `climates` is a bit mask, bit c = climate c (0 water,
  1 desert, 2 tropic, 3 mediterranean, 4 temperate, 5 tundra, 6 rocky, 7 arctic). `waytype` only for
  stops, extensions, docks and depots; `enables` only for stops and extensions (bit 0 passengers,
  1 mail, 2 goods). `intro`/`retire` are years.
* vehicles: `length` in 1/16 of a square (16 = one square), `freight` the `goods` name (`None` for
  vehicles without freight), `capacity` units, `power` kW, `speed` km/h.
* ways: `system` `flat`, `elevated`, `runway` (elevated air way), `tram` (tram tracks, `waytype`
  `tram`), `river`, `other`; `speed` km/h. The power line way is in this list too.
* bridges: `pillars` = a pillar every N squares (0 none). signs (also signals): `flags` bits 1 one-way,
  2 choose sign, 4 private road, 8 signal, 16 pre-signal, 32 only back image, 64 long block signal,
  128 end of choose area, 256 priority signal. wayobjs: `waytype` of the way they belong to,
  `overhead` = overhead line. goods: `color` is a palette index (`palette`), `catg` the category.
  citycars: `speed` km/h. City cars and pedestrians are the `extras` of `vehicles3d`.

The game builds the catalogue once, while the first world loads (about 3 ms on pak128: 1349
buildings, 965 vehicles, 65 ways, 27 bridges, 21 tunnels, 40 trees, 46 signs, 18 way objects, 38
goods, 140 city cars, 18 pedestrians); a reply then takes about 0.1 ms. The full reply is 364 KB (38 KB with gzip).

`scene3d cx= cy= [size=64] [objs=bin|json] [level=1-9]` (read, heavy): chunk (cx, cy) of size x size
squares (`size` 16, 32 or 64), i.e. squares `x0` = cx*size to `x0`+`w`-1 and likewise y (`w`, `h`
are smaller at the map edge):

```
{"cx":N,"cy":N,"size":64,"x0":N,"y0":N,"w":N,"h":N,"rev":N,"desc_gen":N,
 "water":N,"season":N,"snowline":N,"rotation":N,"encoding":"zlib+base64",
 "corners":"eJ..","ground":"eJ..","count":N,
 "objs_layout":"x:u8,y:u8,z:i8,kind:u8,desc:i16,a:u16,b:u16,owner:i8","objs":"eJ..","t_us":N}
```

Errors: `missing chunk coordinates cx,cy`, `chunk is outside of the map`, `size must be 16, 32 or 64`,
`objs must be bin or json`.

* Coordinates are map coordinates after the in-game rotation (`rotation` 0-3; a rotation changes all
  of them, `map_changes` then says `full`): x grows to the east, y to the south (north = -y). The
  blocks use chunk-local squares x = map x - `x0`, y = map y - `y0`, row after row: index = y*w + x.
  Heights are height levels (the NYC map uses double slopes: a corner can be 2 levels above the
  ground height).
* `corners`, `ground` and `objs` are base64 encoded zlib streams (RFC 1950, as in `minimap`); `level`
  is the zlib level (default 4: on these blocks nearly as small as 6 in less than half the time).
* `corners`: w*h*4 bytes, int8: the absolute height of the four corners of the surface ground of
  every square, in the order sw, se, ne, nw; nw is the corner at (x, y), ne at (x+1, y), se at
  (x+1, y+1), sw at (x, y+1). Corners of neighbouring squares need not match (cliffs, foundations).
  Water squares are flat at their own water height (`water` for the sea, lakes may be higher).
* `ground`: w*h bytes: low nibble = surface type (0 land, 1 water, 2 foundation under a building,
  3 tunnel portal, 4 bridge head, 5 other), high nibble = climate (0-7 as in `desc_list`).
* `objs`: the `count` objects. Binary (default): 11*count bytes as columns, all values of one field,
  then the next field, little endian, in the order of `objs_layout` (n = count): x u8 at 0, y u8 at
  n, z i8 at 2n, kind u8 at 3n, desc i16 at 4n, a u16 at 6n, b u16 at 8n, owner i8 at 10n. The 16-bit
  columns start at even offsets (in a browser: `new Int16Array(buffer, 4*n, n)` on the decompressed
  ArrayBuffer). Check `objs_layout`: another value means another layout. `objs=json` sends the same
  rows as `"objs":[[x,y,z,kind,desc,a,b,owner],...]` (no `objs_layout`; for tests and debugging, about
  twice the size after gzip).
* Order of the objects: squares row after row, per square its grounds from the bottom up (surface
  first, then bridge decks and elevated ways; tunnel interiors and empty preview grounds are left
  out), per ground in the engine's order. Moving things are not exported (vehicles, pedestrians,
  city cars, animals, smoke). `z` is the height of the ground that carries the object (bridge decks
  and elevated ways lie above the terrain), `desc` the index in the `desc_list` list of the kind (-1
  none), `owner` the player number (-1 nobody).

| kind | object | `desc` | `a` | `b` |
| --- | --- | --- | --- | --- |
| 0 | way | `ways` | ribi (N=1 E=2 S=4 W=8, unmasked) | bit 0 on a bridge (also its ramp) or elevated, bit 1 tunnel portal square, bits 8-15 slope of the way |
| 1 | building (also stations, depots, factories, monuments) | `buildings` | layout | ox + 256*oy, offset of this square in the building (in its layout) |
| 2 | tree | `trees` (tree id) | age class 0-4 | 0 |
| 3 | bridge | `bridges` | ribi of the bridge's way | 0 |
| 4 | tunnel portal | `tunnels` | ribi of the way | 0 |
| 5 | sign or signal | `signs` | direction (ribi; traffic lights: the open directions of the current phase, 5 or 10, 0 while yellow) | state, +256 for signals |
| 6 | way object (overhead line) | `wayobjs` | ribi (15 at closed diagonals) | waytype number of the way object (1 road, 2 track, 5 monorail, 7 tram, ...) |
| 7 | bridge pillar | `bridges` | 0 | 0 |
| 8 | power line | `ways` (power line way) | ribi | 0 line, 1 power source, 2 consumer (transformer) |
| 9 | field | -1 | 0 | 0 |
| 10 | ground object (rocks, ...) | -1 | 0 | 0 |
| 11 | other | -1 | engine object type (27 label, 29 crossing) | 0 |

The slope of a way is the engine slope code sw + 3*se + 9*ne + 27*nw, every corner raised 0-2 levels
above `z`. On a bridge ramp built on a sloped ground the way can be flat while the ground slopes; it
then lies at `z` + the highest corner of the ground. A bridge's deck is a later ground of the same
square (larger `z`), its pillars stand on the ground below.

* `rev` is the map gen (as `gen` of `minimap`): pass it as `since` to `map_changes`; the chunk is stale
  when its 64x64 cell (cx*size/64, cy*size/64) is reported (`chunk=64`); see
  [Map changes for the 3D view](#map-changes-for-the-3d-view) for what counts as a change.
  `scene3d` starts the tracking like `minimap`.
* `desc_gen` = `gen` of `desc_list`. `water` = groundwater (sea) level, `season` 0 summer, 1 autumn,
  2 winter, 3 spring, `snowline` = height level above which there is snow in winter. `t_us` = time in
  the game for this reply including compression.

On the NYC map (1024x1024, 256 chunks of 64x64, laptop) a chunk takes 0.7 ms (median, 95 % below
1.1 ms, at most 1.4 ms) and is 10 KB (7.5 KB with gzip; at most 17 / 13 KB); the densest chunk has
8397 objects.

`heights [step=1|2|4|8|16] [x1= y1= x2= y2=] [level=1-9]` (read, heavy): the terrain heights of a
region for a far terrain and a whole map overview. `step` defaults to 1. The region is given in squares
(inclusive, default the whole map, clipped to it; x1/x2 or y1/y2 given the wrong way round are swapped, as
in `vehicles3d`):

```
{"x1":N,"y1":N,"x2":N,"y2":N,"step":N,"w":N,"h":N,"rev":N,"water":N,"min":N,"max":N,
 "encoding":"zlib+base64","heights":"eJ..","water_heights":"eJ..","t_us":N}
```

Errors: `step must be 1, 2, 4, 8 or 16`, `region is outside of the map`,
`too many samples (at most 66049 per request): use a larger step or a smaller region`.

* The samples are points of the height grid, i.e. square corners: sample (i, j) is the grid point
  (x1 + i*step, y1 + j*step), the north-west corner of that square. The last column and row are the
  east and south edges of the region (x2+1, y2+1), closer than `step` when the size of the region is
  not a multiple of it. So `w` = ceil((x2-x1+1)/step) + 1 and `h` likewise, and the samples are a
  w x h vertex grid that covers the region (the whole 1024x1024 map at step 4: 257 x 257), row after
  row (index = j*w + i). Neighbouring requests share their edge row or column.
* `heights`: w*h bytes, int8: the height of the grid point as the game keeps it for terraforming. On
  land this is the north-west corner of the surface ground (`corners` of `scene3d`, the nw value): on
  the NYC map all 55570 compared land squares agree. Under water it is the sea floor.
* `water_heights`: w*h bytes, int8: the water height of the square whose north-west corner the sample
  is (at the east and south map edges the square next to it): `water` (the sea level) for the sea and
  for dry land, higher for lakes. There is water where it is above the terrain.
* `min`, `max`: of `heights`. `rev`: the map gen as in `scene3d` (`heights` starts the tracking);
  terrain changes mark the cells, but so do all other changes, so `rev` is a conservative test.
  `level`: zlib level, default 1.
* At most 66049 samples per request: 256x256 squares at step 1, 512x512 at step 2, the whole
  1024x1024 map at step 4 (the whole map at step 1 would take 8 ms in one request). On the NYC map
  (laptop) a request takes 0.5 ms for 256x256 at step 1 (5.6 KB), 0.6 ms for 512x512 at step 2
  (10 KB), 0.7 ms for the whole map at step 4 (13 KB), 0.25 ms at step 8 (4.8 KB) and 0.12 ms at
  step 16 (1.8 KB). The whole map at step 1 takes 16 requests of 256x256, one per frame.

`vehicles3d [x1= y1= x2= y2=] [extras=1] [objs=bin|json] [level=1-9]` (read; heavy with `extras=1`):
the moving things in a region (squares, inclusive, default the whole map): every vehicle of the
convoys on the map, one row per car (vehicles in a depot are left out), with `extras=1` also city
cars and pedestrians (then the region may have at most 65536 squares, e.g. 256x256):

```
{"x1":N,"y1":N,"x2":N,"y2":N,"ticks":N,"paused":bool,"ff":bool,"mult":N,"drive_left":bool,
 "diag_steps":N,"desc_gen":N,"count":N,"convoy_rows":N,"encoding":"zlib+base64",
 "objs_layout":"cnv:u16,desc:i16,x:u16,y:u16,ox:i16,oy:i16,zoff:i16,speed:u16,flags:u16,idx:u8,kind:u8,z:i8,dir:u8,steps:u8,steps_next:u8,nx:i8,ny:i8,nz:i8,owner:i8",
 "objs":"eJ..","t_us":N}
```

Errors: `region is outside of the map`, `objs must be bin or json`,
`extras=1: region too large (at most 65536 squares)`.

* `objs`: 28*count bytes as columns like in `scene3d` (n = count), all 16-bit columns first, so they
  start at even offsets for any n: cnv at 0, desc 2n, x 4n, y 6n, ox 8n, oy 10n, zoff 12n, speed 14n,
  flags 16n, idx 18n, kind 19n, z 20n, dir 21n, steps 22n, steps_next 23n, nx 24n, ny 25n, nz 26n,
  owner 27n. `objs=json` sends `"objs":[[cnv,desc,x,y,ox,oy,zoff,speed,flags,idx,kind,z,dir,steps,
  steps_next,nx,ny,nz,owner],...]` (no `encoding`, `objs_layout`). Order: the convoys in the game's
  order with their cars front to back (`convoy_rows` rows), then city cars and pedestrians square by
  square.

| field | meaning |
| --- | --- |
| `cnv` | convoy id (as in `convoys`, `convoy id=`), 0 for city cars and pedestrians |
| `desc` | index in the `desc_list` list `vehicles` (kind 0), `citycars` (1) or `pedestrians` (2) |
| `x`, `y`, `z` | the square and the height of the ground the vehicle is on (bridge decks, tunnels) |
| `ox`, `oy` | position in the square relative to its centre in 1/256 square (x east, y south; ±128 = the edges), as the game draws it: on maps that drive on the left and while overtaking with the lane shift, otherwise on the middle of the way (the pak images carry the right-hand lane) |
| `zoff` | height above `z` in 1/16 height levels: the interpolated way height on slopes, plus the flight altitude of aircraft |
| `speed` | current speed in yards per tick: the vehicle advances speed/4096 steps per tick; km/h = (speed*5+31)/64. All cars of a convoy have its speed; pedestrians 128 |
| `flags` | bit 0 front car, 1 last car (city cars and pedestrians: both), 2 the convoy leaves a depot, 3 it drives into a depot, 4 it loads at a stop, 5 it waits (for a free way, to start, for a route), 6 inside a tunnel (not on a portal), 7 not drawn by the game (e.g. half way into a tunnel portal), 8 aircraft in the air, 9 overtaking |
| `idx` | index of the car in its convoy, 0 = front |
| `kind` | 0 convoy vehicle, 1 city car, 2 pedestrian |
| `dir` | direction of travel as ribi: N=1, E=2, S=4, W=8, diagonals NE=3, SE=6, SW=12, NW=9 |
| `steps`, `steps_next` | progress through the square: from 0 at the entry edge to `steps_next` at the exit edge (255 on straight squares, `diag_steps`-1 on diagonal ones; other values on the last square of a route, when an aircraft turns on a square (0), for city cars and pedestrians) |
| `nx`, `ny`, `nz` | next square (pos_next) minus this square, -128 when unknown or farther; 0,0,0 at the end of the route |
| `owner` | player number, -1 nobody |

For moving the vehicles smoothly between samples (e.g. 5 per second):

* `ticks` is the game time in ms (as in `poll`); it stands still while `paused`. Between two samples a
  car moved about (ticks2 - ticks1) * speed / 4096 steps. The game runs about 1000 * `mult` / 16 ticks
  per second (more with `ff`, as fast as the computer allows): estimate the rate from two replies.
* On a straight square the car is at centre + (steps / (steps_next + 1) - 0.5) * direction; on a
  diagonal square it goes from the middle of the entry edge to the middle of the exit edge (the exit
  is the side towards `nx`,`ny`); `ox`,`oy` already hold this position.
* When a convoy turns round at the end of its route, the game places its cars anew on the new route:
  `dir` reverses and the positions jump. Do not interpolate when the direction reverses or a car moved
  more than about two squares; convoys that enter a depot vanish from the rows, leaving ones appear on
  the depot square (flag 2). `cnv` + `idx` identify a car; city cars and pedestrians have no id.

Costs on the NYC map (1246 convoys, 2860 cars on the map, laptop): 128x128 squares of Manhattan 669
rows in 0.4 ms (6.7 KB), 256x256 956 rows in 0.4-0.6 ms (9 KB), the whole map 1.1-1.6 ms (26 KB);
with `extras=1` 128x128 3060 rows (476 city cars, 1915 pedestrians) in 1.3 ms (30 KB), 256x256 5116
rows in 2.6 ms (49 KB). `level` is the zlib level (default 1: samples are short-lived; level 4 saves
7 %).

### Map changes for the 3D view

`map_changes` (see Map export) also reports the changes that the minimap colours do not show: the
engine tells the remote control about every visible change of a square that does not move:

* objects added to or removed from a ground: ways, buildings, trees, bridges and their pillars,
  tunnel portals, signs and signals, overhead lines, power lines, fields, ground objects, labels,
  crossings (not vehicles, city cars, pedestrians, animals, smoke);
* a building tile replaced by another one (city growth, renovation, rotation);
* the directions (ribi) and types of ways, the directions of way objects and signs, the types of
  bridges and tunnels;
* terrain heights and slopes, grounds added, removed or replaced (bridge decks, elevated ways,
  tunnels, foundations, water), climates.

The hooks only set a flag of the 64x64 cells of the square and of its eight neighbours (an object also
changes how the next squares look: ways, overhead lines and power lines join up), so a change at the
edge of a cell also marks the next cell. The flags become changes, each with a new map gen, once per
frame and whenever `poll`, `map_changes`, `minimap`, `scene3d` or `heights` read the map gen, so every
reply sees all changes made before it. Not reported: tree growth (age class),
signal, traffic light and crossing states (also the `a` of traffic lights), seasons and snow (reply
fields of `scene3d`); owner changes come from the
background re-check of the owner colours (within about 16 s). The hooks change nothing in the game and
cost nothing while the map is not tracked.

Checked on the NYC map with a content test: all 256 chunks decoded (tree age classes, sign and signal
states and the directions of traffic lights left out), the game run at 8 times the normal speed while
a road, a bus stop and a sign are built, a road square removed, a tree planted and a corner raised
with `tool`, all chunks decoded again and compared with `map_changes since=<rev of the chunk>
chunk=64`. Over 3 months 224 and 230 of 256 chunks changed (mostly trees), over 1.2 months 15, over
0.3 months 1: every changed chunk was reported (no false negatives), one chunk was reported whose
content was the same again at the end. The hooks ran about 70 times per second.

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
`-remote_control_agent` lets every program that can connect act for any company but the public player
through the agent commands, also for companies protected by a password (on a server for all
clients): enable it only where the connecting program (the dashboard bridge) does the authorization.
