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
| `use_tool` | apply a game tool exactly at map coordinates (build way, station, depot, remove, ...) |
| `change_cash` | add money to (or take it from) a player's bank account, like `book_cash()` of scenario scripts |
| `set_tool_visibility` | hide a toolbar tool, or show a tool that the scenario forbids; see below |
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
every scenario forbids (`simutrans/script/scenario_base.nut`); on a map locked with "Lock game" changing the
player stays impossible. `tool=TOOL_BUILD_WAY waytype=air visibility=show` allows taxiways and
runways when a scenario forbids them. Rules are not saved and last until the game is closed.

## Security

The port is bound to 127.0.0.1 and every connection must start with the line
`HELLO simutrans-remote 1`, so web pages cannot talk to it through HTTP requests.
Any local program that connects can control the game and run Squirrel code (which includes
the Squirrel system library), so only enable `-remote_control` when you need it.
