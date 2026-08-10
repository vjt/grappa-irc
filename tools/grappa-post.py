#!/usr/bin/env python3
"""Post a line to a grappa channel over the REST API. Write-only, no WebSocket.

This is the client the coding agents (w1, w2, orch) use to report progress
into an IRC channel without any of them holding an IRC socket: grappa keeps
the upstream session, the agent only speaks HTTP.

Two facts decide the shape of this script:

  * Sending is a plain REST call -- ``POST /networks/<slug>/channels/<chan>
    /messages`` with ``{"body": ...}`` (``router.ex`` -> ``MessagesController
    .create/2`` -> ``Session.send_privmsg/4``). The Phoenix Channels socket is
    only needed to *read*, and an agent that reports has nothing to read.
  * The upstream session is a property of the credential, not of this process.
    grappa dials it at boot and keeps it; this script may run once per message
    and exit without the IRC connection ever noticing.

The bearer never comes from argv -- a token on a command line leaks into the
process table and into every shell history on the box. Two ways to get one:

  * ``token`` in the config, for a purpose-minted client token
    (``POST /me/client-tokens``). Preferred where the deployment has them.
  * ``identifier`` + ``password``, which this script trades for a session
    bearer at ``POST /auth/login`` and caches next to the config in
    ``<config>.session`` (0600). Needed against deployments predating client
    tokens -- they are a post-0.16.0 addition, so a server on the 0.16.0 tag
    answers 404 at the mint route and this is the only door.

A cached bearer is reused until the server rejects it; a 401 re-logs in once
and retries, so an expired or revoked session heals without operator work.

Usage:

    grappa-post.py "build green on 3383abf6"
    echo "build green" | grappa-post.py
    grappa-post.py --channel '#grappa-live' --join "hello"

Config (JSON, mode 0600, ``~/.config/grappa/client.json`` by default; override
with ``$GRAPPA_CLIENT_CONFIG``)::

    {
      "base_url": "https://irc.example.org",
      "identifier": "w1",
      "password": "<account password>",
      "network": "azzurra",
      "channel": "#grappa-live"
    }

Exit codes: 0 sent, 1 usage/config error, 2 refused by the server, 3 transport.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_CONFIG = "~/.config/grappa/client.json"

# The send door is throttled per (subject, network) and answers 429 with a
# Retry-After in whole seconds. Honour it rather than hammering: the bucket
# exists so grappa refuses us before the upstream server k-lines the session
# for flooding.
MAX_RETRIES = 3
FALLBACK_RETRY_SECONDS = 2

EXIT_USAGE = 1
EXIT_REFUSED = 2
EXIT_TRANSPORT = 3


class ConfigError(Exception):
    pass


def load_config(path: str) -> dict:
    expanded = os.path.expanduser(path)

    try:
        st = os.stat(expanded)
    except OSError as exc:
        raise ConfigError(f"cannot read {expanded}: {exc}") from exc

    # The token is a credential. Refuse to use one that anybody on the box can
    # read -- failing here is cheap, and a leaked bearer outlives the leak.
    if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise ConfigError(f"{expanded} is group/world accessible; chmod 600 it")

    try:
        with open(expanded, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError) as exc:
        raise ConfigError(f"cannot parse {expanded}: {exc}") from exc

    for key in ("base_url", "network"):
        if not isinstance(cfg.get(key), str) or not cfg[key]:
            raise ConfigError(f"{expanded}: missing or non-string {key!r}")

    has_token = isinstance(cfg.get("token"), str) and cfg["token"]
    has_login = all(isinstance(cfg.get(k), str) and cfg[k] for k in ("identifier", "password"))

    if not has_token and not has_login:
        raise ConfigError(f"{expanded}: need either 'token' or 'identifier' + 'password'")

    cfg["_session_path"] = expanded + ".session"

    return cfg


def login(cfg: dict) -> str:
    """Trade identifier+password for a session bearer and cache it 0600."""
    status, body = post_json(
        cfg["base_url"],
        "/auth/login",
        None,
        {"identifier": cfg["identifier"], "password": cfg["password"]},
    )

    if not 200 <= status < 300:
        raise ConfigError(f"login refused ({status}): {body}")

    try:
        token = json.loads(body)["token"]
    except (ValueError, KeyError) as exc:
        raise ConfigError(f"login answered without a token: {body}") from exc

    path = cfg["_session_path"]
    # Create with the right mode from the start: a world-readable window
    # between open() and chmod() is a window in which the bearer leaks.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(token)

    return token


def bearer(cfg: dict, force_fresh: bool = False) -> str:
    """The bearer to send with, minting one only when we have to."""
    if cfg.get("token"):
        return cfg["token"]

    if not force_fresh:
        try:
            cached = open(cfg["_session_path"], encoding="utf-8").read().strip()
            if cached:
                return cached
        except OSError:
            pass

    return login(cfg)


def post_json(base_url: str, path: str, token: str | None, payload: dict) -> tuple[int, str]:
    url = base_url.rstrip("/") + path
    body = json.dumps(payload).encode("utf-8")

    headers = {
        "content-type": "application/json",
        "accept": "application/json",
        "user-agent": "grappa-post/1",
    }

    # The login door is the one call with no bearer to send.
    if token:
        headers["authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, data=body, method="POST", headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        # Retry-After rides on the response, so hand it back with the status.
        retry_after = exc.headers.get("retry-after") if exc.headers else None
        return exc.code, json.dumps({"error": detail, "retry_after": retry_after})


def send(cfg: dict, network: str, channel: str, text: str) -> int:
    path = "/networks/{}/channels/{}/messages".format(
        urllib.parse.quote(network, safe=""),
        urllib.parse.quote(channel, safe=""),
    )

    relogged = False

    for attempt in range(MAX_RETRIES):
        status, body = post_json(cfg["base_url"], path, bearer(cfg), {"body": text})

        if 200 <= status < 300:
            return 0

        # A stale cached session looks exactly like a bad credential from
        # here; mint a fresh one once before believing the rejection.
        if status == 401 and not relogged and not cfg.get("token"):
            relogged = True
            bearer(cfg, force_fresh=True)
            continue

        if status == 429 and attempt < MAX_RETRIES - 1:
            delay = FALLBACK_RETRY_SECONDS
            try:
                hint = json.loads(body).get("retry_after")
                if hint:
                    delay = int(hint)
            except (ValueError, TypeError):
                pass
            time.sleep(delay)
            continue

        print(f"grappa-post: refused ({status}): {body}", file=sys.stderr)
        return EXIT_REFUSED

    print("grappa-post: still throttled after retries", file=sys.stderr)
    return EXIT_REFUSED


def join(cfg: dict, network: str, channel: str) -> int:
    """JOIN the channel. Idempotent server-side: a JOIN of a channel the
    session already sits in costs one upstream line and changes nothing, so
    this is a one-off setup verb rather than something to run per message."""
    path = "/networks/{}/channels".format(urllib.parse.quote(network, safe=""))
    status, body = post_json(cfg["base_url"], path, bearer(cfg), {"name": channel})

    if status == 401 and not cfg.get("token"):
        status, body = post_json(
            cfg["base_url"], path, bearer(cfg, force_fresh=True), {"name": channel}
        )

    if 200 <= status < 300:
        return 0

    print(f"grappa-post: join refused ({status}): {body}", file=sys.stderr)
    return EXIT_REFUSED


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Post one line to a grappa channel (write-only REST client)."
    )
    parser.add_argument(
        "message",
        nargs="*",
        help="the line to send; read from stdin when omitted",
    )
    parser.add_argument("--config", default=os.environ.get("GRAPPA_CLIENT_CONFIG", DEFAULT_CONFIG))
    parser.add_argument("--network", help="network slug (default: config)")
    parser.add_argument("--channel", help="target channel or nick (default: config)")
    parser.add_argument(
        "--join",
        action="store_true",
        help="JOIN the channel before sending (needed once, if the credential has no autojoin)",
    )
    args = parser.parse_args(argv)

    try:
        cfg = load_config(args.config)
    except ConfigError as exc:
        print(f"grappa-post: {exc}", file=sys.stderr)
        return EXIT_USAGE

    network = args.network or cfg["network"]
    channel = args.channel or cfg.get("channel")

    if not channel:
        print("grappa-post: no channel given and none in config", file=sys.stderr)
        return EXIT_USAGE

    text = " ".join(args.message) if args.message else sys.stdin.read()
    text = text.strip()

    if not text:
        print("grappa-post: refusing to send an empty line", file=sys.stderr)
        return EXIT_USAGE

    # One PRIVMSG is one line. Newlines cannot ride the wire, and silently
    # sending only the first line would lose the rest without saying so.
    if "\n" in text:
        print("grappa-post: message contains newlines; send one line per call", file=sys.stderr)
        return EXIT_USAGE

    try:
        if args.join:
            rc = join(cfg, network, channel)
            if rc:
                return rc

        return send(cfg, network, channel, text)
    except ConfigError as exc:
        # Raised from the login path too, not only from load_config.
        print(f"grappa-post: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except urllib.error.URLError as exc:
        print(f"grappa-post: transport error: {exc}", file=sys.stderr)
        return EXIT_TRANSPORT


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
