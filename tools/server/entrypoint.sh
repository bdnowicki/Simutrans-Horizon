#!/bin/bash
# This file is part of the Simutrans-Horizon project under the Artistic License.
# (see LICENSE.txt)
#
# Container entrypoint: starts the dedicated server and the dashboard bridge, passes SIGTERM
# to the server (it saves the game before it quits) and exits when the server exits.
# Secrets (DEEPSEEK_API_KEY, dashboard tokens) come from the environment and are never printed.

set -u

BASE_DIR=${SIMUTRANS_BASE_DIR:-/simutrans/base}
USER_DIR=${SIMUTRANS_USER_DIR:-/simutrans/user}
PAKSET=${SIMUTRANS_PAKSET:-pak128}
GAME_PORT=${SIMUTRANS_SERVER_PORT:-13353}
REMOTE_PORT=${SIMUTRANS_REMOTE_PORT:-13360}
DASHBOARD_PORT=${SIMUTRANS_DASHBOARD_PORT:-13380}
DASHBOARD_HOSTS=${SIMUTRANS_DASHBOARD_HOSTS:-}
INITIAL_SAVE=${SIMUTRANS_INITIAL_SAVE:-}
DEBUG_LEVEL=${SIMUTRANS_DEBUG_LEVEL:-2}
# 1: the player token of the dashboard pauses and speeds up the game for all clients
TIME_CONTROL=${SIMUTRANS_TIME_CONTROL:-1}
# 1: the AI team of the dashboard: the game accepts the agent commands (-remote_control_agent) and the
# players' Team tab works (needs DEEPSEEK_API_KEY); otherwise the dashboard offers no Team tab
AGENTS=${SIMUTRANS_AGENTS:-0}
# access tokens and the AI team's history, kept in the user directory
DASHBOARD_DB=${SIMUTRANS_DASHBOARD_DB:-$USER_DIR/dashboard/agents.sqlite}
# daily cost limits of the AI team in USD (all companies / per company or "off"); stored in the database
TEAM_LIMIT=${SIMUTRANS_TEAM_LIMIT:-}
TEAM_COMPANY_LIMIT=${SIMUTRANS_TEAM_COMPANY_LIMIT:-}
# addresses or networks of the reverse proxies in front of the dashboard (X-Forwarded-For is trusted from them)
TRUSTED_PROXIES=${SIMUTRANS_DASHBOARD_TRUSTED_PROXIES:-}

log() { echo "entrypoint: $*" >&2; }

# the container log must show no secret: the bridge prints access links with tokens (first start with an
# empty database) and never a key, but anything that looks like a token or a key is hidden anyway
redact() {
	sed -u -E \
		-e 's/(token=)[^[:space:]&"]*/\1<hidden>/g' \
		-e 's/(Bearer )[^[:space:]"]+/\1<hidden>/g' \
		-e 's/\bsk-[A-Za-z0-9_-]{8,}/sk-<hidden>/g' \
		-e 's/((DEEPSEEK_API_KEY|SIMUTRANS_DASHBOARD_TOKEN_[A-Z]+)=)[^[:space:]]*/\1<hidden>/g'
}

if [ ! -f "$BASE_DIR/config/simuconf.tab" ] || [ ! -d "$BASE_DIR/$PAKSET" ]; then
	log "$BASE_DIR must hold the base files (config, text, ...) and the pakset $PAKSET"
	exit 1
fi
mkdir -p "$USER_DIR/save" || exit 1
if [ ! -f "$USER_DIR/simuconf.tab" ]; then
	cp /opt/simutrans/server/simuconf.tab "$USER_DIR/simuconf.tab" || exit 1
fi

