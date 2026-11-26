/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 *
 * Simutrans-Horizon, 2026-11: new file, the -remote_control automation interface
 */

#ifndef NETWORK_REMOTE_CONTROL_H
#define NETWORK_REMOTE_CONTROL_H


/**
 * Local remote control interface, used for automation, e.g. by the MCP bridge
 * in tools/mcp/simutrans_mcp.py which lets AI agents look at and play the game.
 *
 * Only enabled with the command line option -remote_control [port] (or -remote_control_readonly).
 * Listens on 127.0.0.1 only, at most 8 connections. Line based protocol:
 *  - the client first sends "HELLO simutrans-remote 1" or "HELLO simutrans-remote 2" (within
 *    5 seconds), anything else closes the connection; the reply is
 *    {"ok":true,"protocol":<1|2>,"read_only":false}
 *  - every further line is "<command> <url encoded arguments>", e.g. "click x=100&y=200"
 *  - every request gets exactly one reply line, a JSON object with at least {"ok":true|false},
 *    in the order of the requests; the argument rid=<text> is echoed as "rid" in the reply
 *  - read-only mode allows only commands that do not change the game or the GUI, others
 *    get {"ok":false,"error":"read-only remote control"}
 *  - protocol 2 only: after "subscribe topics=..." the game also sends event lines
 *    {"event":"<topic>","seq":N,"date":{..},"data":{..}} (no "ok" key) between whole replies
 *
 * Requests are executed on the main thread between two frames (see remote_control_poll()),
 * round-robin within a time budget per frame. Replies are sent without blocking; the next request
 * of a client is executed when its last reply is sent, so a client that does not read its replies
 * only stalls itself. The connection is closed with more than 32 MB of unsent replies, when no
 * reply byte could be sent for 60 seconds, or with more than 8 MB of requests not yet executed.
 */

struct message_node_t;

/// open the listening socket, returns false on error; read_only allows only commands that read,
/// time_control allows pause and fast_forward too in a read-only remote control
bool remote_control_init(int port, bool read_only = false, bool time_control = false);

/// accept connections and execute pending requests, called from the main loops
void remote_control_poll();

/// close all sockets
void remote_control_shutdown();

/// true if remote control is listening
bool remote_control_active();

/// counts the worlds loaded or created in this session (bumped by remote_control_on_world()),
/// reported by the command poll so that clients notice a new world
extern unsigned int remote_control_world_generation;

/*
 * Event hooks, called by the engine. They only record the event for the clients that subscribed
 * it (no I/O, no random numbers, no change of the game, so they are safe in network games and
 * on the dedicated server) and return at once while no client subscribed the topic.
 */

/// a message was added to the message list of the world, seq = its number (list count)
void remote_control_on_message(const message_node_t *node, unsigned int seq);

/// karte_t::new_month() finished
void remote_control_on_month(bool year_changed);

enum remote_control_world_event_t { REMOTE_WORLD_LOADED, REMOTE_WORLD_CREATED, REMOTE_WORLD_CLOSED };

/// a world was loaded or created (bumps remote_control_world_generation) or is about to be destroyed
void remote_control_on_world(remote_control_world_event_t what);

/// a convoy arrived at a stop
void remote_control_on_arrival(unsigned short convoy_id, unsigned short halt_id);

/*
 * Change tracking of the map for the 3D export (command map_changes). The engine reports every
 * visible change of a square that is not a moving thing: objects added to or removed from a
 * ground (except vehicles, pedestrians, city cars, animals, smoke and cursors), a building tile
 * replaced, way and way object directions, way, bridge and tunnel types, terrain heights and
 * slopes, grounds added, removed or replaced, climates. Only flags of the 64x64 cells around the
 * square are set (atomic stores; the world's worker threads may call it while the main thread
 * waits for them), nothing of the game is touched, and while no client tracks the map the
 * inline check returns at once.
 */
extern bool remote_control_map_tracked;

void remote_control_mark_changed(int x, int y);

inline void remote_control_map_changed(int x, int y)
{
	if(  remote_control_map_tracked  ) {
		remote_control_mark_changed(x, y);
	}
}

#endif
