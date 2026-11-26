# Simutrans-Horizon server

A Docker image that runs Simutrans-Horizon as a dedicated network server (headless, no window)
and the [browser dashboard](../dashboard/README.md) next to it, read only except for pausing and
speeding up the game and, optionally, the dashboard's AI team. It is meant for a LAN: the server never
announces itself on the public server list.

- `Dockerfile` builds the engine on Debian (CMake, backend `none`) and copies the dashboard with its
  AI team (`tools/dashboard/team`). The image holds no pakset and no game.
- `entrypoint.sh` starts the server (`-server 13353`, remote control `-remote_control_readonly 13360
  -remote_control_time`, with `SIMUTRANS_AGENTS=1` also `-remote_control_agent`, inside the container only)
  and the dashboard on port 13380 with its database in `user/dashboard/agents.sqlite` (access tokens and
  the AI team's history). On `docker stop` the server saves the game before it quits.
- `simuconf.tab` is copied once into the user directory: `server_announce = 0`,
  `pause_server_no_clients = 0` (time runs on while nobody plays), `autosave = 1` (while nobody
  plays the server saves its game every month) and `server_save_game_on_quit = 1`. With
  `pause_server_no_clients = 1` time runs only while someone plays and the server saves whenever the
  last client leaves. An existing copy in the user directory is not replaced: edit it there.
- `compose.yaml` publishes 13353 (game) and 13380 (dashboard) on one LAN address only.

## Layout on the host

```
simutrans/
  compose.yaml       copy of tools/server/compose.yaml
  .env               chmod 600, see below
  base/              base files of the clients: config, text, script, ai, themes, font and pak128/
  user/              user directory: simuconf.tab, settings.xml, save/, server13353-*.sve,
                     dashboard/agents.sqlite (tokens and AI team history, created by the dashboard)
  pak3d/             optional: clone of a pak 3D (models of the dashboard's 3D view)
```

`.env` (it holds secrets: `chmod 600 .env`; every variable in it reaches the container, none is printed):

```
SIMUTRANS_LAN_IP=192.168.1.10
SIMUTRANS_INITIAL_SAVE=my_game.sve
SIMUTRANS_DASHBOARD_HOSTS="192.168.1.10 myserver"
SIMUTRANS_DASHBOARD_TOKEN_VIEWER=<random, at least 16 characters>
SIMUTRANS_DASHBOARD_TOKEN_PLAYER=<another one>
```

`SIMUTRANS_DASHBOARD_HOSTS` lists the names the browsers use for the host (Host header check).
Tokens: `python3 -c "import secrets; print(secrets.token_urlsafe(24))"`. The dashboard imports the two
tokens into its database at its first start (see [Tokens](#tokens)).

Optional:

| Variable | Meaning |
|---|---|
| `SIMUTRANS_PAK3D_DIR=./pak3d` | the models of a pak 3D for the 3D view of the dashboard, see [3D models](#3d-models-optional) |
| `SIMUTRANS_TIME_CONTROL=0` | the dashboard may not pause or speed up the game |
| `SIMUTRANS_DASHBOARD_PLAYER_COMPANY=N` | company of the imported player token (default 0); only read while the database has no tokens |
| `SIMUTRANS_DASHBOARD_TRUSTED_PROXIES` | addresses or networks of reverse proxies in front of the dashboard (space or comma separated), see [Behind a reverse proxy](#behind-a-reverse-proxy) |
| `SIMUTRANS_AGENTS=1` | the AI team of the dashboard, see [AI team](#ai-team-optional) (default off: no Team tab) |
| `DEEPSEEK_API_KEY` | the key of the DeepSeek API for the AI team (secret) |
| `DEEPSEEK_BASE_URL` | another address of the API (default `https://api.deepseek.com`) |
| `SIMUTRANS_TEAM_LIMIT` | daily cost limit of the AI team for all companies together in USD (default 0.50) |
| `SIMUTRANS_TEAM_COMPANY_LIMIT` | daily cost limit per company in USD, or `off` |

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
whichever is newer. To start over from `SIMUTRANS_INITIAL_SAVE`, stop the server and move
`user/server13353-*` away. After editing `.env` use `docker compose up -d` (it recreates the
container); `docker compose start` keeps the old environment.

- Update: build the image again, then `docker compose up -d` (the game is saved and continued).
- New pakset files: stop the server, copy them into `base/`, start it; clients need the same files.
- Backup: `user/server13353-network.sve` (or `-restore.sve`, the newer one) is a normal save game;
  copy it while the server runs or after `docker compose stop`. The dashboard's database
  `user/dashboard/agents.sqlite` (with `-wal` and `-shm` while it is open): copy it after
  `docker compose stop`.
- Logs: `docker compose logs -f` (tokens and keys are hidden).

## Joining

In the game: join a network game with the address `<LAN IP>:13353`, or from the command line:

```
"Simutrans SDL2 Nightly.exe" -set_basedir <client simutrans dir> -objects pak128/ -load net:<LAN IP>:13353
```

The server allows changing the company even if the map was locked with "Lock game"; companies
with a password ask for it.

## Dashboard

`http://<LAN IP>:13380/?token=<SIMUTRANS_DASHBOARD_TOKEN_VIEWER>` (read the token with
`grep TOKEN_VIEWER .env` on the host), or `http://<LAN IP>:13380/` and the token in the sign-in form. The
remote control of the server is read only except for the time and, when enabled, the AI team: with a
player token the buttons Pause and Fast forward pause the game and run it at 4× speed for all clients
(`-remote_control_time`; `SIMUTRANS_TIME_CONTROL=0` in `.env` switches this off). A client that joins
resumes the game at normal speed, as Simutrans does. The dashboard's own building tools stay off on the
server (they need a full remote control); changes of the game from the dashboard are possible only
through the [AI team](#ai-team-optional), as projects that a player of the company approves. The container
log hides tokens and keys.

### Tokens

The dashboard keeps its access tokens in `user/dashboard/agents.sqlite` (hashes only, each with a role,
a label and for player tokens a company). At its first start with an empty database it imports
`SIMUTRANS_DASHBOARD_TOKEN_VIEWER` and `SIMUTRANS_DASHBOARD_TOKEN_PLAYER` from `.env` once; the player
token is bound to the company `SIMUTRANS_DASHBOARD_PLAYER_COMPANY` (default 0). After that the database
holds the tokens: changing them in `.env` has no effect (the log says so). Manage them while the server
runs:

```
docker compose exec server python3 /opt/simutrans/tools/dashboard/simutrans_dashboard.py \
  token add --role player --company 0 --label Alice --db /simutrans/user/dashboard/agents.sqlite
docker compose exec server python3 /opt/simutrans/tools/dashboard/simutrans_dashboard.py \
  token list --db /simutrans/user/dashboard/agents.sqlite
docker compose exec server python3 /opt/simutrans/tools/dashboard/simutrans_dashboard.py \
  token revoke 2 --db /simutrans/user/dashboard/agents.sqlite
```

`token add` prints the new token once, in the terminal only (not in the container log); `--role viewer`
takes no `--company`. `token list` shows ids, roles, companies, labels and dates, never a token. `token
revoke` ends the token's sessions within about 2 seconds. (`--db` may be left out: `compose.yaml` sets
`SIMUTRANS_DASHBOARD_DB`.) A player token of company N lets its holder pause and speed up the game and,
with the AI team, spend company N's money through approved projects, without the company's password:
give every player a token of their own (with a label) and revoke it when they leave. The server deletes
companies that nobody plays after `remove_dummy_player_months`; revoke the tokens of a company that is
gone, before its number is used by a new one.

### AI team (optional)

The Team tab of the dashboard (see [tools/dashboard](../dashboard/README.md#ai-team)) gives the players
of a company eight AI specialists (DeepSeek language models): they analyse the company and prepare
changes as projects. To enable it, add to `.env`

```
SIMUTRANS_AGENTS=1
DEEPSEEK_API_KEY=<the key>
SIMUTRANS_TEAM_LIMIT=0.50
SIMUTRANS_TEAM_COMPANY_LIMIT=0.25
```

and run `docker compose up -d`. The game then also runs with `-remote_control_agent`: its remote control
accepts the agent commands besides the reads, nothing else. Without `SIMUTRANS_AGENTS=1` the dashboard
offers no Team tab; without the key the tab says that none is set up. The image talks to the API over
HTTPS (it contains the CA certificates).

* **Who:** only player tokens (bound to a company); viewers do not see the tab and cause no cost. All
  player tokens of a company share its chats, tasks, questions and projects; other companies never see
  them. The history stays in the database across restarts; questions waiting for an answer survive a
  restart, a run or project interrupted by one stops with a note.
* **What the agents can do:** read the game through the dashboard (aggregated lists, the company's own
  lines and convoys in detail), ask the players questions (options, text, number, squares on the map,
  game objects) and propose projects: build and remove ways, bridges, tunnels, stations, depots, signs and
  way objects of the company, create, change and delete its lines, buy, assign, withdraw, replace and sell
  its vehicles. A project shows its cost estimate and a preview on the 2D map and in the 3D view and runs
  only after a player clicked "Build it"; the dashboard carries it out step by step with the agent
  commands, as the token's company, for all clients like the clicks of a player. It does not start when
  the cash after the estimate would be below 0, stops at the first failing step and stops when the actual
  cost exceeds the estimate by more than 20 %.
* **What they cannot do:** act for another company or the public player, use depots, lines or convoys
  of other companies, remove or change what does not belong to the company (city roads, factories, other
  companies' ways and stops), move money, change passwords or lock the game, pause or change settings,
  run scripts or anything else of the full remote control, or change anything without an approved
  project. They work only when asked (no background runs).
* **Costs:** the dashboard counts every model call; the tab shows today's cost of all companies against
  `SIMUTRANS_TEAM_LIMIT` (default 0.50 USD per UTC day) and the company's share against
  `SIMUTRANS_TEAM_COMPANY_LIMIT` (default none: one company may use the whole day's budget; set a share
  when several companies use the team). At the limit the agents refuse until midnight UTC. One request
  costs about 0.004–0.012 USD with `deepseek-flash`; the coordinator, the analyst and the designer use
  `deepseek-v4-pro` (about 4.4 times the price per token). The limits given in `.env` are stored in the
  database at every start.

### Behind a reverse proxy

When the dashboard is published through a reverse proxy (e.g. Apache on a router with a public host
name), every visitor arrives from the proxy's address, so the connection limit (32 per address) and the
login limit (5 failures per minute and address) act on all visitors together. Name the proxy in `.env`:

```
SIMUTRANS_DASHBOARD_TRUSTED_PROXIES=192.168.1.1
```

Then the dashboard takes the visitor's address from the `X-Forwarded-For` header that the proxy appends
(Apache's `mod_proxy` does so by default) for the limits and the log; the header is ignored from every
other address. To find the address to trust, sign in once through the proxy with a wrong token and read
`docker compose logs server | grep "failed login"`: the address in front is the proxy as the dashboard sees
it. Trust only an address from which nothing but the proxy connects to the dashboard. If every visitor,
also in the LAN, shows the same address of a Docker network (e.g. `172.17.0.1`), Docker's port mapping
hides the addresses and trusting it would let LAN clients write their own `X-Forwarded-For`. With a CDN in
front of the proxy (Cloudflare), the right-most entry is the CDN's edge address: add the CDN's published
address ranges (`https://www.cloudflare.com/ips/`) to the variable to count real visitors, or let the
proxy replace the address (Apache `mod_remoteip` with `RemoteIPHeader CF-Connecting-IP` and the CDN's
ranges as `RemoteIPTrustedProxy`).

### Security notes

* `.env` holds the API key and the tokens: `chmod 600 .env`. The container log hides anything that
  looks like a token or a key (`token=`, `Bearer`, `sk-...`, `DEEPSEEK_API_KEY=`).
* Token links (`/?token=...`) end up in the access logs of the proxies on the way (Apache, Cloudflare)
  and in the browser history. Player tokens now authorise spending a company's money: give them out for
  the sign-in form instead of as links, and drop query strings from proxy logs or rotate tokens whose
  links were logged.
* After the first start with the database, create personal tokens with `token add` and revoke the
  imported `.env` tokens (`token list` shows their ids), as they were stored in `.env` and may have been
  shared as links. A bridge started outside Docker prints the tokens it creates at its first start in its
  output: rotate those as well if that output was kept.
* The database contains the chats with the agents; its directory is readable only by the container user
  (mode 0700, file 0600). Backups of `user/` contain it.

## 3D models (optional)

The 3D tab of the dashboard needs an image built from a source tree with the 3D export of the remote
control (an older image keeps working, the dashboard then hides the tab). It draws every object with
generated shapes; a pak 3D
([tools/pak3d](../pak3d/README.md), e.g. the
[Simutrans-Horizon pak 3D](https://github.com/bdnowicki/simutrans-horizon-pak3d) for pak128) adds glTF models
for selected objects. To use one, clone it next to `compose.yaml` and name it in `.env`:

```
cd simutrans
git clone https://github.com/bdnowicki/simutrans-horizon-pak3d.git pak3d
echo 'SIMUTRANS_PAK3D_DIR=./pak3d' >> .env
docker compose up -d
```

`compose.yaml` mounts the directory read only at `/simutrans/pak3d` and sets
`SIMUTRANS_DASHBOARD_PAK3D` for the bridge (`--pak3d`), which serves it under `/pak3d/` behind the
session (only model, texture and data files, never `.git`). Set the variable in `.env` as
`SIMUTRANS_PAK3D_DIR` only: compose derives `SIMUTRANS_DASHBOARD_PAK3D` from it and overrides a
value of its own in `.env`. Without `SIMUTRANS_PAK3D_DIR` nothing changes: the bridge serves no pak
3D (the mount then shows `base/` again, unused, so Docker creates no directory on the host).
Updating the models needs no restart: `git -C pak3d pull`, then reload the 3D tab. The container
reads the clone as user 1000 (`UID` of the image), so the files must be readable for it.
