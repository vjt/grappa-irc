// Smoke spec — verifies the harness wires up correctly. No assertions
// against grappa or cicchetto yet; the only signal we care about is
// "Playwright launched, navigated to baseURL, got an HTTP response".
//
// Real specs replace this in S2-S3.

import { test, expect } from "@playwright/test";

test("nginx-test serves something on /", async ({ page }) => {
  const response = await page.goto("/");
  expect(response, "page.goto returned no response").not.toBeNull();
  expect(response!.status(), "expected non-error status").toBeLessThan(500);
});

test("grappa /healthz proxies through nginx", async ({ request }) => {
  const response = await request.get("/healthz");
  expect(response.status()).toBe(200);
});
