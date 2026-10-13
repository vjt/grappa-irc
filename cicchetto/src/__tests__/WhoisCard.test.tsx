import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { WhoisBundle } from "../lib/api";
import { SELECTABLE_TEXT_CLASS } from "../lib/keepKeyboard";
import WhoisCard from "../WhoisCard";

// P-0a — Cluster `numeric-delegation-p0` 2026-05-13. Verifies WhoisCard
// renders all 11 newly-folded WHOIS-leg flags as inline tag chips +
// structured rows. Server emits typed booleans / strings; cic builds
// the human-readable strings ("services agent" / "SSL" / etc) here.
//
// #606 — WhoisCard is now PROP-DRIVEN (presentational): it takes the
// `bundle` to render + an optional `onDismiss`. The scrollback overlay
// passes the single-slot `whoisCardBySlug` bundle + a dismiss handler;
// the query rail (#606) passes its per-nick bundle and OMITS onDismiss
// (the rail card is persistent, like ServerInfoCard — no × button).

const baseBundle: WhoisBundle = {
  network: "azzurra",
  target: "alice",
  source: "user",
  user: "alice_u",
  host: "alice.host",
  realname: "Alice Liddell",
  server: "irc.azzurra.org",
  server_info: "Azzurra Hub",
  is_operator: false,
  oper_text: null,
  idle_seconds: null,
  signon: null,
  channels: null,
  using_ssl: false,
  is_registered: false,
  is_admin: false,
  is_services_admin: false,
  is_helper: false,
  is_chanop: false,
  is_agent: false,
  is_java: false,
  umodes: null,
  away_message: null,
  actually_host: null,
  actually_ip: null,
  account: null,
  secure: false,
  secure_cipher: null,
  certfp: null,
  extra_lines: null,
  avatar_url: null,
};

const renderCard = (overrides: Partial<WhoisBundle> = {}, onDismiss?: () => void) =>
  render(() => <WhoisCard bundle={{ ...baseBundle, ...overrides }} onDismiss={onDismiss} />);

// issue 2394 — on a coarse pointer the sheet kills selection on <html>; the
// card's root must carry the shared re-enable class or the host / IP / account
// it shows cannot be copied off a phone.
describe("WhoisCard issue 2394 selectable text", () => {
  it("carries the shared selectable-text class on its root", () => {
    renderCard({ actually_host: "real.host.example", actually_ip: "192.0.2.42" });
    expect(screen.getByTestId("whois-card")).toHaveClass(SELECTABLE_TEXT_CLASS);
  });
});

