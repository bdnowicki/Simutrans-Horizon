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
| `factories` | production, input/output storage, suppliers/consumers |
| `messages` | message center (incl. scenario messages) |
| `ui_elements`, `tile_to_screen`, `screen_to_tile` | GUI elements and coordinate conversion |
| `run_squirrel` | any query or action through the scripting API |
| `use_tool` | apply a game tool exactly at map coordinates (build way, station, depot, remove, ...) |
| `change_cash` | add money to (or take it from) a player's bank account, like `book_cash()` of scenario scripts |
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

## Security

The port is bound to 127.0.0.1 and every connection must start with the line
`HELLO simutrans-remote 1`, so web pages cannot talk to it through HTTP requests.
Any local program that connects can control the game and run Squirrel code (which includes
the Squirrel system library), so only enable `-remote_control` when you need it.
