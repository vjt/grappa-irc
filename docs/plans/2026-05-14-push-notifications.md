# Push notifications via Web Push + VAPID (cluster)

**Status**: brainstorm — implementation NOT started.
**Branch**: `cluster/push-notifications`.
**Position**: post-`no-silent-drops` (CP31 CLOSED 2026-05-14, see
`project_no_silent_drops_closed`). FIRST gating-to-PUBLIC-OPEN
cluster per `project_post_p4_1_arc`. Cluster scope blessed by vjt
2026-05-14 with FULL ORCHESTRATOR AUTOMATION (close included).
**Origin evidence**: GitHub issue #6 filed 2026-05-13 specced
ntfy.sh as the push relay. 2026-05-14 vjt added "target both
Android AND iOS, no app install anywhere" — ntfy.sh's iOS path
requires the ntfy iOS app + ntfy.sh-hosted APNs proxy, breaking
both the no-app-install AND the self-hosted-only premises. Path
flipped to Web Push + VAPID + service worker per
issue-6 comment 4449765503. Web Push delegates to FCM/APNs/Mozilla
the same way ntfy → APNs would, but with zero phone-side install
and the existing cic PWA stack (manifest + workbox SW + iOS
standalone-mode meta tags shipped S45) already 60% of the way
there.
**North star**: when cic is not focused on the channel/DM that
generated a mention or PRIVMSG, the user gets a native OS push
inside their PWA (Chrome/Firefox/Edge desktop + Android, Safari
iOS post-install-to-home-screen) — no ntfy app, no third-party
container, no per-platform credential management beyond the
single VAPID keypair grappa generates once and stores as env vars.
Trigger logic respects per-user notification_prefs; SW dedups
when the source window is focused.

## Cluster ordering

| Bucket | Surface | Risk | Deploy | Notes |
|---|---|---|---|---|
| 0 | Install splash + injectManifest SW switch | small cic | hot + cic-bundle | "Install app" / "Continue from browser" splash; persists choice; switches vite-plugin-pwa to `injectManifest` so we own service-worker.ts for B2's push handler |
| 1 | push_subscriptions schema + REST | medium server | **COLD** | new schema → cold per `feedback_cluster_with_migration_must_cold` |
| 2 | VAPID + Push.Sender + SW push handler | medium server + cic | **COLD** | new env vars (Bootstrap reads at boot) → cold; `:web_push_encryption` dep → `mix.lock` cold trigger |
| 3 | notification_prefs + cic settings UI | small server + medium cic | hot + cic-bundle | user_settings JSON typed accessor + 5-checkbox settings page + master Enable toggle dance |
| 4 | trigger logic + mention regex port | medium server | hot | hook PRIVMSG persistence; port mention detection from cic to Elixir; SW dedup via clients.matchAll |
| 5 | Playwright e2e coverage | small | none | 6 specs covering install / permission / channel-mention / DM / focused-window-dedup / prefs-whitelist |
| 6 | iOS PWA install + push smoke | manual | none | HALT for vjt iPhone test |

## Standing rules (cluster-wide, carried from no-silent-drops)

- **Wire-shape rule (with documented push-payload exception)**:
  server emits typed booleans / integers / atoms / ISO timestamps;
  cic owns ALL human-readable strings — per
  `feedback_no_localized_strings_server_side`. **EXCEPTION**: Web
  Push payloads are opaque to browsers; the SW receives whatever
  bytes the server signed, and the OS surface (notification
  centre / lockscreen) renders them BEFORE cic JS gets a chance to
  format. So push payloads carry user-facing strings (`title`,
  `body`) chosen server-side. The wire shape inside the payload is
  still typed (`%{title: String.t(), body: String.t(), tag:
  String.t(), url: String.t()}`); only the values are localized.
  Document the exception in CLAUDE.md if anyone later proposes
  generalizing it.
- **No silent drops** (carried from CP31): push delivery failures
  (4xx, 5xx, network) MUST log + telemetry. Dead subscriptions
  (404 Gone / 410 Gone) MUST trigger row deletion. NEVER
  `try/rescue` and swallow.
- **Per-bucket discipline**: `scripts/check.sh` exit 0 +
  `scripts/bun.sh run check` + `scripts/bun.sh run test` +
  `scripts/integration.sh --grep <bucket-tag>` +
  `scripts/integration.sh` full regression sanity + commit + push +
  per-bucket deploy + browser smoke. Per
  `feedback_per_bucket_deploy` + `feedback_landed_claim_evidence`.
- **LANDED claim evidence**: literal `scripts/check.sh` exit-0
  tail in the commit message body.
- **Hot-vs-cold deploy**: B0 cic-only (cic-bundle deploy). B1 +
  B2 cold (new schema; new env vars; new dep). B3 hot + cic-bundle.
  B4 hot. B5 no deploy. B6 manual.
- **Subagent-driven development** per
  `feedback_subagent_driven_development`: Plan agent for B1+B2
  design (boundary surface + Bootstrap wiring), code-reviewer
  agent BEFORE landing B1 migration + B2 dep+env-var changes
  + B4 trigger-logic boundary touch.