describe("WhoisCard P-0a flags", () => {
  it("renders SSL tag when using_ssl: true", () => {
    renderCard({ using_ssl: true });
    expect(screen.getByText("SSL")).toBeInTheDocument();
  });

  it("renders 'registered' tag when is_registered: true", () => {
    renderCard({ is_registered: true });
    expect(screen.getByText("registered")).toBeInTheDocument();
  });

  it("renders 'services agent' tag when is_agent: true", () => {
    renderCard({ is_agent: true });
    expect(screen.getByText("services agent")).toBeInTheDocument();
  });

  it("renders 'server admin' / 'services admin' / 'helper' / 'chanop' / 'java' tags from typed flags", () => {
    renderCard({
      is_admin: true,
      is_services_admin: true,
      is_helper: true,
      is_chanop: true,
      is_java: true,
    });
    expect(screen.getByText("server admin")).toBeInTheDocument();
    expect(screen.getByText("services admin")).toBeInTheDocument();
    expect(screen.getByText("helper")).toBeInTheDocument();
    expect(screen.getByText("chanop")).toBeInTheDocument();
    expect(screen.getByText("java")).toBeInTheDocument();
  });

  it("renders away row with the away message when away_message is non-null", () => {
    renderCard({ away_message: "Gone fishing" });
    expect(screen.getByText("away")).toBeInTheDocument();
    expect(screen.getByText("Gone fishing")).toBeInTheDocument();
  });

  it("renders 'connecting from' row with host + ip when actually_host/ip set", () => {
    renderCard({ actually_host: "real.host.example", actually_ip: "192.0.2.42" });
    expect(screen.getByText("connecting from")).toBeInTheDocument();
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).toContain("real.host.example");
    expect(card.textContent).toContain("[192.0.2.42]");
  });

  it("renders modes row with the extracted umode string when umodes is set", () => {
    renderCard({ umodes: "+iZ" });
    expect(screen.getByText("modes")).toBeInTheDocument();
    expect(screen.getByText("+iZ")).toBeInTheDocument();
  });

  it("does NOT render any P-0a tag chip when all flags are false (defaults)", () => {
    renderCard();
    // Empty-flag header should NOT contain any of the localized tag labels.
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).not.toContain("SSL");
    expect(card.textContent).not.toContain("services agent");
    expect(card.textContent).not.toContain("registered");
    expect(card.textContent).not.toContain("helper");
  });

  // #142 follow-up — every free-text whois field routes through the shared
  // mIRC renderer, not just realname/away. `umodes`, `actually_host`,
  // `actually_ip` and `server_info` were wrongly treated as "structured"
  // and dumped raw — a services-set colored vhost / swhois leaked the
  // control bytes into the DOM (vjt prod report: "connecting from and
  // modes lines still show control codes"). RED on the unfixed card: the
  // raw `\x03`/`\x02` bytes sit in textContent and no mIRC span exists.
  it("renders mIRC formatting in umodes / connecting-from / server_info, never raw control bytes", () => {
    renderCard({
      // \x02 bold, \x03 04 red, \x0f reset — the codes a colored vhost /
      // swhois / formatted gecos carries on the wire.
      umodes: "\x02+iZ\x02",
      actually_host: "\x0304vhost.azzurra.chat\x0f",
      actually_ip: "\x02192.0.2.42\x02",
      server_info: "\x0303Azzurra\x03 Hub",
      realname: "\x1fAlice\x1f",
    });
    const card = screen.getByTestId("whois-card");

    // The parser splits the formatted runs into styled <span>s — proof the
    // text routed through MircBody, not a raw `{field}` interpolation.
    expect(card.querySelector(".scrollback-mirc-bold")).not.toBeNull();
    expect(card.querySelector(".scrollback-mirc-underline")).not.toBeNull();

    // The de-formatted visible text is present...
    expect(card.textContent).toContain("+iZ");
    expect(card.textContent).toContain("vhost.azzurra.chat");
    expect(card.textContent).toContain("192.0.2.42");
    expect(card.textContent).toContain("Azzurra");
    expect(card.textContent).toContain("Alice");

    // ...and NO raw mIRC control byte leaks into the DOM (hard req #1).
    for (const byte of ["\x02", "\x03", "\x0f", "\x1f"]) {
      expect(card.textContent).not.toContain(byte);
    }
  });

  it("renders ALL chip labels in the same card for a fully-flagged services-agent user", () => {
    renderCard({
      is_operator: true,
      is_registered: true,
      is_agent: true,
      using_ssl: true,
      umodes: "+iZ",
      actually_host: "secure.host",
      actually_ip: "10.0.0.1",
      away_message: "AFK",
    });
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).toContain("oper");
    expect(card.textContent).toContain("registered");
    expect(card.textContent).toContain("services agent");
    expect(card.textContent).toContain("SSL");
    expect(card.textContent).toContain("+iZ");
    expect(card.textContent).toContain("AFK");
    expect(card.textContent).toContain("secure.host");
  });
});

