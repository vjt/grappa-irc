"""e2e-bot control: claude-ircbot's bot.py on irc-olm, driven over HTTP by the
2430 interop specs (tests/issue2430-*.spec.ts, fixtures/e2eBot.ts).

The container idles until a spec starts the bot, so no other spec ever meets an
extra client on the testnet. Root runs this file and owns /data/etc, what the
bot only reads: the pins above all, which the bot must find unwritable (its
README's posture; it says E2E_PINS_WRITABLE otherwise). bot.py and its key
generation run as uid 1000, which owns /data/bot (key, state, FIFO, logs):
irc-olm refuses a key anyone but its owner can read.

  GET  /healthz                 200 once this server listens.
  POST /start {"nick", "trust": [lines], "dmallow": [lines]}
                                A fresh bot: stops any running one, wipes
                                /data/bot (key, state, logs: a new Ed25519
                                identity every start), writes the files the
                                bot reads (no pins yet), starts bot.py. Answers
                                {"nick", "ed25519", "since"} once E2E_READY,
                                FIFO_READY and CONNECTED are on the stream;
                                502 if it exits first, 504 if they never come.
                                After any answer but 200 to a JSON object (a
                                400 for its fields included) no bot is left
                                running; a body that is not one is refused
                                before anything is stopped.
  POST /stop                    Stops bot.py.
  PUT  /pins {"pins": {nick: key}}
                                Rewrites the pins (write + rename, root-owned
                                0644). Answers once E2E_PINS_LOADED N=<n> came.
  POST /cmd {"line"}            One line into the bot's FIFO.
  GET  /events?since=N&wait=S   {"next", "events": [{"n", "t", "line"}]}: the
                                bot's stdout lines from N on, long-polling up
                                to S seconds (at most 30).

Every request is logged, the 5 s healthcheck included: the stack's log census
reads a silence over 10 s as a stall. The bot's lines go to stdout too, for the
container log a red run keeps.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ETC = "/data/etc"
HOME = "/data/bot"
BOT_UID = 1000
KEY = f"{HOME}/key"
FIFO = f"{HOME}/bot.send"
PINS = f"{ETC}/pins"
NETWORK = os.environ["BOT_E2E_NETWORK"]
START_TIMEOUT = 45.0
PINS_TIMEOUT = 5.0
WAIT_MAX = 30.0
# One IRC token: a nick, a host glob, a key. Nothing that could end a line.
TOKEN = re.compile(r"[^\s\x00]+")
PIPE_BUF = 4096                 # a FIFO write this size or smaller lands whole
# One bot.trust / bot.dmallow line: two tokens, one space, no '#' (a comment to the bot).
RULE = re.compile(r"[^\s\x00#]+ [^\s\x00#]+")

events = []                     # {"n", "t", "line"}, the bot's stdout, every run
cond = threading.Condition()
bot = None                      # the running bot.py, or None
reader = None                   # the thread recording its stdout
lock = threading.Lock()         # one /start, /stop, /pins or /cmd at a time


def _record(line):
    with cond:
        events.append({"n": len(events), "t": time.time(), "line": line})
        cond.notify_all()
    print(f"bot: {line}", flush=True)


def _read(proc):
    for line in proc.stdout:
        _record(line.rstrip("\n"))
    _record(f"E2E_BOT_EXITED RC={proc.wait()}")


def _wait_for(pattern, since, timeout):
    """The first event from `since` on matching `pattern`, or None."""
    deadline = time.monotonic() + timeout
    with cond:
        n = since
        while True:
            for ev in events[n:]:
                if pattern.search(ev["line"]):
                    return ev
            n = len(events)
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            cond.wait(left)


def _running():
    return bot is not None and bot.poll() is None


def _as_bot():
    return {"user": BOT_UID, "group": BOT_UID, "extra_groups": []}


def _write_root(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def _stop():
    """Stops bot.py and waits for its last line, E2E_BOT_EXITED: a /start
    that came next must not read the old bot's exit as its own."""
    global bot, reader
    if bot is None:
        return
    proc, bot = bot, None
    thread, reader = reader, None
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    if thread is not None and thread.ident is not None:  # started: its E2E_BOT_EXITED comes
        thread.join()


def _stop_cmd(body):
    _stop()
    return 200, {}


def _lines(body, key):
    lines = body.get(key, [])
    if not isinstance(lines, list) or not all(
            isinstance(x, str) and RULE.fullmatch(x) for x in lines):
        raise ValueError(f"{key}: a list of '<nick> <host_glob>' lines, no '#' (the bot reads it as a comment)")
    return "".join(f"{x}\n" for x in lines)