- **Wire-edge runtime allowlist exhaustiveness**: any new
  TypeScript discriminated union mirrored as a runtime
  `Set<EnumValue>` MUST gain a vitest exhaustiveness pin. Per
  CP31 B6.11 lesson. Push payload types likely qualify — check
  cic's wireNarrow.ts when adding the SW message channel.

## Bucket 0 — Install splash + injectManifest SW switch

### Origin

cic already ships a workbox-backed SW via vite-plugin-pwa's
`generateSW` strategy (vite.config.ts:34-92). That strategy
auto-generates the SW from a workbox template — we cannot inject
custom event handlers (push, notificationclick) without switching
to `injectManifest` mode where we own a `service-worker.ts` source
file that workbox merges with its precache manifest.

Separately, vjt 2026-05-14: when visiting cic from the web
(not standalone PWA), users have no signal that "Add to Home
Screen" is the right move for getting push notifications later.
Especially on iOS where it's the ONLY way push works. Need a
splash with **"Install app"** + **"Continue from browser"**
buttons. Detect `display-mode: standalone` to skip when already
installed; persist the "Continue from browser" choice in
localStorage so it doesn't re-prompt every visit.

### Fix shape

**1. Switch vite-plugin-pwa strategy.** In `cicchetto/vite.config.ts`:

```typescript
VitePWA({
  registerType: "autoUpdate",
  injectRegister: false,
  strategies: "injectManifest",            // was: default ("generateSW")
  srcDir: "src",
  filename: "service-worker.ts",
  includeAssets: [...],
  manifest: { ... },                       // unchanged
  injectManifest: {
    globPatterns: ["**/*.{js,css,html,svg,png,webmanifest,ico}"],
  },
}),
```

**2. Create `cicchetto/src/service-worker.ts`** — minimal version
in B0 (precache + skipWaiting + activate); push + notificationclick
handlers added in B2. Workbox merges `self.__WB_MANIFEST` (the
precache list) at build time:

```typescript
/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";
declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
```

**3. InstallSplash component.** New `cicchetto/src/InstallSplash.tsx`:

- Mounts at app root (before Login / Shell routes).
- Shows when: `window.matchMedia("(display-mode: standalone)").matches === false`
  AND `localStorage.getItem("cic.installChoice") !== "browser"`.
- Two buttons:
  - **Install app** — fires `beforeinstallprompt` saved event's
    `.prompt()` if available (Android Chrome); on iOS Safari shows
    inline instruction "Tap Share → Add to Home Screen" with the
    Share icon glyph.
  - **Continue from browser** — sets
    `localStorage["cic.installChoice"] = "browser"` and unmounts.
- Listen for `beforeinstallprompt` event in `main.tsx`; stash the
  event globally so InstallSplash's button can call `.prompt()`
  later. Pre-iOS Safari 17 doesn't fire this event — fall back to
  the inline-instruction UX.

**4. Detect-and-skip logic.** In `main.tsx`:

```typescript
import InstallSplash from "./InstallSplash";

const isStandalone = window.matchMedia("(display-mode: standalone)").matches
  || (window.navigator as any).standalone === true; // iOS pre-17 Safari
const userDeclined = localStorage.getItem("cic.installChoice") === "browser";
const showSplash = !isStandalone && !userDeclined;

render(() => (
  <Router>
    {showSplash ? <InstallSplash /> : null}
    <Route path="/login" component={Login} />
    {/* ... */}
  </Router>
), root);
```

InstallSplash is positioned over the Router (z-index: 1000)
rather than a route, so it doesn't interfere with auth flow.

### Files

- `cicchetto/vite.config.ts` — strategies + srcDir + filename + injectManifest opts
- `cicchetto/src/service-worker.ts` — NEW (minimal precache for B0)
- `cicchetto/src/InstallSplash.tsx` — NEW
- `cicchetto/src/main.tsx` — wire beforeinstallprompt capture + splash mount
- `cicchetto/package.json` — `workbox-precaching` dep (workbox-window already present)

### Tests

- vitest: InstallSplash renders when not standalone + no localStorage choice
- vitest: clicking "Continue from browser" sets localStorage + unmounts
- vitest: when localStorage already set, splash does not render
- Playwright (deferred to B5 e2e bucket — push-install-banner.spec.ts)

### Deploy

Cic-only. Hot-deploy for grappa (no server changes). Cic bundle
deploy via `scripts/deploy-cic.sh` — refresh banner triggers on
hash mismatch.

### LANDED criteria

- vitest green (`scripts/bun.sh run test`)
- bun typecheck green (`scripts/bun.sh run check`)
- `scripts/integration.sh` full regression sanity green
- vite build produces a `dist/sw.js` whose source maps back to our
  `service-worker.ts` (sanity: `grep -c precacheAndRoute dist/sw.js`)
- Browser smoke: open cic in private window → splash visible;
  click "Continue from browser" → splash gone, persists across
  reload; install to home screen (Chrome) → reopen as PWA →
  splash skipped

