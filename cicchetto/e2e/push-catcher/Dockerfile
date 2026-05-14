# push-catcher — minimal node:http sink for the e2e Push.Sender path.
# Push notifications cluster B5 (2026-05-14).
#
# Stdlib-only (no npm install) so the image stays cache-friendly and
# rebuilds fast across docker pruning. Runs as a non-root UID with no
# filesystem writes (state lives in-memory; per-spec teardown clears
# via POST /reset).
FROM node:22-alpine

WORKDIR /app
COPY server.mjs /app/server.mjs

# nobody:nogroup (65534:65534) is universally present in alpine and
# matches "no privileges needed" — push-catcher only listens on a
# port and holds an in-memory map.
USER 65534:65534

EXPOSE 3000
CMD ["node", "/app/server.mjs"]
