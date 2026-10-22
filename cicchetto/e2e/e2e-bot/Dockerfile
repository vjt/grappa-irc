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

# irc-olm at 309c9c7, the commit claude-ircbot 12fc7b5 pins.
ADD --checksum=sha256:beab9b51847365ff7719930409b32e1afd220e1ae34687373069b04e0108dafa \
    https://raw.githubusercontent.com/vjt/irc-olm/309c9c7374e68528beddf3c8a1d9beb265f7a302/src/irc_olm/__init__.py /opt/irc-olm/irc_olm/__init__.py
ADD --checksum=sha256:5a800d58b6ae83f884c4e35f64d351859ef92c2b119d5242993b7321d794299a \
    https://raw.githubusercontent.com/vjt/irc-olm/309c9c7374e68528beddf3c8a1d9beb265f7a302/src/irc_olm/__main__.py /opt/irc-olm/irc_olm/__main__.py
ADD --checksum=sha256:800c963d363527c9539c2825f5ad63faa72f05aa3c3413f8e4dd2a04e8a8cd1a \
    https://raw.githubusercontent.com/vjt/irc-olm/309c9c7374e68528beddf3c8a1d9beb265f7a302/src/irc_olm/challenge.py /opt/irc-olm/irc_olm/challenge.py
ADD --checksum=sha256:ce0c94a248ef05b8aac743682c517d69132f0ed99bc006ad50de48d10c836abd \
    https://raw.githubusercontent.com/vjt/irc-olm/309c9c7374e68528beddf3c8a1d9beb265f7a302/src/irc_olm/engine.py /opt/irc-olm/irc_olm/engine.py
ADD --checksum=sha256:511e2473582a2fcc254f147152021161b445f910b3bac43709ffee246f72a566 \
    https://raw.githubusercontent.com/vjt/irc-olm/309c9c7374e68528beddf3c8a1d9beb265f7a302/src/irc_olm/framing.py /opt/irc-olm/irc_olm/framing.py
ADD --checksum=sha256:a44828fc1ba05d978d5d11fba3b073e783399e741f6779572704565886f6c60c \
    https://raw.githubusercontent.com/vjt/irc-olm/309c9c7374e68528beddf3c8a1d9beb265f7a302/src/irc_olm/pacing.py /opt/irc-olm/irc_olm/pacing.py
ADD --checksum=sha256:87974e502545d11997c145c49a78de8b46ab2753da5b2e5729a16b858994a534 \
    https://raw.githubusercontent.com/vjt/irc-olm/309c9c7374e68528beddf3c8a1d9beb265f7a302/src/irc_olm/pins.py /opt/irc-olm/irc_olm/pins.py
ADD --checksum=sha256:83f1f560c0faed366e520fc32f3fa315d44573c344f90053a1a901b97410c326 \
    https://raw.githubusercontent.com/vjt/irc-olm/309c9c7374e68528beddf3c8a1d9beb265f7a302/src/irc_olm/reassembly.py /opt/irc-olm/irc_olm/reassembly.py
ADD --checksum=sha256:83a04bd9ae7a32950a43092ffacfbee882d8adedc17c2776ffa51c918dfb03db \
    https://raw.githubusercontent.com/vjt/irc-olm/309c9c7374e68528beddf3c8a1d9beb265f7a302/src/irc_olm/store.py /opt/irc-olm/irc_olm/store.py

# claude-ircbot at 12fc7b5: master after PR 6.
ADD --checksum=sha256:ed04960e0305aaf5ed02139fce9e5fbb63824d73f05ac60159c99f63f4df936b \
    https://raw.githubusercontent.com/vjt/claude-ircbot/12fc7b56f35e13c5fb0222b7dadae452b600d25a/bot.py /opt/bot/bot.py
ADD --checksum=sha256:16ebcee7495ca284e939f70f4dcd87acbb61b9a05de335ffbeee5bf034b3ff73 \
    https://raw.githubusercontent.com/vjt/claude-ircbot/12fc7b56f35e13c5fb0222b7dadae452b600d25a/e2e_bridge.py /opt/bot/e2e_bridge.py
ADD --checksum=sha256:037cfcb23b19706cd35adf8dd035bcea5e34d46c71c0b5b841d675c24f7bce6d \
    https://raw.githubusercontent.com/vjt/claude-ircbot/12fc7b56f35e13c5fb0222b7dadae452b600d25a/leak_guard.py /opt/bot/leak_guard.py

COPY control.py /opt/e2e-bot/control.py

# A remote ADD lands mode 600: uid 1000 runs bot.py and must read it. /data/etc
# is root's (what the bot only reads), /data/bot is uid 1000's; control.py
# (re)creates both on every /start.
RUN chmod -R a+rX /opt/irc-olm /opt/bot && mkdir -p /data && chmod 755 /data

EXPOSE 8080
# Root on purpose: control.py owns the files the bot must find unwritable, and
# starts bot.py as uid 1000.
CMD ["python", "/opt/e2e-bot/control.py"]
