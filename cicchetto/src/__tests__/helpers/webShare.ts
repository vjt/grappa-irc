import { type Mock, vi } from "vitest";

// A Web Share API on `navigator`, for the unit tests of the share doors (the
// media viewer since issue 2468, the audio mini player since issue 2501).
//
// jsdom has none, and every door hides its control without one, so a test
// that expects the control installs this; `restoreWebShare` in `afterEach`
// takes it back. Defined on `navigator` itself rather than by stubbing the
// global, because the mini player also reads `navigator.mediaSession`.
// Lifted out of MediaViewerModal.test.tsx when the mini player's tests needed
// the same rig, the way e2e/fixtures/webShare.ts holds the e2e twin.

const restorers: Array<() => void> = [];

export function defineOnNavigator(key: "share" | "canShare", value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(navigator, key);
  Object.defineProperty(navigator, key, { value, configurable: true });
  restorers.push(() => {
    if (original === undefined) Reflect.deleteProperty(navigator, key);
    else Object.defineProperty(navigator, key, original);
  });
}

/**
 * `navigator.share` answering with `respond`, beside a `canShare` that always
 * accepts a link and accepts a file only when `canShareFiles` says so.
 */
export function stubWebShare(
  respond: (data: ShareData) => Promise<void>,
  canShareFiles: boolean,
): Mock<(data: ShareData) => Promise<void>> {
  const share = vi.fn<(data: ShareData) => Promise<void>>(respond);
  defineOnNavigator("share", share);
  defineOnNavigator("canShare", (data: ShareData) => data.files === undefined || canShareFiles);
  return share;
}

/** A share that went through: the sheet opened and closed. */
export const sheetCloses = (): Promise<void> => Promise.resolve();

export function restoreWebShare(): void {
  for (const restore of restorers.splice(0)) restore();
}