## Bucket 1 — push_subscriptions schema + REST endpoints

### Origin

Server needs a per-user, per-device persistence layer for the
PushSubscription objects browsers hand out. Each subscription is
opaque to us beyond `(endpoint, p256dh_key, auth_key)`, but those
three fields are everything `:web_push_encryption` needs to sign
and POST a payload to the right vendor push endpoint. Per-device
metadata (`user_agent`, `last_used_at`) drives the "see my devices
+ revoke this one" UX added in B3.

### Schema

```elixir
# lib/grappa/push/subscription.ex
defmodule Grappa.Push.Subscription do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}

  schema "push_subscriptions" do
    field :endpoint, :string
    field :p256dh_key, :string
    field :auth_key, :string
    field :user_agent, :string
    field :last_used_at, :utc_datetime_usec

    belongs_to :user, Grappa.Accounts.User, type: :binary_id
    timestamps(type: :utc_datetime_usec)
  end

  @required ~w(endpoint p256dh_key auth_key user_id)a
  @optional ~w(user_agent last_used_at)a

  def changeset(sub, attrs) do
    sub
    |> cast(attrs, @required ++ @optional)
    |> validate_required(@required)
    |> validate_length(:endpoint, max: 2048)
    |> unique_constraint([:user_id, :endpoint])
  end
end
```

### Migration

```elixir
# priv/repo/migrations/<ts>_create_push_subscriptions.exs
defmodule Grappa.Repo.Migrations.CreatePushSubscriptions do
  use Ecto.Migration

  def change do
    create table(:push_subscriptions, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :endpoint, :text, null: false
      add :p256dh_key, :text, null: false
      add :auth_key, :text, null: false
      add :user_agent, :text
      add :last_used_at, :utc_datetime_usec
      timestamps(type: :utc_datetime_usec)
    end

    create unique_index(:push_subscriptions, [:user_id, :endpoint])
    create index(:push_subscriptions, [:user_id])
  end
end
```

`on_delete: :delete_all` — when a user is deleted, their push
subscriptions go with them. Per CP29 R-Z lesson: cluster with new
migration MUST cold-deploy.

### Context

`lib/grappa/push/subscriptions.ex`:

```elixir
@spec create(User.t(), map()) :: {:ok, Subscription.t()} | {:error, Changeset.t()}
@spec delete(Subscription.t()) :: {:ok, Subscription.t()} | {:error, Changeset.t()}
@spec list_for_user(User.t()) :: [Subscription.t()]
@spec touch_last_used(Subscription.t()) :: {:ok, Subscription.t()} | {:error, Changeset.t()}
@spec delete_dead(String.t()) :: {non_neg_integer(), nil}  # by endpoint, used by Sender on 410
```

### REST endpoints

`lib/grappa_web/controllers/push_subscription_controller.ex`:

- `POST /api/push/subscriptions` — body `{ endpoint, keys: { p256dh, auth } }` →
  201 with `%{id, created_at}`. user_agent pulled from request header.
- `DELETE /api/push/subscriptions/:id` — 204 on success; 404 if not user's
- `GET /api/push/subscriptions` — 200 with `[%{id, user_agent, created_at, last_used_at}, ...]`

Auth via existing session (`Plug.AuthenticatedUser` or whatever
the controllers/auth.ex pattern is — read it).

### Files

- `priv/repo/migrations/<ts>_create_push_subscriptions.exs` — NEW
- `lib/grappa/push/subscription.ex` — NEW
- `lib/grappa/push/subscriptions.ex` — NEW
- `lib/grappa_web/controllers/push_subscription_controller.ex` — NEW
- `lib/grappa_web/controllers/push_subscription_json.ex` — NEW (or reuse fallback render)
- `lib/grappa_web/router.ex` — add scope `/api/push/subscriptions`
- `test/grappa/push/subscriptions_test.exs` — context unit tests
- `test/grappa_web/controllers/push_subscription_controller_test.exs` — REST tests

### Tests

- Context: create/delete/list happy paths + uniqueness constraint
- Controller: 401 without auth, 201 on POST, 204 on DELETE, 404 on cross-user DELETE, 200 on GET
- Property: endpoint length validation rejects > 2048

### Deploy

**COLD** per `feedback_cluster_with_migration_must_cold`. Run
`scripts/mix.sh ecto.migrate` after merge; `scripts/deploy.sh`
will detect `priv/repo/migrations/*` and force cold path.

### LANDED criteria

- `scripts/check.sh` exit 0 + literal tail in commit body
- All controller + context tests green
- Code-reviewer agent on the migration before push (per
  `feedback_subagent_driven_development`)
- Browser smoke deferred to B2 (no UI surface yet)

## Bucket 2 — VAPID keypair + Push.Sender + SW push handler

### Origin

Once we have subscriptions stored, we need:
1. A VAPID keypair to sign push payloads (RFC 8292 — Voluntary
   Application Server Identification). Browsers reject
   unsigned push payloads.
