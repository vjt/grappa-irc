import { render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #1404 — the token arrives in the fragment, so there is no `useParams` to
// mock any more: the component reads `window.location.hash` and jsdom gives
// us a real one. Mocking a param accessor here would have re-created the
// path-shaped world in the test while production had left it.
const routerHolder = vi.hoisted(() => ({
  navigate: vi.fn(),
}));
vi.mock("@solidjs/router", () => ({
  useNavigate: () => routerHolder.navigate,
}));

// Put a token in the address bar the way a followed link would.
const landOn = (hash: string) => {
  window.history.replaceState(null, "", `/share${hash}`);
};

const apiHolder = vi.hoisted(() => ({
  consumeShareToken: vi.fn(),
}));
vi.mock("../lib/api", () => ({
  consumeShareToken: apiHolder.consumeShareToken,
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
}));

const authHolder = vi.hoisted(() => ({
  installSharedSession: vi.fn(),
}));
vi.mock("../lib/auth", () => ({
  installSharedSession: authHolder.installSharedSession,
}));

import ShareConsume from "../ShareConsume";

beforeEach(() => {
  vi.clearAllMocks();
  landOn("#signed-payload");
});

describe("ShareConsume", () => {
  it("posts to consume on mount and installs the session on success", async () => {
    apiHolder.consumeShareToken.mockResolvedValue({
      token: "new-bearer-uuid",
      // #211 phase 7 — the visitor subject wire carries only
      // {kind, id, registered}; nick/network_slug moved to GET /networks.
      subject: { kind: "visitor", id: "v1", registered: false },
    });

    render(() => <ShareConsume />);

    await waitFor(() => {
      expect(apiHolder.consumeShareToken).toHaveBeenCalledWith("signed-payload");
    });

    await waitFor(() => {
      expect(authHolder.installSharedSession).toHaveBeenCalledWith("new-bearer-uuid", {
        kind: "visitor",
        id: "v1",
        registered: false,
      });
      expect(routerHolder.navigate).toHaveBeenCalledWith("/", { replace: true });
    });
  });

  it("renders the wire-shape error string on failure (expired)", async () => {
    apiHolder.consumeShareToken.mockRejectedValue(new Error("share_token_expired"));

    render(() => <ShareConsume />);

    await waitFor(() => {
      expect(screen.getByTestId("share-consume-error").textContent).toBe("share_token_expired");
    });

    // No session install, no nav home
    expect(authHolder.installSharedSession).not.toHaveBeenCalled();
    expect(routerHolder.navigate).not.toHaveBeenCalledWith("/", { replace: true });
  });

  it("renders the wire-shape error string on failure (already used)", async () => {
    apiHolder.consumeShareToken.mockRejectedValue(new Error("share_token_consumed"));

    render(() => <ShareConsume />);

    await waitFor(() => {
      expect(screen.getByTestId("share-consume-error").textContent).toBe("share_token_consumed");
    });
  });

  it("clicking 'go to login' navigates to /login", async () => {
    apiHolder.consumeShareToken.mockRejectedValue(new Error("not_found"));

    render(() => <ShareConsume />);

    await waitFor(() => expect(screen.getByTestId("share-consume-go-login")).toBeInTheDocument());

    screen.getByTestId("share-consume-go-login").click();

    expect(routerHolder.navigate).toHaveBeenCalledWith("/login", { replace: true });
  });

  // #1404 — the fragment keeps the token off the wire; these three keep it
  // out of the address bar and out of history, which is the other half.
  describe("the token does not linger in the URL", () => {
    it("is already gone from the bar by the time the request goes out", async () => {
      // Pre-state: the bar really does carry the token before we render.
      // Without this the assertions below would also pass on a component
      // that never saw a fragment at all.
      expect(window.location.hash).toBe("#signed-payload");

      // Sampled INSIDE the call rather than after it: "empty afterwards" is
      // what scrubbing on success also produced, and that left every failed
      // or unredeemed link sitting in the bar. The property is ordering.
      let hashDuringRequest: string | null = null;
      apiHolder.consumeShareToken.mockImplementation(async (token: string) => {
        hashDuringRequest = window.location.hash;
        return {
          token: `bearer-for-${token}`,
          subject: { kind: "visitor", id: "v1", registered: false },
        };
      });

      render(() => <ShareConsume />);

      await waitFor(() => {
        expect(apiHolder.consumeShareToken).toHaveBeenCalledWith("signed-payload");
      });

      expect(hashDuringRequest).toBe("");
      expect(window.location.pathname).toBe("/share");
    });

    it("is gone after a REFUSED consume too, not only a successful one", async () => {
      apiHolder.consumeShareToken.mockRejectedValue(new Error("share_token_consumed"));

      render(() => <ShareConsume />);

      await waitFor(() => {
        expect(screen.getByTestId("share-consume-error").textContent).toBe("share_token_consumed");
      });

      // The scrub is unconditional: a consume that fails clears the
      // fragment exactly like one that succeeds.
      expect(window.location.hash).toBe("");
    });

    it("answers missing_token locally when there is no fragment, spending no request", async () => {
      landOn("");

      render(() => <ShareConsume />);

      await waitFor(() => {
        expect(screen.getByTestId("share-consume-error").textContent).toBe("missing_token");
      });

      expect(apiHolder.consumeShareToken).not.toHaveBeenCalled();
    });
  });
});
