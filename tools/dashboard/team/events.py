"""
Event streams of the team, one per company.

The bridge's main stream (/api/events) goes to every browser; team events are private to a company, so they travel
on /api/team/events with a ring buffer and an id counter of their own per company: a stream of company 2 never sees
an event of company 0, and Last-Event-ID replays only the company's own events. publish() is the only way to emit
team events; the streams themselves are written by the bridge (Handler.pump).
"""

import collections
import queue
import re
import threading
import time

from .db import json_text

RING_EVENTS = 500
RING_BYTES = 4 * 1024 * 1024
QUEUE_SIZE = 2000
# team streams of one token at once (tabs and devices of a player): the streams share the bridge's slots with the
# main streams of everybody, so one token must not take them all
MAX_PER_TOKEN = 16
PER_TOKEN = "per_token"   # subscribe's refusal when the token has MAX_PER_TOKEN streams open
EVENT_NAME = re.compile(r"^team_[a-z_]{1,32}$")
# the events of contract T (others named team_<name> may be added by later rounds)
EVENT_NAMES = ("team_delta", "team_message", "team_tool", "team_run", "team_question", "team_task", "team_project",
               "team_usage")
PLAYER_UNOWNED = 15
PUBLIC_PLAYER = 1


class StreamSlots:
    """The number of open event streams of the bridge (main and team streams share MAX_SSE)."""

    def __init__(self, limit):
        self.lock = threading.Lock()
        self.limit = limit
        self.used = 0

    def take(self):
        with self.lock:
            if self.used >= self.limit:
                return False
            self.used += 1
            return True

    def give(self):
        with self.lock:
            self.used = max(0, self.used - 1)

    def count(self):
        with self.lock:
            return self.used


class TeamClient:
    """One open team stream (same interface as the bridge's SseClient: queue of chunks, b"" ends it)."""
    CLOSE = b""

    def __init__(self, sid, company, token_id):
        self.sid = sid
        self.company = company
        self.token_id = token_id
        self.queue = queue.Queue(maxsize=QUEUE_SIZE)
        self.dead = False

    def push(self, chunk):
        try:
            self.queue.put_nowait(chunk)
        except queue.Full:
            self.dead = True  # too slow: dropped, the browser reconnects and replays or reloads


def _json(data):
    return json_text(data)   # NaN / Infinity as null: one such number would break JSON.parse of the event


class TeamEvents:
    def __init__(self, slots=None, ring_events=RING_EVENTS, ring_bytes=RING_BYTES, max_per_token=MAX_PER_TOKEN):
        self.lock = threading.Lock()
        self.slots = slots or StreamSlots(64)
        self.ring_events = ring_events
        self.ring_bytes = ring_bytes
        self.max_per_token = max_per_token
        self.rings = {}      # company -> {"seq", "ring": deque of (id, chunk), "bytes"}
        self.clients = set()
        self.closed = False

    def _ring_locked(self, company):
        r = self.rings.get(company)
        if r is None:
            # ids start at the current time in ms (like the main stream), so ids of an earlier bridge process are
            # never mistaken for ids of this one: Last-Event-ID of those gets a resync
            r = self.rings[company] = {"seq": int(time.time() * 1000), "ring": collections.deque(), "bytes": 0}
        return r

    def publish(self, company, name, data):
        """Send an event to the streams of one company (and keep it for Last-Event-ID). Returns its id."""
        if type(company) is not int or not 0 <= company < PLAYER_UNOWNED or company == PUBLIC_PLAYER:
            raise ValueError("invalid company %r" % (company,))
        if not isinstance(name, str) or not EVENT_NAME.match(name):
            raise ValueError("team event names look like team_<name>, not %r" % (name,))
        payload = _json(data)
        with self.lock:
            r = self._ring_locked(company)
            r["seq"] += 1
            chunk = ("id: %d\nevent: %s\ndata: %s\n\n" % (r["seq"], name, payload)).encode("utf-8", "replace")
            r["ring"].append((r["seq"], chunk))
            r["bytes"] += len(chunk)
            while len(r["ring"]) > self.ring_events or (r["bytes"] > self.ring_bytes and len(r["ring"]) > 1):
                r["bytes"] -= len(r["ring"].popleft()[1])
            for client in self.clients:
                if client.company == company:
                    client.push(chunk)
            return r["seq"]

    def subscribe(self, company, sid, last_id, token_id=None):
        """Open a stream of a company: (client, first chunk bytes); (None, None) when too many streams are open,
        (None, PER_TOKEN) when the token has max_per_token streams open already. The first chunk is a hello
        ({"company", "resync"}); after a known Last-Event-ID the missed events follow, otherwise resync is true
        (reload the team state with GET)."""
        with self.lock:
            if self.closed:
                return None, None
            if token_id is not None and self.max_per_token is not None and \
                    sum(1 for c in self.clients if c.token_id == token_id) >= self.max_per_token:
                return None, PER_TOKEN
            if not self.slots.take():
                return None, None
            client = TeamClient(sid, company, token_id)
            self.clients.add(client)
            r = self._ring_locked(company)
            replay = None
            if last_id is not None and last_id <= r["seq"]:
                if last_id == r["seq"]:
                    replay = []
                elif r["ring"] and r["ring"][0][0] <= last_id + 1:
                    replay = [chunk for eid, chunk in r["ring"] if eid > last_id]
            # on a resume the hello keeps the client's position, so a drop before the replay loses nothing
            hello_id = last_id if replay is not None else r["seq"]
            hello = _json({"company": company, "resync": replay is None})
            first = [("retry: 3000\nid: %d\nevent: hello\ndata: %s\n\n" % (hello_id, hello)).encode("utf-8")]
            first.extend(replay or ())
            return client, b"".join(first)

    def unsubscribe(self, client):
        with self.lock:
            if client in self.clients:
                self.clients.discard(client)
                self.slots.give()

    def stream_count(self):
        with self.lock:
            return len(self.clients)

    def close_session(self, sid):
        """End the team streams of a session (signed out, replaced, revoked)."""
        with self.lock:
            for client in self.clients:
                if client.sid == sid:
                    client.dead = True
                    client.push(TeamClient.CLOSE)

    def close(self):
        with self.lock:
            self.closed = True
            for client in self.clients:
                client.dead = True
                client.push(TeamClient.CLOSE)

    def last_id(self, company):
        with self.lock:
            r = self.rings.get(company)
            return r["seq"] if r else None
