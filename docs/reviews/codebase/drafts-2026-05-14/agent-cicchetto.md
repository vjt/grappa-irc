# Codebase Review Draft — Cicchetto (TS/SolidJS PWA)

**Agent:** cicchetto/
**Scope:** cicchetto/src/** + cicchetto/{tsconfig.json,vite.config.ts,vitest.config.ts,biome.json,package.json,index.html} + cicchetto/public/{icon*} + cicchetto/e2e/**
**Date:** 2026-05-14
**Cluster context:** B5 codebase review of the no-silent-drops cluster (B0 /invite, B1 EventRouter fallthrough, B2 INVITE [Join] CTA, B3 Bahamut audit, B4 linkify). Trajectory: push notifications → image upload → voice → mobile UI polish → PUBLIC OPEN.

## Summary

| Severity | Count |
|----------|-------|
| CRIT     | 0     |
| HIGH     | 4     |
| MED      | 8     |
| LOW      | 6     |
| NIT      | 2     |

**Carry-overs from 2026-05-12 review (still open / partially open):** H2 (CSP/hcaptcha drift) — not in scope of this review's grep. H1/H3 (own-nick foot-gun + case-sensitive nick eq) — appear FIXED via `nickEquals` adoption + `ownNickForNetwork` migration in `Shell.tsx`/`MembersPane.tsx`/`ScrollbackPane.tsx`. H4 (UserNetwork/VisitorNetwork split) — FIXED via `tagNetwork` boundary. M2 (banner setSelectedChannel violates user-action focus rule) — STILL OPEN. M5 (mentions_bundle / whois_bundle array element check) — STILL OPEN.

**Top themes from THIS review:**

1. **Undefined CSS variable `--fg-muted` rendered as inheritance-fallback in 14 places** — every new P-0 cluster card (LusersCard, WhowasCard, WhoisCard close, PeerAwayBanner, invite-ack rows) references a token that does NOT exist in `themes/default.css`; only `--muted` is defined. This is a SILENT visual regression that vitest jsdom cannot catch — the muted labels render at full body color. New since 2026-05-12.
2. **No-silent-drops UX-behavior commits (B0/B2/B4) shipped without Playwright e2e** — cluster-wide rule violation per `feedback_ux_e2e_mandatory`. INVITE CTA has zero browser test, linkify has zero browser test, /invite skip-requireChannel has zero browser test. The cluster's whole point is "stop dropping silently"; shipping new UX surfaces with no e2e coverage repeats the same class of risk one layer up.
3. **Optimistic state mutation in `queryWindows.openQueryWindowState`** — cic writes the row to its local store BEFORE the server `query_windows_list` broadcast resolves it. This is the only remaining "cic originates state" violation (CP17 closed `setPending` here, but `openQueryWindowState` still has it). Server-replay is correct in steady state; the failure mode is "operator opens DM during a WS gap → ghost row that vanishes when the broadcast finally lands NOT containing this entry" (e.g. the server failed to persist for any reason).
4. **Module-level event listeners + module-level globals make test isolation fragile and survive identity rotation** — `bundleHash.ts`, `socketHealth.ts`, `theme.ts`, `documentVisibility.ts` all wire `window`/`matchMedia` listeners at module load; `socket.ts` exposes `__cic_dropSocketForTests` and `__cic_socketHealth` in production builds. Same theme as 2026-05-12 M8.

---

## HIGH

### [HIGH] Undefined CSS variable `--fg-muted` — 14 references, all NEW P-0 cluster surfaces

**File(s):**
- `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/themes/default.css:1333,1356` (WhoisCard close + dt)
- `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/themes/default.css:1382,1386` (PeerAwayBanner border + text)
- `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/themes/default.css:1408,1430` (peer-away-close + invite-ack-row)
- `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/themes/default.css:1475,1494,1504` (LusersCard close + dt + muted)
- `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/themes/default.css:1516,1526,1546,1570,1580` (WhowasCard border + text + nested + dt)

**Description:** The variable `--fg-muted` is referenced in 14 places across the new P-0a/b/c/d/e/f cards and the no-silent-drops invite-ack row CSS, but the only defined token in BOTH theme blocks (`:root[data-theme="irssi-dark"]` and `:root[data-theme="mirc-light"]`) is `--muted` (lines 45, 58). The existing 30+ usages in the codebase use `var(--muted)` correctly (line 86, 118, 318, …). When `var(--fg-muted)` resolves to nothing, browsers fall back to inherited color, which for `.lusers-card-fields dt`, `.whois-card-close`, `.peer-away-banner` etc. inherits the surrounding `--fg` (full body color). Result: "muted" labels render at full intensity, the `border-left: 3px solid var(--fg-muted)` accent bar on PeerAwayBanner renders as `currentColor` (will be a transparent or `--fg`-shaded line — not the intended dim accent). Card "muted" UX is silently broken.

This is a SILENT regression class — vitest jsdom does not run a CSS parser; only real browsers expose it. Per `feedback_cicchetto_browser_smoke`, cicchetto-touching cluster buckets MUST run real browser smoke at close — this slipped because the P-0 cluster's e2e specs (`p0a-…`, `p0b-…`, `p0d-…`) test data wiring, not visual rendering of muted text.

**Recommended fix:** Either (a) add `--fg-muted: <value>` to both theme blocks (with sane defaults — `#5f5f5f` for irssi-dark, `#8a8a8a` for mirc-light, semantically "between --muted and --fg"), or (b) replace all 14 `var(--fg-muted)` references with `var(--muted)` for total consistency. Option (b) is simpler and lines up with `feedback_total_consistency_or_nothing` — there's no design reason to introduce a NEW muted shade for these cards when the existing `--muted` token already had design buy-in.

### [HIGH] No Playwright e2e for B0 (/invite skip-requireChannel), B2 (INVITE [Join] CTA), or B4 (linkify) — UX-behavior cluster commits shipped without browser smoke

**File(s):**
- `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/e2e/tests/` — no new spec files for B0/B2/B4.
- `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/compose.ts:432-453` (B0 /invite skip-requireChannel)
- `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/ScrollbackPane.tsx:318-351` (B2 INVITE [Join] CTA — the `<button class="scrollback-invite-join">`)
- `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/ScrollbackPane.tsx:204-225` (B4 linkify — `<a class="scrollback-link" href={seg.href}>`)

**Description:** The 2026-05-13 cluster shipped three new UX surfaces in cicchetto:

1. B0 — `/invite foo #it-opers` from `$server` no longer errors, posts INVITE to upstream. New code path with no e2e coverage; the only test is a vitest unit on `compose.ts` (per the grep, only `compose.test.ts` mentions `invite`).
2. B2 — Inbound `INVITE` rows render a `[Join]` button that calls `postJoin` + auto-focus. Brand new clickable affordance in scrollback. Per `feedback_css_block_button_wraps_inline_prefix`, button rendering inside scrollback rows is exactly the class of bug vitest jsdom misses (it only validates DOM structure, not CSS layout — and the `.scrollback-invite-join` rule sets `display: inline; padding: 0 0.25em` which COULD interact with `.scrollback-line` / `.scrollback-body` flex/inline rules in unexpected ways at small viewports).
3. B4 — Every URL in scrollback becomes an `<a>` with `target="_blank"` and `rel="noopener noreferrer"`. Affects EVERY scrollback row that contains a URL. Zero e2e coverage; if the regex misclassifies (e.g. matches part of an IPv6 address, fails on email-shaped strings, eats `?` and `#` in URL fragments), the operator sees broken links and there's no test that would catch it post-deploy.

`feedback_ux_e2e_mandatory`: every cicchetto UX-behavior change MUST ship with a Playwright e2e via `scripts/integration.sh`. `feedback_recurring_e2e_not_flake` and `feedback_landed_claim_evidence` reinforce this — without a real-browser test, "LANDED" is a claim, not evidence.

**Recommended fix:** Add three Playwright specs under `cicchetto/e2e/tests/`:
- `b0-invite-from-server-window.spec.ts` — operator on $server window, types `/invite foo #it-opers`, asserts the upstream INVITE was relayed (existing P-0e invite-ack pipeline is the observable signal — `[data-testid="invite-ack-row"]` lands).
- `b2-inbound-invite-cta.spec.ts` — testnet peer issues `INVITE grappa #sbiffo`, cic shows the `[Join]` button in scrollback, click → channel mounts + auto-focused.
- `b4-linkify.spec.ts` — peer says "see https://example.com.", scrollback row contains `<a href="https://example.com" target="_blank">`, trailing `.` stays as text, parens-balanced URLs preserve trailing `)`.

### [HIGH] `openQueryWindowState` mutates client state optimistically before server broadcast resolves it — last remaining "cic originates state" violation

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/queryWindows.ts:69-84`

**Description:** CP17 closed the `setPending` optimistic mutation in `compose.ts` by routing pending state through the server's `Topic.user/1` `window_pending` event. `openQueryWindowState` is the same anti-pattern that survived: it writes the new query window into `queryWindowsByNetwork` BEFORE pushing `open_query_window` to the server, then the server's `query_windows_list` broadcast lands and replaces the entire map.

In steady state this works because the broadcast IS authoritative and replaces the optimistic write. The failure modes are:
1. **WS-disconnected at open time**: cic shows a query window in its sidebar, the push to server is silently dropped (per `pushOpenQueryWindow` no-op when `_userChannel === null`), the server NEVER persists the row, the broadcast NEVER lands. Operator sees a phantom DM window that survives until reconnect (when `query_windows_list` lands sans this entry → optimistic write gets replaced with server truth → row vanishes).
2. **Server-side persist fails** (sqlite contention, validation): same shape — operator sees row, then it vanishes silently with no error feedback.
3. **CLAUDE.md hard-invariant violation**: "cic NEVER originates state — no optimistic STATE assumptions, no parallel client-side state machine". `queryWindows` is exactly window state.

This is the SAME class as the no-silent-drops cluster's whole point — a state mutation that could vanish without operator-visible signal.

**Recommended fix:** Mirror the CP17 pattern: route the open through a server-emitted `query_window_opened` event that triggers `setQueryWindowsByNetwork`. cic-side `openQueryWindowState` becomes pure server-push: call `pushOpenQueryWindow(networkId, targetNick)` and let the broadcast resolve the state. The window would not appear in the sidebar until the server confirms — which is the correct UX (no phantom rows). For the `/msg` path that needs immediate focus-shift before the server confirms, the focus shift already happens at `compose.ts:267` separately from the queryWindows write — no behavioral regression.

### [HIGH] `userTopic.ts` `narrowUserEvent` skips array-element typecheck for `mentions_bundle.messages` (still open from 2026-05-12 cic M5)

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/userTopic.ts:79-95`

**Description:** Carry-over from 2026-05-12 M5; promoting to HIGH because the cluster theme is "no silent drops" and this is exactly such a class. `narrowUserEvent` validates `Array.isArray(r.messages)` for `mentions_bundle` and asserts the cast to `MentionsBundleMessage[]`, but does NOT typecheck individual elements. A malformed broadcast with `messages: [null, {}]` lands as a typed `WireUserEvent`, the dispatcher writes the bundle into `mentionsBundleBySlug`, and `MentionsWindow.tsx` would then crash on `row.body` access (undefined / null deref). Same shape applies to `whois_bundle.channels` (line 156: `(r.channels !== null && !Array.isArray(r.channels))` — no per-element check) and `whowas_bundle` (per-field nullable, but the array-element class doesn't apply there since there's no array field).

The narrowness GAP makes the runtime narrowing a half-measure. The pattern is well-established elsewhere in the file (`narrowMembers` in `wireNarrow.ts` per-element validates) — same discipline, two surfaces.

**Recommended fix:** Add a `narrowMentionsBundleMessage(raw): MentionsBundleMessage | null` per-element validator, mirror it for `whois_bundle.channels` (each element typeof string), and call it inside the array iteration. If any element fails, return null from `narrowUserEvent` so the dispatcher logs and drops.

---

## MEDIUM

### [MED] `socket.ts` `__cic_dropSocketForTests` exposed in production builds — same as 2026-05-12 M8

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/socket.ts:416-431`

**Description:** Test-only WS-disrupt hook is installed unconditionally on `window` at module load. `socketHealth.ts:149-156` and `bundleHash.ts:87-93` have the same pattern. Comment in socketHealth.ts acknowledges "any hostile script that's already running same-origin could already do whatever it wants" — true for state mutators, but `__cic_dropSocketForTests` is an attacker primitive: any same-origin script can call it to force WS reconnect loops, drain the user's bandwidth, or trigger denial-of-service against the server's NetworkCircuit (per memory `project_network_circuit_ets_leak`, the circuit doesn't tolerate well burst reconnects).

**Recommended fix:** Wrap all three install blocks in `if (import.meta.env.MODE !== "production")` or guard on `import.meta.env.PROD` (vite injects this at build time). Test environments fall through; production strips them. Vitest test setup can preserve them via a vitest config option.

### [MED] `bundleHash.readBootBundleHash` runs at module init — does not re-run after Vite hot-reload re-injects bundle script

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/bundleHash.ts:32-42`

**Description:** `bootBundleHash` is captured once at module load by reading `<script src="/assets/index-...js">` from the DOM. In dev (vite HMR) the script tag never has the `index-<hash>.js` shape (it's `/src/main.tsx`), so `readBootBundleHash()` returns `null`. The `shouldShowRefreshBanner` predicate then returns `false` regardless of server hash because `boot !== null` is the gate. This means the BundleRefreshBanner is INERT in dev, which mostly works as intended — but a developer testing the banner has to navigate from a vite-built bundle to verify, and the test suite's coverage is only the unit-level `bundleHash.test.ts` + the `bundle-refresh-banner.spec.ts` e2e (which DOES use a built bundle, so OK).

The deeper concern: `readBootBundleHash` only reads ONE matching script tag; if vite ever splits chunks (e.g. dynamic import for a future code-split route), there could be MULTIPLE `/assets/index-` script tags and the loop returns the first one's hash, which may or may not be the "primary" entry. Brittle to future bundle structure changes.

**Recommended fix:** (a) Hoist the regex to require a more-specific shape (e.g. match the entry chunk via a marker the build embeds); or (b) document clearly that `bundleHash` assumes single-entry bundle topology and add a vitest test that asserts only one `index-` script tag exists in `index.html` (build-time invariant).

### [MED] `ScrollbackPane.tsx` — `markerRef` set to `undefined` then read in queueMicrotask; Solid's ref binding does NOT re-set the variable on next render

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/ScrollbackPane.tsx:564,821-841,1089`

**Description:** The known SolidJS `let varName` ref leak (per `feedback_solidjs_for_ref_leak`) is partially mitigated here — at key change `markerRef = undefined` is set synchronously, then the `queueMicrotask` callback reads `markerRef`. In Solid, `<div ref={markerRef}>` on a `<For>`-rendered element runs the binding ONCE per element creation. If the new window's rows render WITHOUT an unread marker (the `<Show when={row.type === "unread-marker"}>` arm is absent), `markerRef` stays `undefined` and the queueMicrotask falls through to `scrollTop = scrollHeight` — correct behavior. If the new window DOES have a marker, the `<For>`'s element commit happens BEFORE queueMicrotask (Solid commits during the createEffect's tick) so `markerRef` is reassigned by the JSX ref binding — also correct.

The fragile bit: the comment at line 808-814 says "(2) defer the scroll decision via queueMicrotask so Solid commits the new window's rows first — at that point markerRef is reassigned by `<div ref={markerRef}>`". This is true for `<For>` in solid-js, but only because `For` is non-keyed by default and recreates DOM nodes — if a future refactor uses `<For each={...} keyed>` or memoizes rows, the binding might NOT re-run and `markerRef` stays at the cleared `undefined`. The mechanism is implicit; the code shape doesn't telegraph it.

A more robust shape: use Solid's `ref` setter form (`<div ref={el => markerRef = el}>`) so the binding is explicit, and on every <For> tick the function runs.

**Recommended fix:** Switch the marker `<div ref={markerRef}>` to the setter form: `<div ref={(el) => { markerRef = el; }}>`. This is unambiguous re-binding semantics, robust across `<For>` modes, and matches the same shape used elsewhere when ref needs to refresh.

### [MED] `ScrollbackPane.tsx` self-JOIN banner effect re-fires `setSelectedChannel` on server-initiated rejoins — STILL OPEN from 2026-05-12 M2

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/ScrollbackPane.tsx:757-770`

**Description:** Verbatim carry-over from 2026-05-12 M2 — the `shouldShowBanner` effect calls `setSelectedChannel({...kind: "channel"})` whenever own-nick JOIN appears, including server-initiated re-joins (NickServ ghost recovery + autojoin replay, SAJOIN by an oper, post-disconnect auto-rejoin). Per `feedback_target_window_ux_rule` the focus-only-on-user-action rule covers this case. `compose.ts:225` already auto-focuses on user-issued `/join`. The duplicate setSelectedChannel here yanks focus from whatever the operator was doing.

**Recommended fix:** Drop the setSelectedChannel call inside `shouldShowBanner` effect; the banner-shown latch is the only state that effect should drive.

### [MED] `compose.ts` `/quit` PATCH-park failures degrade silently — partial network unparking on next boot

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/compose.ts:282-321`

**Description:** Per the comment, partial PATCH failures DO get a `console.warn` per network. But the operator is logged out within milliseconds and never sees it. The behavioral consequence is that a network whose PATCH-park failed will auto-respawn on the next bootstrap (Bootstrap skips `:parked` only). This is a "no silent drop" violation in spirit: the operator's intent ("logout completely, park everything") gets silently honored partially. Same theme as the cluster.

**Recommended fix:** Surface the partial failure via an `alert()` or by routing through a synchronous beacon (`navigator.sendBeacon('/api/log-quit-failures', payload)`) BEFORE logout, so the failures are at least logged server-side for forensic recovery. Better: surface as a confirm() before logout — "N networks failed to park; quit anyway?"

### [MED] `subscribe.ts` DM-listener loop drops `mode`, `join`, `part`, `quit`, `kick`, `nick_change`, `topic` events on own-nick topic — silent class continues into the no-silent-drops cluster

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/subscribe.ts:444-449`

**Description:** The DM-listener handler explicitly drops every non-PRIVMSG/NOTICE/ACTION message kind on the own-nick topic, with the comment "deferred to feature #4 (server-messages window). Drop silently for now". Per the cluster's "no silent drops" theme this should be a tracked TODO at minimum. Today's risk: a peer's PRIVMSG arrives (handled), but their nick_change, mode-on-self, or any future kind silently never reaches cic. The server persists the row (the comment notes this), so a page refresh recovers — but the live UX is broken.

**Recommended fix:** Add a `[Logger metadata]`-shape browser console warning (with rate limit so it doesn't spam) so operators know there's an unrendered class. Better: instead of dropping silently, route to the existing `$server` window (which already aggregates server-scope notices) keyed on the network slug — operator sees the row there until feature #4 lands. The server already routes structurally similar events to `$server` via `Session.Server`'s catch-all; the cic-side drop here is the LAST silent-drop site.

### [MED] `linkify.ts` URL regex matches scheme-only strings and IDN-bearing tokens with no validation pass

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/linkify.ts:50`

**Description:** The `URL_REGEX = /(?:https?:\/\/|ftp:\/\/|www\.)\S+/gi` matches any non-whitespace run after a scheme prefix. Edge cases:

1. `https:// ` (a raw scheme in a sentence like "use https:// or ftp://") matches `https://` then nothing, BUT the `\S+` requires AT LEAST one non-whitespace char after the scheme — fine. However `https:///foo` (triple-slash typo) matches and renders as a link to `https:///foo` which the browser then resolves arbitrarily.
2. `www.` prefix matches `www.foo` (one char) and the `toHref` prepends `https://www.foo` — a bare `www.foo` with no TLD is rendered as a clickable link. Not catastrophic but visually confusing.
3. IDN: the regex matches any `\S` so non-ASCII gets through. Browsers render IDN as punycode, which is fine for navigation, but the visible link text is unicode — a homoglyph attack vector when the URL substring is the rendered run text. Not unique to cic but worth documenting.

The `feedback_no_localized_strings_server_side` constraint pushes URL handling client-side, which is correct — but the cic-side URL regex is the trust boundary. Server already linkifies nothing; cic IS where the contract lives.

**Recommended fix:** (a) Tighten the regex to require at least one `.` followed by 2+ chars after the scheme/www prefix (rejects `https:///`, `www.foo`); (b) add a `try { new URL(href); } catch { return null; }` validation pass in `toHref` to drop manifestly malformed URLs; (c) add a Playwright e2e (per the bucket-4 finding above) that asserts both positive (the common URL shapes link) and negative (`/`, `https:///`, `www.x`) behavior.

### [MED] `ScrollbackPane.tsx` renderRawEvent INVITE arm renders `[Join]` button styled with `display: inline` + `padding: 0 0.25em` — interaction with `width: 100%` member-name button class is not protected against

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/ScrollbackPane.tsx:331-344`, `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/themes/default.css:718-727`

**Description:** Per `feedback_css_block_button_wraps_inline_prefix`, the prior CSS regression class was a `width: 100%` block-level button paired with a `::before` inline prefix wrapping to a new line. The new B2 INVITE [Join] button is `display: inline` so it WON'T trigger that exact bug, but the surrounding `.scrollback-line` row is a div that wraps; if a long sender-nick + long channel name + the [Join] button overflow the available row width, the [Join] wraps to the next visual line and the operator may not associate it with the INVITE row above. No e2e covers this; jsdom doesn't measure layout.

**Recommended fix:** Add a Playwright e2e that asserts the `[Join]` button stays on the same visual line as the INVITE text at standard viewport widths (1280px desktop AND the 768px mobile breakpoint). Bonus: assert at narrow viewport (375px iPhone) that the button is still tappable (≥44px target).

---

## LOW

### [LOW] `index.html` apple-touch-icon still uses `.svg` — STILL OPEN from 2026-05-12 L1

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/index.html:18`

**Description:** Verbatim carry-over. iOS apple-touch-icon historically wants PNG (180×180); SVG support is partial. The 192/512 PNG icons exist in `public/`. This continues to bite iOS PWA installs.

**Recommended fix:** Use `/icon-192.png` (or a dedicated 180px PNG) for the `apple-touch-icon`.

### [LOW] `auth.ts` reads localStorage at module init — STILL OPEN from 2026-05-12 M9

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/auth.ts:29-31`

**Description:** Test-friction tax of the eager-init pattern. Lazy `getOrInitToken()` would let tests reset by clearing localStorage without resetModules. Not urgent.

**Recommended fix:** Defer to next test-cleanup cluster.

### [LOW] `theme.ts` matchMedia listeners attached at module load with no cleanup — STILL OPEN from 2026-05-12 L6

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/theme.ts:73-79,94-104`

**Description:** Verbatim carry-over.

**Recommended fix:** Defer.

### [LOW] `slashCommands.ts` `/q` alias write at module-init via mutable cast — STILL OPEN from 2026-05-12 L3

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/slashCommands.ts:303-306`

**Description:** Verbatim carry-over.

**Recommended fix:** Add `q: (verb, rest) => DISPATCH.query(verb, rest)` directly in the const initializer.

### [LOW] `wireNarrow.ts` `narrowChannelEvent` does not validate `read_cursor_set.last_read_message_id > 0`

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/wireNarrow.ts:216-221`

**Description:** The narrower accepts any number for `last_read_message_id` including negative or zero. `applyReadCursorSet` then writes it into the cursor map; the next render's marker calculation does `m.id > cursor` which is meaningless if cursor is 0 or negative (id is sqlite AUTOINCREMENT, always positive). Not a functional bug today (the worst case is "show all messages as unread") but defensive validation matches the rest of the file's bias.

**Recommended fix:** Add `r.last_read_message_id > 0` check in the narrower's predicate.

### [LOW] `members.ts` mode `args` filter casts after filter, lost type info

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/members.ts:86-88`

**Description:** `Array.isArray(msg.meta.args) ? (msg.meta.args.filter((a) => typeof a === "string") as string[]) : []` — the `as string[]` cast is needed because `Array.prototype.filter` doesn't narrow the type. Use a type-predicate filter: `.filter((a): a is string => typeof a === "string")`. Lower-noise than the cast and tsc-validated.

**Recommended fix:** Switch to predicate filter form.

---

## NIT

### [NIT] `linkify.ts` global regex with `lastIndex = 0` reset is a foot-gun — prefer non-global regex with manual loop

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/linkify.ts:50,92`

**Description:** Using a `g`-flagged regex with manual `lastIndex` reset works but is a known trap — a re-entrant call (e.g. if a future caller is recursive or if vitest runs concurrent test cases sharing the module) would corrupt `lastIndex` across calls. The defensive `URL_REGEX.lastIndex = 0` at the start of `linkify` mitigates within a single call but fails under recursion. Local non-global regex + `String.matchAll` is cleaner.

### [NIT] `userTopic.ts` `intOrNull` helper is overly defensive

**File:** `/Users/mbarnaba/code/grappa/.worktrees/no-silent-drops/cicchetto/src/lib/userTopic.ts:233-234`

**Description:** `(v: unknown): number | null => typeof v === "number" ? v : v === null ? null : null` — the second `: null` is redundant; the function returns null on every non-number input regardless. Simplify to `typeof v === "number" ? v : null`.

---

## Trajectory risks

The cluster trajectory is push notifications → image upload → voice → mobile UI polish → PUBLIC OPEN. Going public dramatically raises the cost of every silent-drop class. Things to watch:

1. **Push notifications.** A Service Worker is already wired (`registerSW` in main.tsx). Adding push will involve `navigator.serviceWorker.ready` + `pushManager.subscribe` + a fetch to register the subscription with grappa. Risks:
   - The SW lifecycle is its own state machine — `vite-plugin-pwa`'s `autoUpdate` mode can race the page's own update-detection logic. Plan to coordinate with `BundleRefreshBanner` so the operator doesn't get TWO refresh CTAs.
   - VAPID keys must be a server-side secret; the public key is bundle-baked. Make sure the cic build pulls it from `import.meta.env.VITE_VAPID_PUBLIC_KEY` (compile-time) and the server validates the bundle against the matching private key.
   - Subscription persistence per (user, network, device) is server-side; the cic-side stores `endpoint` + `keys.p256dh` + `keys.auth`. NEW server-side schema → migration → cold deploy required (per `feedback_cluster_with_migration_must_cold`).

2. **Image upload (litterbox.catbox.moe per project memory).** Risks:
   - Outbound HTTP from the browser to a third-party domain — CSP must allow `img-src` and `connect-src` to `*.catbox.moe`. Per `compose.override.yaml` rule, this goes in the per-host override not the committed base.
   - Image preview rendering in scrollback: every URL that ends in `.png/.jpg/.gif/.webp` becomes a candidate for inline preview. The B4 linkify already renders these as `<a>`; adding preview means `<img>` mounted via the same regex match. Per `feedback_no_localized_strings_server_side`, server emits the URL, cic decides to render as image. Image overlay UX (click → modal lightbox) needs e2e coverage from day one.
   - The litterbox endpoint is unauthenticated public file storage — anyone with the URL has the file. If the operator uploads a sensitive screenshot, it's effectively public. UX must surface this clearly (per `project_image_upload`).

3. **Mobile UI polish.** Per `feedback_cicchetto_browser_smoke` mandatory real-browser smoke at bucket close. The 768px breakpoint is JS-toggled in `Shell.tsx`. The mobile branch has KNOWN gaps (per 2026-05-12 M7): no per-tab close affordance on `BottomBar` (X buttons omitted), but the sidebar with X buttons is also not rendered on mobile → mobile operators have NO way to close a query window today.

4. **Public open.** The pre-public-open security review should re-audit:
   - All `__cic_*` window globals (3 today: `__cic_dropSocketForTests`, `__cic_socketHealth`, `__cic_bundleHash`). Strip or guard for production builds (this review's MED finding).
   - The `localStorage`-stored bearer token persists across PWA cold starts — XSS surface per the auth.ts doc. Cic renders no untrusted HTML today, but image preview (trajectory item 2) introduces a new attack vector. Audit any `srcset`, `data-` URL, or inline-style-from-server paths.
   - Bundle hash CSP — Vite's source-map output (`sourcemap: true` in vite.config.ts) leaks original source paths. Decide whether the public deploy ships sourcemaps (good for debugging operator reports, bad for IP / fingerprinting reverse-engineer).
   - Service worker cache staleness — `BundleRefreshBanner` works for the JS bundle, but the SW precache is its own contract. Per the vite.config comment, `registerType: "autoUpdate"` swaps SW silently. With push notifications added, the SW will have NEW handlers (push listeners) that the prior SW doesn't have — make sure rollout is staged so a user-with-stale-SW doesn't lose pushes for a deploy cycle.

5. **No-silent-drops cluster scope creep.** The B0/B2/B4 commits are clean per-bucket "open up a previously-silent-drop class" wins. The remaining drops (DM-listener silent skip per MED above, `openQueryWindowState` optimistic per HIGH above, missing e2e per HIGH above) sit in cic. The bucket-5 codebase review (this document) IS the close-out signal — recommend NOT shipping the cluster as "CLOSED" until the HIGH findings are at least triaged into a follow-up checkpoint.