// #606 — the presentational contract: bundle is prop-injected, and the ×
// dismiss button is present ONLY when an onDismiss handler is supplied.
describe("WhoisCard #606 prop-driven render", () => {
  it("renders nothing when no bundle is supplied", () => {
    render(() => <WhoisCard bundle={undefined} />);
    expect(screen.queryByTestId("whois-card")).toBeNull();
  });

  it("renders the × dismiss button and fires onDismiss when supplied (scrollback card)", () => {
    const onDismiss = vi.fn();
    renderCard({}, onDismiss);
    const close = screen.getByLabelText("Dismiss WHOIS");
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("omits the × dismiss button when no onDismiss is supplied (persistent rail card)", () => {
    renderCard();
    expect(screen.queryByLabelText("Dismiss WHOIS")).toBeNull();
  });
});

// #367 — 313 RPL_WHOISOPERATOR role text. bahamut (Azzurra) distinguishes
// operator levels via the trailing text ("is an IRC Operator" vs "is a
// Server Administrator" vs "is a Services Administrator"). The bug: the card
// collapsed 313 to a bare "oper" badge and dropped the role text, so a
// viewer could not tell an ordinary oper from a server/services admin. The
// fix surfaces `oper_text` as a structured row while KEEPING the "oper"
// badge as the always-on flag + the fallback for a bare 313.
describe("WhoisCard #367 oper role text", () => {
  it("renders the role text row AND the oper badge when oper_text is present", () => {
    renderCard({ is_operator: true, oper_text: "is a Services Administrator" });
    const card = screen.getByTestId("whois-card");
    // The role text is surfaced verbatim (upstream ircd string).
    expect(card.textContent).toContain("is a Services Administrator");
    expect(card.querySelector(".whois-card-oper-text")).not.toBeNull();
    // The at-a-glance badge stays present alongside the detail row.
    expect(card.querySelector(".whois-card-tag-oper")).not.toBeNull();
  });

  it("routes oper_text through the mIRC renderer, never leaking raw control bytes", () => {
    // A services-set swhois can carry mIRC formatting — it must route
    // through MircBody like every other free-text whois field (#142 lesson).
    renderCard({ is_operator: true, oper_text: "\x0304is a Services Administrator\x0f" });
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).toContain("is a Services Administrator");
    for (const byte of ["\x03", "\x0f"]) {
      expect(card.textContent).not.toContain(byte);
    }
  });

  it("falls back to the bare oper badge with NO role row when oper_text is null (bare 313)", () => {
    renderCard({ is_operator: true, oper_text: null });
    const card = screen.getByTestId("whois-card");
    // Badge still present (is_operator latched)...
    expect(card.querySelector(".whois-card-tag-oper")).not.toBeNull();
    // ...but no descriptive role row when the ircd sent no text.
    expect(card.querySelector(".whois-card-oper-text")).toBeNull();
  });
});

// #221 (reopened) — solanum/Libera WHOIS badges + fields. The regression:
// solanum signals "is registered" via 330 RPL_WHOISLOGGEDIN (→ `account`)
// and "is secure" via 671 RPL_WHOISSECURE (→ `secure` + `secure_cipher`),
// whereas bahamut used 307 (→ `is_registered`) and 275 (→ `using_ssl`). The
// card badged ONLY the bahamut fields, so a registered + TLS Libera user's
// modal looked anonymous + insecure. The account name + TLS-protocol string
// + certfp were never rendered at all. These lock the fix: a badge/field
// keyed off the solanum fields, without regressing the bahamut path.
describe("WhoisCard #221 solanum fields", () => {
  it("renders 'registered' badge from account (330) even when is_registered is false", () => {
    // solanum: account present, is_registered false (no 307 emitted).
    renderCard({ account: "AliceAccount", is_registered: false });
    expect(screen.getByText("registered")).toBeInTheDocument();
  });

  it("renders 'SSL' badge from secure (671) even when using_ssl is false", () => {
    // solanum: secure true, using_ssl false (no 275 emitted).
    renderCard({ secure: true, using_ssl: false });
    expect(screen.getByText("SSL")).toBeInTheDocument();
  });

  it("renders the account name in a dedicated row when account is set", () => {
    renderCard({ account: "AliceAccount" });
    expect(screen.getByText("account")).toBeInTheDocument();
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).toContain("AliceAccount");
  });

  it("renders the TLS protocol string from secure_cipher when present", () => {
    renderCard({ secure: true, secure_cipher: "TLSv1.3, TLS_AES_256_GCM_SHA384" });
    expect(screen.getByText("secure")).toBeInTheDocument();
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).toContain("TLSv1.3, TLS_AES_256_GCM_SHA384");
  });

  it("renders the certfp fingerprint row when certfp is set", () => {
    renderCard({ certfp: "deadbeefcafef00d" });
    expect(screen.getByText("cert")).toBeInTheDocument();
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).toContain("deadbeefcafef00d");
  });

  it("renders registered badge + account name + SSL badge + TLS proto together for a solanum user", () => {
    // The full reopened-#221 bug scenario in one card: registered + TLS
    // Libera user must NOT look anonymous + insecure.
    renderCard({
      account: "AliceAccount",
      secure: true,
      secure_cipher: "TLSv1.3, TLS_AES_256_GCM_SHA384",
      is_registered: false,
      using_ssl: false,
    });
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).toContain("registered");
    expect(card.textContent).toContain("SSL");
    expect(card.textContent).toContain("AliceAccount");
    expect(card.textContent).toContain("TLSv1.3, TLS_AES_256_GCM_SHA384");
  });

  it("does NOT render a 'registered' badge or account row when account is null and is_registered false", () => {
    renderCard();
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).not.toContain("registered");
    expect(card.textContent).not.toContain("account");
  });
});

