import type { Page } from "@playwright/test";

// A recording Web Share API, for the specs that drive a share control (the
// media viewer since issue 2468, the audio mini player since issue 2501).
//
// No Playwright engine renders a share sheet, and headless Linux chromium has
// no `navigator.share` at all, so the control would not even render there. The
// stub is installed BEFORE the app boots, so the feature-detect sees an API
// that exists, and it RECORDS what the app hands it. What it cannot fake is
// the part that matters: the app's own fetch of the upload, through the proxy,
// admitted by the prod `connect-src` (the `_cspGuard` fixture fails the spec on
// a violation), arriving as a File with the served type and size.

export type RecordedShare = {
  url: string | null;
  files: { name: string; type: string; size: number }[];
};

// A serialisable digest of each call: a File does not survive
// `page.evaluate`'s structured clone back to the runner.
export async function recordShares(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: RecordedShare[] = [];
    Object.assign(window, { __e2eShares: calls });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data: ShareData): Promise<void> => {
        calls.push({
          url: data.url ?? null,
          files: (data.files ?? []).map((f) => ({ name: f.name, type: f.type, size: f.size })),
        });
        return Promise.resolve();
      },
    });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  });
}

export const recordedShares = (page: Page): Promise<RecordedShare[]> =>
  page.evaluate(() => (window as unknown as { __e2eShares: RecordedShare[] }).__e2eShares);
