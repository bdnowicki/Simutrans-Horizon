# This file is part of the Simutrans-Horizon project under the Artistic License.
# (see LICENSE.txt)
#
# Dedicated network server of Simutrans-Horizon (headless, backend "none") with the browser
# dashboard next to it. Build context: the repository root. The pakset is not part of the
# image; it comes from a volume (see README.md).
#
#   docker build -f tools/server/Dockerfile --build-arg SIMUTRANS_REVISION=<r of the clients> \
#       -t simutrans-horizon-server .

FROM debian:trixie AS build
RUN apt-get update \
	&& apt-get install -y --no-install-recommends g++ make cmake pkg-config \
		zlib1g-dev libbz2-dev libpng-dev libzstd-dev \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt ./
COPY cmake ./cmake
COPY src ./src
# Clients show a mismatching revision in the server list; use the r number of the clients' build.
ARG SIMUTRANS_REVISION
RUN test -n "$SIMUTRANS_REVISION" || { echo "--build-arg SIMUTRANS_REVISION=<number> is required" >&2; exit 1; } \
	&& cmake -S . -B /build -DCMAKE_BUILD_TYPE=Release -DSIMUTRANS_BACKEND=none \
		-DSIMUTRANS_USE_REVISION="$SIMUTRANS_REVISION" -DSIMUTRANS_USE_UPNP=OFF \
		-DSIMUTRANS_USE_FONTCONFIG=OFF -DSIMUTRANS_USE_FLUIDSYNTH_MIDI=OFF -DSIMUTRANS_USE_CCACHE=OFF \
	&& cmake --build /build -j"$(nproc)" \
	&& strip /build/simutrans/simutrans

FROM debian:trixie-slim
# ca-certificates: the AI team of the dashboard calls the DeepSeek API over HTTPS; sqlite3 (part of Python's
# standard library on Debian) keeps the dashboard's tokens and the team's history
RUN apt-get update \
	&& apt-get install -y --no-install-recommends zlib1g libbz2-1.0 libpng16-16t64 libzstd1 python3 \
		ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& python3 -c "import sqlite3, ssl; sqlite3.connect(':memory:').execute('select 1')" \
	&& test -s /etc/ssl/certs/ca-certificates.crt
ARG UID=1000
ARG GID=1000
RUN groupadd -g "$GID" simutrans && useradd -u "$UID" -g "$GID" -M -d /simutrans/user -s /usr/sbin/nologin simutrans
COPY --from=build /build/simutrans/simutrans /opt/simutrans/bin/simutrans
COPY tools/mcp/simutrans_mcp.py /opt/simutrans/tools/mcp/
# the bridge, its package team/ (AI team, with the prompts in team/prompts) and the web page; not the tests and dev/
COPY tools/dashboard/simutrans_dashboard.py /opt/simutrans/tools/dashboard/
COPY tools/dashboard/team /opt/simutrans/tools/dashboard/team
COPY tools/dashboard/web /opt/simutrans/tools/dashboard/web
COPY tools/server/entrypoint.sh tools/server/simuconf.tab /opt/simutrans/server/
RUN sed -i 's/\r$//' /opt/simutrans/server/entrypoint.sh /opt/simutrans/server/simuconf.tab \
	&& chmod 755 /opt/simutrans/server/entrypoint.sh \
	&& python3 -B /opt/simutrans/tools/dashboard/simutrans_dashboard.py --help > /dev/null \
	&& cd /opt/simutrans/tools/dashboard \
	&& python3 -B -c "import team.runtime, team.executor, team.llm, team.roles as r; [r.system_prompt(a, 0, {}) for a in r.AGENT_IDS]"
USER simutrans
# 13353 game (clients), 13380 dashboard; the remote control (13360) stays inside the container
EXPOSE 13353 13380
ENTRYPOINT ["/opt/simutrans/server/entrypoint.sh"]