2. A `Push.Sender` module to fan out a payload to all
   subscriptions for a user, handle delivery failures, delete
   dead endpoints.
3. Cic-side: SW push handler that decrypts the payload (workbox
   does this; we just receive the JSON) and calls
   `self.registration.showNotification(title, options)`.
4. Cic-side: notificationclick handler that `clients.openWindow`
   to the deep-link URL.

### Library choice

Two Elixir options:
- **`:web_push_encryption`** (kastenbutt/elixir-web-push-encryption) —
  minimal, focused, last released 2023; depends on `:jose` for ECDH.
- **`:elixir_web_push`** (a newer fork) — TBD which is healthier.

**Action item for B2 first commit**: eval both via
`mix hex.info`, pick the cleaner API + active maintenance, document
the call in commit body. Use Plan agent to brief — this is a
boundary decision worth the second opinion.

### VAPID generation

`lib/mix/tasks/grappa.gen_vapid.ex`:

```elixir
defmodule Mix.Tasks.Grappa.GenVapid do
  use Mix.Task

  @shortdoc "Generate a VAPID keypair for Web Push signing"

  def run(_) do
    {pub, priv} = WebPushEncryption.VapidKey.generate()  # API TBD post-lib-eval
    IO.puts("Add to your env:")
    IO.puts("VAPID_PUBLIC_KEY=#{pub}")
    IO.puts("VAPID_PRIVATE_KEY=#{priv}")
  end
end
```

Operator runs `scripts/mix.sh grappa.gen_vapid` once, copies into
`compose.override.yaml` env section. Bootstrap reads at boot via
`config/runtime.exs`:

```elixir
config :grappa, :vapid,
  public_key: System.fetch_env!("VAPID_PUBLIC_KEY"),
  private_key: System.fetch_env!("VAPID_PRIVATE_KEY"),
  subject: System.get_env("VAPID_SUBJECT", "mailto:admin@example.org")
```

`fetch_env!` so missing config crashes Bootstrap loudly rather
than silently dropping push delivery.

### Push.Sender

`lib/grappa/push/sender.ex`:

```elixir
@spec send_to_user(user_id :: binary(), payload :: map()) :: :ok
@spec send_to_subscription(Subscription.t(), payload :: map()) ::
  :ok | {:error, :gone | :rate_limited | term()}
```

- `send_to_user/2` — `Subscriptions.list_for_user/1`, fan out
  via `Task.async_stream` (concurrency 4, timeout 10s), result
  per-sub: `{:ok, sub}` → `touch_last_used`, `{:error, :gone}` →
  `delete_dead(endpoint)`, other errors → log + telemetry.
- Telemetry events (mirror `cic_bundle_changed` shape from CP31
  B6.9a HIGH-17):
  - `[:grappa, :push, :send, :start]` — measurements `%{count: n_subs}`
  - `[:grappa, :push, :send, :stop]` — measurements `%{success: x, gone: y, error: z, duration_ms: ms}`
  - `[:grappa, :push, :delete_dead]` — measurements `%{count: n}`

### Cic SW push handler

Extend `cicchetto/src/service-worker.ts` (created in B0):

```typescript
self.addEventListener("push", (event: PushEvent) => {
  if (!event.data) return;
  const payload = event.data.json() as { title: string; body: string; tag: string; url: string };
  event.waitUntil(
    (async () => {
      // Dedup: if a client window is already focused on the same URL, suppress
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const focused = clients.find((c) => c.focused && new URL(c.url).pathname === payload.url);
      if (focused) {
        focused.postMessage({ type: "push.suppressed", payload });
        return;
      }
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        icon: "/icon-192.png",
        data: { url: payload.url },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data as { url: string }).url;
  event.waitUntil(self.clients.openWindow(url));
});
```

`tag` ensures dedup at the OS level — multiple pushes to the same
channel collapse into one notification rather than stacking.
`url` is the cic deep-link (e.g.
`/?network=libera&channel=%23sbiffo`); main.tsx already parses
URL params on cold-load — no new routing needed.

### VAPID public key endpoint

Cic SW needs the public key to construct the PushSubscription. New
endpoint:

```elixir
# GET /api/push/vapid-public-key
# response: %{public_key: "BLah..."}
```

Cached in cic via `localStorage["cic.vapidPublicKey"]` on first
fetch. Refreshed if subscription registration fails with
`InvalidApplicationServerKey`.

### Files

- `mix.exs` — add `:web_push_encryption` (or sibling — TBD post-eval) to deps
- `mix.lock` — regenerated
- `lib/mix/tasks/grappa.gen_vapid.ex` — NEW
- `config/runtime.exs` — VAPID env-var read
- `lib/grappa/push/sender.ex` — NEW
- `lib/grappa_web/controllers/push_vapid_controller.ex` — NEW
- `lib/grappa_web/router.ex` — `GET /api/push/vapid-public-key`
- `cicchetto/src/service-worker.ts` — push + notificationclick handlers
- `cicchetto/src/lib/push.ts` — NEW: subscription registration helper for B3
- `compose.override.yaml.example` — document VAPID env vars
- `test/grappa/push/sender_test.exs` — Bypass-backed Sender tests
- `test/grappa_web/controllers/push_vapid_controller_test.exs`

