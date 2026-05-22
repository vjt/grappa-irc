# cicchetto scope — 18 findings (0 CRIT, 4 HIGH, 9 MED, 5 LOW)

Server-side wire counterparts read for parity:
`lib/grappa/scrollback/wire.ex`, `lib/grappa/networks/wire.ex`,
`lib/grappa/accounts/wire.ex`, `lib/grappa/query_windows/wire.ex`,
`lib/grappa/server_settings/wire.ex`, `lib/grappa/admin_events/wire.ex`,
`lib/grappa_web/controllers/me_json.ex`,
`lib/grappa_web/controllers/channels_json.ex`,
`lib/grappa_web/channels/grappa_channel.ex`,
`lib/grappa_web/channels/admin_channel.ex`.

---

### S1. `WireAdminEvent` missing `upload_reaped` + `uploads_swept` arms — server emits, cic crashes via `assertNever`
**File:** `cicchetto/src/lib/api.ts:756`, `cicchetto/src/lib/adminEvents.ts:76`, `cicchetto/src/AdminEventsTab.tsx:38`
**Category:** wire-shape drift (HIGH per checklist calibration)
**Severity:** HIGH
Server-side `Grappa.AdminEvents.Wire.event_kind/0`
(`lib/grappa/admin_events/wire.ex:47-60`) is a closed atom union with
13 kinds, including `:upload_reaped` and `:uploads_swept`.
`lib/grappa/uploads/reaper.ex:99` and `:173` actively emit both
verbs via `AdminEvents.record(AdminWire.upload_reaped(...))` and
`AdminEvents.record(AdminWire.uploads_swept(n))` on every TTL sweep.

Cic's `WireAdminEvent` discriminated union in `api.ts:756-846` enumerates
only 11 kinds — `upload_reaped` and `uploads_swept` are absent. The
runtime consequence is severe:

1. `lib/adminEvents.ts:76` `ingest()` falls through to `default: assertNever(ev)`.
2. `assertNever` (defined in `api.ts:860`) throws
   `unreachable discriminated-union variant: ...`.
3. The throw kills the `channel.on("event", ...)` handler inside
   `installAdminEvents`. The channel stays joined but the operator's
   admin events tab stops updating until a full reload.

Reproducer: any admin operator open on the Events tab when the
uploads reaper sweeps (60s tick by default, plus on operator-issued
`POST /admin/reaper/run` for visitors which currently swallows
upload sweep telemetry under the same code path).

