import { describe, expect, it, vi } from "vitest";

import { deliverNavigate } from "../swNavigate";

// #146 recurrence — the SW→page navigate delivery must survive a
// rejecting `WindowClient.focus()`. Pre-fix `focusOrOpen` ran
// `await focus()` BEFORE `postMessage`, so a focus() rejection (no
// transient activation — the iOS/WebKit field bite) threw before the
// navigate was posted and the tap opened nothing.

describe("deliverNavigate", () => {
  const URL = "/?network=bahamut-test&channel=%23bofh";

  it("posts the navigate message with the deep-link url", async () => {
    const client = { postMessage: vi.fn(), focus: vi.fn(() => Promise.resolve()) };
    await deliverNavigate(client, URL);
    expect(client.postMessage).toHaveBeenCalledWith({ type: "navigate", url: URL });
  });

  it("posts the navigate BEFORE focusing (post can't depend on focus)", async () => {
    const order: string[] = [];
    const client = {
      postMessage: vi.fn(() => order.push("post")),
      focus: vi.fn(() => {
        order.push("focus");
        return Promise.resolve();
      }),
    };
    await deliverNavigate(client, URL);
    expect(order).toEqual(["post", "focus"]);
  });

  it("still delivers the navigate when focus() REJECTS (the swallow bug)", async () => {
    const client = {
      postMessage: vi.fn(),
      focus: vi.fn(() => Promise.reject(new Error("no transient activation"))),
    };
    // Must not throw — a rejected focus() cannot abort delivery.
    await expect(deliverNavigate(client, URL)).resolves.toBeUndefined();
    // And the navigate MUST have gone out regardless.
    expect(client.postMessage).toHaveBeenCalledWith({ type: "navigate", url: URL });
  });
});
