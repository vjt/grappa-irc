// Push-notifications e2e helpers — push notifications cluster B5
// (2026-05-14).
//
// Three concerns:
//
//   1. **Stub `pushManager.subscribe`** so the install-path spec can
//      complete the cic enablePush() dance without a real push vendor
//      registration. The real W3C `pushManager.subscribe` would
//      contact FCM / Mozilla autopush and fail in the integration
//      stack (no external network, no valid VAPID-public-key
//      registration with a vendor). The stub returns a
//      PushSubscription-shaped object whose `endpoint` points at the
//      push-catcher sidecar — cic POSTs that endpoint to
//      /push/subscriptions, server stores the row, and B2's
//      Push.Sender then routes to push-catcher.
//
//   2. **Grant / clear notification permission** at the BrowserContext
//      level so cic's `Notification.requestPermission()` short-
//      circuits to "granted" / "denied" without an OS dialog.
//
//   3. **Push-catcher REST client** for spec-side polling of "did a
//      Sender POST land for subscription <id>?". Mirrors
//      grappaApi.assertMessagePersisted's poll-with-timeout shape.
//
// Why a single helper module + page-level initScript stub instead of
// per-spec inline setup: each push-trigger spec opens a fresh
// BrowserContext, completes the same `loginAs + enablePush + assert
// catcher` sequence, and tears down by resetting catcher state. The
// helper lifts that ritual into one call site so the specs read like
// "operator enables push, peer mentions, catcher saw a body".
//
// Boundaries with cicchettoPage.ts: this module owns push-specific
// glue (initScript, permissions, catcher REST). Window-state
// assertions, scrollback queries, channel selection still come from
// cicchettoPage.ts — push specs use both.

import { type BrowserContext, expect, type Page } from "@playwright/test";
import { openSettingsSection } from "./cicchettoPage";
import { assertMessagePersisted, GRAPPA_BASE_URL } from "./grappaApi";
import { assertNoPushAfterStimulus } from "./pushAbsence";

const PUSH_CATCHER_URL = process.env.E2E_PUSH_CATCHER_URL ?? "http://push-catcher:3000";

// W3C PushSubscription shape that cic's enablePush -> postPushSubscription
// expects. Mirrors `cicchetto/src/lib/push.ts` PushSubscribeRequest.
export type StubSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

// Real ECDSA P-256 client public key + auth secret used by the
// Sender Bypass test fixture (test/grappa/push/sender_test.exs).
// Reusing them here so the changeset's length validations
// (`p256dh_key max: 256`, `auth_key max: 64`) trivially pass and
// the upstream `:web_push_elixir` lib's encrypt step doesn't
// reject a malformed key when Sender actually fans out.
const STUB_P256DH =
  "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs";
const STUB_AUTH = "dGVzdC1hdXRoLXNlY3JldDE2Yg";

/**
 * Mints a per-spec push-catcher endpoint. Each spec uses a unique
 * id so concurrent specs (when fullyParallel flips on later) and
 * within-spec multi-device cases don't pollute each other's
 * catcher inbox.
 */
export function pushCatcherEndpoint(id: string): string {
  return `${PUSH_CATCHER_URL}/p/${encodeURIComponent(id)}`;
}

/**
 * Adds an initScript that monkey-patches
 * `navigator.serviceWorker.ready.pushManager.subscribe` to return a
 * fake PushSubscription pointing at the push-catcher endpoint. Also
 * stubs `getSubscription()` so cic's probe-on-mount sees the active
 * subscription on subsequent loads.
 *
 * Additionally forces `Notification.permission === "granted"` because
 * chromium's headless mode reports `denied` for the getter even
 * after `context.grantPermissions(["notifications"])` (the grant
 * affects only `Notification.requestPermission()`'s resolved value;
 * the synchronous getter remains "denied"). Cic's `enablePush()`
 * short-circuits on the getter check before reaching
 * requestPermission, so without this stub the install path always
 * trips `permission_denied`.
 *
 * MUST be called BEFORE `page.goto` — initScript runs in every new
 * document context BEFORE any page script, so the stub is in place
 * when cic's `enablePush` resolves `navigator.serviceWorker.ready`.
 */
