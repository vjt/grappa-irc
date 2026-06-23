// e2e ↔ prod nginx parity tripwires (e2e CSP parity, 2026-06-11).
//
// Both assertions pin behavior that ONLY exists at the nginx layer,
// which ConnTest (Phoenix-level) is structurally blind to and which
// unit suites green right through:
//
// 1. Security headers on the wire. The e2e nginx has served the real
//    prod header set since 2026-05-22 (infra/snippets/
//    security-headers.conf via locations-api.conf — the same files
//    infra/nginx.conf and infra/freebsd/nginx.conf include), but
//    nothing ASSERTED it, and two docs claimed the opposite while the
//    `media-src blob:` hole (6f3327c) shipped under a green suite.
//    This spec turns "does the e2e surface carry prod CSP?" from an
//    archaeology question into a red/green one: if someone forks
//    nginx-test.conf away from the shared snippets, or a directive
//    that the media pipeline depends on disappears, this fails — on
//    BOTH listeners (:80 legacy + :443 push surface), since each
//    server block re-includes the snippet chain independently.
//    Directive pins are the load-bearing subset, not the full header
//    string: the full string lives in one snippet shared by all three
//    substrates, and mirroring it here would just be a second copy to
//    drift. (`securitypolicyviolation` enforcement coverage is the
//    `_cspGuard` fixture's job — fixtures/test.ts.)
//
// 2. Range round-trip THROUGH the proxy. Controller-side single-range
//    206 landed 2026-06-10 (GrappaWeb.ByteRange — iOS Safari refuses
//    to play video without it), but a proxy that strips/buffers
//    `Range:` would degrade every video seek on prod while ConnTest
//    stays green — same prod-only blind-spot class as the CSP.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";
import { uploadViaPicker } from "../fixtures/uploadJourney";

// Directives whose loss has bitten (media-src/worker-src, 6f3327c) or
// would silently disarm the XSS posture the bearer-in-localStorage
// design leans on (default-src/frame-ancestors/base-uri).
const LOAD_BEARING_DIRECTIVES = [
  "default-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
];

test("nginx parity — prod security-header set served on :80 and :443", async ({ page }) => {
  for (const origin of ["http://nginx-test", "https://nginx-test"]) {
    const res = await page.request.get(`${origin}/`);
    expect(res.status(), `GET ${origin}/`).toBe(200);

    const headers = res.headers();
    const csp = headers["content-security-policy"];
    expect(csp, `${origin} must serve Content-Security-Policy`).toBeTruthy();
    for (const directive of LOAD_BEARING_DIRECTIVES) {
      expect(csp, `${origin} CSP must carry "${directive}"`).toContain(directive);
    }

    expect(headers["x-content-type-options"], origin).toBe("nosniff");
    expect(headers["x-frame-options"], origin).toBe("DENY");
    expect(headers["referrer-policy"], origin).toBe("same-origin");
  }
});

test("nginx parity — ranged GET /uploads/<slug> through the proxy → 206 + content-range", async ({
  page,
}) => {
  const body = readFileSync(fileURLToPath(new URL("../fixtures/upload.txt", import.meta.url)));
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const { slug } = await uploadViaPicker(
    page,
    { name: "range-probe.txt", mimeType: "text/plain", buffer: body },
    { postTimeout: 10_000 },
  );

  // page.request goes through baseURL = https://nginx-test — the
  // proxy, not grappa directly. bytes=0-3 is a 4-byte slice.
  const res = await page.request.get(`/uploads/${slug}`, {
    headers: { Range: "bytes=0-3" },
  });
  expect(res.status()).toBe(206);
  expect(res.headers()["content-range"]).toBe(`bytes 0-3/${body.length}`);
  expect(res.headers()["accept-ranges"]).toBe("bytes");
  expect((await res.body()).equals(body.subarray(0, 4))).toBe(true);
});