// #673 — `extra_lines` rendered by nobody. #221 built the whole generic
// catch (any WHOIS-leg numeric with no typed field folds into
// `extra_lines`), the wire carried it, `userTopic.ts` validated it — and
// the card discarded it. The reported symptom was Azzurra's 340
// RPL_SHUNNED (oper-only) vanishing, but the perimeter is every untyped
// WHOIS numeric: on Libera that also silently dropped 320
// RPL_WHOISSPECIAL, the very case #221's generic catch was written for.
//
// Order note: the server accumulator prepends LIFO for O(1) fold and
// `Grappa.Session.Wire.reverse_extra_lines/1` reverses on emit, so the
// wire delivers ARRIVAL order. The card must render that order as-is —
// a card-side reverse would ship lines backwards. Locked below.
describe("WhoisCard #673 extra_lines", () => {
  it("renders the extra_line text for a shunned user (340 RPL_SHUNNED)", () => {
    renderCard({ extra_lines: [{ numeric: 340, text: "is currently shunned" }] });
    expect(screen.getByTestId("whois-card").textContent).toContain("is currently shunned");
  });

  it("renders multiple extra_lines in ARRIVAL order", () => {
    renderCard({
      extra_lines: [
        { numeric: 320, text: "is a volunteer staff member" },
        { numeric: 340, text: "is currently shunned" },
      ],
    });
    const lines = screen.getByTestId("whois-card").querySelectorAll(".whois-card-extra-line");
    expect(Array.from(lines, (el) => el.textContent)).toEqual([
      "is a volunteer staff member",
      "is currently shunned",
    ]);
  });

  it("exposes the numeric on hover, keeping it out of the card body text", () => {
    // The bare trailing text keeps the card readable; the numeric is
    // oper-facing diagnostics, so it rides in `title` instead.
    renderCard({ extra_lines: [{ numeric: 340, text: "is currently shunned" }] });
    const card = screen.getByTestId("whois-card");
    expect(card.querySelector(".whois-card-extra-line")?.getAttribute("title")).toContain("340");
    expect(card.textContent).not.toContain("340");
  });

  it("routes extra_line text through the mIRC renderer, never leaking raw control bytes", () => {
    // Same class as `oper_text` / swhois (#142): a services-set line can
    // carry mIRC formatting, so it must not be interpolated raw.
    renderCard({ extra_lines: [{ numeric: 320, text: "\x0304is a volunteer staff member\x0f" }] });
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).toContain("is a volunteer staff member");
    for (const byte of ["\x03", "\x0f"]) {
      expect(card.textContent).not.toContain(byte);
    }
  });

  it("treats extra_lines as data — no empty banner when it is the ONLY field", () => {
    // A privacy-stripped or oper-only reply can carry nothing but an
    // extra_line. Without this the card renders "no WHOIS information
    // returned" while holding the very line the user ran /whois for.
    renderCard({
      user: null,
      host: null,
      realname: null,
      server: null,
      server_info: null,
      extra_lines: [{ numeric: 340, text: "is currently shunned" }],
    });
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).toContain("is currently shunned");
    expect(card.textContent).not.toContain("no WHOIS information returned");
  });

  it("renders no extra-line row when extra_lines is null (the bahamut-plain path)", () => {
    renderCard();
    expect(screen.getByTestId("whois-card").querySelector(".whois-card-extra-line")).toBeNull();
  });
});