export async function stubPushManager(
  context: BrowserContext,
  opts: { endpoint: string },
): Promise<void> {
  await context.addInitScript(
    ([endpoint, p256dh, auth]) => {
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: () => "granted",
      });
      Notification.requestPermission = async () => "granted";

      const fakeSubscription = {
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        getKey: (name: string) => {
          // Return a stub ArrayBuffer so any caller that introspects
          // the keys via getKey doesn't NPE. Production cic uses
          // toJSON only, so this branch is defensive.
          const src = name === "p256dh" ? p256dh : auth;
          const bytes = new Uint8Array(src.length);
          for (let i = 0; i < src.length; i++) bytes[i] = src.charCodeAt(i);
          return bytes.buffer;
        },
        toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
        unsubscribe: async () => true,
      };
      // State: starts unsubscribed (matches a fresh browser profile).
      // `subscribe()` flips the flag — subsequent `getSubscription()`
      // calls reflect the post-subscribe state. SettingsDrawer's
      // `probeLocalSubscription` (onMount) calls getSubscription
      // BEFORE the user clicks the master toggle; if we returned the
      // fake sub eagerly, the toggle would render pre-checked + the
      // toggle.check() in the spec would be a no-op (no POST fires).
      let subscribed = false;
      // Patch the registration's pushManager AFTER serviceWorker.ready
      // resolves — registration is a real object owned by the browser,
      // we only swap its pushManager property.
      const originalReady = navigator.serviceWorker.ready;
      Object.defineProperty(navigator.serviceWorker, "ready", {
        configurable: true,
        get: () =>
          originalReady.then((reg) => {
            // Idempotent — multiple `await ready` calls in the same
            // page session must yield the same patched pushManager.
            // @ts-expect-error — patching for test-seam purposes.
            if (reg.pushManager.__cic_push_stub === true) return reg;
            const stubManager = {
              subscribe: async () => {
                subscribed = true;
                return fakeSubscription;
              },
              getSubscription: async () => (subscribed ? fakeSubscription : null),
              permissionState: async () => "granted",
              __cic_push_stub: true,
            };
            Object.defineProperty(reg, "pushManager", {
              configurable: true,
              get: () => stubManager,
            });
            return reg;
          }),
      });
    },
    [opts.endpoint, STUB_P256DH, STUB_AUTH] as const,
  );
}

/**
 * Adds an initScript that overrides `navigator.serviceWorker.ready`
 * so `pushManager.subscribe` rejects with a NotAllowedError, AND
 * `Notification.permission` is forced to "denied". Used by the
 * permission-denied spec to simulate the "user clicked Block at the
 * browser permission prompt" path without needing a real OS dialog.
 *
 * MUST be called BEFORE `page.goto` — same reason as stubPushManager.
 */
export async function stubPushManagerDenied(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "denied",
    });
    Notification.requestPermission = async () => "denied";
  });
}

/**
 * Hands a per-spec subscription id to the push-catcher's `/reset`
 * endpoint so prior runs' deliveries don't bleed into this spec.
 * Cleaner than per-id `DELETE /received/<id>` because resets cover
 * the multi-device shape too.
 */
export async function resetPushCatcher(): Promise<void> {
  const res = await fetch(`${PUSH_CATCHER_URL}/reset`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`resetPushCatcher: ${res.status} ${await res.text()}`);
  }
}

/**
 * Default `notification_prefs` shape — MUST stay in lockstep with
 * `Grappa.UserSettings.default_notification_prefs/0` AND
 * `cicchetto/src/lib/userSettings.ts:DEFAULT_NOTIFICATION_PREFS`.
 *
 * Re-importing from `cicchetto/src/lib/userSettings.ts` would pull in a
 * transitive import of solid-router types — heavier than this small literal.
 * (It would NOT need "a path alias in `cicchetto/e2e/tsconfig.json`", which is
 * what this comment claimed until #1646: `grappaApi.ts` reaches `src` with a
 * plain relative import and no alias. The dependency graph is the reason; the
 * module resolution never was.)
 * The drift class is real but bounded: a new pref key would silently
 * keep writing the old shape AND break cic's TypeScript at the same
 * time; the latter is the loud failure mode.
 */
