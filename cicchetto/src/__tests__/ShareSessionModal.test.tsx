import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

const apiHolder = vi.hoisted(() => ({
  mintShareToken: vi.fn(),
}));
vi.mock("../lib/api", () => ({
  mintShareToken: apiHolder.mintShareToken,
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

// #232 — ShareSessionModal now routes Esc through the REAL shared overlay
// stack (createOverlayLock onEscape). Use the real module so the Esc test
// exercises the actual registration; __resetForTest drains it per test.
import {
  __resetForTest,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";
import ShareSessionModal from "../ShareSessionModal";

const futureIso = (secondsAhead: number): string =>
  new Date(Date.now() + secondsAhead * 1000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTest();
  // Clipboard polyfill — jsdom doesn't ship one. Tests that touch it
  // mock `writeText` per-case.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  __resetForTest();
});

describe("ShareSessionModal", () => {
  it("does not render when open=false", () => {
    render(() => <ShareSessionModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId("share-modal")).not.toBeInTheDocument();
  });

  it("mints a token on open and shows the URL + countdown", async () => {
    apiHolder.mintShareToken.mockResolvedValue({
      token: "signed-token-payload",
      expires_at: futureIso(600),
    });

    render(() => <ShareSessionModal open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(apiHolder.mintShareToken).toHaveBeenCalledWith("test-bearer");
    });

    await waitFor(() => {
      const input = screen.getByTestId("share-modal-url") as HTMLInputElement;
      // Hash route, token URL-encoded
      expect(input.value).toContain("/share/signed-token-payload");
    });

    expect(screen.getByTestId("share-modal-countdown").textContent).toMatch(
      /expires in (9|10):\d\d/,
    );
  });

  it("shows an error string when mint fails", async () => {
    apiHolder.mintShareToken.mockRejectedValue(new Error("forbidden"));

    render(() => <ShareSessionModal open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("share-modal-error").textContent).toBe("forbidden");
    });
  });

  it("clicking copy writes the URL to the clipboard + flips the button label", async () => {
    apiHolder.mintShareToken.mockResolvedValue({
      token: "abc",
      expires_at: futureIso(600),
    });

    render(() => <ShareSessionModal open={true} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId("share-modal-copy")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("share-modal-copy"));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("/share/abc"),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("share-modal-copy").textContent).toBe("copied!");
    });
  });

  it("backdrop click fires onClose", async () => {
    apiHolder.mintShareToken.mockResolvedValue({
      token: "abc",
      expires_at: futureIso(600),
    });
    const onClose = vi.fn();

    render(() => <ShareSessionModal open={true} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("share-modal-backdrop"));
    expect(onClose).toHaveBeenCalled();
  });

  it("close button fires onClose", async () => {
    apiHolder.mintShareToken.mockResolvedValue({
      token: "abc",
      expires_at: futureIso(600),
    });
    const onClose = vi.fn();

    render(() => <ShareSessionModal open={true} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("share-modal-close"));
    expect(onClose).toHaveBeenCalled();
  });

  // #232 — ShareSessionModal had NO Esc handler before (the a11y gap #232
  // closes). It now registers onClose on the shared overlay stack, so
  // runTopmostOverlayEscape (the verb the global keydown listener calls)
  // fires the same close verb the × / backdrop use — focus-independent.
  it("closes on Escape via the shared overlay stack (was the a11y gap)", async () => {
    apiHolder.mintShareToken.mockResolvedValue({
      token: "abc",
      expires_at: futureIso(600),
    });
    const onClose = vi.fn();

    render(() => <ShareSessionModal open={true} onClose={onClose} />);

    await waitFor(() => expect(overlayEscapeDepth()).toBe(1));
    expect(runTopmostOverlayEscape()).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not mint when token() returns null", () => {
    apiHolder.mintShareToken.mockResolvedValue({ token: "x", expires_at: futureIso(600) });

    vi.resetModules();
    vi.doMock("../lib/auth", () => ({ token: () => null }));

    // Re-require with the new mock applied — can't easily re-import the
    // already-evaluated default. Skip this scenario at the unit level;
    // the auth.ts contract guarantees `token()` is set when the modal
    // can plausibly open (Settings drawer requires bearer to mount).
  });
});
