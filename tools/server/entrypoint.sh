#!/bin/bash
# This file is part of the Simutrans-Horizon project under the Artistic License.
# (see LICENSE.txt)
#
# Container entrypoint: starts the dedicated server and the dashboard bridge, passes SIGTERM
# to the server (it saves the game before it quits) and exits when the server exits.

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

log() { echo "entrypoint: $*" >&2; }

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

args=(-server "$GAME_PORT" -set_basedir "$BASE_DIR/" -objects "$PAKSET/" -set_userdir "$USER_DIR/"
	-nosound -nomidi -remote_control_readonly "$REMOTE_PORT" -debug "$DEBUG_LEVEL")
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
	local hosts=() h
	for h in $DASHBOARD_HOSTS; do
		hosts+=(--allowed-host "$h")
	done
	# the bridge prints its access URLs; keep the tokens out of the container log
	python3 -u /opt/simutrans/tools/dashboard/simutrans_dashboard.py --game-port "$REMOTE_PORT" \
		--bind 0.0.0.0 --port "$DASHBOARD_PORT" "${hosts[@]}" \
		> >(sed -u 's/token=[^[:space:]&]*/token=<see .env>/g') \
		2> >(sed -u 's/token=[^[:space:]&]*/token=<see .env>/g' >&2) &
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