const DEFAULT_NOTIFICATION_PREFS = {
  channel_messages_all: false,
  channel_messages_only: [] as string[],
  channel_mentions: true,
  private_messages_all: true,
  private_messages_only: [] as string[],
};

/**
 * Resets `notification_prefs` to the cic defaults via PUT
 * /me/settings/notification-prefs. Mirrors
 * `Grappa.UserSettings.default_notification_prefs/0`. Push prefs
 * persist across specs (server-side row, shared seeded vjt user);
 * the prefs-whitelist spec turns `channel_mentions` off, which
 * silently breaks subsequent channel-mention specs unless reset.
 */
export async function resetNotificationPrefs(token: string): Promise<void> {
  await fetch(`${GRAPPA_BASE_URL}/me/settings/notification-prefs`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(DEFAULT_NOTIFICATION_PREFS),
  });
}

/**
 * Deletes every push_subscription row owned by `token`'s user. Cic's
 * GET /push/subscriptions exposes the row ids; DELETE /push/
 * subscriptions/:id removes them. Specs share the seeded `vjt`
 * user (per fixtures/seedData.ts), so without this teardown the
 * install spec's subscription leaks into permission-denied + every
 * trigger spec, polluting devices-list assertions and confusing
 * Push.Sender's per-user fan-out target list.
 */
export async function resetPushSubscriptions(token: string): Promise<void> {
  const headers = { authorization: `Bearer ${token}` };
  const list = await fetch(`${GRAPPA_BASE_URL}/push/subscriptions`, { headers });
  if (!list.ok) {
    // Treat missing endpoint / 401 as "nothing to clean" — first-run
    // shape before any subscription has been created.
    return;
  }
  const body = (await list.json()) as { subscriptions?: { id: string }[] };
  for (const sub of body.subscriptions ?? []) {
    await fetch(`${GRAPPA_BASE_URL}/push/subscriptions/${encodeURIComponent(sub.id)}`, {
      method: "DELETE",
      headers,
    });
  }
}

/**
 * #964 — blocks until the server has stamped `last_used_at` on at least one
 * of `token`'s push subscriptions.
 *
 * Push.Sender bumps the row AFTER the vendor's 200, so push-catcher recording
 * a delivery does NOT mean the DB write has landed: a UI refetch fired off the
 * catcher alone races it. This polls the same REST view the settings drawer
 * reads, so when it returns, a reload is GUARANTEED to render the stamped
 * value — a real barrier, not a sleep.
 */
export async function awaitDeviceLastUsed(token: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${GRAPPA_BASE_URL}/push/subscriptions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { subscriptions?: { last_used_at: string | null }[] };
      if ((body.subscriptions ?? []).some((s) => s.last_used_at !== null)) return;
    }
    await sleep(100);
  }
  throw new Error(`awaitDeviceLastUsed: no subscription stamped within ${timeoutMs}ms`);
}

export type CaughtDelivery = {
  headers: Record<string, string>;
  body_b64: string;
  received_at: number;
};

type CatcherResponse = { id: string; deliveries: CaughtDelivery[] };

/**
 * Waits for at least one delivery on the subscription — AFTER proving that
 * the message whose push is expected actually reached grappa.
 *
 * The stimulus is a REQUIRED argument for the same reason it is one on
 * `assertNoPushDelivery`, and #1152 is the measurement that says so. A peer
 * DM went to a nick nobody was registered under (a 7ms teardown/reconnect
 * left bahamut holding the ghost, and grappa's #604 reconcile correctly
 * adopted `vjt-grappa_`); nothing was ever pushed because nothing ever
 * arrived, and this wait spent five seconds watching a catcher for something
 * nobody sent. It then reported `timeout after 5000ms`, which accuses the
 * push pipeline for a failure that happened before the pipeline was reached.
 * Measured on that run: the peer's nick appears ZERO times in a 240MB log
 * carrying 135 902 message INSERTs.
 *
 * Two things change. The failure now names WHICH half broke — a stimulus
 * that never landed and a pipeline that never delivered are different
 * errors. And the delivery window is clocked from the delivery PROOF rather
 * than from the call, so a slow stimulus transit no longer eats the budget
 * the pipeline is being judged on.
 *
 * Sender's fan-out is fire-and-forget via `Task.async_stream`, so
 * the spec MUST poll rather than assume synchronous delivery. 5s
 * default ceiling matches `assertMessagePersisted` — the Sender HTTP
 * roundtrip + push-catcher record is sub-100ms in practice.
 */
