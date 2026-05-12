# Codebase Review Draft — Cicchetto (TS/SolidJS PWA)
**Agent:** cicchetto/
**Scope:** cicchetto/src/** + cicchetto/{tsconfig.json,vite.config.ts,vitest.config.ts,biome.json,package.json,index.html} + cicchetto/public/{icon*}
**Date:** 2026-05-12

## CRITICAL

_None._

## HIGH

### H1 — `displayNick(me)` regression in Shell.tsx + MembersPane.tsx — own-nick foot-gun re-introduced after H3 fix
**Files:** `/Users/mbarnaba/code/grappa/cicchetto/src/Shell.tsx:55-58`, `/Users/mbarnaba/code/grappa/cicchetto/src/MembersPane.tsx:73-76`

`api.ts:84-114` is explicit and emphatic: `displayNick(me)` returns the operator's account NAME (`me.name` for users), which can DIFFER from the per-network IRC nick. Codebase-review-2026-05-08 cic H3 closed this exact silent class of DM-misrouting bug; the moduledoc says **"WARNING — for 'what is my IRC nick on THIS network', use `ownNickForNetwork(net, me)` instead"**.

Two production callsites still use `displayNick(me)` in places that ARE per-network own-nick comparisons:

- `Shell.tsx:55` — `ownNick()` passed to `MentionsWindow` for highlight rendering. If the user's account name happens to match a peer's IRC nick on the network the mentions bundle is for, mentions get miscolored / miscounted.
- `MembersPane.tsx:73` — `ownModes()` derives the operator's per-channel modes by looking up `displayNick(me)` in the member list. On a network where the operator runs as a different IRC nick than their account name, this returns `[]` (member not found) and the right-click context menu silently disables all op-gated actions even when the operator IS oped — and worst case, returns the modes of a peer whose nick equals the operator's account name (e.g. peer "vjt" in #foo on a network where operator's IRC nick is "vjt-grappa").

**Fix:** replace both with `ownNickForNetwork(net, user())`. Pattern already exists in `ScrollbackPane.tsx:445-449` and `subscribe.ts:462`.

### H2 — CSP allowlists Turnstile only; hcaptcha mounts will fail silently
**Files:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/captcha.ts:1-7`, `/Users/mbarnaba/code/grappa/infra/snippets/security-headers.conf:48`

`captcha.ts` accepts `provider: "turnstile" | "hcaptcha"` and loads the corresponding script from `js.hcaptcha.com` for hcaptcha. Server supports hcaptcha (`config/runtime.exs:115`, `lib/grappa/admission/captcha/h_captcha.ex`). Nginx CSP `script-src` and `connect-src` and `frame-src` allowlist ONLY `https://challenges.cloudflare.com`. If the operator wires `CAPTCHA_PROVIDER=hcaptcha`:

1. cic gets `provider: "hcaptcha"` from the server's `captcha_required` admission error.
2. `mountCaptchaWidget` injects `<script src="https://js.hcaptcha.com/1/api.js">`.
3. Browser blocks per CSP; `script.onerror` fires.
4. `loadScript` rejects → `mountCaptchaWidget` rejects → `Login.handleCaptchaMountFailure` shows "Captcha unavailable. Disable ad-blocker or try again." misdirecting the operator to ad-blockers when the actual cause is server-side CSP misconfig.

**Fix:** either (a) extend CSP `script-src` / `connect-src` / `frame-src` to `*.hcaptcha.com` + `*.hcaptcha.net` when the operator selects hcaptcha (per-host override), or (b) drop hcaptcha from the cic provider union so the server contract narrows. Decide which is the source-of-truth.

### H3 — Case-sensitive nick comparisons throughout members + scrollback (RFC 2812 violation)
**Files:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/members.ts:57,62,69,76`, `/Users/mbarnaba/code/grappa/cicchetto/src/ScrollbackPane.tsx:461-462,562`

IRC nicks are case-insensitive per RFC 2812 §2.2 (and most modern IRCds use rfc1459 / ascii / strict-rfc1459 CASEMAPPING). The cic-side member list and scrollback use `===` for nick comparisons:

- `members.ts:57` — `current.some((m) => m.nick === msg.sender)` for JOIN dedup. A `JOIN :Alice` after a 353 NAMES reply containing `alice` adds Alice as a duplicate; both stay until QUIT.
- `members.ts:62` — `current.filter((m) => m.nick !== msg.sender)` for PART/QUIT. A `PART :Alice` after `JOIN :alice` leaves alice in the list — phantom member with no live presence.
- `members.ts:69,76` — same shape for KICK target + NICK rename.
- `ScrollbackPane.tsx:461` — `members.find((m) => m.nick === nick)` for ownModes lookup (compounds with H1).
- `ScrollbackPane.tsx:562` — `m.sender === nick` for self-JOIN banner detection. If upstream's NAMES reply lower-cased the operator's nick but the JOIN echo cased it differently, banner never fires.

`subscribe.ts:183,319,328,556` correctly use `.toLowerCase()` comparison — but the per-message presence handlers in `members.ts` don't, creating drift between "did this message route as own-action" and "is this nick in the member list".

**Fix:** centralize an `nickEq(a, b)` helper (probably `a.toLowerCase() === b.toLowerCase()` for the simple-case start; CASEMAPPING from ISUPPORT is a Phase-5 polish). Use everywhere a nick comparison happens. Also normalize the storage key — currently `members[].nick` round-trips upstream casing, so the WHO/353 path may seed `Alice` while MODE later emits `alice`. Pick one (lowercased) and stick to it.

### H4 — `Network.connection_state` typed as optional in cic; server contract is required for user subjects
**Files:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/api.ts:142-158`, `/Users/mbarnaba/code/grappa/lib/grappa/networks/wire.ex:74-83,189-201`

`Networks.Wire.network_with_nick_to_json/3` is the user-subject `GET /networks` shape and unconditionally populates `connection_state`, `connection_state_reason`, `connection_state_changed_at`. Server typespec `network_with_nick_json` declares them required. Cic's `Network` type marks all three optional — same single type covers user AND visitor subjects (visitors get the `network_to_json/1` shape that omits these fields).

Two consequences:

1. Every consumer (Sidebar.tsx isNetworkGreyed, ComposeBox.tsx greyed) writes defensive `state !== undefined` checks that compile away to no-ops at runtime for the user case but visually pollute the codebase + create the impression these branches matter.
2. The visitor case has the SAME type as user but with the fields actually missing — Sidebar correctly returns `false` from `isNetworkGreyed` when state is undefined, which is correct for visitors but accidentally so. A future refactor that removes the optional check breaks visitors silently.

**Fix:** split the type — `UserNetwork` (required state fields) | `VisitorNetwork` (omits them). Discriminate at the `me().kind` boundary. Mirrors the discriminated `MeResponse` already in api.ts.

## MEDIUM

### M1 — `cacheKey` in readCursor.ts uses raw string instead of `ChannelKey` brand
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/readCursor.ts:56`

`channelKey.ts` ships an opaque-branded `ChannelKey` type explicitly to prevent un-branded string indexing into per-channel maps. `readCursor.ts:56` defines its own private `cacheKey(slug, channel): string` returning a raw string with the same `${slug} ${name}` shape. The cache map is `Record<string, number>`, so a future caller passing a wrong-shape string (e.g. `${slug}:${channel}` from copy-paste) silently writes to a never-read key. The brand exists; use it.

**Fix:** import `channelKey` from `./channelKey` and key the map on `Record<ChannelKey, number>`. Drop the local `cacheKey`.

### M2 — `setSelectedChannel` in ScrollbackPane's banner effect violates "user-action focus only" rule
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/ScrollbackPane.tsx:572-585`

The shouldShowBanner effect calls `setSelectedChannel({...kind: "channel"})` when the banner appears. Comment claims "spec #7: /join-self switches focus automatically" and "the user issued /join". But the effect fires on ANY self-JOIN — including server-initiated re-joins (NickServ ghost recovery + autojoin replay, SAJOIN by an oper) where the user did NOT issue an action. The C4.2 cluster-wide rule per `feedback_target_window_ux_rule` is "focus only on user action".

`compose.ts:223` already auto-focuses on user-issued `/join` (the comment there even acknowledges this). The duplicate setSelectedChannel here will yank focus away from whatever the user was doing when an upstream re-JOIN lands.

**Fix:** drop the setSelectedChannel call here; rely on compose.ts to set focus for user-issued joins. The banner-shown latch is fine; the focus shift is the violation.

### M3 — `onCleanup` nested inside `createEffect` in UserContextMenu adds listener correctly only by accident
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/UserContextMenu.tsx:109-112`

```ts
createEffect(() => {
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));
});
```

Effect tracks zero signals → runs once on mount, never re-runs. `onCleanup` inside `createEffect` registers a cleanup tied to the effect's lifecycle which fires on next-effect-run OR owner dispose. Works once because there's never a "next run", but the pattern is fragile: any future edit that adds a tracked signal to the effect body re-runs the effect, removes the listener, then adds it again — no leak, but extra DOM churn. More importantly, the intent is "install once on mount, remove on unmount" — `onMount` + `onCleanup` at the component top-level expresses this directly and resists the next-edit foot-gun.

**Fix:** use `onMount(() => { document.addEventListener(...); }); onCleanup(() => document.removeEventListener(...))` at the component top level.

### M4 — `connection_state_reason` lookup in Sidebar leaks `null` to title attr
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/Sidebar.tsx:85-88,180`

`networkReason(slug)` returns `?? undefined`, but the underlying `connection_state_reason` is typed `string | null`; `?? undefined` only kicks in on null|undefined, so for non-null strings the function returns the string and JSX renders the title. Correct so far. But the H4 finding (network type optional) means the field could be missing entirely — `?.connection_state_reason ?? undefined` then returns undefined and JSX skips the title. Fine. However the `isNetworkGreyed` check uses `state !== undefined` — for a parked network with no operator-supplied reason (`reason = null`), the title attribute would be `undefined` (correct: no tooltip). For `reason = ""` (operator passed empty string), title becomes empty string and DOM renders `title=""` which screen readers may speak as "blank". Low impact, easy fix.

**Fix:** `networkReason` should return `undefined` for `null | "" | undefined` uniformly.

### M5 — `userTopic.ts` payload narrowing skips array element typecheck for `mentions_bundle.messages` and `whois_bundle.channels`
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/userTopic.ts:75-91, 146-148`

`narrowUserEvent` runtime-checks `Array.isArray(r.messages)` for `mentions_bundle` and `Array.isArray(r.channels)` for `whois_bundle` — but does not type-check the elements. The cast then declares them `MentionsBundleMessage[]` and `string[]` respectively. A server bug (or any malformed broadcast) sending `messages: [null, null]` lets `MentionsWindow.tsx` render `row.body` as undefined → crash; `WhoisCard.tsx` would render `For each={null|undefined}` items and likely throw on `chan` access.

**Fix:** validate each element shape (typeof checks) before returning the narrowed payload, mirroring the per-arm shape rigor for top-level fields.

### M6 — `compactModeString` on TopicBar emits `+` for empty modes (line 56-57 says it returns "" but the surrounding render emits when length > 0)
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/channelTopic.ts:54-57`

Function correctly returns `""` for empty array. But `TopicBar.tsx:97-102` calls `<Show when={modeStr().length > 0}>` AFTER calling `modeStr()` which calls `compactModeString(modesEntry.modes)`. If `modesEntry.modes` is `[]`, returns `""`, length 0, Show false → fine. But if `modesEntry.modes` is `[""]` (one empty mode entry — possible from a server bug or future edge case), returns `"+"` (length 1) which renders as a pure `+` chip with no tooltip body. Defensive: filter empties in `compactModeString` or assert non-empty entries up-front.

### M7 — `BottomBar.tsx` close-buttons documented as omitted on mobile but no per-tab close affordance ANYWHERE on mobile
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/BottomBar.tsx:21-24`

Decision documented: "X-close buttons are OMITTED from mobile bottom-bar tabs (decision: preserves thumb-tap area on small viewports; close behavior is desktop-only via Sidebar X)". But on mobile the Sidebar is NOT rendered (Shell.tsx mobile branch omits it). Net result: a mobile user has zero way to close a channel/query window. They can `/part` for channels but no `/close` for queries; `closeQueryWindowState` is unreachable. UX gap.

**Fix:** either add long-press to close in BottomBar tabs, or add a `/close` slash-command for queries (mirror `/part` for channels), or expose a per-tab small ✕ that's still thumb-friendly (24px square at the corner).

### M8 — Floating `--cic_socketHealth` / `--cic_bundleHash` window globals exposed in production builds
**Files:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/socketHealth.ts:148-155`, `/Users/mbarnaba/code/grappa/cicchetto/src/lib/bundleHash.ts:87-93`

Both files install hooks on `window.__cic_*` at module-init time, comment says "any hostile script that's already running same-origin could already do whatever it wants" — true for state mutators, but exposing them widens the attack surface for content-script extensions that fingerprint the page or auto-trigger refresh loops on a heavily-loaded operator's machine. Production build should drop these (vite `define` flag or `import.meta.env.DEV` guard). Not severe, but the bias should be "test-only is test-only".

**Fix:** wrap the `if (typeof window !== "undefined")` install block in `if (import.meta.env.MODE !== "production")` or add a Playwright-only `if (window.__playwright_e2e_marker)` gate.

### M9 — `auth.ts` reads localStorage at module init unconditionally; pattern works in browser but tests need `beforeEach` reset gymnastics (already documented)
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/auth.ts:29-31`

`createSignal(localStorage.getItem(STORAGE_KEY))` runs at module load. setupTests.ts works around with per-test stubGlobal. But `auth.test.ts` uses `vi.resetModules()` + re-import per case, which is the test-friction tax of the eager-init pattern. A lazy `getOrInitToken()` would let tests reset by clearing localStorage without resetModules. Low priority since the test infrastructure already handles it, but flagging as a future-facing simplification.

### M10 — `mode` schema in `Grappa.Scrollback.Wire` declares `meta: Meta.t()` but cic types as `Record<string, unknown>` — inconsistency permits typo at extraction sites
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/api.ts:208`

`ScrollbackMessage.meta: Record<string, unknown>` lets every consumer narrow ad-hoc: `typeof msg.meta.modes === "string"` (members.ts:80), `typeof msg.meta.target === "string"` (members.ts:67, ScrollbackPane.tsx:328). Server has a closed `Grappa.Scrollback.Meta` type with per-kind shape table. cic should mirror with a discriminated union per kind (the kind discriminator is already there; meta shape is determined by kind). A typo'd `msg.meta.targets` (vs `target`) silently routes to the `?` fallback at extraction sites and the kick member never gets removed.

**Fix:** add per-kind meta shape types, narrow at extraction. Same exhaustiveness discipline as `WireUserEvent`.

## LOW

### L1 — `index.html` favicon uses `.svg` for both modern + iOS apple-touch-icon; iOS may not honor SVG for home-screen
**File:** `/Users/mbarnaba/code/grappa/cicchetto/index.html:18`

`<link rel="apple-touch-icon" href="/icon.svg">` — iOS apple-touch-icon historically wants PNG (180×180 typical); SVG support is partial. The 192/512 PNG icons exist in public/. Use `/icon-192.png` (or a dedicated 180px PNG) for the apple-touch-icon for full compatibility.

### L2 — `parseMircFormat` in mircFormat.ts uses unbounded recursion via `for (const ch of body)` then `body.charCodeAt(i)` — works but mixes paradigms
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/mircFormat.ts:93-178`

Loop reads `body.charCodeAt(i)` while also reading `body[i]` for digit accumulation. Both are byte-indexed; this is fine for ASCII control chars but `body[i]` for a multi-byte UTF-8 character returns the surrogate pair half. Not a real bug because all `+`/`,`/digit checks are ASCII-only, but mixing `charCodeAt` (UTF-16 code unit) with `body[i]` (single character or surrogate half) is a bug magnet. Pure `charCodeAt(i)` everywhere or pure iterator — pick one.

### L3 — `slashCommands.ts` `q` alias write happens at module-init time outside any guard
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/slashCommands.ts:293-296`

```ts
const queryHandler = DISPATCH.query;
if (queryHandler) {
  (DISPATCH as Record<string, Handler>).q = queryHandler;
}
```

`DISPATCH.query` is GUARANTEED defined (it's a key in the const initializer above), so the `if` is dead-coded around a tsc narrowing concern. The cast `as Record<string, Handler>` defeats the `Readonly<Record>` brand. Cleaner: declare `q` directly in the DISPATCH initializer (`q: (verb, rest) => parseQuery(verb, rest)` extracted helper).

### L4 — `lazy` socket construction comment is inaccurate
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/socket.ts:14-16`

Comment says "the lazy path means we don't even try to open a WS without a bearer". But the createRoot at line 66 fires `getSocket()` immediately when the token signal becomes non-null on cold-start (RequireAuth doesn't gate the socket module load — main.tsx imports `notifyClientClosing` from `./socket` BEFORE the route guard runs). For a logged-in user this happens at boot, before any component renders. The `lazy` claim is true in the sense that visitors-not-logged-in don't hit it, but the framing is misleading.

### L5 — `windowKinds.ts` uses `noNonNullAssertion` ignore comments that could be eliminated with destructuring
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/windowKinds.ts:77-83`

Two `biome-ignore lint/style/noNonNullAssertion` comments because `byNetwork.get(networkId)!` can't be narrowed by tsc after the `byNetwork.has(...)` check. Standard destructure-with-default pattern (`const list = byNetwork.get(networkId) ?? [];`) eliminates both.

### L6 — `theme.ts` matchMedia listener has no removeEventListener — module-singleton lifetime so leak is bounded but pattern is wrong
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/lib/theme.ts:73-79,94-104`

Two matchMedia listeners attached at module load with no cleanup. Comment acknowledges "module-singleton lives for app lifetime; matchMedia listeners on window are cheap and there's no token-rotation analogue". Fine in practice, but if the module ever gets re-imported (HMR, vi.resetModules in test env that runs the module multiple times), a second listener attaches. The void createEffect that "forces the signal into the createRoot's tracking scope" is also hard to read — the comment says "keeps Solid's owner happy across HMR reloads" but the actual mechanism is that the createSignal MUST be tracked by SOMETHING in createRoot or it leaks. Cleaner: explicit `void mobile()` inside an effect with onCleanup that detaches the matchMedia listener.

### L7 — Test file size — `subscribe.test.ts` ≈ 2400+ lines, single file
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/__tests__/subscribe.test.ts`

(13295 total LOC across all `__tests__/`; subscribe.test.ts is by far the largest.) At this size the file is a maintainability liability — split per concern (channels-loop, query-windows-loop, dm-listener-loop, server-loop, identity rotation). No correctness issue.

### L8 — `package.json` deps pin major-zero versions with `^` (semver-unsafe per npm convention)
**File:** `/Users/mbarnaba/code/grappa/cicchetto/package.json:16-34`

`"@solidjs/router": "^0.16.1"` — a `^` on `0.x` resolves to `>=0.16.1 <0.17.0` per npm semver (not the `0.x` pinning some users assume). This is fine but worth noting that bun.lock is the actual pin source — package.json range is a hint. Also `@biomejs/biome: ^2.4.13` and others — keep an eye on these during renovate / dependency-update cycles.

### L9 — `Login.tsx` password input has no minimum-length validation client-side
**File:** `/Users/mbarnaba/code/grappa/cicchetto/src/Login.tsx:204-211`

Server enforces password rules via Argon2 + Comeonin; cic accepts any string and submits. Visitor login with no password works (intentional). For users, the form sends and surfaces "invalid_credentials". Not a bug — server-side validation is the source of truth — but client-side feedback could be friendlier (e.g. a hint when password field is empty for a non-visitor identifier).

## Summary
- **0 CRITICAL**, **4 HIGH**, **10 MEDIUM**, **9 LOW**
- **Top themes:**
  1. **Own-nick foot-gun re-emerging.** The H1 fix from 2026-05-08 (cic H3) closed the per-network IRC nick vs account name confusion in subscribe.ts + ScrollbackPane.ts but TWO callsites (Shell, MembersPane) still use the deprecated `displayNick(me)` path. The api.ts moduledoc explicitly warns against this — code drifted from documented invariant.
  2. **Case-sensitive nick comparisons.** Members store and scrollback compare nicks with `===` despite IRC nicks being case-insensitive per RFC 2812. subscribe.ts uses `.toLowerCase()` correctly; the per-message presence handlers don't. Drift creates phantom members + miscolored own-action detection. Centralize a `nickEq` helper.
  3. **Wire-shape narrowness gaps.** `Network.connection_state` is typed optional but ALWAYS present for user subjects (server contract). cic-side runtime narrowing of WS payloads (`narrowUserEvent`) skips array element typechecks for `mentions_bundle` + `whois_bundle`. Both leave silent runtime risk surfaces. Server CSP allowlists Turnstile only while cic supports both Turnstile and hcaptcha — config-vs-CSP drift.
