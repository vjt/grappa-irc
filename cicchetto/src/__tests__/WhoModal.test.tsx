import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { WhoReply, WhoUser } from "../lib/api";
import { setSelectedChannel } from "../lib/selection";
import { dismissWhoModal, setWhoReply } from "../lib/whoModal";
import WhoModal from "../WhoModal";

// #169 — WhoModal renders the buffered /who roster as a flat per-user table
// (nick, flags, user@host, server, hops, realname), a "target — N user/users"
// heading, an End-of-WHO footer, and dismisses on the close button / Esc. The
// nick-click → open-query interaction is covered end-to-end in e2e (it reuses
// the tested MembersPane verb pair).

const SLUG = "azzurra";

const row = (over: Partial<WhoUser>): WhoUser => ({
  nick: "alice",
  user: "au",
  host: "ah.example.org",
  server: "irc.test.org",
  modes: "H",
  hops: 0,
  realname: "Alice Liddell",
  channel: "#bofh",
  ...over,
});

const roster = (users: WhoUser[]): WhoReply => ({
  network: SLUG,
  target: "#bofh",
  users,
});

const focusNetwork = (): void =>
  setSelectedChannel({ networkSlug: SLUG, channelName: "#bofh", kind: "channel" });

describe("WhoModal (#169)", () => {
  afterEach(() => {
    dismissWhoModal(SLUG);
    setSelectedChannel(null);
  });

  it("renders the target + user-count heading and the End-of-WHO footer", () => {
    focusNetwork();
    setWhoReply(SLUG, roster([row({ nick: "alice" }), row({ nick: "bob", modes: "H@" })]));
    render(() => <WhoModal />);
    const modal = screen.getByTestId("who-modal");
    expect(modal.textContent).toContain("#bofh — 2 users");
    expect(modal.textContent).toContain("End of /WHO list: 2");
  });

  it("renders parsed per-user rows (user@host, flags, realname)", () => {
    focusNetwork();
    setWhoReply(
      SLUG,
      roster([row({ nick: "alice", user: "au", host: "ah.example.org", modes: "H@", realname: "Alice L" })]),
    );
    render(() => <WhoModal />);
    const rows = screen.getAllByTestId("who-modal-row");
    expect(rows).toHaveLength(1);
    const text = rows[0]?.textContent ?? "";
    expect(text).toContain("alice");
    expect(text).toContain("au@ah.example.org");
    expect(text).toContain("H@");
    expect(text).toContain("Alice L");
  });

  it("renders one user (singular) for a single-row roster", () => {
    focusNetwork();
    setWhoReply(SLUG, roster([row({ nick: "solo" })]));
    render(() => <WhoModal />);
    expect(screen.getByTestId("who-modal").textContent).toContain("#bofh — 1 user");
  });

  // #175 — the WHO realname (gecos) is arbitrary user free-text and carries
  // mIRC control bytes (colored / bold gecos). RED before the fix:
  // `{u.realname}` interpolates the raw string so the control bytes leak into
  // the DOM and no styled span exists. Only realname is free-text — nick,
  // flags, user@host, server, hops are identifiers and stay literal.
  it("renders mIRC formatting in the realname, never raw control bytes (#175)", () => {
    focusNetwork();
    // \x02 bold, \x0304 red, \x1f underline, \x0f reset — a colored gecos.
    setWhoReply(
      SLUG,
      roster([row({ nick: "alice", realname: "\x02Alice\x02 \x1fLiddell\x1f \x0304X\x0f" })]),
    );
    render(() => <WhoModal />);
    const rowEl = screen.getByTestId("who-modal-row");

    // realname routed through MircBody → styled spans.
    expect(rowEl.querySelector(".scrollback-mirc-bold")).not.toBeNull();
    expect(rowEl.querySelector(".scrollback-mirc-underline")).not.toBeNull();

    // The de-formatted visible text is present...
    expect(rowEl.textContent).toContain("Alice");
    expect(rowEl.textContent).toContain("Liddell");

    // ...and NO raw mIRC control byte leaks into the DOM.
    for (const byte of ["\x02", "\x03", "\x0f", "\x1f"]) {
      expect(rowEl.textContent).not.toContain(byte);
    }
  });

  it("omits the realname span when the server sent no realname", () => {
    focusNetwork();
    setWhoReply(SLUG, roster([row({ nick: "alice", realname: null })]));
    render(() => <WhoModal />);
    expect(screen.getByTestId("who-modal-row").querySelector(".who-modal-realname")).toBeNull();
  });

  it("renders nothing when no roster is present for the active network", () => {
    focusNetwork();
    render(() => <WhoModal />);
    expect(screen.queryByTestId("who-modal")).not.toBeInTheDocument();
  });

  it("dismisses on the close button", () => {
    focusNetwork();
    setWhoReply(SLUG, roster([row({ nick: "alice" })]));
    render(() => <WhoModal />);
    fireEvent.click(screen.getByLabelText("close who"));
    expect(screen.queryByTestId("who-modal")).not.toBeInTheDocument();
  });

  it("dismisses on Escape", () => {
    focusNetwork();
    setWhoReply(SLUG, roster([row({ nick: "alice" })]));
    render(() => <WhoModal />);
    fireEvent.keyDown(screen.getByTestId("who-modal"), { key: "Escape" });
    expect(screen.queryByTestId("who-modal")).not.toBeInTheDocument();
  });
});