### Tests

- Sender: success path → touch_last_used; 410 → delete_dead;
  network error → log + telemetry, no crash
- Sender: assert request shape via Bypass (TTL header,
  Content-Encoding: aes128gcm, VAPID Authorization JWT decodable
  with public key)
- SW push handler: vitest with mocked PushEvent → showNotification
  called with right args
- SW dedup: when matchAll returns a focused client matching url →
  showNotification NOT called, postMessage IS called

### Deploy

**COLD** — `mix.lock` change + new env vars Bootstrap reads at
boot. `scripts/deploy.sh` preflight detects `mix.lock` diff and
forces cold. Operator MUST run `scripts/mix.sh grappa.gen_vapid`
between merge and deploy, copy keys into `compose.override.yaml`.

### LANDED criteria

- `scripts/check.sh` exit 0 + tail in commit body
- Sender Bypass tests green (request shape verified)
- vitest SW handler tests green
- Code-reviewer agent on Sender + Bootstrap wiring before push
- Browser smoke: in dev container after VAPID set, manually POST
  to `/api/push/subscriptions` with a real subscription from
  Chrome DevTools, then trigger Sender from IEx →
  notification appears

## Bucket 3 — notification_prefs + cic settings UI

### Origin

Per-user preferences for what triggers a push. Storing in the
existing `user_settings` JSON typed accessor (lib/grappa/user_settings.ex
pattern) is lighter than a new schema — these prefs are pure
config, not relational.

vjt's spec (5 checkboxes + master toggle):

- [ ] Notify me on all channel messages
- [ ] Notify me on channel messages in: [comma-separated input]
- [x] Notify me on channel mentions (default ON)
- [x] Notify me on all private messages (default ON)
- [ ] Notify me on private messages from: [comma-separated input]

