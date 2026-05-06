# grappa e2e — Playwright runner image.
#
# Built from the official Playwright base image (Node 22 + chromium /
# firefox / webkit + system deps for headless browsers). We layer
# package.json deps + leave source mounted via compose volume.
#
# The base image tag MUST match @playwright/test in package.json —
# the bundled browser binaries are version-locked to the @playwright
# JS code that drives them. Bumping one without the other breaks the
# launcher with "Executable doesn't exist".
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /work

# Pre-install deps so the first `compose up` doesn't pay the cold-cache
# tax. Source is bind-mounted via compose at runtime; node_modules
# stays in the image (faster, also avoids the "node_modules from host
# wrong arch" pitfall when a contributor on macOS-arm64 mounts into
# linux-amd64).
COPY package.json /work/
RUN npm install --no-audit --no-fund --package-lock-only=false --silent

# Sanity check: the bundled browser binaries should be present.
RUN npx playwright --version

CMD ["npx", "playwright", "test"]
