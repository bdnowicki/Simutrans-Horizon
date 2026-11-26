# Simutrans-Horizon

> **Unofficial fork of [Simutrans](https://www.simutrans.com/).**
> Simutrans-Horizon is not affiliated with, endorsed by or supported by the Simutrans Team.
> If you are looking for the original game, visit [simutrans.com](https://www.simutrans.com/en/) or the
> [official source mirror](https://github.com/simutrans/simutrans).

- 1.0) [About](#1-about)
- 2.0) [Differences from Simutrans](#2-differences-from-simutrans)
- 3.0) [Playing](#3-playing)
- 4.0) [Compiling](#4-compiling)
	- 4.1) [Getting the source code](#41-getting-the-source-code)
	- 4.2) [Getting the libraries](#42-getting-the-libraries)
	- 4.3) [Compiling with make](#43-compiling-with-make)
	- 4.4) [Compiling with Microsoft Visual Studio](#44-compiling-with-microsoft-visual-studio)
	- 4.5) [Compiling with CMake](#45-compiling-with-cmake)
	- 4.6) [Cross-compiling](#46-cross-compiling)
- 5.0) [Contributing](#5-contributing)
- 6.0) [License](#6-license)
- 7.0) [Credits](#7-credits)

## 1) About

Simutrans is a freeware and open-source transportation simulator. Your goal is to establish a successful transport company: transport passengers, mail and goods by rail, road, ship and air, and connect cities, industries and attractions with the network you always dreamed of.

**Simutrans-Horizon** takes the Simutrans source code (Simutrans Standard, SVN trunk) as its starting point and develops it in a more modern direction. Changes are made openly in this repository and listed below.

The `master` branch started from Simutrans trunk **r12390** and takes in newer Simutrans revisions from time to time.

## 2) Differences from Simutrans

The Artistic License asks every modified version to document how it differs from the standard version. This section is that documentation and is kept up to date with every change. In the source, every file that differs from Simutrans carries a `Simutrans-Horizon` notice near its top.

### New features

- **Remote control interface.** With the command line option `-remote_control [port]` (default port 13360) the game accepts JSON commands on 127.0.0.1 only. Without the option the game behaves like Simutrans. The line protocol is described in [tools/mcp](tools/mcp/README.md).
  - *Game and windows:* commands read the game state, the map, the tiles, the open windows with their buttons, players, cities, stations, convoys, lines, factories and the messages. Other commands send mouse and keyboard input and text, move and zoom the view, pause the game, switch fast forward, add money to a player (`cash`), take screenshots and run Squirrel scripts (`eval`).
  - *Tools:* build and remove tools can be applied at map positions like scripts do (`tool`), also in network games (through the server). Players protected by a password are refused. Toolbar tools can be hidden, or a tool that a scenario forbids can be shown, which then works again (single player only, not saved). The command that lifts the "Lock game" lock of a map so the player can be changed, and the command that removes the password of a player such as the public player, work in single player games only and are saved with the game.
  - *Dashboard commands:* a small status for frequent polling (`poll`), new messages since the last request (`messages since=`), the positions of all convoys in compact rows (`positions`), and paging of the object lists.
  - *Map export:* the colours of the minimap as palette indices (`palette`, `minimap`), the minimap in 12 modes (terrain, owner, traffic, freight, passengers, mail, tracks, speed, power, forest, level, climates), the areas that changed since an earlier request (`map_changes`) and the map labels (`labels`).
  - *3D export:* a catalogue of the pak objects with their untranslated names and stable numbers (`desc_list`) and the map in chunks of 64x64 squares for a 3D view: corner heights, ground types and all objects that do not move (ways, buildings, trees, bridges, tunnels, signs, overhead lines, ...) in compact binary blocks (`scene3d`), the terrain heights of large areas (`heights`) and the moving vehicles with what is needed to animate them smoothly, optionally with city cars and pedestrians (`vehicles3d`). Changes of the map that the minimap does not show (a city building replaced, a road extended, a sign added) are reported too (`map_changes`). These commands only read the game, so they also work with `-remote_control_readonly` and in network games, and the game runs at most one large request per frame, so a burst of them does not stall a network game.
  - *Details and histories:* the content of several windows as data: finances (`finance`), lines (`line`), convoys with their vehicles and freight (`convoy`), the route of a convoy (`line_route`), stations with capacity, history, waiting goods, lines and departure board (extra arguments of `station`), cities (`city`), factories with their connections and charts (`factory`, and `factories links=1` for the supply links), the supply chains (`supply_chain`), the goods list (`goods`) and the world statistics (`world_stats`). They only read values that the game keeps and change nothing, so they also work in network games.
  - *Events:* programs that greet with protocol 2 can subscribe to events that the game sends by itself: new messages, new month, world loaded or closed, pause and speed changes, cash changes, convoy state changes and arrivals at stops (`subscribe`). Recording them does not change the game, so they also work in network games.
  - *Limits:* up to 8 programs can be connected at the same time. Large requests are spread over several frames and replies are sent without blocking, so a slow program does not freeze the game. A program that stops reading its replies for 60 seconds, or sends more than 8 MB of requests ahead, is disconnected. Text input is queued safely: every text is kept until the game has processed it, and when too many texts are waiting the command fails with an error instead of losing input.
  - *Safety:* Squirrel scripts sent this way cannot start programs or rename or delete files (`system`, `remove`, `rename` and `getenv` are removed from their script engine). `eval` also refuses the scripted tools (`tool_exec_script`, `tool_exec_two_click_script`). Screenshots cannot be written to network paths.
  - *Read-only mode:* with `-remote_control_readonly [port]` instead (or in addition) only commands that read the game and the windows are accepted. Input, scripts, screenshots and all other commands that change something are refused; with `-remote_control_time` as well, pause and fast forward are still accepted.
  - *Time of network games:* on a server, pause and fast forward of the remote control act for all clients: pause stops the server's steps (the clients wait), fast forward runs the game at 4× speed through the speed tool of the public player, which every client applies at the same step. Simutrans itself offers neither to the players of a network game.
  - *Agent commands:* a few allow-listed changes for one company, given by its number (`player=N`), for trusted programs such as the AI team of the dashboard: building and removal tools for ways, bridges, tunnels, stations, signs, depots and way objects (`agent_tool`, which refuses to remove anything that does not belong to the company), buying, starting and selling vehicles in a depot (`depot_op`, `depot`), creating, changing, renaming and deleting lines (`line_op`), and putting convoys on lines, selling, withdrawing or sending them to a depot (`convoy_op`), plus a dry run of the way builder with route and price (`plan_way`) and prices of objects (`estimate`). The public player and objects of other companies are refused and the scenario rules apply; on a network server the changes go to all clients like a player's clicks, also for companies protected by a password. A full `-remote_control` accepts them; with `-remote_control_readonly` they need `-remote_control_agent` as well (a dedicated server whose remote control stays read only otherwise).
  - *Agent commands:* a few allow-listed changes for one company, given by its number (`player=N`), for trusted programs such as the AI team of the dashboard: building and removal tools for ways, bridges, tunnels, stations, signs, depots and way objects (`agent_tool`, which refuses to remove anything that does not belong to the company), buying, starting and selling vehicles in a depot (`depot_op`, `depot`), creating, changing, renaming and deleting lines (`line_op`), and putting convoys on lines, selling, withdrawing or sending them to a depot (`convoy_op`), plus a dry run of the way builder with route and price (`plan_way`) and prices of objects (`estimate`). The public player and objects of other companies are refused and the scenario rules apply; on a network server the changes go to all clients like a player's clicks, also for companies protected by a password. A full `-remote_control` accepts them; with `-remote_control_readonly` they need `-remote_control_agent` as well (a dedicated server whose remote control stays read only otherwise).
  - [tools/mcp](tools/mcp/README.md) contains an MCP server that lets AI assistants such as Claude Code read and play the game through this interface.
- **Browser dashboard.** [tools/dashboard](tools/dashboard/README.md) is a separate Python program (standard library only, not part of the game). It connects to the remote control of a running game and serves a web page with a live map, finances, messages, convoys, lines, stations, cities, factories, supply chains and world statistics. Access needs a token; the roles are viewer (read only), player (also pause, fast forward and build tools as the active player) and an optional admin. The program listens on 127.0.0.1 by default. The web page includes these third-party JavaScript libraries, with their licences in `tools/dashboard/web/vendor`: htm with Preact (Apache-2.0 and MIT), uPlot (MIT) and Leaflet (BSD-2-Clause).
  - *3D view:* the tab "3D" shows the map in 3D (WebGL 2, with three.js under the MIT licence in `tools/dashboard/web/vendor`): an isometric camera with the four rotations of the game or a free camera, zoom from a city block out to the whole map, and a click or tap shows the same details as a click on the map. Everything is drawn in a stylized low-poly look: terrain with water and cliffs, ways, bridges, tunnel portals, overhead lines, signals and signs (arrows painted on runways and taxiways), stations and depots, buildings generated from the pak's building list (towers with setbacks, houses with roofs by climate, factory sites, churches, parks, stadiums, monuments, town halls and headquarters in the company colour; rules in `gen/rules.json`), trees by kind, age and season, fields and rocks, and beyond the loaded area a coarse terrain of the whole map coloured from the minimap. Every convoy car, and optionally city cars and pedestrians, moves smoothly between the game's positions; the camera can follow a convoy ("Follow in 3D" in its panel or card). Options in a quality panel: day and night by the game time with lit windows at night, shadows of the sun, names of cities and stations, detail distance and tree density; seasons and snow above the snowline follow the game. Phones get a lighter quality and touch gestures.
  - *AI team:* players of a company get the tab "Team" with eight AI specialists (coordinator, analyst, accountant, designer, engineer, logistician, dispatcher, fleet manager) based on the DeepSeek language models (`DEEPSEEK_API_KEY`). Each has its own chat, shared by the players of the company; they answer questions about the company from the game's data, ask back with structured questions (options, text, numbers, squares or areas picked on the map, lines, stations, convoys or factories), hand work to each other through the coordinator on a task board, and prepare changes (ways, stations, depots, signs, lines, schedules, buying, replacing and selling vehicles) as projects with a cost estimate and a preview on the 2D map and as transparent ghosts in the 3D view. A project runs only after a player approved it, step by step through the agent commands of the game: not when the cash after the estimate would be negative, stopping at the first failing step or when the actual cost exceeds the estimate by more than 20 %. A daily cost limit (all companies and optionally per company) and a cost counter are shown in the tab. Access tokens are kept as hashes in a SQLite database together with the team's history; each player token is bound to a company, and a token command adds, lists and revokes tokens. Viewers do not see the team.
  - *Pak 3D:* with `--pak3d DIR` the 3D view draws selected buildings, vehicles, trees and signs with glTF models matched by their pak names or bound to a place of a map (a landmark such as the Empire State Building where the New York City map marks it; a manifest with LODs, season and climate variants, company coloured materials, night lights, animations and generator rules); everything else stays generated, and a "Model authors" page lists the authors and licences of the models. [tools/pak3d](tools/pak3d/README.md) describes the format and has a checker and a coverage report (Python, standard library only). The models for pak128 are in a separate repository, [simutrans-horizon-pak3d](https://github.com/bdnowicki/simutrans-horizon-pak3d) (CC BY 4.0).
- **Dedicated server in Docker.** [tools/server](tools/server/README.md) builds a headless server (Linux, Docker) that hosts a saved game for clients in the LAN, never announces itself publicly, keeps the game running while nobody plays, saves the game when it is stopped and runs the browser dashboard next to it, read only except that the player token may pause and speed up the game for everyone. Simutrans does not autosave network games; a server whose time runs on without clients (`pause_server_no_clients = 0`) now saves its game every `autosave` months while nobody plays, into the save it continues on its next start. A pak 3D can be mounted read only for the dashboard's 3D view (`SIMUTRANS_PAK3D_DIR`).
- **Option "Show future objects".** In the display settings (GUI tab) and as the checkbox "Show future" in every depot window. Toolbars then offer also ways, bridges, tunnels, catenary, signs and stations that are not yet introduced in the timeline, and depots sell vehicles that are not yet in production. The option is for single player games only: it is not saved and has no effect in network games. Polish translations are included.

### Bug fixes

- Scenario texts loaded from files (info, goal, rules, result, about) were shown as "(null)" after the plainstring change in Simutrans r12344.
- The public chat tab listed the direct messages instead of the public ones (same cause).
- In network games, scenarios whose `resume_game` calls tools (e.g. `settings.set_traffic_level`) were dropped by the server when it loaded the game; the server now ignores these calls during loading, as single player games do.
- A scenario that opens its window without a tab (`gui.open_info_win()`) made every client crash when it joined the server.

### Compatibility

The save game format is unchanged: Simutrans-Horizon and Simutrans load each other's saved games.

## 3) Playing

There are no binary releases of Simutrans-Horizon yet; build it from source (see below).

Like Simutrans, the program needs a pakset (the graphics and game data) to run. Paksets are distributed separately, for example from the [Simutrans paksets page](https://www.simutrans.com/en/paksets/). Start the executable with `-use_workdir` to point it to an existing Simutrans installation.

Saved games and network games are compatible with Simutrans only as long as Simutrans-Horizon does not change the file format or the game logic; incompatibilities will be listed in section 2.

To play the original game, download Simutrans from the [official website](https://www.simutrans.com/en/) or [Steam](https://store.steampowered.com/app/434520/Simutrans/).

## 4) Compiling

This is a short guide. For more details, read the [Compiling Simutrans](https://simutrans-germany.com/wiki/wiki/en_CompilingSimutrans) wiki page, which applies to Simutrans-Horizon as well.

If you are on Windows, install either [Microsoft Visual Studio](https://visualstudio.microsoft.com/) or [MSYS2](https://www.msys2.org/). MSVC is easier for debugging; MSYS2 is easy to set up (on the command line).

### 4.1) Getting the source code

```
git clone https://github.com/bdnowicki/Simutrans-Horizon.git
```

To follow the development of Simutrans itself, add the official mirror as a second remote:

```
git remote add upstream https://github.com/simutrans/simutrans.git
git fetch upstream
```

The git history does not carry the SVN revision number that Simutrans uses as its version. Set the game version manually if you need to join a network game.

### 4.2) Getting the libraries

Not all libraries are necessary; pick them according to your needs.

| Library       | Website                             | Necessary? | Notes                                                                     |
|---------------|-------------------------------------|------------|---------------------------------------------------------------------------|
| zlib          | https://zlib.net/                   | Necessary  | Basic compression support                                                 |
| bzip2         | https://www.bzip.org/downloads.html | Necessary  | Alternative compression. You can pick this or zstd                        |
| libpng        | http://www.libpng.org/pub/png/      | Necessary  | Image manipulation                                                        |
| libSDL2       | http://www.libsdl.org/              | Necessary* | *On Linux & Mac. Optional but recommended for Windows. Graphics back-end  |
| libzstd       | https://github.com/facebook/zstd    | Optional   | Alternative compression (larger save files than bzip2, but faster)        |
| libfreetype   | http://www.freetype.org/            | Necessary  | TrueType font support                                                     |
| libminiupnpc  | http://miniupnp.free.fr/            | Optional   | Easy Server option                                                        |
| libfluidsynth | https://www.fluidsynth.org/         | Optional   | MIDI playback recommended on Linux & temporarily on Mac                   |
| libSDL2_mixer | http://www.libsdl.org/              | Optional   | Alternative MIDI playback and sound system                                |
| libfontconfig | https://www.fontconfig.org/         | Optional   | Font autodetection (Linux/Mac)                                            |

You will also need pkgconfig (Unix) or [vcpkg](https://github.com/Microsoft/vcpkg) (Microsoft Visual C++).

- MSVC: the needed libraries are compiled automatically if vcpkg is installed. Alternatively, copy install-building-libs-{architecture}.bat to the vcpkg folder and run it.
- MSYS2: run [tools/setup-mingw.sh](tools/setup-mingw.sh) to get the libraries and set up the environment.
- Ubuntu/Debian: run [tools/setup-debian.sh](tools/setup-debian.sh) to get the libraries and set up the environment.
- Linux: use [pkgs.org](https://pkgs.org/) to find the development libraries in your package manager.
- Mac: install the libraries via [Homebrew](https://brew.sh/).

Compiling gives you only the executable; you still need a pakset to run the program (see [Playing](#3-playing)).

### 4.3) Compiling with make

The executable is built in build/default.

```
(Linux) autoconf
(MacOS) autoreconf -ivf
./configure
make -j 4
(MacOS) make OSX/getversion
```

### 4.4) Compiling with Microsoft Visual Studio

The solution file [Simutrans.sln](./Simutrans.sln) contains these projects:

- Simutrans-Main: the shared files that are not specific to a back-end. All the following projects use it.
- Simutrans SDL2: the preferred back-end.
- Simutrans SDL3: the SDL3 back-end.
- Simutrans GDI: Windows-only back-end.
- Simutrans Server: server back-end without a graphical interface.

Select one of them as the startup project and build it.

### 4.5) Compiling with CMake

The executable is built in build/simutrans.

Command line on Linux/MinGW/MacOS:
```
cmake -G "Insert Correct Makefiles Generator" -B build .
cmake --build build -j 4
```
See [the list of CMake generators](https://cmake.org/cmake/help/latest/manual/cmake-generators.7.html).

MSVC:
```
mkdir build && cd build
cmake.exe .. -G "Visual Studio 17 2022" -A x64 -DCMAKE_TOOLCHAIN_FILE=[vcpkg-root]/scripts/buildsystems/vcpkg.cmake
cmake --build . --config Release
```

### 4.6) Cross-compiling

To cross-compile from Linux for Windows, see the [Cross-Compiling Simutrans](https://simutrans-germany.com/wiki/wiki/en_Cross-Compiling_Simutrans) wiki page.

## 5) Contributing

Issues and pull requests are welcome in this repository.

- Follow the coding guidelines in [documentation/coding_styles.txt](documentation/coding_styles.txt).
- Every file changed compared with Simutrans gets a short notice near its top stating what was changed for Simutrans-Horizon and when, as the Artistic License requires. Example: `// Simutrans-Horizon, 2026-11: added the "Show future objects" option`.
- Describe each change visible to players in [section 2](#2-differences-from-simutrans).
- Report a bug here if it happens only in Simutrans-Horizon. If it also happens in the original game, report it in the [Simutrans Bug Reports forum](https://forum.simutrans.com/index.php/board,8.0.html).
- Improvements that would also benefit Simutrans itself can be offered to the Simutrans Team as a patch in the [Patches & Projects forum](https://forum.simutrans.com/index.php/board,33.0.html); the Simutrans Team does not accept GitHub pull requests.
- Translations of texts that also exist in Simutrans belong in [SimuTranslator](https://translator.simutrans.com/); texts added by Simutrans-Horizon are translated in `simutrans/text/*.tab` here.

## 6) License

Simutrans-Horizon is a modified version of Simutrans and is distributed under the same **Artistic License version 1.0**; see [LICENSE.txt](./LICENSE.txt) for the complete text. The copyright holders of Simutrans are Hansjörg Malthaner (1997-2004) and The Simutrans Team (since 2005). All modifications made in this repository are freely available under the same license.

The name Simutrans is used only to describe where this project comes from; it does not imply any endorsement by the Simutrans Team.

Paksets, which are necessary to run the game, have their own licenses, and none is included here. Check the license of each pakset before redistributing it; some parts of paksets (for example the sounds of pak128) are not covered by the pakset's main license.

## 7) Credits

Simutrans was originally written by Hansjörg Malthaner "Hajo" from 1997 until he retired from development around 2004. Since then, a team of contributors (The Simutrans Team) led by Markus Pristovsek "Prissi" has been developing Simutrans. A list of early contributors can be found in [simutrans/thanks.txt](./simutrans/thanks.txt).

Simutrans-Horizon is maintained by [bdnowicki](https://github.com/bdnowicki).