Plus a master "Enable notifications" toggle that triggers the
browser permission prompt + SW subscription dance + POST to
`/api/push/subscriptions`. Per-device list shown with delete
buttons (uses B1's GET/DELETE endpoints).

### Schema (typed accessor)

`lib/grappa/user_settings.ex` (extend existing):

```elixir
@type notification_prefs :: %{
  channel_messages_all: boolean(),
  channel_messages_only: [String.t()],
  channel_mentions: boolean(),
  private_messages_all: boolean(),
  private_messages_only: [String.t()],
}

@spec get_notification_prefs(User.t()) :: notification_prefs()
@spec put_notification_prefs(User.t(), notification_prefs()) :: {:ok, User.t()} | {:error, Changeset.t()}

def default_notification_prefs do
  %{
    channel_messages_all: false,
    channel_messages_only: [],
    channel_mentions: true,
    private_messages_all: true,
    private_messages_only: [],
  }
end
```

Validation in `put_notification_prefs/2`:
- At least one trigger must be enabled (else: `{:error, :no_triggers}`)
- Channel names normalized to lowercase + trimmed
- Nicks normalized to lowercase + trimmed (IRC nicks case-insensitive per RFC 2812)
- Whitelists ignored if `_all` is true (UI greys them out, server
  doesn't enforce — server uses them only as a fallback when `_all` is false)

### REST

Extend existing `/api/users/me/settings` endpoint (or whichever
shape exists — read it). PUT body merges `notification_prefs` key
into user_settings JSON.

### Cic settings UI

Extend `cicchetto/src/SettingsDrawer.tsx` (existing). New section:

```
[Notifications]
  [✓] Enable browser notifications  — toggles permission + sub
  ────────────────────────────────────
  [ ] All channel messages
  [ ] Only in: [#channel, #other  ]
  [✓] Channel mentions
  [✓] All private messages
  [ ] Only from: [nick1, nick2  ]
  ────────────────────────────────────
  Devices:
   • Firefox 124 on Linux  — last used 2026-05-13  [Remove]
   • Chrome 130 on macOS   — last used 2026-05-14  [Remove]
```

Master toggle behavior:
1. Click → check Notification.permission
2. If `default` → Notification.requestPermission() → if granted, proceed
3. If `granted` → SW.pushManager.subscribe({ userVisibleOnly: true,
   applicationServerKey: vapidPublicKey }) → POST to
   /api/push/subscriptions → setEnabled(true)
4. If `denied` → show error banner with browser-specific reset
   instructions
5. Toggle OFF → unsubscribe from pushManager + DELETE current
   subscription

Subscription helper lives in `cicchetto/src/lib/push.ts` (created
in B2). Per-device list reads `GET /api/push/subscriptions` on
mount; Remove button calls DELETE.

### Files

- `lib/grappa/user_settings.ex` — typed accessor + default + validation
- `lib/grappa_web/controllers/user_settings_controller.ex` — extend with notification_prefs handling
- `cicchetto/src/SettingsDrawer.tsx` — Notifications section
- `cicchetto/src/lib/push.ts` — subscription helpers (subscribe / unsubscribe / list)
- `cicchetto/src/lib/userSettings.ts` — extend wire types
- `test/grappa/user_settings_test.exs` — extend
- `test/grappa_web/controllers/user_settings_controller_test.exs` — extend

### Tests

- user_settings: get returns defaults if absent; put validates;
  whitelists normalized; no-triggers rejected
- Controller: PUT updates only notification_prefs, leaves other
  user_settings keys untouched
- vitest: SettingsDrawer renders devices from API; toggle dance;
  whitelists greyed when `_all` true
- Playwright (deferred to B5)

### Deploy

Hot-deploy + cic bundle deploy. No schema change.

### LANDED criteria

- `scripts/check.sh` exit 0 + tail
- vitest + bun check green
- `scripts/integration.sh` full regression sanity green
- Browser smoke: settings drawer toggles work; permission prompt
  appears; subscription created (verified via GET endpoint)

## Bucket 4 — trigger logic + mention regex port

### Origin

The hot path: when a message lands in `Session.Server`'s PRIVMSG
persistence (`Grappa.Scrollback.persist/N` or wherever the actual
write lands — read it), evaluate the destination user's
notification_prefs against the message and dispatch to
`Push.Sender.send_to_user/2` async if it matches.

Mention/highlight detection currently lives in cic
(`cicchetto/src/lib/mentions.ts`). Server can't call into JS;
need to port the word-boundary regex to Elixir. Reuse existing
highlight_patterns from user_settings (watchlist patterns shipped
in channel-client-polish CP12).

### Trigger evaluation

`lib/grappa/push/triggers.ex`:

```elixir
@spec should_notify?(message :: Scrollback.Message.t(), user :: User.t(), prefs :: map()) :: boolean()
```

Logic:
1. **DM** (`channel == own_nick`): respect `prefs.private_messages_all`
   OR `String.downcase(message.nick) in prefs.private_messages_only`
2. **Channel message**: respect `prefs.channel_messages_all`
   OR `String.downcase(channel) in prefs.channel_messages_only`
   OR (`prefs.channel_mentions` AND mentioned?(message.body, own_nick, highlight_patterns))
3. **Other kinds** (notice, action, server_event, etc.): no notify
   (only `:privmsg` and `:action` trigger; document why — server
   events shouldn't push)

### Mention regex port

`lib/grappa/mentions.ex`:

```elixir
@spec mentioned?(body :: String.t(), own_nick :: String.t(), patterns :: [String.t()]) :: boolean()
```

Word-boundary regex on own_nick (case-insensitive) + each
highlight pattern. Build the regex once per call (no compilation
cache yet — premature optimization; Triggers calls per-PRIVMSG so
hot-path matters but the regex is ~50 chars).

Port directly from cicchetto/src/lib/mentions.ts logic (read
first; the JS version is already battle-tested).

### Wiring

Find the PRIVMSG persistence call in `Session.Server` — likely
`Scrollback.persist_inbound_privmsg/N` or similar. Right after the
persist returns `{:ok, message}`:

```elixir
if message.kind in [:privmsg, :action] do
  Task.start(fn ->
    user = Accounts.get_user!(state.user_id)
    prefs = UserSettings.get_notification_prefs(user)
    if Triggers.should_notify?(message, user, prefs) do
      payload = build_push_payload(message, state.network_slug, user)
      Push.Sender.send_to_user(user.id, payload)
    end
  end)
end
```

`Task.start` (not `Task.async`) — fire-and-forget, no result needed
in the hot path. `Sender` already telemetry+logs failures.

**No `try/rescue`** — let any crash propagate to the spawned task,
which is unlinked from Session.Server. Crash = telemetry event
(crashes already get logged by SASL).

### Build payload

`lib/grappa/push/payload.ex`:

```elixir
@spec build(Scrollback.Message.t(), network_slug :: String.t(), User.t()) :: map()
def build(msg, network_slug, user) do
  is_dm = msg.channel == user.name
  title = if is_dm, do: msg.nick, else: "#{msg.nick} in #{msg.channel}"
  body = msg.body
  tag = "#{network_slug}:#{msg.channel || msg.nick}"
  url = build_deeplink(network_slug, msg.channel || msg.dm_with)
  %{title: title, body: body, tag: tag, url: url}
end
```

This is the documented push-payload exception to the wire-shape
rule — server picks user-facing strings because the OS surfaces
them before any cic JS runs.

### Files

- `lib/grappa/mentions.ex` — NEW (port from cicchetto/src/lib/mentions.ts)
- `lib/grappa/push/triggers.ex` — NEW
- `lib/grappa/push/payload.ex` — NEW
- `lib/grappa/session/server.ex` — wire trigger call after PRIVMSG persist
- `test/grappa/mentions_test.exs` — NEW (mirror cic mentions tests)
- `test/grappa/push/triggers_test.exs` — NEW
- `test/grappa/push/payload_test.exs` — NEW
- `test/grappa/session/server_test.exs` — extend with trigger-call assertion (Mox the Sender)

### Tests

- Mentions: word boundary, case insensitive, accent handling, multi-pattern
- Triggers: DM all-on, DM whitelist hit/miss, channel mention,
  channel whitelist hit/miss, mute when no trigger matches,
  non-PRIVMSG kinds skip
- Payload: DM title shape, channel title shape, tag dedup format,
  deep-link URL encoding (channel names with `#` need pct-encoding)
- Session.Server: Sender mocked, assert called with right payload
  on incoming PRIVMSG matching prefs; assert NOT called when
  no subs or no triggers match

### Deploy

Hot-deploy. Pure logic addition; no schema, no new env, no struct
field additions to Session.Server (just a Task.start in an
existing handler).

**Caveat**: if the trigger eval needs to be added INSIDE a
`Session.Server` `defstruct` field for caching (e.g. cached
prefs lookup), that's a long-lived state struct change → check
`lib/grappa/hot_reload/long_lived_modules.ex` and
`scripts/_extract_state_block.awk` AST oracle. Plan to avoid this
by reading prefs in the spawned Task (cold cache hit per push,
acceptable for the message rate).

### LANDED criteria

- `scripts/check.sh` exit 0 + tail
- All trigger + mention + payload tests green
- Code-reviewer agent on the trigger boundary touch + Session.Server wiring
- Browser smoke: in dev, mention own_nick from peer → push arrives
  in the OS notification centre

## Bucket 5 — Playwright e2e coverage

### Origin

Per `feedback_ux_e2e_mandatory`, every cic UX-touching change
ships with Playwright e2e via `scripts/integration.sh`. vitest
jsdom doesn't render layout, doesn't run service workers, doesn't
fire push events — push notifications are 100% browser-runtime
and need real Playwright coverage.

### Spec list

`cicchetto/e2e/tests/`:

1. **push-install-banner.spec.ts** — visit cic from web (not
   standalone); assert install splash visible; click "Continue
   from browser"; reload → splash gone (localStorage persists)
2. **push-permission-toggle.spec.ts** — settings page; mock
   `page.context().grantPermissions(['notifications'])`; click
   master toggle; assert POST to /api/push/subscriptions; assert
   "Devices: 1" in UI
3. **push-trigger-channel-mention.spec.ts** — peer mentions
   own_nick in #sbiffo; intercept SW push event via
   `page.evaluate` listening on navigator.serviceWorker; assert
   notification.title contains peer nick; assert
   notification.body contains mention text
4. **push-trigger-dm.spec.ts** — peer sends DM; same flow;
   assert notification.title is just the peer nick (no channel)
5. **push-dedup-focused-window.spec.ts** — focus #sbiffo; peer
   mentions; assert notification NOT shown via showNotification
   spy; assert clients.postMessage IS called
6. **push-prefs-whitelist.spec.ts** — set
   channel_messages_only=["#sbiffo"]; message in #other → no
   push; message in #sbiffo → push fires

### Push event mocking

Real Web Push e2e is hard — testing infrastructure can't actually
exchange VAPID-signed payloads with browser-vendor push services.
Two approaches:

- **Drive the SW directly via `page.evaluate`**: post a synthetic
  PushEvent into the SW's scope. Bypasses the network round-trip
  entirely; tests only the SW handler logic + downstream UI
  effects.
- **Mock the Push.Sender at server side via Mox**: Sender's
  `send_to_subscription` swapped for a stub that records calls;
  tests assert Sender called with right payload. Doesn't test the
  SW side, but covers the trigger logic.

Pick approach 1 for coverage of dedup + notification-rendering;
approach 2 covers trigger eval — use both, partition specs.

### Files

- `cicchetto/e2e/tests/push-*.spec.ts` (×6) — NEW
- `cicchetto/e2e/helpers/push.ts` — shared SW push-event injection helper

### Tests

These ARE the tests.

### Deploy

None.

### LANDED criteria

- All 6 specs green via `scripts/integration.sh --grep push`
- Full `scripts/integration.sh` regression sanity (no new flakes
  introduced)
- Per `feedback_recurring_e2e_not_flake`: same triplet failing N
  runs in a row = real regression, not flake. Run with
  `--repeat-each 5` locally before claiming LANDED.

## Bucket 6 — iOS PWA install + manual smoke

### Origin

iOS Safari Web Push only fires after the user adds the PWA to
home screen. No emulator + no Playwright reliably reproduces this
gate (Playwright iOS is webkit, not Safari; install-to-home-screen
is a Safari-specific UX). Real device test required.

### Steps for vjt to perform

1. Open Safari on iPhone (iOS 16.4+)
2. Visit `https://cic.<host>/` (whichever production hostname)
3. See install splash; tap **Install app**
4. Follow inline instruction: tap Share icon → Add to Home Screen
5. Confirm "Cicchetto" name + icon → tap Add
6. Open Cicchetto from home screen (NOT from Safari)
7. Settings → Notifications → toggle **Enable browser notifications**
8. iOS shows native permission prompt → Allow
9. From another device (or different IRC client), join a channel
   you're in and `/msg vjt: test push` (mention)
10. Lock the iPhone; wait ~2s; unlock — notification should be on
    lockscreen
11. Tap notification → cicchetto opens directly to that channel
12. Repeat with a DM from another nick
13. Repeat with cicchetto FOREGROUND on the channel — notification
    should NOT appear (dedup); only in-app badge / scroll update

### Failure modes to flag

- No prompt at step 8 → check Notification.permission state in
  Safari devtools (USB-debug from macOS Safari); reset via
  Settings → Safari → Clear Website Data
- No notification at step 10 → check Push.Sender telemetry
  (`scripts/monitor.sh | grep push.send`); 410 Gone means iOS
  invalidated the subscription (re-toggle); 200 means delivery
  succeeded but browser dropped — check Settings → Notifications →
  Cicchetto → Allow Notifications

### Deploy

None — manual test on the live deploy.

### LANDED criteria

- vjt confirms steps 1-13 pass on his iPhone
- Document any iOS-specific issues found in checkpoint + memory

## Cluster CLOSE checklist

After bucket 5 green + bucket 6 vjt-confirmed:

1. `cd /Users/mbarnaba/code/grappa/.worktrees/push-notifications && git fetch origin main && git rebase origin/main`
2. Re-run all gates after rebase: `scripts/check.sh` + `scripts/bun.sh run check` + `scripts/bun.sh run test` + `scripts/integration.sh`
3. Standalone Dialyzer per `feedback_dialyzer_plt_staleness`: `scripts/dialyzer.sh`
4. Brief vjt with cluster summary (commit sha, what shipped, any deviations from plan)
5. Merge: `cd /Users/mbarnaba/code/grappa && git checkout main && git merge --ff-only cluster/push-notifications`
6. **COLD deploy**: `scripts/deploy.sh` (auto-cold from B1+B2 forces) — operator MUST have VAPID env vars set BEFORE deploy
7. Healthcheck: `scripts/healthcheck.sh`
8. Browser smoke: full flow from B6 steps minus iOS install (already verified in B6)
9. Push origin/main per `feedback_push_autonomy`
10. Update `project_post_p4_1_arc` — mark this cluster CLOSED, point at next (image upload per `project_image_upload`)
11. Write CP32 at `docs/checkpoints/2026-05-XX-cp32.md`
12. DESIGN_NOTES entry — chronological log, the Path A→B decision + why
13. README update — PWA install flow + push notifications + settings UX
14. Story episode at `docs/project-story.md`
15. GitHub issue #6: comment with what shipped + close
16. Save memory: `project_push_notifications_closed`
17. Worktree cleanup: `git worktree remove .worktrees/push-notifications` (only after the post-close work finishes)

## Memories that ARE relevant

- `project_no_silent_drops_closed` — what just shipped + the typed-event arc
- `project_post_p4_1_arc` — current cluster arc; this is the FIRST gating-to-public-open cluster
- `project_image_upload` — NEXT cluster after this one
- `feedback_no_localized_strings_server_side` — wire-shape rule (with documented push-payload exception)
- `feedback_per_bucket_deploy` — browser smoke at bucket close
- `feedback_landed_claim_evidence` — check.sh exit-0 tail in commit
- `feedback_cluster_with_migration_must_cold` — B1 + B2 → manual --force-cold
- `feedback_dialyzer_plt_staleness` — standalone dialyzer at multi-session cluster close
- `feedback_check_sh_working_tree_trap` — `git diff --quiet HEAD` before every push
- `feedback_no_ci_retries_on_first_failure` — never `gh run rerun --failed`
- `feedback_recurring_e2e_not_flake` — same triplet N runs in a row = real regression
- `feedback_ux_e2e_mandatory` — every cic UX-touching change ships with Playwright e2e
- `feedback_subagent_driven_development` — Plan + code-reviewer parallel-agent pattern
- `feedback_readme_currency` — README updates in-step
- `feedback_orchestrator_proactive_clear` — clear at ~25% ctx
- `feedback_push_autonomy` — push autonomy granted; skip the "push?" turn

## Authoritative refs

- **GitHub issue #6** — `GH_CONFIG_DIR=./.gh gh issue view 6` (run from main repo)
- **Issue #6 path-change comment** — https://github.com/vjt/grappa-irc/issues/6#issuecomment-4449765503
- **`docs/DESIGN_NOTES.md`** — chronological decision log; append cluster-CLOSED entry at close
- **`CLAUDE.md`** — engineering standards
- **Reference patterns to mirror**:
  - WSPresence: `lib/grappa/ws_presence.ex` — pattern for per-user runtime state
  - User settings: `lib/grappa/user_settings.ex` — typed accessors over JSON blob
  - Telemetry events: `cic_bundle_changed` shape from CP31 B6.9a HIGH-17
  - REST endpoint pattern: `lib/grappa_web/controllers/`
  - Mention regex: `cicchetto/src/lib/mentions.ts` (port to Elixir)
