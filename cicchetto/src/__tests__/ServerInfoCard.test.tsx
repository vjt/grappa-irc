import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { ConnectionInfo, Network } from "../lib/api";
import { SELECTABLE_TEXT_CLASS } from "../lib/keepKeyboard";
import ServerInfoCard from "../ServerInfoCard";

// #474 — the server-window rail card. Pure presentational: it takes the
// already-in-store `Network` + an injected `now` (epoch ms) so the rendered
// duration is deterministic. Facts-only — slug, nick, connection state (+
// reason), connected-since, services flavor, AND (scope B) the live upstream
// connection facts under `network.connection`: which box the socket dialled
// (`server:port`), whether it is TLS, and whether the nick is identified to
// services. `connection` is null when the session is not live (honesty), so
// those rows appear ONLY when there is a real connected socket.

const now = Date.parse("2026-07-31T12:00:00.000Z");

// #897 — the LIVE link facts. `connected_at` is the instant THIS socket came
// up (Session.Server's per-process stamp), deliberately 4h12m ago while the
// credential row below last TRANSITIONED 10 days ago: the two must not be
// confused, and the card renders the former.
const baseConn: ConnectionInfo = {
  server: "89.31.72.10",
  port: 6697,
  tls: true,
  registered: true,
  connected_at: new Date(now - (4 * 3600 + 12 * 60) * 1000).toISOString(),
};

const baseNet: Network = {
  kind: "user",
  id: 7,
  slug: "libera",
  services_flavor: "atheme",
  nick: "vjt",
  ident: "vjt",
  realname: "VJT",
  connection_state: "connected",
  connection_state_reason: null,
  connection_state_changed_at: new Date(now - 10 * 86400 * 1000).toISOString(),
  connection: baseConn,
  age: null,
  gender: null,
  location: null,
  languages: null,
  custom: null,
  avatar_url: null,
  inserted_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

describe("ServerInfoCard", () => {
  // issue 2394 — the shared re-enable class, or the server name is uncopyable
  // on touch.
  it("carries the shared selectable-text class on its root", () => {
    render(() => <ServerInfoCard network={baseNet} now={now} />);
    expect(screen.getByTestId("rail-server-info")).toHaveClass(SELECTABLE_TEXT_CLASS);
  });

  it("renders the network slug, own nick, connected state, uptime and services", () => {
    render(() => <ServerInfoCard network={baseNet} now={now} />);
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("libera"); // network slug (the only label)
    expect(card.textContent).toContain("vjt"); // own nick on this network
    expect(card.textContent).toContain("connected"); // connection-state word (a11y label)
    expect(card.textContent).toContain("4h 12m"); // connected-since duration
    expect(card.textContent).toContain("atheme"); // services flavor
  });

  it("shows NO uptime row when the state is parked, but shows the state + reason", () => {
    render(() => (
      <ServerInfoCard
        network={{
          ...baseNet,
          connection_state: "parked",
          connection_state_reason: "user /disconnect",
          connection: null,
        }}
        now={now}
      />
    ));
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("parked");
    expect(card.textContent).toContain("user /disconnect");
    // Honesty: a "connected for 4h 12m" line would be a lie while parked.
    expect(card.textContent).not.toContain("4h 12m");
  });

  it("shows the failed state with its reason", () => {
    render(() => (
      <ServerInfoCard
        network={{
          ...baseNet,
          connection_state: "failed",
          connection_state_reason: "SASL 904 authentication failed",
          connection: null,
        }}
        now={now}
      />
    ));
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("failed");
    expect(card.textContent).toContain("SASL 904 authentication failed");
  });

  it("omits the uptime row when connected but the connect instant is unknown (null)", () => {
    render(() => (
      <ServerInfoCard
        network={{ ...baseNet, connection: { ...baseConn, connected_at: null } }}
        now={now}
      />
    ));
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("connected");
    expect(card.textContent).not.toContain("4h 12m");
  });

  // #897 — Mezmerize's report: the card read `connection_state_changed_at`,
  // the credential's last state TRANSITION. A bouncer restart never moves the
  // row out of `:connected` (Networks.connect/1 no-ops without a DB write), so
  // that column outlives the link by however many restarts happened since. The
  // card must measure the LIVE link, which is what `connection.connected_at`
  // (Session.Server's per-process stamp) is.
  it("measures the live link, not the last DB state transition (#897)", () => {
    render(() => <ServerInfoCard network={baseNet} now={now} />);
    const card = screen.getByTestId("rail-server-info");
    // The fixture's link came up 4h12m ago; its row last transitioned 10d ago.
    expect(card.textContent).toContain("4h 12m");
    expect(card.textContent).not.toContain("10d");
  });

  it("shows NO uptime when the DB row says connected but no link is live (#897)", () => {
    // DB state and live state are separate sources of truth and may diverge
    // (CLAUDE.md). A `:connected` row with a dead/reconnecting session gets an
    // honest silence, never a duration computed from the DB column.
    render(() => (
      <ServerInfoCard
        network={{ ...baseNet, connection_state: "connected", connection: null }}
        now={now}
      />
    ));
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("connected");
    expect(card.textContent).not.toContain("10d");
    expect(card.textContent).not.toContain("4h 12m");
  });

  it("omits the services row when the flavor is unknown (no useful fact)", () => {
    render(() => <ServerInfoCard network={{ ...baseNet, services_flavor: "unknown" }} now={now} />);
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).not.toContain("services");
  });

  it("renders the dialled server:port, a TLS lock and identified state (#474 B)", () => {
    render(() => <ServerInfoCard network={baseNet} now={now} />);
    const card = screen.getByTestId("rail-server-info");
    // The box the session actually landed on (round-robin triage).
    expect(card.textContent).toContain("89.31.72.10:6697");
    // TLS lock present on a secure link.
    expect(card.querySelector("[aria-label='TLS']")).not.toBeNull();
    // +r registered → identified to services.
    expect(card.querySelector("[data-testid=rail-server-info-identified]")?.textContent).toBe(
      "yes",
    );
  });

  it("shows the non-TLS + not-identified state honestly", () => {
    render(() => (
      <ServerInfoCard
        network={{
          ...baseNet,
          connection: {
            ...baseConn,
            server: "127.0.0.1",
            port: 6667,
            tls: false,
            registered: false,
          },
        }}
        now={now}
      />
    ));
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).toContain("127.0.0.1:6667");
    // No lock on a plain-text socket.
    expect(card.querySelector("[aria-label='TLS']")).toBeNull();
    expect(card.querySelector("[data-testid=rail-server-info-identified]")?.textContent).toBe("no");
  });

  it("shows NO connection rows when connection is null (session not live)", () => {
    render(() => <ServerInfoCard network={{ ...baseNet, connection: null }} now={now} />);
    const card = screen.getByTestId("rail-server-info");
    expect(card.textContent).not.toContain("89.31.72.10");
    expect(card.querySelector("[aria-label='TLS']")).toBeNull();
    expect(card.querySelector("[data-testid=rail-server-info-identified]")).toBeNull();
  });
});
