import { render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { WhoisBundle } from "../lib/api";
import { dismissWhoisCard, setWhoisBundle } from "../lib/whoisCard";
import WhoisCard from "../WhoisCard";

// P-0a — Cluster `numeric-delegation-p0` 2026-05-13. Verifies WhoisCard
// renders all 11 newly-folded WHOIS-leg flags as inline tag chips +
// structured rows. Server emits typed booleans / strings; cic builds
// the human-readable strings ("services agent" / "SSL" / etc) here.

const baseBundle: WhoisBundle = {
  network: "azzurra",
  target: "alice",
  user: "alice_u",
  host: "alice.host",
  realname: "Alice Liddell",
  server: "irc.azzurra.org",
  server_info: "Azzurra Hub",
  is_operator: false,
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
};

describe("WhoisCard P-0a flags", () => {
  afterEach(() => {
    dismissWhoisCard("azzurra");
  });

  it("renders SSL tag when using_ssl: true", () => {
    setWhoisBundle("azzurra", { ...baseBundle, using_ssl: true });
    render(() => <WhoisCard networkSlug="azzurra" />);
    expect(screen.getByText("SSL")).toBeInTheDocument();
  });

  it("renders 'registered' tag when is_registered: true", () => {
    setWhoisBundle("azzurra", { ...baseBundle, is_registered: true });
    render(() => <WhoisCard networkSlug="azzurra" />);
    expect(screen.getByText("registered")).toBeInTheDocument();
  });

  it("renders 'services agent' tag when is_agent: true", () => {
    setWhoisBundle("azzurra", { ...baseBundle, is_agent: true });
    render(() => <WhoisCard networkSlug="azzurra" />);
    expect(screen.getByText("services agent")).toBeInTheDocument();
  });

  it("renders 'server admin' / 'services admin' / 'helper' / 'chanop' / 'java' tags from typed flags", () => {
    setWhoisBundle("azzurra", {
      ...baseBundle,
      is_admin: true,
      is_services_admin: true,
      is_helper: true,
      is_chanop: true,
      is_java: true,
    });
    render(() => <WhoisCard networkSlug="azzurra" />);
    expect(screen.getByText("server admin")).toBeInTheDocument();
    expect(screen.getByText("services admin")).toBeInTheDocument();
    expect(screen.getByText("helper")).toBeInTheDocument();
    expect(screen.getByText("chanop")).toBeInTheDocument();
    expect(screen.getByText("java")).toBeInTheDocument();
  });

  it("renders away row with the away message when away_message is non-null", () => {
    setWhoisBundle("azzurra", { ...baseBundle, away_message: "Gone fishing" });
    render(() => <WhoisCard networkSlug="azzurra" />);
    expect(screen.getByText("away")).toBeInTheDocument();
    expect(screen.getByText("Gone fishing")).toBeInTheDocument();
  });

  it("renders 'connecting from' row with host + ip when actually_host/ip set", () => {
    setWhoisBundle("azzurra", {
      ...baseBundle,
      actually_host: "real.host.example",
      actually_ip: "192.0.2.42",
    });
    render(() => <WhoisCard networkSlug="azzurra" />);
    expect(screen.getByText("connecting from")).toBeInTheDocument();
    const card = screen.getByTestId("whois-card");
    expect(card.textContent).toContain("real.host.example");
    expect(card.textContent).toContain("[192.0.2.42]");
  });

  it("renders modes row with the extracted umode string when umodes is set", () => {
    setWhoisBundle("azzurra", { ...baseBundle, umodes: "+iZ" });
    render(() => <WhoisCard networkSlug="azzurra" />);
    expect(screen.getByText("modes")).toBeInTheDocument();
    expect(screen.getByText("+iZ")).toBeInTheDocument();
  });

  it("does NOT render any P-0a tag chip when all flags are false (defaults)", () => {
    setWhoisBundle("azzurra", baseBundle);
    render(() => <WhoisCard networkSlug="azzurra" />);
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
    setWhoisBundle("azzurra", {
      ...baseBundle,
      // \x02 bold, \x03 04 red, \x0f reset — the codes a colored vhost /
      // swhois / formatted gecos carries on the wire.
      umodes: "\x02+iZ\x02",
      actually_host: "\x0304vhost.azzurra.chat\x0f",
      actually_ip: "\x02192.0.2.42\x02",
      server_info: "\x0303Azzurra\x03 Hub",
      realname: "\x1fAlice\x1f",
    });
    render(() => <WhoisCard networkSlug="azzurra" />);
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
    setWhoisBundle("azzurra", {
      ...baseBundle,
      is_operator: true,
      is_registered: true,
      is_agent: true,
      using_ssl: true,
      umodes: "+iZ",
      actually_host: "secure.host",
      actually_ip: "10.0.0.1",
      away_message: "AFK",
    });
    render(() => <WhoisCard networkSlug="azzurra" />);
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
