/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 */

#ifndef NETWORK_REMOTE_CONTROL_H
#define NETWORK_REMOTE_CONTROL_H


/**
 * Local remote control interface, used for automation, e.g. by the MCP bridge
 * in tools/mcp/simutrans_mcp.py which lets AI agents look at and play the game.
 *
 * Only enabled with the command line option -remote_control [port].
 * Listens on 127.0.0.1 only. Line based protocol:
 *  - the client first sends "HELLO simutrans-remote 1", anything else closes the connection
 *  - every further line is "<command> <url encoded arguments>", e.g. "click x=100&y=200"
 *  - every request gets exactly one reply line, a JSON object with at least {"ok":true|false}
 *
 * Requests are executed on the main thread between two frames (see remote_control_poll()).
 */

/// open the listening socket, returns false on error
bool remote_control_init(int port);

/// accept connections and execute pending requests, called from the main loops
void remote_control_poll();

/// close all sockets
void remote_control_shutdown();

/// true if remote control is listening
bool remote_control_active();

#endif
