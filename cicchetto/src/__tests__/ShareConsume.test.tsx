import { render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routerHolder = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { token: "signed-payload" } as { token: string },
}));
vi.mock("@solidjs/router", () => ({
  useNavigate: () => routerHolder.navigate,
  useParams: () => routerHolder.params,
}));

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
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
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
  routerHolder.params = { token: "signed-payload" };
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
});
