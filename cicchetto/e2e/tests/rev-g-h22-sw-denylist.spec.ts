// REV-G H22 (2026-05-22) — PWA SW navigation denylist regression.
//
// Pre-REV-G the service worker's NavigationRoute denylist was
// `[/^\/auth/, /^\/me/, /^\/networks/, /^\/socket/, /^\/push/]` —
// missing `/uploads`, `/admin`, `/api`. When a user posted a
// `📸 https://<host>/uploads/<slug>.png` URL in IRC and a peer tapped
// the link in a new tab (top-level navigation), the SW intercepted
// the request and served the SPA shell instead of the image bytes —
// broken image in new tab.
//
// This spec drives the exact bug-repro path:
//   1. login as vjt → cic PWA loads → service worker registers +
//      activates + claims the page.
//   2. upload a tiny PNG (via in-page fetch using the cic SDK's
//      Authorization header from localStorage) → server returns
//      {slug, url}.
//   3. open the upload URL via top-level navigation (page.goto, which
//      is what tab-open from another origin / URL paste does for
//      Workbox NavigationRoute matching).
//   4. assert content-type is image/png + body starts with PNG magic
//      bytes (89 50 4E 47), NOT text/html with SPA shell.
//
// Pre-REV-G this spec fails because page.goto resolves to the SPA
// shell (text/html, contains <div id="root">). Post-REV-G the denylist
// matches `/uploads` and the SW lets the request through to the
// origin server's UploadsController.show.
//
// Sibling test covers /api/server-settings → JSON not SPA shell.

import { expect, test } from "../fixtures/test";
import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";

async function waitForServiceWorkerControl(page: import("@playwright/test").Page): Promise<void> {
  // cic's SW uses skipWaiting + clients.claim so the first navigation
  // post-login is already SW-controlled. Poll briefly if the
  // controllerchange event hasn't landed yet.
  await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) throw new Error("no SW support");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
  });
}

// Uploads a PNG via in-page fetch so the cic SDK's auth header (read
// from localStorage["grappa-token"] per cicchettoPage.loginAs) is
// honoured. page.request.post bypasses the localStorage / interceptor
// layer.
async function uploadPng(
  page: import("@playwright/test").Page,
  hex: string,
  filename: string,
): Promise<{ slug: string; url: string }> {
  return await page.evaluate(
    async ([hexBody, name]) => {
      const bytes = new Uint8Array(hexBody.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(hexBody.slice(i * 2, i * 2 + 2), 16);
      }
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "image/png" }), name);
      const token = localStorage.getItem("grappa-token");
      if (!token) throw new Error("missing grappa-token in localStorage");
      const res = await fetch("/api/uploads", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (res.status !== 201) {
        throw new Error(`expected 201, got ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as { slug: string; url: string };
    },
    [hex, filename] as const,
  );
}

test("REV-G H22 — SW does not intercept /uploads/<slug> navigation (serves image bytes)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await waitForServiceWorkerControl(page);

  const body = await uploadPng(page, TINY_PNG_HEX, "rev-g-h22.png");
  expect(body.slug).toMatch(/^[a-z2-7]{26}$/);

  // Top-level navigation to the upload URL — this is what tapping the
  // 📸 link in a new tab does, and what pre-REV-G the SW intercepted
  // with the SPA shell.
  const navResponse = await page.goto(`/uploads/${body.slug}`);
  if (!navResponse) throw new Error("page.goto returned null response");

  // POST-REV-G: response IS the image bytes, NOT the SPA shell.
  expect(navResponse.status()).toBe(200);
  expect(navResponse.headers()["content-type"]).toMatch(/image\/png/i);

  const responseBody = await navResponse.body();
  expect(responseBody[0]).toBe(0x89);
  expect(responseBody[1]).toBe(0x50); // P
  expect(responseBody[2]).toBe(0x4e); // N
  expect(responseBody[3]).toBe(0x47); // G

  // Pre-REV-G assertion: the body would contain the SPA shell. Pin
  // explicitly so a denylist regression that re-routes /uploads to
  // the SPA shell fails LOUDLY rather than silently degrading.
  const asText = responseBody.toString("utf8", 0, 200);
  expect(asText).not.toContain('id="root"');
  expect(asText).not.toContain("<!DOCTYPE html>");
});

test("REV-G H22 — SW does not intercept /api/server-settings (serves JSON)", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await waitForServiceWorkerControl(page);

  // Top-level navigation to /api/server-settings. Pre-REV-G the SW
  // intercepted /api/* navigations and served the SPA shell instead
  // of forwarding to the controller. Post-REV-G `/api` is in the
  // denylist. The endpoint requires auth — we pass through the page's
  // cookie context (loginAs seeded the token via localStorage, but
  // /api/server-settings reads from the bearer token; since this is
  // a top-level navigation the browser DOESN'T add the Authorization
  // header — the server returns 401. The point of THIS test is the
  // CONTENT-TYPE: 401 application/json is still proof the controller
  // ran, NOT the SPA shell. Pre-REV-G the SW would intercept and
  // serve 200 text/html SPA shell, bypassing the controller entirely.
  const navResponse = await page.goto("/api/server-settings");
  if (!navResponse) throw new Error("page.goto returned null response");

  // The controller answered — could be 200 (if browser sent some auth
  // shape) or 401 (unauthenticated top-level navigation, which is the
  // expected real-world shape). Either way: content-type is JSON, not
  // text/html.
  expect([200, 401]).toContain(navResponse.status());
  expect(navResponse.headers()["content-type"]).toMatch(/application\/json/i);

  const text = await navResponse.text();
  expect(() => JSON.parse(text)).not.toThrow();
  expect(text).not.toContain('id="root"');
});
