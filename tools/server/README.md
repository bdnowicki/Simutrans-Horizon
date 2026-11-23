# Simutrans-Horizon server

A Docker image that runs Simutrans-Horizon as a dedicated network server (headless, no window)
and the [browser dashboard](../dashboard/README.md) next to it, read only. It is meant for a LAN:
the server never announces itself on the public server list.

- `Dockerfile` builds the engine on Debian (CMake, backend `none`) and copies the dashboard.
  The image holds no pakset and no game.
- `entrypoint.sh` starts the server (`-server 13353`, remote control `-remote_control_readonly 13360`
  inside the container only) and the dashboard on port 13380. On `docker stop` the server saves the
  game before it quits.
- `simuconf.tab` is copied once into the user directory: `server_announce = 0`,
  `pause_server_no_clients = 1` (time runs only while someone plays), `server_save_game_on_quit = 1`.
  `autosave` has no effect in network games; the server saves whenever the last client leaves.
- `compose.yaml` publishes 13353 (game) and 13380 (dashboard) on one LAN address only.

## Layout on the host

```
simutrans/
  compose.yaml       copy of tools/server/compose.yaml
  .env               chmod 600, see below
  base/              base files of the clients: config, text, script, ai, themes, font and pak128/
  user/              user directory: simuconf.tab, settings.xml, save/, server13353-*.sve
```

`.env`:

```
SIMUTRANS_LAN_IP=192.168.1.10
SIMUTRANS_INITIAL_SAVE=my_game.sve
SIMUTRANS_DASHBOARD_HOSTS="192.168.1.10 myserver"
SIMUTRANS_DASHBOARD_TOKEN_VIEWER=<random, at least 16 characters>
SIMUTRANS_DASHBOARD_TOKEN_PLAYER=<another one>
```

`SIMUTRANS_DASHBOARD_HOSTS` lists the names the browsers use for the host (Host header check).
Tokens: `python3 -c "import secrets; print(secrets.token_urlsafe(24))"`.

## Build and deploy

The engine revision must be the r number of the clients (title bar or "About" of the game); the
server list of the clients shows other revisions as mismatching. From the repository root, with
the image built on the host:

```
git ls-files -co --exclude-standard -z -- CMakeLists.txt cmake src tools/mcp tools/dashboard tools/server \
  | tar --null -T - -czf - \
  | ssh host 'docker build --build-arg SIMUTRANS_REVISION=12400 -f tools/server/Dockerfile -t simutrans-horizon-server -'
ssh host 'cd simutrans && docker compose up -d'
```

The base files and the pakset must be byte-identical to those of the clients (copy the
`simutrans` directory of the client, e.g. `tar -chf - . | ssh host 'tar -xf - -C simutrans/base'`).
Put the game to host into `user/save/` and name it in `SIMUTRANS_INITIAL_SAVE`.

In network games the server deletes companies (other than the first two) that nobody plays and
that ran no vehicle for `remove_dummy_player_months` months (a setting stored in the save,
default 6), with everything they own.
If the game has such a company that must stay (e.g. a scenario's helper company), set the value to
0 in single player first (Settings, Economy) and save the game under a new name for the server.

On the first start the server loads `SIMUTRANS_INITIAL_SAVE`. Later it continues its own game: the save written
when it quit (`server13353-restore.sve`) or when the last client left (`server13353-network.sve`),
whichever is newer. To start over from `SIMUTRANS_INITIAL_SAVE`, stop the server and delete
`user/server13353-*.sve`.

- Update: build the image again, then `docker compose up -d` (the game is saved and continued).
- New pakset files: stop the server, copy them into `base/`, start it; clients need the same files.
- Backup: `user/server13353-network.sve` (or `-restore.sve`, the newer one) is a normal save game;
  copy it while the server runs or after `docker compose stop`.
- Logs: `docker compose logs -f`.

## Joining

In the game: join a network game with the address `<LAN IP>:13353`, or from the command line:

```
"Simutrans SDL2 Nightly.exe" -set_basedir <client simutrans dir> -objects pak128/ -load net:<LAN IP>:13353
```

The server allows changing the company even if the map was locked with "Lock game"; companies
with a password ask for it.

## Dashboard

`http://<LAN IP>:13380/?token=<SIMUTRANS_DASHBOARD_TOKEN_VIEWER>` (read the token with
`grep TOKEN_VIEWER .env` on the host). The remote control of the server is read only, so the
player token can look but not act. The container log hides the tokens.