def _start(body):
    global bot, reader
    nick = body.get("nick")
    if not isinstance(nick, str) or not TOKEN.fullmatch(nick):
        raise ValueError("nick: one token")
    trust, dmallow = _lines(body, "trust"), _lines(body, "dmallow")
    _stop()
    os.makedirs(ETC, mode=0o755, exist_ok=True)
    os.chmod(ETC, 0o755)
    os.makedirs(HOME, mode=0o700, exist_ok=True)
    os.chown(HOME, BOT_UID, BOT_UID)
    os.chmod(HOME, 0o700)
    for name in os.listdir(HOME):
        path = os.path.join(HOME, name)
        shutil.rmtree(path) if os.path.isdir(path) and not os.path.islink(path) else os.remove(path)
    _write_root(PINS, "# e2e-bot pins: <nick> <ed25519>\n")
    _write_root(f"{ETC}/trust", trust)
    _write_root(f"{ETC}/dmallow", dmallow)
    for name in ("startup", "reserved", "env"):
        _write_root(f"{ETC}/{name}", "")
    env = dict(os.environ, HOME=HOME, IRC_NICK=nick,
               BOT_E2E_KEY=KEY, BOT_E2E_PINS=PINS, BOT_E2E_STATE=f"{HOME}/state.json",
               BOT_TRUST=f"{ETC}/trust", BOT_DM_ALLOW=f"{ETC}/dmallow",
               BOT_STARTUP=f"{ETC}/startup", BOT_RESERVED=f"{ETC}/reserved",
               BOT_ENV=f"{ETC}/env", BOT_FIFO=FIFO, BOT_LOG=f"{HOME}/bot.log",
               BOT_RESERVED_STORE=f"{HOME}/reserved.tsv", BOT_DCC_DIR=f"{HOME}/dcc")
    subprocess.run([sys.executable, "-m", "irc_olm", "keygen", KEY], env=env, cwd=HOME,
                   check=True, **_as_bot())
    with cond:
        since = len(events)
    _record(f"E2E_BOT_STARTING NICK={nick}")
    proc = subprocess.Popen([sys.executable, "/opt/bot/bot.py"], env=env, cwd=HOME,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            bufsize=1, **_as_bot())
    bot = proc
    reader = threading.Thread(target=_read, args=(proc,), daemon=True)
    reader.start()
    deadline = time.monotonic() + START_TIMEOUT
    found = {}
    for kind in ("E2E_READY", "FIFO_READY", "CONNECTED"):
        ev = _wait_for(re.compile(rf"\] {kind}\b|^E2E_BOT_EXITED"), since,
                       max(0.0, deadline - time.monotonic()))
        if ev is None:
            return 504, {"error": f"no {kind}", "since": since}
        if ev["line"].startswith("E2E_BOT_EXITED"):
            return 502, {"error": f"the bot exited before {kind}", "since": since}
        found[kind] = ev["line"]
    key = re.search(r" KEY=(\S+)", found["E2E_READY"]).group(1)
    return 200, {"nick": nick, "ed25519": key, "since": since}


def _start_cmd(body):
    """/start: a bot that did not come up is stopped before the answer, so a
    failed start never leaves a client on the testnet."""
    try:
        code, doc = _start(body)
    except BaseException:
        _stop()
        raise
    if code != 200:
        _stop()
    return code, doc


def _pins(body):
    pins = body.get("pins")
    if not isinstance(pins, dict) or not all(
            isinstance(k, str) and isinstance(v, str) and TOKEN.fullmatch(k) and TOKEN.fullmatch(v)
            for k, v in pins.items()):
        raise ValueError("pins: {nick: key}")
    if any(k.startswith("#") for k in pins):
        raise ValueError("pins: a nick may not start with '#' (a comment to the bot)")
    if not _running():
        return 409, {"error": "the bot is not running"}
    with cond:
        since = len(events)
    _write_root(PINS, "".join(f"{k} {v}\n" for k, v in pins.items()))
    if _wait_for(re.compile(rf"\] E2E_PINS_LOADED N={len(pins)}\b"), since, PINS_TIMEOUT) is None:
        return 504, {"error": "no E2E_PINS_LOADED", "since": since}
    return 200, {"since": since}


def _cmd(body):
    line = body.get("line")
    if not isinstance(line, str) or not line.strip() or "\n" in line or "\r" in line:
        raise ValueError("line: one bot command")
    data = (line + "\n").encode()
    if len(data) > PIPE_BUF:
        raise ValueError(f"line: at most {PIPE_BUF - 1} bytes, so it reaches the bot whole")
    if not _running():
        return 409, {"error": "the bot is not running"}
    try:
        fd = os.open(FIFO, os.O_WRONLY | os.O_NONBLOCK)
    except OSError as e:
        return 409, {"error": f"the bot's FIFO: {e}"}
    try:
        n = os.write(fd, data)
    except BlockingIOError:
        return 409, {"error": "the bot's FIFO is full"}
    finally:
        os.close(fd)
    if n != len(data):
        return 500, {"error": f"short FIFO write {n}/{len(data)}"}
    return 200, {}


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code, doc):
        data = json.dumps(doc).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        doc = json.loads(self.rfile.read(n) or b"{}")
        if not isinstance(doc, dict):
            raise ValueError("a JSON object")
        return doc

    def _locked(self, fn):
        try:
            body = self._body()
            with lock:
                code, doc = fn(body)
        except ValueError as e:
            code, doc = 400, {"error": str(e)}
        except Exception as e:
            self.log_error("%s: %r", self.path, e)
            code, doc = 500, {"error": f"{type(e).__name__}: {e}"}
        self._reply(code, doc)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/healthz":
            self._reply(200, {"ok": True})
        elif url.path == "/events":
            q = parse_qs(url.query)
            try:
                since = max(0, int(q.get("since", ["0"])[0]))
                wait = min(max(0.0, float(q.get("wait", ["0"])[0])), WAIT_MAX)
            except ValueError:
                self._reply(400, {"error": "since: an integer, wait: seconds"})
                return
            deadline = time.monotonic() + wait
            with cond:
                while len(events) <= since and time.monotonic() < deadline:
                    cond.wait(deadline - time.monotonic())
                out = events[since:]
            self._reply(200, {"next": since + len(out), "events": out})
        else:
            self._reply(404, {"error": "no such path"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/start":
            self._locked(_start_cmd)
        elif path == "/stop":
            self._locked(_stop_cmd)
        elif path == "/cmd":
            self._locked(_cmd)
        else:
            self._reply(404, {"error": "no such path"})

    def do_PUT(self):
        if urlparse(self.path).path == "/pins":
            self._locked(_pins)
        else:
            self._reply(404, {"error": "no such path"})


if __name__ == "__main__":
    if os.getuid() != 0:
        sys.exit("control.py runs as root: it must own what the bot only reads")
    print(f"e2e-bot control listening on :8080 (network {NETWORK})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