The cic-side `assertNever` enforcement is correct discipline per
`feedback_no_silent_drops_closed`; the bug is the missed coupling.
**Fix:** add the two arms to `WireAdminEvent` in
`api.ts` (mirroring `upload_reaped_event` / `uploads_swept_event`
from `admin_events/wire.ex`), add the matching `case` arms in
`adminEvents.ts:76` `ingest()` switch, and add `renderEvent`
clauses in `AdminEventsTab.tsx`. Then add a vitest pinning the
13-arm parity against `event_kind` (or at minimum a string-array
assertion that the cic discriminator set is a superset of the
server's atom list).

---

### S2. Admin-channel payloads consumed without runtime narrowing — boundary-validation gap vs the rest of the codebase
**File:** `cicchetto/src/lib/adminEvents.ts:103,112`
**Category:** wire-shape boundary
**Severity:** HIGH
Both event handlers cast directly:

```ts
channel.on("snapshot", (payload: AdminSnapshotPayload) => { ... setEvents(cap(payload.events)); });
channel.on("event",    (payload: WireAdminEvent)       => { ... ingest(payload); });
```

`userTopic.ts` (`narrowUserEvent`) and `wireNarrow.ts`
(`narrowChannelEvent`) close exactly this gap for the user-topic +
per-channel WS surfaces: phoenix.js delivers payloads as
`unknown`-shaped JSON; trusting them as the discriminated union is a
*lie* (no runtime enforcement). A malformed payload (kind valid,
required field missing or wrong-typed) reaches the dispatch and either
crashes a setter or, here, hits `assertNever` and kills the channel
subscription (see S1).

The `wireNarrow.ts` moduledoc explicitly notes this pattern is the
precedent for "future per-topic narrowers (e.g. a `narrowAdminEvent`
if Phase 5 grows the /admin LiveDashboard's WS surface)."

**Fix:** introduce `narrowAdminEvent(raw: unknown): WireAdminEvent | null`
and `narrowAdminSnapshot(raw: unknown): AdminSnapshotPayload | null`
in `lib/wireNarrow.ts` (or a sibling `lib/adminEventsNarrow.ts`).
Have both `channel.on("event", ...)` and `channel.on("snapshot", ...)`
arms run through the narrower; drop + `console.warn` on null per the
existing convention in `subscribe.ts:307` and `userTopic.ts:509`.

---

### S3. SW navigation-route denylist missing `/api`, `/uploads`, `/admin` — direct navigation serves SPA shell
**File:** `cicchetto/src/service-worker.ts:54`
**Category:** PWA shell correctness
**Severity:** HIGH
```ts
denylist: [/^\/auth/, /^\/me/, /^\/networks/, /^\/socket/, /^\/push/],
```

Server-handled paths NOT listed:
- `/api/uploads` (POST, multipart) — embedded image upload
  (`image-upload.ts:282`). Same-origin, used live.
- `/uploads/:slug` (GET) — the served file. Any link or
  bookmark navigation to a `📸 https://<host>/uploads/<slug>.png`
  posted in IRC will, when opened in a new tab in the same browser
  profile that has cic installed as a PWA, match `request.mode ===
  "navigate"`, fall through the denylist, and serve the precached
  `index.html` — the user sees cic instead of the image.
- `/admin/*` — every admin REST endpoint
  (`/admin/visitors`, `/admin/sessions`, `/admin/networks`,
  `/admin/settings`, `/admin/reaper/run`, `/admin/circuit/:id/reset`).
  Direct navigation (operator bookmark, dev workflow) serves the SPA
  shell.
- `/api/server-settings`, any future `/api/*` route.

The pattern is "denylist mirrors `router.ex` REST scope prefixes" per
the moduledoc; the implementation has drifted as new scopes landed
(image upload `/api/*`, file serve `/uploads/*`, admin moved under
`/admin/*`).

**Fix:** broaden the denylist to `[^\\/(auth|me|networks|socket|push|api|admin|uploads)/]`
(or per-prefix as today). Add a comment in the moduledoc binding the
list to `lib/grappa_web/router.ex`'s top-level scope prefixes so
future scope additions track here. Consider an integration test that
parses the router scope prefixes at build time and asserts the SW
denylist is a superset.

---

### S4. `markerRef` SolidJS `let`-bound ref leaks across `<For>` re-renders
**File:** `cicchetto/src/ScrollbackPane.tsx:622,944-958,993`
**Category:** SolidJS reactivity (per `feedback_solidjs_for_ref_leak`)
**Severity:** HIGH
`markerRef` is a `let`-bound `HTMLDivElement | undefined` assigned
via `ref={markerRef}` on the unread-marker `<div>` inside `<For>`
(line 1189). Per the known SolidJS gotcha already documented in user
memory (`feedback_solidjs_for_ref_leak`): "let varName via JSX
ref={var} doesn't auto-null on unmount; manually reset in parent
lifecycle."

The component compensates for the **channel switch** case at line 993
(`markerRef = undefined` inside the `on(key, …, { defer: true })`
effect), but does NOT compensate for **mid-channel marker removal**.
When the operator scrolls past the unread-marker the cursor advances
(via selection.ts focus-leave) which mutates `getReadCursor`, the
`rows()` memo recomputes, the `unread-marker` row no longer enters
`result`, and `<For>` unmounts the marker `<div>` — but
`markerRef` is NOT cleared.

`scrollToActivation()` (line 944) then checks `if (markerRef)`, finds
the stale reference, calls `markerRef.scrollIntoView?.({block:
"center"})` on a detached DOM node — silent no-op in jsdom, in real
browsers may scroll the viewport unpredictably or simply do nothing
while `setMarkerScrolled(true)` latches, leaving the channel pinned
where the marker WAS until the next activation trigger that finds
no marker.

Reproducer: open a channel with an unread marker; scroll past so the
cursor advances; switch tab away then back (triggers
`scrollToActivation` via `isDocumentVisible` arm). The if-marker
branch fires against the detached node; the else (scroll-to-tail)
branch never runs.

**Fix:** clear `markerRef` whenever the `rows()` memo's output no
longer contains an `unread-marker` row. The cleanest shape is to
make `markerRef` a signal (`const [markerRef, setMarkerRef] =
createSignal<...>()`) and bind it via `ref={el => setMarkerRef(el)}`
on the `<div>`; SolidJS calls the ref function with `undefined` on
unmount when bound to a function ref, closing the leak naturally.
Then `scrollToActivation` reads `const m = markerRef(); if (m) m.scrollIntoView(...)`.

---

### S5. `userSettings.ts` and `push.ts` bypass `buildHeaders` — no `x-grappa-client-id` on those REST calls
**File:** `cicchetto/src/lib/userSettings.ts:40,55,98,113`; `cicchetto/src/lib/push.ts:39,95,123,140`
**Category:** wire shape / per-client capping
**Severity:** MEDIUM
The canonical `api.ts:18` `buildHeaders()` adds
`x-grappa-client-id: <getOrCreateClientId()>` and is used by every
controller helper except these two modules, which hand-roll headers
with only `authorization` (and `content-type` on PUT). The header is
consumed server-side by `Grappa.Admission` per-client cap counting and
by the admin events stream's `capacity_reject` payload's `client_id`
field.

Practical impact today is small (settings + push subscription
endpoints aren't admission-gated), but the divergence from the
single-source convention is exactly the drift the moduledoc warns
against ("Consistency: same problem, same solution"). A future
admission rule that gates a settings endpoint will mis-key these
calls.

**Fix:** export `buildHeaders` from `api.ts` (or move it to a shared
`lib/headers.ts`) and use it in `userSettings.ts` + `push.ts`. Remove
the inline header object literals.

---

### S6. `MeResponse.home_data` typed optional but server contract requires it for users
**File:** `cicchetto/src/lib/api.ts:142`
**Category:** wire-shape drift
**Severity:** MEDIUM
Server `lib/grappa_web/controllers/me_json.ex:50-58` declares
`home_data: NetworksWire.home_data()` REQUIRED (not optional) on the
user variant; the show clause unconditionally `Map.put(:home_data,
home_data)`. The cic type:

```ts
home_data?: HomeData;        // user arm
home_data?: null;            // visitor arm
```

The inline comment says "Optional on the type so test mocks predating
the field landing don't need touching — production /me always emits
it." But the same justification applied to `read_cursors?:` (line 137,
also optional) — both fields are documented as always-emitted but
typed as optional, weakening type-checker enforcement at every consumer.

`HomePane.tsx:147` reads `homeData()?.networks ?? []` which silently
returns `[]` when the field is missing for any reason — including a
server bug that genuinely fails to emit it.

**Fix:** flip both `read_cursors` and `home_data` to required on the
user arm (and `home_data: null` required on the visitor arm). Update
test mocks at the same time per the project's "total consistency or
nothing" rule. Drop the moduledoc's "optional for test mocks"
justification — the mocks should mirror production shape.

---

### S7. `RawNetwork.kind` typed optional with inference fallback — deferred-cleanup TODO never closed
**File:** `cicchetto/src/lib/api.ts:297,326`
**Category:** wire-shape evolution risk
**Severity:** MEDIUM
The comment at line 297 says "Once every deployed server emits `kind`
explicitly, the optional marker can flip to required and the inference
fallback can be removed." `lib/grappa/networks/wire.ex:46,76` always
emits `kind` on every shape today (`:visitor` and `:user`); there is
no version of the deployed server that omits it. The
`raw.kind ?? (raw.nick !== undefined && raw.nick !== "" ? "user" :
"visitor")` fallback is dead code shielding nothing.

Keeping it weakens the contract: any future "I'll just default
something" reflex has a foothold. And it papers over the case where a
server bug genuinely loses the `kind` field — instead of dropping the
row with a loud `console.error`, the inference silently picks a
discriminator.

**Fix:** flip `kind` to required, drop the `??` fallback in
`tagNetwork`, drop the trailing inference branch. Move the "drop the
row with console.error" path forward.

---

### S8. `Shell.tsx` calls `registerHandlers` + `install` at component body level instead of `onMount`
**File:** `cicchetto/src/Shell.tsx:247,335`
**Category:** SolidJS reactivity / convention
**Severity:** MEDIUM
`registerHandlers({...})` and `install()` execute during the Shell
component's render function body, not inside `onMount`. For SolidJS
components, body-level side effects run on every component
instantiation — fine in production (one Shell mount), but:

1. The handler closure captures the current Shell instance's
   signals (`flatChannels`, `selectedChannel`, etc.) but the
   closure is stored in a module-level `let handlers` in
   `keybindings.ts`. If Shell re-mounts (e.g. via a future Route
   change, hot-reload, or a wrapping `<Show>` whose `when`
   toggles), the old Shell's closure remains the registered
   handler briefly until the new Shell's body runs.
2. The associated `onCleanup(uninstall)` (line 336) nulls
   `handlers` AND removes the listener — so a re-mount that
   triggers cleanup-then-fresh-init has a window where keystrokes
   are dropped (handler null) before the new register fires.

`install()` is idempotent for the listener but not for the handler
registration; the order is body-render → onCleanup-old → body-render-new.

**Fix:** move `registerHandlers({...}); install();` into
`onMount(() => { registerHandlers(...); install(); })`. The lifecycle
contract is then "handlers + listener live for the SolidJS-managed
lifetime of this component", matching the surrounding `onCleanup`.

---

### S9. `Sidebar.tsx` archive-section delete handler relies on string concatenation key with space separator
**File:** `cicchetto/src/Sidebar.tsx:82-83,525`
**Category:** evolution risk
**Severity:** MEDIUM
```ts
const archiveKey = (slug: string, target: string) => `${slug} ${target}`;
```

The comment defends this: "Space separator is safe here because
network slugs and IRC targets cannot contain raw spaces." That's true
for the IRC contract today, but the same ad-hoc string
concatenation is already centralized in `lib/channelKey.ts` for the
identical `(slug, name)` shape with a `decodeChannelKey` paired
inverse. The Sidebar's local `archiveKey` re-introduces the drift
the CP24 audit (`cic M4`) explicitly closed: "the composite-key shape
lives in `channelKey.ts`; the decoder is the inverse of `channelKey
(slug, name)`."

Two key conventions in the codebase for the same conceptual primitive
("address a window by slug + name") is the drift class CLAUDE.md
warns against.

**Fix:** use `channelKey(slug, target)` for the armed-key tracking
too; it's the same shape with the same safety properties and the same
decoder when needed. Drop the local `archiveKey` helper.

---

### S10. `compose.ts` `tabComplete` returns `null` for empty matches but ignores `noUncheckedIndexedAccess`
**File:** `cicchetto/src/lib/compose.ts:660,667`
**Category:** TypeScript strictness
**Severity:** MEDIUM
`tsconfig.json` has `noUncheckedIndexedAccess: true`. Despite that,
`matches[idx]` is the natural shape and tsc is satisfied because the
modulo arithmetic guarantees `0 <= idx < matches.length` — but the
defensive `const chosen = matches[idx] ?? matches[0]; if (chosen ===
undefined) return null;` immediately after suggests the author wasn't
sure. The double-check is dead code (both `matches[idx]` and
`matches[0]` are `T | undefined` under the flag; if `matches.length >
0`, both are defined). Inconsistent posture: either trust the index
bound, or narrow once at the top.

The same pattern is sprinkled across the codebase (e.g.
`ScrollbackPane.tsx:999` `(msgs[msgs.length - 1]?.id ?? null)`); the
project has a `noUncheckedIndexedAccess` flag and either should rely
on its safety net (and write `msgs[msgs.length - 1]!` plus a
documented invariant) or honor it everywhere with narrowing-via-let.

**Fix:** Pick one convention. The cleaner shape is to narrow at the
boundary:

```ts
const head = matches[0];
if (head === undefined) return null;
const chosen = matches[idx] ?? head;
```

The current `matches[idx] ?? matches[0]; if (chosen === undefined)` is
the worst of both — twice the noise of the narrow, no clearer to the
reader.

---

### S11. `pushTarget.ts` `deferUntilNetworksSeed` creates a `createRoot` that's never disposed
**File:** `cicchetto/src/lib/pushTarget.ts:127`
**Category:** SolidJS lifecycle
**Severity:** MEDIUM
```ts
function deferUntilNetworksSeed(target: PushTarget): void {
  let applied = false;
  createRoot(() => {
    createEffect(on(networks, (nets) => { ... applied = true; ... }));
  });
}
```

The `createRoot` callback receives a `dispose` argument but the body
doesn't capture it. The moduledoc justifies this ("The root is
intentionally never disposed — the cold-path effect is module-
singleton and one-shot."). But it isn't actually one-shot — the
function can be called multiple times in a session (the moduledoc
notes it isn't, but the symbol is exported). Each call creates
another root whose effect runs once and then leaks (closed-over
`applied=true` guards the body but the reactive subscription on
`networks` lives forever).

For the documented single-call site this isn't observable. For a
defensive posture matching the rest of the codebase (every other
`createRoot` in lib/* uses module-singleton scope or test-cleaning),
this should self-dispose after the effect runs once.

**Fix:** capture and call `dispose` after the first apply:

```ts
createRoot((dispose) => {
  createEffect(on(networks, (nets) => {
    if (applied) return;
    if (!nets || nets.length === 0) return;
    applied = true;
    setSelectedChannel(...);
    if (typeof window !== "undefined") {
      window.__cicPushTargetApplied = true;
      window.history?.replaceState?.({}, "", "/");
    }
    dispose();
  }));
});
```

---

### S12. `push.ts:306` returns `endpoint !== ""` — always true
**File:** `cicchetto/src/lib/push.ts:306`
**Category:** dead-code / logic
**Severity:** LOW
```ts
const endpoint = subscription.endpoint;
await subscription.unsubscribe();
...
forgetSubscription();
return endpoint !== "";
```

`PushSubscription.endpoint` is non-empty by W3C spec. The return value
is effectively `true` always in this branch. Callers (`SettingsDrawer`)
treat `false` as "no subscription was present" — which is correctly
returned earlier in the `subscription === null` branch — so the
`return endpoint !== ""` collapse to `return true` is fine, but the
expression's intent ("did we have something to remove?") is encoded
twice and ambiguously. A future reader could conclude "if endpoint is
empty I'm returning false on purpose."

**Fix:** `return true;` with a comment "subscription existed and was
removed; the `subscription === null` early-return above handles the
no-op case."

---

### S13. `index.html` viewport meta uses `user-scalable=no, maximum-scale=1` — a11y baseline
**File:** `cicchetto/index.html:7`
**Category:** a11y
**Severity:** MEDIUM
`<meta name="viewport" content="... maximum-scale=1, user-scalable=no
...">`. WCAG 2.2 SC 1.4.4 (Resize Text, Level AA) requires text up
to 200% without loss of content or functionality. Disabling user
zoom on mobile blocks users with low vision from pinch-zooming the
PWA. iOS Safari 10+ ignores this directive by default (forced
respect for user accessibility); Android Chrome respects it.

Cic targets a PWA install on both iOS and Android per the project
spec. The intent is presumably to prevent input-focus auto-zoom on
iOS, but the canonical workaround for that is `font-size: 16px` on
form inputs (which cic already has via CSS), not viewport
suppression.

**Fix:** drop `maximum-scale=1, user-scalable=no` from the viewport
meta. Verify iOS input-focus auto-zoom doesn't return via the
input-font-size path.

---

### S14. `linkify.ts` `\S+` regex can match very long non-URL strings (e.g. base64 in IRC body)
**File:** `cicchetto/src/lib/linkify.ts:50`
**Category:** parser robustness
**Severity:** LOW
The URL regex `(?:https?:\/\/|ftp:\/\/|www\.)\S+` matches `\S+`
unbounded after the scheme. A pasted shell command like `curl
https://example.com/api 2>&1 | tee output.log` (URL split by space)
works fine, but `http://example.com/api?token=ZmFrZXRva2VuLi4u...`
where the query string is hundreds of bytes long allocates a
correspondingly large match string per scan. Not catastrophic — IRC
PRIVMSG lengths are capped at ~512 bytes on the wire — but in a
post-CHATHISTORY world or a server-side relayed paste from another
medium this could pathologically slow `<For each={rows()}>` rendering.

Lower priority because: (1) IRC message length caps bound the input;
(2) the `XSS via linkified URL → click → href` path is already
mitigated by `target="_blank" rel="noopener noreferrer"` (line 221 in
ScrollbackPane).

**Fix:** bound the URL body — `(?:https?:\/\/|ftp:\/\/|www\.)\S{1,2048}`
— and add a property test that strings longer than the cap produce a
single-segment text result instead of a URL match. The cap aligns with
real-world URL limits and prevents future O(n²) shapes.

---

### S15. `image-upload.ts` reads localStorage `"grappa-token"` directly instead of via `token()` signal
**File:** `cicchetto/src/lib/image-upload.ts:354-357`
**Category:** convention violation
**Severity:** LOW
```ts
let _tokenReader: () => string | null = () => {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem("grappa-token");
};
```

The moduledoc justifies this ("Token reader extracted so tests can
inject without hauling in the whole `auth.ts` module graph"), but the
constant `"grappa-token"` is duplicated from `auth.ts:26`'s
`STORAGE_KEY` — a magic string-pair that drift if either side renames.
And the cic-side identity model is `token()` signal as the single
source; reading localStorage directly bypasses any future identity
indirection (e.g. session-cookie auth, in-memory ephemeral bearer).

**Fix:** export `STORAGE_KEY` from `auth.ts` (or `token()` itself as
the production reader) and inject via `__setImageUploadTokenReader` at
boot. The test seam already supports injection; production should use
the same path with a real reader function.

---

### S16. `narrowPushPayload` accepts `tag` from an unbounded string — push tag collisions are not validated
**File:** `cicchetto/src/lib/pushPayload.ts:42`
**Category:** wire shape robustness
**Severity:** LOW
The narrower accepts any non-empty `tag` string from a server push.
Browsers use the `tag` to dedup OS notifications (a second push with
the same tag replaces the first); a server bug or hostile sender that
spoofs another channel's tag could merge notifications across windows.
The server's `Grappa.Push.Payload.build_tag/2` is the single
generator, but the narrower has no contract assertion that the
incoming tag matches the server's emit shape.

This is informational — the W3C Push spec has the same tag-trust
property, and the SW only `showNotification` from server-emitted
payloads.

**Fix:** consider a server-tag prefix check (e.g. require
`tag.startsWith("grappa:")`) so an unrelated push provider sharing the
SW registration couldn't dedup against our notifications. Low priority
because cic registers one SW per origin and there's no realistic
collision today.

---

### S17. `subscribe.ts` per-channel handler `joined`/`join_failed`/`kicked` arms duplicated between `narrowChannelEvent` and `narrowUserEvent`
**File:** `cicchetto/src/lib/wireNarrow.ts:185-222`, `cicchetto/src/lib/userTopic.ts:376-419`
**Category:** wire shape duplication
**Severity:** LOW
F1's dual-broadcast (`Session.Server.broadcast_window_state_dual/3`)
duplicates the three terminal arms across two narrowers — both
narrowers have a copy of the `joined`/`join_failed`/`kicked` shape
check. The shape is identical (network/channel/state +
metadata fields), but maintained twice. A future field addition to
e.g. `kicked` (server emits `kick_kind: :voluntary | :forced`) lands
at one site, drifts at the other.

**Fix:** factor the per-arm shape narrowers into a shared module
(`lib/wireNarrow.ts` exports `narrowJoinedArm`, `narrowJoinFailedArm`,
`narrowKickedArm`) called from both `narrowChannelEvent` and
`narrowUserEvent`. The dispatcher arms in `subscribe.ts` /
`userTopic.ts` still differ (they route to the same setter from
different topics), but the shape contract lives once.

---

### S18. `bunfig.toml`/`bun.lock` exclusive — `npm`/`yarn` users can't install
**File:** `cicchetto/bunfig.toml`, `cicchetto/bun.lock`, `cicchetto/package.json` scripts
**Category:** developer ergonomics
**Severity:** LOW
The cic tree uses bun exclusively per the moduledoc convention
(`bun.lock` is the lockfile, scripts dispatch to bun-resolved
binaries). The `docker compose` infra wraps this for the dev path;
human contributors without bun installed locally cannot
`npm install && npm test` even for a quick check before opening the
container.

Not a bug — explicit project decision per `CLAUDE.md`. Flagging only
because a contributor reading the codebase for the first time might
not realize and waste time on `npm i` failures (no `engines` field in
`package.json` pins the runtime).

**Fix:** add `"engines": { "bun": ">=1.x" }` to `package.json` so
`npm install` fails fast with a useful message. Or add a `preinstall`
check.
