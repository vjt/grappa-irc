# e2e-bot — claude-ircbot's bot.py on the irc-olm engine: the bot side of the
# 2430 E2E query protocol, for the interop specs (tests/issue2430-*.spec.ts,
# driven through control.py; see fixtures/e2eBot.ts).
#
# The code under test is the bots' own, fetched at pinned commits with every
# file checksummed: a changed blob fails the build instead of quietly testing
# something else. Bump the two together — claude-ircbot's requirements-e2e.txt
# names the irc-olm commit its bots run. A checksum is
#   git -C <clone> show <commit>:<file> | shasum -a 256
#
# An e2e-only third-party base (like node:22-alpine and debian:trixie next to
# it): pinned by tag only, see test/infra/base_image_digest_pin_test.bats.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/opt/irc-olm

COPY requirements.txt /opt/e2e-bot/requirements.txt
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: \
        -r /opt/e2e-bot/requirements.txt

# irc-olm at 1606c85 (wire v2: main's squash merge of vjt/irc-olm#4), the
# commit claude-ircbot 5267471 pins.
ADD --checksum=sha256:beab9b51847365ff7719930409b32e1afd220e1ae34687373069b04e0108dafa \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/__init__.py /opt/irc-olm/irc_olm/__init__.py
ADD --checksum=sha256:2be196d4baedd4153353580557679588c6de4b98adb309bef613a8eb0a46f263 \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/__main__.py /opt/irc-olm/irc_olm/__main__.py
ADD --checksum=sha256:eb20254bc93b1a35d760ba305ee1c8fe301cb9636776f2c6039b024559a49e01 \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/challenge.py /opt/irc-olm/irc_olm/challenge.py
ADD --checksum=sha256:d669067415979bb61a2df0ed297c5a349251ad403f6d9213fea7009f44c0c478 \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/devices.py /opt/irc-olm/irc_olm/devices.py
ADD --checksum=sha256:d8bcd519c17ebd90a1145e0c48f61c637050de737d211fa4a7aa84bd67c7837e \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/engine.py /opt/irc-olm/irc_olm/engine.py
ADD --checksum=sha256:4dda6cfe94f92ce4b93f77ca3d3a672a743a622a5a2e978d061e9895a335a544 \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/framing.py /opt/irc-olm/irc_olm/framing.py
ADD --checksum=sha256:3c01ec0ebdadc8320c470d044e225c35e5e6b3abcf28798ccab5b8de2f01e5a7 \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/keys.py /opt/irc-olm/irc_olm/keys.py
ADD --checksum=sha256:9defb6bf41ebc01cce70d2b54da9d85698f4f570f1291d79a2498d1f252b93fb \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/pacing.py /opt/irc-olm/irc_olm/pacing.py
ADD --checksum=sha256:46554865e187256f4ed8eee0447772bb6ff6a67d56890b4e897f27b3858131bb \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/pins.py /opt/irc-olm/irc_olm/pins.py
ADD --checksum=sha256:78752010b4f2af531352b8c8f18c895c168f8755ee5c907c06f0a7adeb0b04fb \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/reassembly.py /opt/irc-olm/irc_olm/reassembly.py
ADD --checksum=sha256:83a04bd9ae7a32950a43092ffacfbee882d8adedc17c2776ffa51c918dfb03db \
    https://raw.githubusercontent.com/vjt/irc-olm/1606c8506df699b3102186c12a0402415814da46/src/irc_olm/store.py /opt/irc-olm/irc_olm/store.py

# claude-ircbot at 5267471: master's squash merge of vjt/claude-ircbot#7, the bridge on wire v2.
ADD --checksum=sha256:ed04960e0305aaf5ed02139fce9e5fbb63824d73f05ac60159c99f63f4df936b \
    https://raw.githubusercontent.com/vjt/claude-ircbot/526747163a032ac331d6099bd2a4d1317b59262c/bot.py /opt/bot/bot.py
ADD --checksum=sha256:c38a2ea57528fd567befba0f068c53ce22ade8826a62817704465d3a8605350b \
    https://raw.githubusercontent.com/vjt/claude-ircbot/526747163a032ac331d6099bd2a4d1317b59262c/e2e_bridge.py /opt/bot/e2e_bridge.py
ADD --checksum=sha256:037cfcb23b19706cd35adf8dd035bcea5e34d46c71c0b5b841d675c24f7bce6d \
    https://raw.githubusercontent.com/vjt/claude-ircbot/526747163a032ac331d6099bd2a4d1317b59262c/leak_guard.py /opt/bot/leak_guard.py

COPY control.py /opt/e2e-bot/control.py

# A remote ADD lands mode 600: uid 1000 runs bot.py and must read it. /data/etc
# is root's (what the bot only reads), /data/bot is uid 1000's; control.py
# (re)creates both on every /start.
RUN chmod -R a+rX /opt/irc-olm /opt/bot && mkdir -p /data && chmod 755 /data

EXPOSE 8080
# Root on purpose: control.py owns the files the bot must find unwritable, and
# starts bot.py as uid 1000.
CMD ["python", "/opt/e2e-bot/control.py"]
