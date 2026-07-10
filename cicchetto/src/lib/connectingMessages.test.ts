import { describe, expect, it } from "vitest";
import { CONNECTING_MESSAGES } from "./connectingMessages";

// #204 foolproof-login — connecting-screen reassurance copy.
//
// HONESTY CONTRACT: these lines are COSMETIC. Login is a single blocking
// request (`POST /auth/login` runs the upstream IRC connect inside the
// call and returns a token or a timeout/admission error) — there is no
// server-pushed progress stream to subscribe to. The rotation exists so
// the user sees motion instead of a dead page, NOT because we know which
// phase the server is in.
//
// vjt Q5 ruling: GENERIC copy — no network-name interpolation, no
// build-time branding constant. The first line is the anchor the connecting
// view shows immediately; the rest rotate on a timer.

describe("CONNECTING_MESSAGES", () => {
  it("leads with the generic no-network connect line", () => {
    expect(CONNECTING_MESSAGES[0]).toBe("connecting to IRC…");
  });

  it("never interpolates a network name (vjt Q5: generic copy only)", () => {
    for (const msg of CONNECTING_MESSAGES) {
      expect(msg).not.toMatch(/\$|\{|azzurra/i);
    }
  });

  it("provides more than one line so the view can rotate", () => {
    expect(CONNECTING_MESSAGES.length).toBeGreaterThan(1);
  });
});