# The server writes server<port>-network.sve whenever the last client leaves and
# server<port>-restore.sve when it quits; on start it continues server<port>-network.sve.
network="$USER_DIR/server$GAME_PORT-network.sve"
restore="$USER_DIR/server$GAME_PORT-restore.sve"
if [ -f "$restore" ]; then
	if [ ! -f "$network" ] || [ "$restore" -nt "$network" ]; then
		[ -f "$network" ] && mv -f "$network" "$network.old"
		mv -f "$restore" "$network" || exit 1
		log "continuing the game saved when the server quit"
	else
		mv -f "$restore" "$restore.old"
	fi
fi

# -lang en: a network server gives the loaded game its own language for the names it creates (new stops,
# factory names in scenario texts); without it the language would only be English by fallback
args=(-server "$GAME_PORT" -set_basedir "$BASE_DIR/" -objects "$PAKSET/" -set_userdir "$USER_DIR/"
	-nosound -nomidi -lang en -remote_control_readonly "$REMOTE_PORT" -debug "$DEBUG_LEVEL")
if [ "$TIME_CONTROL" = 1 ]; then
	args+=(-remote_control_time)
fi
if [ "$AGENTS" = 1 ]; then
	args+=(-remote_control_agent)
	if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
		log "SIMUTRANS_AGENTS=1 but DEEPSEEK_API_KEY is not set: the Team tab of the dashboard stays disabled"
	fi
fi
if [ -f "$network" ]; then
	log "continuing $(basename "$network")"
elif [ -n "$INITIAL_SAVE" ] && [ -f "$USER_DIR/save/$INITIAL_SAVE" ]; then
	log "first start: loading save/$INITIAL_SAVE"
	args+=(-load "$INITIAL_SAVE")
else
	log "no server save yet: put the game to host into $USER_DIR/save and set SIMUTRANS_INITIAL_SAVE"
	exit 1
fi

bridge_pid=
start_bridge() {
	local opts=(--db "$DASHBOARD_DB") words=() w
	read -r -a words <<< "$DASHBOARD_HOSTS"
	for w in "${words[@]}"; do
		opts+=(--allowed-host "$w")
	done
	read -r -a words <<< "${TRUSTED_PROXIES//,/ }"
	for w in "${words[@]}"; do
		opts+=(--trusted-proxy "$w")
	done
	if [ "$AGENTS" != 1 ]; then
		opts+=(--no-team)
	fi
	if [ -n "$TEAM_LIMIT" ]; then
		opts+=(--team-limit "$TEAM_LIMIT")
	fi
	if [ -n "$TEAM_COMPANY_LIMIT" ]; then
		opts+=(--team-company-limit "$TEAM_COMPANY_LIMIT")
	fi
	# DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL and SIMUTRANS_DASHBOARD_PLAYER_COMPANY reach the bridge through the
	# environment; the bridge prints its access URLs, redact keeps the tokens out of the container log
	python3 -u /opt/simutrans/tools/dashboard/simutrans_dashboard.py --game-port "$REMOTE_PORT" \
		--bind 0.0.0.0 --port "$DASHBOARD_PORT" "${opts[@]}" \
		> >(redact) 2> >(redact >&2) &
	bridge_pid=$!
}

stopping=0
on_term() {
	stopping=1
	log "stopping: the server saves the game and quits"
	kill -TERM "$game_pid" 2>/dev/null
}
trap on_term TERM INT

/opt/simutrans/bin/simutrans "${args[@]}" &
game_pid=$!
start_bridge

status=0
while :; do
	unset done_pid
	wait -n -p done_pid "$game_pid" "$bridge_pid"
	status=$?
	if [ -z "${done_pid:-}" ]; then
		continue  # a signal interrupted the wait
	fi
	if [ "$done_pid" = "$game_pid" ]; then
		break
	fi
	if [ "$stopping" = 0 ]; then
		log "dashboard exited ($status), restarting it in 5 s"
		sleep 5
		start_bridge
	fi
done

log "server exited ($status)"
if kill -0 "$bridge_pid" 2>/dev/null; then
	kill -TERM "$bridge_pid"
	wait "$bridge_pid" 2>/dev/null
fi
exit "$status"