export async function awaitPushDelivery(
  id: string,
  stimulus: PushStimulus,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<CaughtDelivery[]> {
  return awaitPushDeliveryAfter(id, scrollbackProof(stimulus), opts);
}

/**
 * `awaitPushDelivery` for a stimulus whose proof is not a scrollback row.
 * issue 2430: an end-to-end encrypted message is never one — grappa queues
 * it opaque (`awaitE2eQueued`) — so `assertMessagePersisted` could never
 * pass for it, and the wait would accuse the stimulus of a push it did send.
 */
export async function awaitPushDeliveryAfter(
  id: string,
  proof: DeliveryProof,
  opts: { timeoutMs?: number; intervalMs?: number },
): Promise<CaughtDelivery[]> {
  try {
    await proof.delivered();
  } catch (cause) {
    throw new Error(
      `awaitPushDelivery: the stimulus never reached grappa, so a missing push for ` +
        `id=${id} says nothing about the push pipeline — ${proof.describe}\n  cause: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
    );
  }

  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${PUSH_CATCHER_URL}/received/${encodeURIComponent(id)}`);
    if (res.ok) {
      const body = (await res.json()) as CatcherResponse;
      if (body.deliveries.length > 0) return body.deliveries;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `awaitPushDelivery: the stimulus reached grappa but no delivery landed for id=${id} ` +
      `within ${timeoutMs}ms of the proof — ${proof.describe}`,
  );
}

/**
 * The message whose push must NOT arrive — and the proof it reached
 * grappa in the first place.
 *
 * `window` is the REST scrollback segment the row is readable under:
 * the channel name for a channel message, the PEER's nick for a peer
 * DM (the CP14-B3 aggregation shape — probing our own nick hits the
 * own-nick narrowing path and misses peer-originated DMs).
 */
export type PushStimulus = {
  token: string;
  networkSlug: string;
  window: string;
  sender: string;
  body: string;
};

/**
 * What proves a stimulus reached grappa, whatever kind of thing it is.
 * `describe` is quoted back on failure so the reader sees WHICH stimulus was
 * supposed to arrive; `delivered` resolves once it provably has, and rejects
 * with the reason when it has not.
 */
export type DeliveryProof = {
  readonly describe: string;
  readonly delivered: () => Promise<void>;
};

// The proof for a message grappa keeps as a scrollback row: the row itself.
function scrollbackProof(stimulus: PushStimulus): DeliveryProof {
  return {
    describe: `<${stimulus.sender}> ${JSON.stringify(stimulus.body)} → ${stimulus.window}`,
    delivered: () =>
      assertMessagePersisted({
        token: stimulus.token,
        networkSlug: stimulus.networkSlug,
        channel: stimulus.window,
        sender: stimulus.sender,
        body: stimulus.body,
      }),
  };
}

/**
 * Asserts NO deliveries have landed for `id` by the end of `windowMs`,
 * AFTER proving that the message whose push is forbidden actually
 * reached grappa. Used by the suppress/mute specs where the absence of
 * a push is the contract (focused-window suppress; unmatched channel
 * skip; muted conversation).
 *
 * The stimulus is a REQUIRED argument, not a convention: #1152 measured
 * a peer DM that never arrived at all (a ghost-nick collision sent it to
 * a name nobody was registered under), and on an absence assertion that
 * is a silent pass — no message, no trigger, no push, contract
 * "satisfied" without the suppression ever being exercised. Making the
 * proof part of the signature is what stops the next spec author from
 * omitting it. Rationale + the unit-tested core: `pushAbsence.ts`.
 *
 * windowMs is intentionally short (default 1.5s) — Sender's hot path
 * is fire-and-forget but the eval+POST round-trip is sub-100ms when
 * it does fire, so a 1.5s window catches everything that *would*
 * have fired without dragging the suite. Pass a higher window only
 * if a real regression demonstrates a slower path. It is now clocked
 * from the delivery proof rather than from the call, so it can no
 * longer expire before the push it forbids could have fired.
 */
export async function assertNoPushDelivery(
  id: string,
  stimulus: PushStimulus,
  windowMs = 1_500,
): Promise<void> {
  await assertNoPushDeliveryAfter(id, scrollbackProof(stimulus), windowMs);
}

/**
 * `assertNoPushDelivery` for a stimulus whose proof is not a scrollback row
 * — see `awaitPushDeliveryAfter`.
 */
export async function assertNoPushDeliveryAfter(
  id: string,
  proof: DeliveryProof,
  windowMs: number,
): Promise<void> {
  await assertNoPushAfterStimulus(
    {
      stimulusDelivered: proof.delivered,
      deliveryCount: async () => {
        const res = await fetch(`${PUSH_CATCHER_URL}/received/${encodeURIComponent(id)}`);
        if (!res.ok) return 0;
        return ((await res.json()) as CatcherResponse).deliveries.length;
      },
    },
    { id, stimulus: proof.describe, windowMs, pollMs: 100 },
  );
}

/**
 * Asserts an id NOBODY ever sent to stays empty — the push-catcher
 * partitioning check, not a suppression check.
 *
 * Deliberately NOT the same door as `assertNoPushDelivery`: there is no
 * stimulus to prove here, because the whole point is that no message was
 * ever addressed to this id. Its positive control is the real delivery
 * the same test already awaited on the id under test — a Sender that
 * fanned out to every known endpoint would land on both. Uniforming this
 * onto the barriered signature would mean inventing a stimulus that does
 * not exist, which is how an honest assertion becomes a decorative one.
 */
export async function assertNoPushDeliveryOnUnusedId(id: string, windowMs = 1_500): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${PUSH_CATCHER_URL}/received/${encodeURIComponent(id)}`);
    if (res.ok) {
      const body = (await res.json()) as CatcherResponse;
      if (body.deliveries.length > 0) {
        throw new Error(
          `assertNoPushDeliveryOnUnusedId: expected zero, saw ${body.deliveries.length} for id=${id}`,
        );
      }
    }
    await sleep(100);
  }
}

/**
 * #182 — drives the page's foreground visibility for foreground-
 * suppression specs. Overrides `document.visibilityState` / `.hidden`
 * and dispatches `visibilitychange`, which fires cic's PRODUCTION
 * `reportVisibility` reporter → server WSPresence. Then blocks on the
 * `window.__visibilityAck` seam until the server has acked the WS
 * round-trip, so a subsequent triggering PRIVMSG can't race the
 * visibility update.
 *
 * This drives the PAGE-context signal the server now keys off (the
 * reliable one on iOS); the SW's own `clients.matchAll` gate is a
 * separate defensive backstop and is not exercised here.
 */
export async function setPageVisibility(page: Page, visible: boolean): Promise<void> {
  await page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (v ? "visible" : "hidden"),
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => !v,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);

  // Deterministic barrier: block until the reporter's server ack lands,
  // so the caller knows WSPresence has recorded the new visibility.
  await page.waitForFunction(
    (v) => (window as unknown as { __visibilityAck?: boolean }).__visibilityAck === v,
    visible,
    { timeout: 5_000 },
  );
}

/**
 * #192 — drives the page's window FOCUS for the focus-suppression spec.
 * Overrides `document.hasFocus()` and dispatches a `window` `focus`/`blur`
 * event, which fires cic's PRODUCTION presence reporter via
 * documentVisibility.ts's signal → `reportVisibility` → WSPresence. Unlike
 * `setPageVisibility`, `document.visibilityState` is left untouched: this
 * isolates the "desktop tab on-screen but unfocused" case that Page
 * Visibility alone misses. Blocks on the same `__visibilityAck` seam.
 *
 * Precondition: call `setPageVisibility(page, true)` first so visibilityState
 * is pinned "visible" — presence = visible AND focused, so with visibility
 * held true the acked value equals `focused`.
 */
export async function setPageFocus(page: Page, focused: boolean): Promise<void> {
  await page.evaluate((f) => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => f,
    });
    window.dispatchEvent(new Event(f ? "focus" : "blur"));
  }, focused);

  // Presence folds visibility AND focus; with visibilityState pinned
  // "visible", the server-acked presence equals `focused`.
  await page.waitForFunction(
    (f) => (window as unknown as { __visibilityAck?: boolean }).__visibilityAck === f,
    focused,
    { timeout: 5_000 },
  );
}

/**
 * Returns the headers of a CaughtDelivery, downcased by node:http.
 *
 * The body is ciphertext: push-catcher plays the vendor, and the vendor
 * cannot read a Web Push payload — only the subscription's private key
 * can. So the e2e contract is not "did the body decrypt to this JSON"
 * (that is `test/grappa/push/wire_format_test.exs`, which owns the
 * subscription keys and performs a real decrypt) but "did fan-out reach
 * a vendor-shaped endpoint carrying the wire format we promise".
 * `expectRfc8291Delivery` below is that contract.
 */
export function deliveryHeaders(delivery: CaughtDelivery): Record<string, string> {
  return delivery.headers;
}

// RFC 8188 §2.1 content-coding header block: salt(16) ‖ rs(4) ‖ idlen(1)
// ‖ keyid(idlen). Under RFC 8291 the keyid IS the sender's ephemeral
// P-256 public key, uncompressed — 65 bytes opening with 0x04.
const RFC8188_SALT_BYTES = 16;
const RFC8188_RECORD_SIZE_BYTES = 4;
const RFC8188_IDLEN_BYTES = 1;
const P256_UNCOMPRESSED_POINT_BYTES = 65;
const AES_GCM_TAG_BYTES = 16;
const RFC8188_HEADER_BYTES = RFC8188_SALT_BYTES + RFC8188_RECORD_SIZE_BYTES + RFC8188_IDLEN_BYTES;

/**
 * Asserts one caught delivery is RFC 8291 + RFC 8292 on the wire (#1290).
 *
 * This is the tripwire the issue asks for, and it lives here rather than
 * copy-pasted into five specs so there is ONE statement of the wire
 * contract to update — five copies would be five chances to update four.
 *
 * What it pins, and why each half matters:
 *
 *   * `content-encoding: aes128gcm` — the coding RFC 8291 mandates.
 *   * The salt and the sender's ephemeral key are in the BODY's own
 *     binary header, not in HTTP headers. That relocation IS the fix:
 *     both values are mandatory HKDF inputs, so under the superseded
 *     `aesgcm` draft any transport that drops headers (UnifiedPush
 *     discards them by design) handed the app a body it could not
 *     decrypt however correct its keys were.
 *   * The ABSENCE of `encryption:` and `crypto-key:` — half the point.
 *     Emitting them alongside the new coding would mean the old draft
 *     had merely been supplemented, not replaced, and a lenient vendor
 *     would keep the regression invisible.
 *   * `authorization: vapid t=<jwt>, k=<key>` — the RFC 8292 scheme,
 *     not draft-01's `Authorization: WebPush <jwt>`.
 *
 * Deliberately NOT asserted here: JWT claims and the decrypt itself.
 * Both need key material the vendor never sees, and both are already
 * pinned server-side by `wire_format_test.exs`. Measuring them here
 * would mean re-implementing ES256 verification in the harness for a
 * weaker assertion than the one that already exists.
 */
export function expectRfc8291Delivery(delivery: CaughtDelivery): void {
  const headers = delivery.headers;

  expect(headers["content-encoding"]).toBe("aes128gcm");
  // RFC 8030 — every vendor-bound push MUST carry a TTL.
  expect(headers.ttl).toBeDefined();

  // The superseded draft's two headers must be GONE, not merely joined.
  expect(headers.encryption).toBeUndefined();
  expect(headers["crypto-key"]).toBeUndefined();

  // RFC 8292 §3: `vapid t=<JWS compact>, k=<base64url public key>`, and
  // NOT draft-01's `Authorization: WebPush <jwt>`. Same regex as the
  // server-side pin in `test/grappa/push/wire_format_test.exs` — one
  // statement of the shape, not a second one that can drift from it. The
  // whitespace after the comma is OWS per RFC 7235's #auth-param rule, so
  // it stays unpinned.
  expect(headers.authorization).not.toMatch(/^WebPush /);
  expect(headers.authorization).toMatch(/^vapid t=[A-Za-z0-9_.-]+,\s*k=[A-Za-z0-9_-]+$/);

  const body = Buffer.from(delivery.body_b64, "base64");

  // Header block + at least one non-empty record (ciphertext ‖ GCM tag).
  expect(body.length).toBeGreaterThan(
    RFC8188_HEADER_BYTES + P256_UNCOMPRESSED_POINT_BYTES + AES_GCM_TAG_BYTES,
  );

  const salt = body.subarray(0, RFC8188_SALT_BYTES);
  // A constant salt is a real defect and a passing length check would
  // hide it, so assert the value is not the degenerate one.
  expect(salt.every((b) => b === 0)).toBe(false);

  const recordSize = body.readUInt32BE(RFC8188_SALT_BYTES);
  expect(recordSize).toBeGreaterThanOrEqual(body.length);

  const idlen = body.readUInt8(RFC8188_SALT_BYTES + RFC8188_RECORD_SIZE_BYTES);
  expect(idlen).toBe(P256_UNCOMPRESSED_POINT_BYTES);

  const keyid = body.subarray(RFC8188_HEADER_BYTES, RFC8188_HEADER_BYTES + idlen);
  expect(keyid.length).toBe(P256_UNCOMPRESSED_POINT_BYTES);
  // Uncompressed EC point marker — the sender's ephemeral public key.
  expect(keyid[0]).toBe(0x04);
}

/**
 * Composite enable: opens SettingsDrawer + flips the master toggle.
 * Caller MUST have already installed the push stub via
 * `stubPushManager(context, { endpoint: pushCatcherEndpoint(id) })`
 * + granted notification permission BEFORE calling `loginAs` —
 * Playwright initScripts only run for FUTURE navigations, so a stub
 * added after page.goto wouldn't intercept the SW that already
 * registered. The helper closes the drawer afterwards so subsequent
 * sidebar / compose interactions aren't intercepted by the backdrop.
 *
 * Returns the pushCatcherEndpoint id used so the spec can poll for
 * deliveries against it.
 */
export async function enablePushFromSettings(
  page: Page,
  _context: BrowserContext,
  opts: { id: string; token: string },
): Promise<string> {
  // Reset prefs to defaults so a prior spec's `channel_mentions=false`
  // (or any non-default whitelist) doesn't silently neutralise the
  // current spec's trigger eval. Defaults: channel_mentions=true,
  // private_messages_all=true (matches cic's DEFAULT_NOTIFICATION_PREFS).
  await resetNotificationPrefs(opts.token);
  // Caller is responsible for navigation (loginAs etc.). We just
  // open the SettingsDrawer, navigate into the #460 push sub-page, and
  // flip the master toggle.
  const pushPage = await openSettingsSection(page, "push");
  const toggle = pushPage.getByTestId("push-master-toggle");
  await expect(toggle).toBeVisible();
  // click() not check() — see push-install-toggle-subscribe.spec.ts moduledoc for
  // why .check() is unsafe under cic's signal-controlled toggle.
  await toggle.click();
  // The drawer's onMasterToggle awaits enablePush which awaits the
  // POST /push/subscriptions round-trip. Once the device list updates
  // (B3 contract: enablePush -> refreshDevices) we know the server
  // accepted the subscription.
  await expect(page.locator('[data-testid="devices-list"] li')).toHaveCount(1, {
    timeout: 5_000,
  });
  // Close the drawer so subsequent click targets (sidebar window
  // selection, compose textarea) aren't intercepted by the backdrop
  // that sits over the SPA when the drawer is open. Backdrop click
  // dismisses; force: true to bypass the visibility check that the
  // backdrop's hit-target ambiguity sometimes trips.
  await page.locator('[data-testid="settings-drawer-backdrop"]').click({ force: true });
  await expect(page.locator(".settings-drawer.open")).toHaveCount(0);
  return opts.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
