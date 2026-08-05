// #474 — the right rail shows server-info context on a SERVER window.
//
// #71 INC-2 made `.shell-members` a PERMANENT desktop column on every
// window kind; on a channel it shows the members pane, on a server window
// it previously showed only the RailActions button drawer. #474 fills that
// slot with per-window-kind context: on the server window, connection facts
// already in the client store (network slug, own nick, connection state,
// connected-since) rendered by `RailContext` → `ServerInfoCard`.
//
// Scope B adds the LIVE upstream facts under `network.connection`, resolved
// from `Session.connection_info/2` at the `GET /networks` boundary (the
// additive #447 wire field): the dialled `server:port` (resolved peer IP,
// #550), a 🔒 when TLS, and whether the nick is identified to services
// (`registered`, from the +r umode — the #561 signal). `connection` is null
// whenever there is no live connected session, so these rows render ONLY on
// a real socket. This spec asserts them against what the e2e seeder actually
// dials: `bahamut-test:6667 --no-tls --auth none` (compose.yaml) — so the
// server row shows `:6667`, there is NO lock (plaintext), and `identified`
// reads "no" (no SASL/NickServ → the nick never gains +r). Honesty rule:
// never assert a 🔒 that the plaintext transport does not render.
//
// vitest (RailContext/ServerInfoCard/duration) proves the pure dispatch +
// formatting in jsdom, but jsdom is blind to layout + the live WS-hydrated
// Network store (feedback_ux_e2e_mandatory). This chromium e2e is the
// WIRING proof: a real login over the running stack, a real server window,
// the real store-fed card. Desktop viewport → the rail column is visible
// with no drawer toggle (permanent surface), so no members-open dance.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { expectRailFieldsStacked } from "../fixtures/railFieldGeometry";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SERVER_WINDOW_LABEL = "Server";

test.describe("#474 server-info rail card", () => {
  test("server window rail shows slug, nick, state, connected-since + dialled server / identified", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Precondition: the server window entry exists, then focus it.
    const serverEntry = sidebarWindow(page, NETWORK_SLUG, SERVER_WINDOW_LABEL);
    await expect(serverEntry).toHaveCount(1);
    await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW_LABEL, { awaitWsReady: false });

    // The per-kind rail context surface renders on the server window.
    const card = page.locator("[data-testid=rail-server-info]");
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Header carries the network slug (the folded key IS the display).
    await expect(card.locator(".rail-server-info-title")).toHaveText(NETWORK_SLUG);

    // Facts from the live-hydrated Network store, scoped to the card so a
    // stray match elsewhere in the shell can't false-green this.
    await expect(card).toContainText(NETWORK_NICK);
    // The DB-canonical connection state — the seeded network is live
    // (cp13 S8 drives /away over it), so it reads "connected".
    await expect(card).toContainText("connected");

    // The connected-since row is present with a non-empty duration value —
    // it renders ONLY while connected (honesty rule), so its presence
    // doubles as a live-state assertion. dt "connected" → its dd holds a
    // compact duration like "4h 12m" / "45s".
    const uptimeValue = card.locator('dt:text-is("connected") + dd');
    await expect(uptimeValue).toHaveText(/\d+\s*[smhd]/);

    // Scope B — the LIVE upstream connection facts under network.connection.
    // The seeder binds bahamut-test `--server bahamut-test:6667 --no-tls
    // --auth none` (compose.yaml), so the card renders the honest plaintext,
    // unregistered shape below.
    //
    // `server` row: `<resolved-peer-ip>:6667` — the IP the socket dialled
    // (#550), not the hostname. Assert the :6667 port (the peer IP is a
    // dynamic docker bridge address, so match the stable port suffix), and
    // that there is NO 🔒 glyph — --no-tls means plaintext, and asserting a
    // lock that isn't there would be the exact dishonesty the card avoids.
    await expect(card.locator('dt:text-is("server")')).toBeVisible();
    const serverValue = card.locator('dt:text-is("server") + dd');
    await expect(serverValue).toContainText(":6667");
    await expect(serverValue.locator(".rail-server-info-tls")).toHaveCount(0);

    // `identified` row: "no" — --auth none means no SASL/NickServ handshake,
    // so the nick never gains the +r umode connection_info reads.
    await expect(card.locator("[data-testid=rail-server-info-identified]")).toHaveText("no");

    // #857 — nothing in the rail may render as two columns. This card shipped
    // as `max-content 1fr`, which inside the #605-capped 14rem rail leaves
    // each value a fraction of the card; every `<dt>` and `<dd>` must now own
    // a full-width row of its own. Same helper guards the query-window card
    // (`issue606-query-rail-whois.spec.ts`) — one rule, one assertion.
    await expectRailFieldsStacked(card, ".rail-server-info-fields");
  });
});
