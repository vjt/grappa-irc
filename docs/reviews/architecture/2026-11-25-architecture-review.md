# Architecture Review — 2026-11-25 (four class hunts)

**Base:** `ec8e66bca` (detached worktree). Every `path:line` below is at that sha; `server.ex` means `lib/grappa/session/server.ex`.
**Follows:** the full six-concern review of 2026-11-21 @ `3a247669d` (`docs/reviews/architecture/2026-11-21-architecture-review.md`), 148 commits earlier.

**Method.** This is not the six-concern dispatch of `docs/reviewing.md` §2. Four reviewers ran in parallel, each hunting ONE bug class across the whole tree, server and cicchetto. They were seeded with the issues filed in those classes since 2026-11-21: 2693, 2696, 2697 (PR 2718), 2703, 2715, 2716, 2719, 2721, 2723, 2724, 2725, 2726. Those issues are the pattern and are not re-reported. The findings are the rest of each family.

1. State copied out of its source of truth (`STALE`)
2. Process lifecycle: start and stop order, restart semantics, partial boots (`LIFE`)
3. Failure surfacing: where an error goes and who sees it (`FAIL`)
4. Connection-phase windows: what a verb does before registration, during it and after it (`PHASE`)

**Nothing was executed.** No `mix`, `bun`, test, docker or script was run. Every finding is a reading of the code. Each reviewer marked as INFERRED whatever depends on behaviour it did not trace to the end (a library's semantics, an ircd's answer, a timing), and named what would measure it. Those labels are kept here.

**Editing.** An editor compiled the four reports and re-read the cited lines for every HIGH and for every MEDIUM proposed for filing. Each finding records the result as **Verified by editor: yes / partly / no**. Where the editor's reading changed or extended a claim, the finding says so. Nothing was downgraded or dropped. Security observations are handled outside this document.

**IDs.** Each finding keeps its reviewer's number behind the class prefix: `PHASE-A2` is the phase reviewer's A2.

**Since the base.** PR 2727 (issue 2721, a PART before 001) merged after `ec8e66bca`. The phase reviewer read it at `06c561e46`, and the cells that depend on it say "PR 2727". PR 2718 (issue 2697, SourceAliasManager order) is still open; the lifecycle reviewer read it at `7f7373455`.

## Severity summary

| Class | CRITICAL | HIGH | MEDIUM | LOW | Total |
|---|---:|---:|---:|---:|---:|
| Stale copies (`STALE`) | 0 | 0 | 6 | 3 | 9 |
| Process lifecycle (`LIFE`) | 0 | 1 | 6 | 2 | 9 |
| Failure surfacing (`FAIL`) | 0 | 1 | 5 | 1 | 7 |
| Connection-phase windows (`PHASE`) | 0 | 2 | 4 | 3 | 9 |
| **Total** | **0** | **4** | **21** | **9** | **34** |

These are the reviewers' own counts. No two findings were merged: no cross-class pair shares both the defect and the cure. Pairs that touch the same fact are cross-referenced under *Related findings kept separate*.

Of the 25 HIGH and MEDIUM findings, the editor verified 21 **yes** and 4 **partly**, and none **no**. The four partly verified are STALE-A6, LIFE-A5, PHASE-A5 and PHASE-A6: their core claim was re-read, but one or more of their members was not.

Two findings are already filed issues: STALE-A8 is issue 2612, and LIFE-A8 is issue 1613 (with issue 1334). Six more extend a filed issue: STALE-A4, LIFE-A2, LIFE-A3, LIFE-A6, FAIL-A2 and FAIL-A6.

### What this review says, in one paragraph

**The four hunts found one shape four times. A fact the server owns is copied or re-derived where it is used, and the copy has no way back when the source moves.** The source moves across devices (display prefs), across process restarts (`WSPresence`, `SourceAliasManager`, `SessionSupervisor`), across connection attempts (a held JOIN) and across the registration boundary (verbs that treat "has a socket" as "is registered").

In every case the cure already exists in the tree, and some members of the family already use it:
- the settings bridge on `Topic.user_settings/1`;
- the after-join snapshot;
- the holders Registry;
- the JOIN hold's `registration_pending?/1`;
- the timeout arm on four of the eleven channel pushes.

What is missing is a rule that makes every member use it. Without one, each fix lands as a point fix next to its nearest sibling (issues 2114, 2703, 2721), and the next sibling is still wrong.

The structural answers are few, and they recur across the classes:
- a derived **link phase** in place of six proxies;
- a **snapshot twin** for every live client-state event;
- a **reseed** for every copy holder that restarts;
- one **push and request bridge** and one **error sink** in the client;
- lifecycle invariants written as **data a test can walk**.

`Session.Server` grew from 10,374 to 10,933 lines in the four days since the base (+5.4%, 22 commits; MEASURED by the editor with `wc -l` and `git log`). Keepnick, kick-rejoin and the JOIN hold were its main sources. PHASE-A4 is a first cut along the seam the 2026-11-21 review asked for.

### HIGH findings

| ID | Finding | Verified | Filed |
|---|---|---|---|
| LIFE-A1 | The release `remove-network` verb and the mix `unbind-network` verb stop a session in a VM that has none: the first always fails, the second leaves the live session running | yes | new |
| FAIL-A1 | Seven promise-returning channel pushes have no `timeout` arm and no REST call has a deadline; a push into a dead socket can lock that window's composer | yes | new |
| PHASE-A1 | A JOIN held for 001 is answered 202 and dies with the connection attempt it was held for; cic keeps the `:pending` row | yes | new |
| PHASE-A2 | Before 001, the message verbs persist a row, broadcast it and answer success for a line the ircd discards | yes | new |

## Cross-class themes

### T1. One derived value instead of scattered proxies
**Members:** PHASE-A4 (six proxies for "registered?"), PHASE-A2, A3, A5, A6, A9, STALE-A3 with PHASE-A5 (two copies of "the nick we want"), and STALE-A5 (two client copies of the live nick).
**Shape:** a fact that can be derived from fields that already exist is instead re-derived at each reader, each in its own way. The readers disagree at the edges: `client: nil` cannot see the window before 001, and `registered_at` cannot see the +r defer. A new reader copies whichever neighbour is closest.
**Recommendation:** derive once, name it, and make the readers consult the name. On the server: `link_phase/1` plus a verb policy table (PHASE-A4), and a desired-nick value written by the nick verbs (PHASE-A5, which also removes STALE-A3's stale copy). On the client: derive the `$home` rows from the networks store plus the two fields only the envelope carries (STALE-A5).

### T2. Every live event needs a snapshot twin, and every copy holder needs a reseed
**Members:** STALE-A4 (away and "reconnecting" have no snapshot), STALE-A5 (`/me` has no resync door), PHASE-A1's client half (cic's window state is never reset when the server's is), STALE-A2 (`WSPresence` restarts empty), LIFE-A2 (issue 2716) and LIFE-A5 (`SessionSupervisor` restarts empty).
**Shape:** state that a live event writes on one side and that nothing re-sends after a gap or a restart. The after-join snapshot and the holders Registry are both the right mechanism. These members are simply not in them.
**Recommendation:** write the rule down where the next event is added. A user-topic event that sets client state ships with its after-join snapshot entry. A process that holds a copy of other processes' facts rebuilds it, at `init/1` or from the next signal it already receives, from the processes that own those facts.

### T3. One push bridge, one request bridge, one error sink in the client
**Members:** FAIL-A1 (timeouts applied by copy), FAIL-A6 (no sink outside the typed errors), FAIL-A5's client half (replies nobody listens for), issue 2723 and issue 2726.
**Shape:** every channel push and every REST call is hand-written: 105 `await fetch(` in `api.ts` alone, about 65 in other modules, and eleven promise bodies in `socket.ts`. So the `ok`/`error`/`timeout`/deadline contract is applied push by push, the non-typed failures (offline, timeout, 5xx envelope) have three or more renderings, and a door that has no inline error slot falls back to `console.warn`.
**Recommendation:** `pushWithReply()` and `request()` own the contract. A closed client-side failure union (`ApiError | ChannelPushError | offline | timeout | server_fault | unknown`) is produced only by those two functions. One identity-scoped action-failure toast queue is the default sink. The 2026-11-21 carry-overs (prior abstraction A5 `readError` bypasses, A8 `api.ts` size, A18 transport spread) are paid at the same seam.

### T4. One write path per owner, one bridge from it
**Members:** STALE-A6 (four mechanisms, several members with none), STALE-A1 (full-map replace from a copy taken at login), STALE-A7 (network-scoped edit reaches no session), STALE-A8 (issue 2612, a copy adopted before the commit).
**Shape:** the mechanism that works is the owning context broadcasting after its commit, with the holder patching one field. Members that bypass it either write from the web layer (ignores, notify), adopt before committing (`SourceAliasManager.arm/1`), or have no bridge at all.
**Recommendation:** `UserSettings.update_data/2` is already the single write path for every key. Broadcast `{:user_setting_changed, key, value}` from it, on the server topic and mirrored on the user topic. Holders keep a table of the keys they hold. Writes merge per key rather than replace.

### T5. Every question gets a bounded answer
**Members:** FAIL-A1 (client awaits with no deadline), FAIL-A4 (a window `:pending` for the life of the session), PHASE-A1 (a `:pending` that outlives the process that would answer it), PHASE-A6 (accumulators primed for replies that cannot come) and issue 2723.
**Shape:** a request records "waiting", and the paths that end the wait all assume an answer arrives. The TTLs that exist evict the bookkeeping without moving the visible state.
**Recommendation:** every visible waiting state gets a terminal exit that is itself an event: an expiry becomes a `join_failed` and a timeout becomes a rejection. A process that dies holding unanswered questions announces them, as `drop_e2e_pending/1` already does for E2E sends.

### T6. Lifecycle invariants as data, and cleanup where it is guaranteed to run
**Members:** LIFE-A7 (order relations are comments), LIFE-A4 (a reader before its publisher), LIFE-A6 (the partial boot is a denylist), LIFE-A1 (a teardown in the wrong VM), LIFE-A2, A3, A9 and A8 (cleanup placed in a `terminate/2` that a kill skips or a supervisor shutdown never reaches).
**Shape:** each of issues 2697 and 2715 and LIFE-A4 and A6 is a relation nobody wrote down as something a machine checks. Each `terminate/2` duty is placed where OTP does not promise to run it.
**Recommendation:** a dependency table next to PR 2718's `children/1`, of the form `{dependant, :needs_at_start | :needs_at_stop, dependency}`, walked by one generic test. An operator-task profile expressed as an allowlist. Bookkeeping that must survive a kill moved to an observer that monitors the session. `terminate/2` keeps only what is best-effort by nature, the QUIT.

## Related findings kept separate

| Pair | Same fact | Why not merged |
|---|---|---|
| STALE-A2 / LIFE-A5 | `WSPresence` restarts empty while sockets stay connected | LIFE-A5's subject is the root strategy, of which `WSPresence` is one member. STALE-A2's cure (self-heal from the heartbeat) is specific to it. LIFE-A5 points here for that member |
| FAIL-A4 / PHASE-A1 | a window stuck `:pending` | one is an in-process TTL eviction, the other a process restart; the cures differ (an expiry transition, versus durable or announced held JOINs) |
| STALE-A3 / PHASE-A5 | `configured_nick` used as the nick the subject wants | STALE-A3 is a stale copy for visitors in any phase. PHASE-A5 is a pre-001 intent the 001 handler overrides, for both subjects. PHASE-A5's desired-nick value would subsume STALE-A3 |
| FAIL-A7 / LIFE-A5 | the detached `credential_failer` write | FAIL-A7: a failed write leaves the row unchanged. LIFE-A5: a `TaskSupervisor` restart kills it in flight |
| STALE-A6 / FAIL-A2 | `ignores_changed` / `notify_changed` answer `:ok` on a failed call | the swallow is a member of STALE-A6's bypass; FAIL-A2 is about what `:no_session` means |
| PHASE-A3 / PHASE-A8 | "the join plan has not fired" is the hold condition | PHASE-A8's PR 2727 residue (a PART written upstream during the +r defer) uses the condition PHASE-A3 proposes |

---

## Class 1 — state copied out of its source of truth (`STALE`)

Every copy has a source of truth. The question asked of each one was whether every writer of the source reaches it. There is a shared mechanism and it works: the owning context broadcasts on `Topic.user_settings/1` after its commit, and the holder patches one field. Profile, keepnick, avatar, kick-rejoin, the auto-away debounce, the auto-away reason and the away-nick suffix all use it. Three gaps recur:
1. **A writer that is not the owning context.** Ignores and notify are synced from the controller (A6), and `SourceAliasManager.arm/1` is driven from the controller before the write (A8).
2. **A live event with no snapshot twin.** Away and "reconnecting" (A4), and the `/me` envelope (A5).
3. **A copy holder that restarts without reseeding.** `WSPresence` (A2), and `SourceAliasManager` (issue 2716).

Reported: 0 CRITICAL, 0 HIGH, 6 MEDIUM, 3 LOW. Not re-reported: issues 2716, 2721 and 2724.

### MEDIUM

### STALE-A1. cic display prefs: a full-map PUT built from a copy taken at login silently reverts another device's changes
**Concern:** stale copies
**Severity:** MEDIUM
**Scope:**
- `cicchetto/src/lib/displayPrefs.ts:120-131` (`buildWireMap`), `:193-236` (`mountDisplayPrefsSync`, keyed on `token()` only), `:249-259` (`pushDisplayPrefs`)
- `lib/grappa/user_settings.ex:2241-2246` (`put_display_prefs/2` replaces the whole `display_prefs` key)
- `cicchetto/src/lib/userTopic.ts:981-1040` (the rejoin hydration list, which has no display prefs)

**Problem:** the source is `user_settings.data["display_prefs"]`. cic holds a copy in eight owner modules plus localStorage. The copy is refreshed in one place, the effect on `token()`, which runs at page load, at login and on token rotation. Nothing else refreshes it: not a user-topic rejoin, not a resume, and no broadcast, because there is none. Every `syncedSet*` then PUTs the ENTIRE map built from that copy, and the server stores it as a full replace. A second device's write never reaches the copy, and the stale copy then overwrites the source.
**Impact:** the phone sets `date_format` or pins a channel's presence filter. A desktop tab open since yesterday toggles any other pref. Its PUT carries yesterday's `date_format` and yesterday's `presence_filter` map, the server stores both, and the phone's change is gone at its next load. `presence_filter` is the costly member: it is a per-channel map, so one write drops every pin made elsewhere since the tab loaded. The #222 unsynced-marker path makes this worse in one case: a tab holding a pending marker re-pushes its whole local map at the next login.
**Recommendation:** make the write a merge, not a replace. Either PUT only the changed key and have `put_display_prefs/2` merge it into the stored map (the validation is already per key), or keep the full PUT and add display prefs to the rejoin hydration plus a `display_prefs_changed` user-topic event. The first removes the class; the second only narrows the window. See T4.
**Evidence:** READ. Measure with a two-context e2e: set `date_format` in B, toggle `colored_nicklist` in A without reloading, then `GET /me/settings/display-prefs`.
**Verified by editor:** yes. Also confirmed by grep that no display-prefs event exists anywhere on the channel side, in `Session.*`, in `userTopic.ts` or in `subscribe.ts`.
**Filed issues:** new.

### STALE-A2. `WSPresence` restarts empty while every socket stays connected, and `set_visibility` from an unknown pid answers `:ok`
**Concern:** stale copies (and lifecycle: the `WSPresence` member of LIFE-A5)
**Severity:** MEDIUM
**Scope:**
- `lib/grappa/ws_presence.ex:515-520` (`init/1`, empty state), `:523-549` (`register`), `:556-570` (`set_visibility`, whose untracked-pid arm answers `:ok`)
- `lib/grappa_web/channels/user_socket.ex:437` (the ONLY `register` call, in `connect/3`); `lib/grappa_web/channels/grappa_channel.ex:770` (the visibility event, carrying `socket.transport_pid`)
- consumers: `lib/grappa/visitors/reaper.ex:245`, `:289-296`; `lib/grappa/window_counts/pusher.ex:66`; `lib/grappa_web/controllers/admin/settings_controller.ex:196`; `lib/grappa_web/controllers/admin_controller.ex:217`; `lib/grappa/push/triggers.ex:596`; `server.ex:4803`

**Problem:** the source is the set of live transport processes, and `WSPresence` is a monitored copy of it, seeded once per socket at `connect/3`. It is a permanent child under a `:one_for_one` root, so a crash restarts it with no sockets while the sockets themselves are untouched. Nothing re-registers them. The page keeps sending visibility heartbeats (`cicchetto/src/main.tsx:308-365`), and each one lands in the untracked-pid arm, which answers `:ok` and changes nothing. This is issue 2716's shape with a wider blast radius, and unlike `SourceAliasManager` there is no reconcile at all.
**Impact:** these hold for every connected subject until each socket happens to reconnect:
- `reconcile_incognito_lingers/0` stops sliding connected incognito visitors' TTL, so the sweep reaps them with a browser attached, and `close_live_incognito/1` reads `ws_count == 0` and wipes the row at the first tab close;
- `WindowCounts.Pusher` gates on `ws_count > 0`, so unread-count pushes stop;
- the `server_settings_changed` and `bundle_hash` fan-outs iterate `list_user_names/0` and reach nobody;
- `any_visible?/1` is false, so foreground push suppression is off and auto-away sees no visible device;
- `client_ips/1` is empty for the mode-2 source derivation.

**Recommendation:** make the copy heal itself from the signal it already receives. `set_visibility` carries the user name and the transport pid, so on an unknown pid it should register and monitor that pid instead of answering `:ok`. The heartbeat then rebuilds the table within one freshness window, with no new process and no parallel state. The silent `:ok` is also a "no silent-swallow at boundaries" case in its own right.
**Evidence:** READ. Whether `WSPresence` ever crashes is NOT established; the reviewer found no clause that obviously raises. Measure with a test that kills the registered process while a channel test socket is joined, then asserts `ws_count/1` after the next `"visibility"` event.
**Verified by editor:** yes, for the restart consequence and the untracked arm. The finding claims no crash cause and none was looked for.
**Filed issues:** new; the same family as issue 2716.

### STALE-A3. A visitor's `configured_nick` is copied once in `init/1`, but the visitor's own session rewrites the credential nick it was copied from
**Concern:** stale copies
**Severity:** MEDIUM
**Scope:**
- `server.ex:1285` (`configured_nick: opts.nick`, the only writer), `:5388-5389` (`configured_nick/1`)
- writers of the source from inside the same session: `server.ex:7982-7998` (`{:visitor_nick_changed, _}` → `visitor_nick_persister`), `lib/grappa/networks/credentials.ex:479-495`, `:510-524`, `lib/grappa/visitors.ex:378`
- readers of the copy: `server.ex:6039-6047` (`keep_nick_target/1`), `:5971-5992` (`reclaim_configured_nick/1`), `:6221-6225`, `:5338` (perform `$nick`)
- `lib/grappa_web/controllers/networks_controller.ex:261-270` (the keepnick door, both subjects)

**Problem:** the readers treat `configured_nick/1` as the credential's `nick` column (#885). For a USER that holds: nothing in the session writes the column, and the identity door bounces the session. For a VISITOR it does not hold. An anonymous visitor's `/nick` rotates the column on the self-NICK echo, and `+r` binds it unconditionally, but no arm updates `state.configured_nick`. Copy and column diverge for the rest of the process's life.
**Impact:**
- Keepnick turned on live after a rename: `apply_keep_nick_toggle/2` arms a tick at delay 0 whose target is the connect-time nick, so the session sends `NICK <old>` and pulls the visitor off the nick they chose. `keep_nick_on_user_nick/2` reads the same stale target, so "`/nick <target>` means try now" is keyed on the wrong nick.
- A second 001 in the same process expands `$nick` in the perform list to the old nick, and the reclaim compares the welcomed nick against the old one.

All of these heal at the next `init/1`.
**Recommendation:** treat the two visitor write points as writers of the copy. When the persister answers `{:ok, %Credential{}}`, and when the identity commit binds at `+r`, set `state.configured_nick` in the same `apply_effects` arm. PHASE-A5's desired-nick value is the more general cure and would subsume this one.
**Evidence:** READ for the copy and its writers. The end-to-end path of each consequence was not traced. Measure with a session test: visitor plan, self-NICK echo, then turn keepnick on and assert no `NICK <old>` reaches the fake server.
**Verified by editor:** yes. `grep configured_nick` finds the init field as the only writer; the visitor persister arm does not touch it; `keep_nick_target/1` reads it.
**Filed issues:** new; related to PHASE-A5.

### STALE-A4. Two cic stores mirror session state from live events only, with no snapshot at join: away and "reconnecting"
**Concern:** stale copies
**Severity:** MEDIUM
**Scope:**
- `cicchetto/src/lib/awayStatus.ts:16-24`, read at `cicchetto/src/Sidebar.tsx:392` and `cicchetto/src/ComposeBox.tsx:207`
- `cicchetto/src/lib/reconnectingStatus.ts:25-37`, written only at `cicchetto/src/lib/userTopic.ts:1195` and `:1678`
- `server.ex:3137-3180` (`:session_snapshot`: no away state, no link progress)
- `lib/grappa_web/channels/grappa_channel.ex:1632-1647` (`push_user_snapshot/2`), `:1685` onwards (`push_session_snapshot/2`)

**Problem:** the server owns away state. `state.away_state` is held there, and the explicit away is persisted and restored through `restored_away` (`server.ex:1389`). cic's `awayByNetwork` starts at `{}` on every page load and is filled only by a live `away_confirmed`. The after-join snapshot re-pushes umodes, supported umodes, the identity verdict, invited and rejected windows, DCC offers and ISUPPORT. It does not re-push away. `reconnectingByNetwork` has the same shape: it is set by `connection_progress: connecting` and cleared only by `connection_progress: connected` or by a `connection_state_changed` to parked or failed.
**Impact:**
- After `/away`, a reload or a second device shows the user as present in the sidebar, and ComposeBox treats the network as present, while upstream still has the user away. The same happens after any WS gap that spans an auto-away or a `/back` from another device.
- A WS gap that swallows `connection_progress: connected` leaves the "reconnecting…" badge on a registered network until the next reconnect or a reload. The reconnect arm's `refetchNetworks()` (`cicchetto/src/lib/subscribe.ts:1502`) does not clear it.

**Recommendation:** put both in `:session_snapshot` and push them from `push_session_snapshot/2` with the Wire verbs the live edge uses (`away_confirmed`, `connection_progress`), as that function already does for seven other facts. The rule to write down is T2's.
**Evidence:** READ. Measure: `/away`, reload, inspect the sidebar away marker.
**Verified by editor:** yes.
**Filed issues:** extends issue 2082, whose report is the same store failing in the other direction (a stale 💤 after an un-away). Its "reopen clears it" observation is this finding: a reopen always starts from present, whatever the server holds.

### STALE-A5. The `$home` rows are a second copy of live nick and link state that three writers do not reach, with an override layer that is never cleared
**Concern:** stale copies
**Severity:** MEDIUM
**Scope:**
- `cicchetto/src/lib/home.ts:42-90` (`overrides`, `live[row.slug] ?? row`, cleared on subject flip only)
- `cicchetto/src/lib/userTopic.ts:1116-1126` (`own_nick_changed` → `mutateNetworkNick` only), `:1173` (`patchHomeNetwork`)
- `cicchetto/src/lib/subscribe.ts:1495-1503`, `cicchetto/src/main.tsx:390-397` (the reconnect and resume arms run `refetchNetworks` and `refetchChannels`, and no `refetchUser`)
- `lib/grappa/networks/wire.ex:674-684` (the row: `slug, nick, connection_state, …, recoverable`); `cicchetto/src/HomePane.tsx:335,361,470`

**Problem:** `$home` renders `nick` and `recoverable` from the `/me` envelope, overlaid by a per-slug override written on each `connection_state_changed`. That copy goes wrong three ways:
1. `own_nick_changed` updates the `GET /networks` copy and not the home row. cic holds two copies of the live nick, and only one follows a rename.
2. The override is cleared only on a subject flip. After a slug's first `connection_state_changed`, a later `refetchUser()` cannot change what is shown: the fresher envelope row loses to the older override.
3. `/me` has no reconnect or resume door. `network_attached` and `network_detached` are its only remote triggers, so one lost during a WS gap leaves `$home` offering a network the account already holds, or showing a detached one. CLAUDE.md's detach section names exactly this consequence for a missing signal, and a lost signal has the same result.

**Impact:** `$home` shows the pre-rename nick after `/nick`, a ghost recovery or an away-suffix rename. The Recover chip's `recoverable` gate stays at its value from the last link transition, even after a password is set. The attach and detach rows are wrong after a suspended tab resumes.
**Recommendation:** clear a slug's override when a newer envelope arrives. Add `refetchUser()` to the two resync arms that already run `refetchNetworks()`, and patch the home row's nick from `own_nick_changed`. Longer term, derive the home rows from the networks store plus the two envelope-only fields instead of holding a second list (T1).
**Evidence:** READ.
**Verified by editor:** yes; `grep refetchUser` finds no call in `subscribe.ts` or `main.tsx`.
**Filed issues:** new. Adjacent to issue 2259 (detach and attach follow-ups), which covers prose and tests, not this staleness.

### STALE-A6. The settings family reaches its live copies by four different mechanisms, and several members by none
**Concern:** stale copies
**Severity:** MEDIUM
**Scope:**
- the bridge from the owning context: `lib/grappa/user_settings.ex:1348,1546,1731`; `lib/grappa/networks/credentials.ex:737,780,821,928`; consumed at `server.ex:3572-3690`
- a synchronous call from the controller: `lib/grappa_web/controllers/ignores_controller.ex:102`, `lib/grappa_web/controllers/notify_controller.ex:90,110,128`; `lib/grappa/session.ex:2722-2762`
- reconnect: `lib/grappa_web/controllers/networks_controller.ex:207,425`; `lib/grappa/operator.ex:918-945`
- nothing: `lib/grappa/user_settings.ex:852-873` (`show_peer_profiles`), `:568`, `:726`, `:2051`, `:2244`; `lib/grappa_web/channels/grappa_channel.ex:1589-1614`
- the cic side: `cicchetto/src/lib/userTopic.ts:981-1040`

**Problem:** one mechanism is sound and general: the context that owns the row broadcasts on `Topic.user_settings/1` after its commit, and the session patches its field. The rest of the family bypasses it:

| Member | Session copy | cic copy | How a write reaches them |
|---|---|---|---|
| ignores | `state.ignores` | settings page only | the controller calls the session; a failed call logs a warning and the request still answers 200 (`session.ex:2729-2734`) |
| notify list | presence map | `notify_list` push | the same controller-side call, the same swallowed failure (`session.ex:2752-2761`) |
| `show_peer_profiles` | `state.show_peer_profiles` | — | nothing until respawn (documented at `user_settings.ex:842-848`) |
| highlight patterns | none (read per event) | `highlightList` | no event; other devices wait for a rejoin |
| aliases | — | `aliasList` | no event; rejoin only |
| notification prefs | none | `notificationPrefs` | no event; rejoin only |
| display prefs | — | eight modules | no event; login only (STALE-A1) |
| command counts | — | store | no event, by ruling (issue 2584) |

Two consequences stand out. First, `show_peer_profiles`: the doc's justification covers opting IN ("no already-in-flight state to correct") and does not cover opting OUT. The gate is read from state on every future JOIN (`lib/grappa/session/event_router.ex:3702,3811,3859`), and a bouncer session lives for weeks. A user who turns the switch off therefore keeps sending CTCP USERINFO and AVATAR queries to joining peers until the next reconnect. Second, ignores and notify put the sync in the web layer. The context cannot be called from any other door without silently skipping the session, and the failure arm returns `:ok`.
**Impact:** a new setting has no default path. Its author picks the nearest sibling, and the four mechanisms have four staleness windows: zero, zero unless the call times out, the next reconnect, and never. The opt-out is the case with a consequence outside the user's own screen.
**Recommendation:** make the bridge the only path (T4). `UserSettings` broadcasts `{:user_setting_changed, key, value}` on `Topic.user_settings/1` from its single write path, `update_data/2` (`user_settings.ex:2256`), which already sees every key, and the session keeps a small table of the keys it holds. Mirror the same event on the user topic for the keys cic holds, so the rejoin hydration becomes the snapshot twin of a live event instead of the only source. Move the ignore and notify sync behind the context on the same bridge, which also removes the swallowed arm. Bring `show_peer_profiles` onto it.
**Evidence:** READ. Before the editor's reading, the reviewer INFERRED that the swallowed arm is reachable through a session call timeout; the editor read the 5 000 ms default (`session.ex:3006-3007`), so that arm is reachable whenever the session is busy for 5 s.
**Verified by editor:** partly. The sync helpers, their `:ok`-on-failure arms and the `show_peer_profiles` doc were re-read. The highlight, alias and notification-prefs rows were not.
**Filed issues:** new. Issue 2365 (a per-network `show_peer_profiles`) will change the same member and should land on the bridge.

### LOW

### STALE-A7. A network's `services_flavor` is copied into every live session, and an admin edit reaches none of them
**Severity:** LOW. **Scope:** `lib/grappa/networks/session_plan.ex:307`; `server.ex:1436`; `lib/grappa/networks.ex:691-695`; `lib/grappa_web/controllers/admin/networks_controller.ex:98-102`; readers `lib/grappa/session/flood_allowance.ex:125`, `lib/grappa/session/identity_state.ex:173`, `lib/grappa/session/event_router.ex:4167`.
**Problem:** issue 2724's shape, one level up. The admin PATCH and `mix grappa.set_network_caps` write `networks.services_flavor`, and each session holds a copy from its plan, so the edit applies per session at its next reconnect. `flood_allowance.ex:50-53` tells an operator to classify a network through that PATCH to get the oper exemption, without saying that live sessions do not see the change.
**Impact:** the flood allowance and the registered-umode letter stay on the old flavour for every connected session.
**Recommendation:** state the next-connect contract where the operator is told to use the PATCH (the issue 2724 ruling, applied here), or broadcast on a network-scoped topic; sessions already subscribe to `Topic.peer_avatar_cache(network_id)`.
**Verified by editor:** spot-checked (`server.ex:1436`). **Filed issues:** not filed.

### STALE-A8. `SourceAliasManager.arm/1` adopts the new prefix before the settings row is committed
**Severity:** LOW. **Scope:** `lib/grappa_web/controllers/admin/settings_controller.ex:223-228` (`arm_for` before `put_many`), `:416-423`; `lib/grappa/net/source_alias_manager.ex:207-211`; `lib/grappa/server_settings.ex:788-794`.
**Problem:** `arm/1` writes two copies (`state.prefix` and the arm `persistent_term`) on a successful probe and runs before `put_many/1`, which can answer `{:error, :db_unavailable}`. The request fails, the row keeps the old prefix, and the manager holds the new one until its next restart or the next successful save.
**Recommendation:** probe before the write and adopt after it; or have the manager hold no copy and read the prefix from `ServerSettings`.
**Verified by editor:** yes, ordering only. **Filed issues:** this is issue 2612, already filed with a measurement (503, manager armed on the unsaved prefix). The consequence on the OS adapters is still unread.

### STALE-A9. Peer profile and avatar cache entries never expire while the peer stays in a shared channel
**Severity:** LOW. **Scope:** `lib/grappa/session/event_router.ex:287-293`, `:3811-3840`, `:3859-3885`, `:1013-1027`, `:4912-4937`.
**Problem:** the cache is queried once per nick (key presence means "asked"), re-keyed on NICK, and dropped on QUIT or when the peer leaves the last shared channel. A peer who edits their profile or avatar while staying in a shared channel is never asked again, so the badge and avatar show the first answer for weeks.
**Recommendation:** a read-time age check on the entry, re-querying on the peer's next JOIN or message once it is older than N hours. No timer is needed.
**Verified by editor:** no (LOW). **Filed issues:** not filed. Issue 2027 is the opposite pressure on the same cache (evicted too often); a TTL design should weigh both.

---

## Class 2 — process lifecycle (`LIFE`)

The root is `:one_for_one`, which treats every child as independent; several are not. Start order, stop order and the partial-boot child set are held in comments. `terminate/2` carries bookkeeping that a kill or a supervisor shutdown skips. Reported: 0 CRITICAL, 1 HIGH, 6 MEDIUM, 2 LOW. Not re-reported: issue 2697 and PR 2718 (SourceAliasManager order, both directions), issue 2715 (a second SourceAliasManager under `start_app_silent/0`), and PR 2718's Q2 (a raise in `terminate/2` turns a `{:stop, :normal, _}` into a `:transient` restart).

### HIGH

### LIFE-A1. The release `remove-network` verb and the mix `unbind-network` verb stop a session in a VM that has none
**Concern:** lifecycle (partial boot acting on shared state)
**Severity:** HIGH
**Scope:**
- `lib/grappa/release.ex:160-168` (`cli/1` loads the app, starts the Vault and runs inside `with_repo`; nothing else)
- `lib/grappa/release/cli.ex:161-168` (`Networks.remove_network/2`), `:118-119` (usage: "Revokes that access and stops any live session for it")
- `lib/grappa/networks.ex:270-272` → `lib/grappa/networks/credentials.ex:1560-1584` (`Session.stop_session/3`, then `delete_all`)
- `lib/grappa/session.ex:742` (`send_quit` → `call_session` → `whereis/2`, `:482-487`, `Registry.lookup` outside any `try`), `:803-806` (`flush_pending_restarts/0` → `DynamicSupervisor.count_children(Grappa.SessionSupervisor)`)
- `lib/mix/tasks/grappa.unbind_network.ex:35-41`; `bin/grappa:75` (`unbind-network` is a `boot`-lane verb); `lib/mix/tasks/grappa/boot.ex:72-81`
- `lib/grappa/release/live_node.ex` (the hop `add-network` has and `remove-network` lacks; `cli.ex:255`)

**Problem:** "stop the live session, then delete the row" is one context function reached from three VMs, and only in one of them is there a session to stop.
- **Release lane (`grappa remove-network`).** The `eval` VM starts the Vault and the Repo, and starts neither `Grappa.SessionRegistry` nor `Grappa.SessionSupervisor`. `unbind_credential/2` calls `Session.stop_session/3` first.
- **Mix lane (`bin/grappa unbind-network`).** `start_app_silent/0` suppresses only Bootstrap and the Endpoint, so it starts a second, EMPTY registry and supervisor. `stop_session` answers `:ok` having stopped nothing, and the row is deleted under the live node's running `Session.Server`.
- `add-network` got `LiveNode.adopt/2` (#1685) for exactly this reason, and `Grappa.Operator` moved `reset_totp!` to the rpc lane for exactly this reason ("a verb that mutates live-node state belongs in the live node", `operator.ex:326-340`). The teardown half of the pair was left in the wrong lane.

**Impact:**
- Release lane: the verb crashes before the delete on every packaged install (jail, `.deb`, Docker image), whether or not a node is running. `CLITest` (`test/grappa/release/cli_test.exs:295-311`) is green because the test VM has the whole application started, so it cannot see this.
- Mix lane: the credential row goes and the live session stays, holding a cached `network_id` whose binding is gone. `credentials.ex:1561-1566` describes what that state does: the next outbound write crashes the handler, and the `:transient` restart re-reads an absent credential.
- The usage text promises the opposite.

**Recommendation:** give teardown the shape of `add-network`. The transient VM parses and validates, then one function call crosses to the live node (`LiveNode`-style `:erpc`, ids only) and runs `unbind_credential/2` there. With no live node, the transient VM deletes the row locally WITHOUT calling `stop_session`. Move `unbind-network` in `bin/grappa` to the rpc lane. Then audit the remaining boot-lane verbs (`remove-server`, `set-network-caps`, `update-network-credential`) for in-node effects that never reach the live node; their broadcasts were not traced.
**Evidence:** READ for which processes each lane starts and for the call chain. INFERRED: the exact exception in the release lane.
**Verified by editor:** yes, with a correction. The reviewer allowed that if `Registry.lookup/2` returned `[]` on an unstarted registry instead of raising, "the verb would silently delete the row". It would not. `stop_session/3` then reaches `flush_pending_restarts/0`, which calls the unstarted `Grappa.SessionSupervisor`, and that call exits `:noproc`. The release lane fails before the delete either way.
Measure: `grappa remove-network USER NET` on a release image, once with the daemon up and once with it down; and `bin/grappa unbind-network` on the dev stack with a live session, then `list-sessions`.
**Filed issues:** new. The mix lane is also a member of issue 2715's family (see LIFE-A6).

### MEDIUM

### LIFE-A2. SourceAliasManager's ref-counts and the holder Registry diverge in both directions, and only a manager boot repairs them
**Concern:** lifecycle (restart semantics; cleanup on a non-graceful death)
**Severity:** MEDIUM
**Scope:** `lib/grappa/net/source_alias_manager.ex:144-160` (`init/1`, `refcounts: %{}`), `:167-197` (acquire and release), `:260` (`held_addresses/1`); `server.ex:1707-1716`, `:1743-1749`; `lib/grappa/session.ex:872` (the `Process.exit(pid, :kill)` escalation in `terminate_and_await_down/3`)
**Problem:** the manager keeps an in-memory count per address, and each session keeps a `Grappa.SourceAliasHolders` Registry entry. The Registry is read in one place only, the reconcile diff, which runs once in `handle_continue` at manager start. Nothing rebuilds `refcounts` from the holders. Two divergences follow:
1. **Manager restart.** The tree is `:one_for_one`, so the sessions survive the restart, but `refcounts` comes back empty while N sessions still hold addresses.
   - A pre-restart holder that later terminates calls `release/1`, finds a count of 0, logs "release of unheld address — ignoring" and never unbinds the OS alias.
   - A NEW session that acquires an address an old session still holds takes the count from 0 to 1. When the new one stops, the 1→0 release unbinds the alias while the old holder's upstream socket is still bound to it. The moduledoc (`:228-260`) argues that the Registry prevents this, but the argument covers the reconcile only, not the prompt 1→0 path.
2. **Death without `terminate/2`.** `Session.stop_session` escalates to `Process.exit(pid, :kill)` after 5 s, and a supervisor shutdown brutal-kills a child after its 5 s budget. Neither path runs `maybe_release_source_alias/1`. The Registry entry is collected, but the count is never decremented, so that address can no longer reach 1→0 and stays bound for the life of the manager.

**Impact:** case 1b drops live IRC connections that share a derived address (several networks of one subject, or visitors collapsed behind one NAT) after any manager crash. Cases 1a and 2 leak OS aliases until the next manager boot. The scale depends on how many sessions run mode 2 with a shared address, which has not been measured on prod.
**Recommendation:** one source of truth for "who holds this address". The manager monitors the acquiring pid (the caller pid is in `from`), counts holders by monitor and drops a holder on `:DOWN`. At `init/1` it rebuilds the counts from `held_source_fn` before serving any call. That removes the release from `terminate/2` altogether, together with its `try/catch` (and with it PR 2718 Q2's hazard for this call, and LIFE-A3).
**Evidence:** READ. The socket-level consequence of an unbind under a live connection is INFERRED. Measure with the Mox adapter in `source_alias_manager_test.exs`: acquire A from pid1, kill and restart the manager, acquire A from pid2, release from pid2, and assert `release_source` was NOT called while pid1 lives.
**Verified by editor:** yes.
**Filed issues:** extends issue 2716. Case 1 is 2716 itself; case 2 (the kill path) and the monitor-based cure are new.

### LIFE-A3. `terminate/2` unbinds the source alias before it sends QUIT, on a call whose timeout is three times the shutdown budget
**Concern:** lifecycle (terminate-time cleanup order)
**Severity:** MEDIUM
**Scope:** `server.ex:1842-1883` (the `:shutdown` clause: release at `:1847`, `send_quit` at `:1857`); `lib/grappa/net/source_alias_manager.ex:70` (`@call_timeout 15_000`); `server.ex:84` (`use GenServer, restart: :transient`, so the default 5 000 ms shutdown)
**Problem:** the `:shutdown` clause runs, in order: lifecycle telemetry, the E2E drop, **the alias release**, the disconnect log and **the QUIT**. The release is a synchronous call into a mailbox that shells out per unbind, with a 15 s timeout, while the child's shutdown budget is 5 s. The QUIT is the only step a remote party observes, and it comes last. The linked `IRC.Client` still owns a socket bound to the address being unbound.
- On this sha it bites `stop_session/2` (`terminate_child` → `:shutdown`): the alias goes first, and then "grappa shutting down" is written to a socket whose source address was just removed.
- At node shutdown on this sha the release exits `:noproc` at once (issue 2697), so the QUIT still goes out. **PR 2718 makes the release real at shutdown.** Every mode-2 session then queues behind the manager's serial shell-outs BEFORE its QUIT, and any session still queued at 5 s is killed with no QUIT, no `:disconnected` log row and (LIFE-A2 case 2) an inflated count.

**Impact:** upstream sees a connection reset or a ping timeout instead of the quit line. With enough distinct aliases, a clean deploy degrades into brutal kills. PR 2718 is right about the stop ORDER between processes, and it exposes this order INSIDE the callback.
**Recommendation:** QUIT first, alias last, since the alias is only safe to drop once the Client is done with the socket. Better, per LIFE-A2: no release in `terminate/2` at all, because the manager's monitor fires after the session, and so its linked Client, is gone.
**Evidence:** READ for the statement order and both timeouts. INFERRED: that the QUIT is lost once the address is gone (this is kernel-dependent), and the queueing time at N sessions. Measure on the dev stack with one mode-2 session: stop it and read the testnet ircd's quit line; time a shutdown with K distinct aliases.
**Verified by editor:** yes.
**Filed issues:** extends issue 2697 (to be read with PR 2718).

### LIFE-A4. The outbound v6 pool is published by Bootstrap, the LAST child, and read by sessions the Endpoint can spawn earlier
**Concern:** lifecycle (a reader before its publisher)
**Severity:** MEDIUM
**Scope:** `lib/grappa/application.ex:164-168` (`OutboundV6Pool.boot/0` installs `[]`; the comment promises "before spawning any session"); `lib/grappa/bootstrap.ex:212-236` (`apply_outbound_pool/0`, after two DB reads and a validation that can raise); `lib/grappa/irc/client.ex:1957` (`OutboundV6Pool.pick/0` per connect); `lib/grappa/outbound_v6_pool.ex:47-80`
**Problem:** this is issue 2697's arm-gate shape, one seam over. The pool is `[]` from `start/2` until the Bootstrap Task has read the credentials, read the visitors, validated the servers and called `apply_pool/1`. The Endpoint is up before that, and with it every door that spawns a session (login, visitor login, `NetworksController.connect/2`). An empty pool means "kernel-default source selection" by design, so a session that connects inside the window egresses from the host's shared default address, silently and for the life of that connection. The comment's guarantee holds only for sessions Bootstrap itself spawns.
- The window is not always milliseconds. `application.ex:634-643` documents Bootstrap crash-looping on its credential read under a saturated pool (measured there at about 2.8 restarts/s); for that whole episode the REST doors work and the pool is empty.
- PR 2718 does not change this; Bootstrap stays last.

**Impact:** after a boot under load, pool-mode sessions run on the wrong source address, with no log line and no state that says so.
**Recommendation:** publish the pool before the Endpoint, from a small child after Repo (or a boot step once the Repo is up) that does what `apply_outbound_pool/0` does, and leave Bootstrap to spawn only. Pin "pool publisher before Endpoint" in PR 2718's order test (T6).
**Evidence:** READ for the order, the default and the reader. INFERRED: that a door is hit inside the window on a real boot. Measure: boot the dev stack with a populated pool and a sleep injected ahead of `apply_outbound_pool/0`, connect through REST, and read the session's local address in the admin sessions tab.
**Verified by editor:** yes.
**Filed issues:** new; the same family as issue 2697. A comment on issue 2697 was considered and rejected, because PR 2718 ends that issue's life without touching Bootstrap.

### LIFE-A5. Nothing re-adopts sessions when `SessionSupervisor` restarts, and four other restarts silently drop state their dependants assume
**Concern:** lifecycle (restart semantics under `:one_for_one`)
**Severity:** MEDIUM
**Scope:** `lib/grappa/application.ex:416-434` (the `SessionSupervisor` budget), `:652` (root `:one_for_one`, 80 restarts in 120 s); `lib/grappa/bootstrap.ex:158` (`use Task, restart: :transient`); `server.ex:4636-4640` (the detached `credential_failer`)
**Problem:** the root treats every child as independent, and several are not.
- **`SessionSupervisor`.** If it exhausts its 10 000-in-60-s budget (the comment at `:416-432` describes how) or crashes, it comes back EMPTY. Bootstrap is a Task that has already exited `:normal`, so it does not run again. The node stays up, `/healthz` has nothing to object to, and every credential still reads `:connected`. The sessions died with `:shutdown`, so each one logged a CLEAN disconnect.
- **`Grappa.TaskSupervisor`.** A restart kills in-flight detached tasks, including the `credential_failer`. The session has already stopped `:normal`, so the `:failed` write is lost and the next boot re-dials a k-lined credential (see FAIL-A7).
- **`Phoenix.PubSub`.** A restart drops every subscription. Sessions subscribe once in `init/1` and channels once at join, and neither re-subscribes.
- **`WSPresence`.** See STALE-A2.
- **`Identd.Bindings`.** A restart forgets every binding, and sessions publish once per connect.

**Impact:** each is rare. The first is a silent total outage of the product's one job, on a node that looks healthy.
**Recommendation:** group by dependency instead of adding rebuild code per child. Put `SessionRegistry`, `SourceAliasHolders`, `SessionSupervisor` and a re-runnable adopter under one `:rest_for_one` supervisor, so a restarted `SessionSupervisor` is followed by a fresh Bootstrap pass. For the rest, decide per child whether its dependants should die with it (`:rest_for_one`) or re-register on its `:DOWN`.
**Evidence:** READ for the strategies and the single registration sites. Not measured. Measure in the test tree: `Supervisor.terminate_child` plus `restart_child(Grappa.Supervisor, Grappa.SessionSupervisor)` on the dev stack, then count sessions.
**Verified by editor:** partly. The `SessionSupervisor` and Bootstrap legs and the `credential_failer` were re-read; the PubSub and `Identd.Bindings` legs were not.
**Filed issues:** new.

### LIFE-A6. `start_app_silent/0` is a two-item denylist: every other child also starts in the operator task's VM, against the shared DB, ports and files
**Concern:** lifecycle (partial boot; a second instance)
**Severity:** MEDIUM
**Scope:** `lib/mix/tasks/grappa/boot.ex:72-81`; `lib/grappa/application.ex:676-688` (identd children, gated on config only), `:465-513` (five Reapers, no flag); `lib/grappa/identd/listener.ex:127-143`, `:268-283`; `lib/grappa/visitors/reaper.ex:333-339`; `lib/grappa/uploads/reaper.ex:168`, `lib/grappa/avatars/reaper.ex:85`, `lib/grappa/dcc/reaper.ex:244`
**Problem:** issue 2715 is one member of a larger family. The helper names what NOT to start (Bootstrap and the Endpoint), so every child added since then inherits "runs in operator tasks too" without anyone deciding it. Other members:
- **`Identd.Listener`.** With identd enabled, the second VM listens on the port the live node holds. `init/1` returns `{:stop, {:identd_listen_failed, …}}`, the application fails to start, and every `mix grappa.*` task dies with "failed to start :grappa". That is the `:eaddrinuse` failure the `:start_endpoint` flag was added for (`boot.ex:20-28`), reintroduced by the next listener.
- **`Visitors.Reaper`.** It ticks every 60 s. A task that outlives one tick (`create_user` waiting at its password prompt, `repair_passwords`, `seed_scrollback`) runs a sweep whose `stop_session` is local, and therefore a no-op, and then deletes the visitor rows. The live node's reaper later finds no row, so those visitors' sessions are never stopped.
- **The Uploads, Avatars and DCC reapers** `File.mkdir_p!` their storage roots in `init/1` as whatever OS user ran the task, and sweep files the live node also sweeps.
- **`AdminEvents` (`persist: true`) and `SessionLog`** become second writers on the same tables.
- LIFE-A1's mix lane (a second, empty session registry) is the same family.

**Impact:** operator tasks break, or mutate live state, depending on which optional child is enabled and how long the task runs.
**Recommendation:** express the partial boot as an allowlist, as data. PR 2718's `children/1` takes flags; add an `:operator_task` profile (Vault, LockWatch, Repo, PubSub, and whatever the task's context functions call) and pin it with a test in the order-test file: "the operator-task child list is exactly this set". Fixing issue 2715 with one more `put_env` keeps the denylist.
**Evidence:** READ. INFERRED: that the second `listen` fails (`reuseaddr` does not allow two listeners on one address and port on Linux or FreeBSD), and the ownership of directories the task creates. Measure: enable identd on the dev stack and run `bin/grappa create-user`.
**Verified by editor:** yes.
**Filed issues:** extends issue 2715.

### LIFE-A7. Start order, stop order and the partial-boot child set are comments, not data a test can pin
**Concern:** lifecycle (structural)
**Severity:** MEDIUM
**Scope:** `lib/grappa/application.ex:205-518`; `test/grappa/application_supervision_tree_test.exs`; PR 2718's `test/grappa/application_child_order_test.exs`
**Problem:** on this sha the child list is an inline literal, and the only pin is that CLAUDE.md NAMES every running child (a superset check, with no order). PR 2718 adds `children/1`, `boot_flags/0` and an order test, which pins four relations of ONE child plus "the running tree == `children(boot_flags())`". After PR 2718 these remain comment-only:
- Vault before Repo, LockWatch before Repo, PubSub before Endpoint;
- SessionRegistry, SourceAliasHolders, Backoff, WSPresence, NetworkCircuit, AdminEvents, SessionLog, DbLatency, TaskSupervisor and the Coalescer before SessionSupervisor;
- ShareTokens, DailyQuota, FailureWindow, WebAuthnChallengeStore, E2ePairing, TokenBucket and PtrCache before Endpoint;
- identd: Bindings, then Acceptors, then Listener, all before Endpoint;
- Endpoint before SessionRevocationListener and the five Reapers; Bootstrap last.
- **No stop-order relation is stated anywhere except the one issue 2697 found.** Each "X before SessionSupervisor" above also means "X outlives every session's `terminate/2`", which is what `terminate/2` relies on for `Backoff.record_failure/2` (a `GenServer.call`), the telemetry sinks and the TaskSupervisor.
- Invariants that are not child order at all also have no pin: the 18 pre-tree `boot` seams (for example `Vhosts.boot` before the manager), the two post-tree writes (`Health.mark_ready` and `Uploads.boot_base_url`), the pool publish (LIFE-A4), the `eval` lane's restated order (`release.ex:214-218`), and `terminate/2`'s work against the 5 s shutdown budget (LIFE-A3).

**Impact:** each of issues 2697 and 2715 and LIFE-A4 and A6 is a relation nobody wrote down as something a machine could check.
**Recommendation:** state each dependency once, as data next to `children/1`: `{dependant, :needs_at_start | :needs_at_stop, dependency}`. One generic test walks the table against `children(@production_flags)`: for start the dependency's index is lower, and for stop it is also lower, since stop runs in reverse. The comments then explain rows instead of being the rows (T6).
**Evidence:** READ.
**Verified by editor:** yes, on this sha. PR 2718's test was not re-read by the editor.
**Filed issues:** new.

### LOW

### LIFE-A8. Four telemetry sinks assert `:ok = :telemetry.detach/1` in a `terminate/2` that rarely runs, on a false premise about its return
**Severity:** LOW. **Scope:** `lib/grappa/admin_events.ex:213`, `lib/grappa/session_log.ex:286`, `lib/grappa/db_latency.ex:378`, `lib/grappa/push/vendor_log.ex:98`; `lib/grappa/repo/lock_watch.ex:811-814`.
**Problem:** `detach/1` on an unknown id returns `{:error, :not_found}`, so with `attach_telemetry: false` (the whole test env) a sink crash raises `MatchError` in `terminate/2` and replaces the real crash reason. None of the five sinks traps exits, so on a supervisor shutdown `terminate/2` does not run at all: `init/1`'s detach-then-attach is what keeps the handler table clean. `LockWatch.terminate/2` likewise runs only on a crash, where it does a `persistent_term` put exactly when the node is in trouble (#1715).
**Recommendation:** delete the four callbacks or match `_ =`; decide whether LockWatch's is wanted.
**Verified by editor:** yes (four sites by grep; `trap_exit` is set only in `Session.Server`). **Filed issues:** this is issue 1613 (measured there in a test log) and issue 1334 (the same `MatchError` in `SessionLog`), widened to four sinks.

### LIFE-A9. Every non-graceful session death skips all of `terminate/2`'s bookkeeping, and three callers produce one on purpose
**Severity:** LOW. **Scope:** `server.ex:1842-1921`; `lib/grappa/session.ex:872` (the kill escalation); `server.ex:1906-1909`.
**Problem:** `terminate/2` is the single funnel for `Backoff.record_failure`, the `:terminated` lifecycle event (the admin live counts), the `:disconnected` session-log row, the E2E "dropped unsent" notices and the alias release. Three deaths skip it: the `:kill` escalation in `stop_session`, the supervisor's own 5 s brutal kill, and a raise earlier in the callback (`:ok = drop_e2e_pending(state)` comes before the release and the log). The comment at `:1906-1909` says every case "we care about" reaches it.
**Recommendation:** move what must survive a kill to an observer that monitors the session (the manager, for aliases, per LIFE-A2); keep the QUIT in `terminate/2`.
**Verified by editor:** yes (the three clauses and the escalation re-read). **Filed issues:** not filed separately; carried with LIFE-A2's comment on issue 2716.

---

## Class 3 — failure surfacing (`FAIL`)

The token vocabulary itself is in good order. `ErrorJSON.rest_error_token` and `channel_error_token` are derived and pinned (`error_tokens_drift_test.exs`), generated into `wireTypes.ts`, and both client switches end in `assertNever`. The findings are about what happens around that vocabulary: failures that never become a token, tokens nobody listens for, and waits with no exit. Reported: 0 CRITICAL, 1 HIGH, 5 MEDIUM, 1 LOW. Not re-reported: issues 2719, 2723, 2725 and 2726.

Where failures go today (grep census, READ; multi-line forms are under-counted):

| Server mechanism | Count | Reaches the operator | Reaches the user |
|---|---|---|---|
| `FallbackController.call/2` clauses | 94 clauses, one per error shape | no log by itself | yes, a typed token |
| an unknown `{:error, _}` at `action_fallback` | raises by design | yes (500 + crash log) | Phoenix's status envelope, not a token |
| `GrappaChannel` reply arms `{:error, %{error: "..."}}` | ~60 literal sites | only one catch-all logs | a typed token, if the client listens |
| `rescue` / `catch` blocks | ~35 files | mostly logged | n/a |
| detached `Task.Supervisor.start_child` | 11 call sites | a crash gives a SASL report; an `{:error, _}` return gets whatever the closure logs | never |
| `_ =` on a possibly-error return | 79 sites | depends on the site | never |

| Client mechanism (`cicchetto/src`, tests excluded) | Count |
|---|---|
| `catch {` blocks | 258 |
| `.catch(` | 80 (15 empty or no-op) |
| floating `void fn()` calls | 190 |
| `console.warn` / `console.error` | 129 / 15 |
| `setError(` (a per-component signal) | 172 |
| token→copy mappers | 5 |
| toast queues | 6, of which 3 are the same `{ message: string }` failure queue |
| raw `await fetch(` | 105 in `api.ts`, plus ~65 in 12 other modules |
| `AbortController` / `signal:` in `api.ts` | 0 |
| an `unhandledrejection` / `window.onerror` handler | 0 |

### HIGH

### FAIL-A1. Seven promise-returning channel pushes have no `timeout` arm and no REST call has a deadline: the client has awaits that cannot settle
**Concern:** failure surfacing
**Severity:** HIGH
**Scope:**
- `cicchetto/src/lib/socket.ts:1010-1021` (`pushAwaySet`), `:1023-1034` (`pushAwayUnset`), `:1080-1091` (`pushUserChannelVerb`, the shared body of op/deop/voice/devoice/kick/ban/unban/mode/umode and `topic_clear` at `:1214`), `:1229-1239` (`pushOper`), `:1246-1256` (`pushRaw`)
- for contrast, the same file: `resolveUserhost` (`:1162-1178`) and the three watchlist pushes (`:1415-1446`) DO carry `.receive("timeout", () => reject(new Error("timeout")))`
- `cicchetto/src/lib/api.ts`: 105 `await fetch(` and no `AbortController` or `signal` (the two grep hits for `signal` are comments at `:1682` and `:2015`); likewise `userSettings.ts`, `themesApi.ts`, `push.ts`, `e2e/pairing.ts`, `readCursor.ts`
- the consumer: `cicchetto/src/lib/compose.ts:1147-1180` `await`s these verbs inside the submit; `:1413-1464` (the #904 pump); `:436-438` (`isSending`, `isQueueFull`); `cicchetto/src/ComposeBox.tsx:500`, `:638`, `:734` (`readOnly` when the queue is full)

**Problem:** the "no silent drops" work (#154, #62, #364) converted fire-and-forget pushes into promises that resolve on `ok` and reject on `error`. Half of them stopped there. A phoenix.js push that gets no reply fires only its `timeout` hook, and with no hook registered the promise is neither resolved nor rejected. The cases that produce no reply are exactly the failure cases: a half-open socket, a `handle_in` that crashes the channel process, a server stalled on the SQLite write lock. For REST there is no seam at all where a deadline could live, since every call is a hand-written `fetch`, so a stalled request waits for the browser's own limit.
**Impact:**
- A `/kick`, `/mode`, `/away`, `/oper` or `/quote` sent into a dead socket shows neither the green tick nor an error, and the submit `await` never returns.
- **Editor's addition.** That await is the head of the composer's per-window outbox (`compose.ts:1413-1464`). While it is pending, `isSending(key)` stays true. The operator's next Enter is parked in the one-deep slot, the one after that is refused ("one message is already waiting"), and ComposeBox turns the textarea `readOnly`. One unanswered push therefore locks that window's composer until a reload.
- The four helpers that do have a timeout arm show that the shape was known and applied by copy, which is why it is half applied. Each new push helper is a coin flip on which neighbour it copies.

**Recommendation:**
1. One `pushWithReply(channel, event, payload)` in `socket.ts` that owns `ok`, `error` and `timeout`; delete the per-helper promise bodies. The fire-and-forget pushes stay explicit and are named as such.
2. One `request()` in `api.ts` that owns headers, a default deadline (`AbortSignal.timeout`), `readError` and the mapping of non-`ApiError` failures (FAIL-A6). The ~170 call sites become one-liners, and the 2026-11-21 carry-overs (prior abstraction A5 `readError` bypasses, A8 `api.ts` size, A18 transport spread) are paid at the same seam. See T3.

**Evidence:** READ for the missing arms, the missing signals and the outbox gate. INFERRED for "never settles" (phoenix.js `Push` semantics, not re-read in `node_modules`). Measure with a vitest case per helper using a fake channel whose push never replies, asserting the promise settles under fake timers; and a compose test asserting the textarea is not left `readOnly` after such a push.
**Verified by editor:** yes.
**Filed issues:** new. The same "wait with no exit" family as issue 2723.

### MEDIUM

### FAIL-A2. `:no_session` carries three different facts, one of them "your request crashed the session", and every door renders it as absence
**Concern:** failure surfacing
**Severity:** MEDIUM
**Scope:** `lib/grappa/session.ex:3009-3037` (`call_session/4`), specifically the `:exit, _ -> {:error, :no_session}` arm at `:3033-3034`; `lib/grappa_web/controllers/fallback_controller.ex:565-576`; `cicchetto/src/lib/friendlyApiError.ts:214-215`; `cicchetto/src/lib/friendlyChannelError.ts` (the `no_session` arm)
**Problem:** `call_session` returns `:no_session` for (a) `whereis` → nil, the parked or failed network of issue 2725; (b) a clean stop racing the call; and (c) **any** exit of the callee during the call, including a crash raised by the very request being served. Case (c) is the wide catch that CLAUDE.md "No silent-swallow at boundaries" (b) names. It was added for one incident (a 433 crash that 500'd `GET /networks`) and absorbs every later crash class. The operator still gets the GenServer crash report, but nothing ties it to the HTTP request, which is logged as a clean 404.
**Impact:**
- A `handle_call` bug presents to the user as "That network or resource doesn't exist." and to request-level monitoring as a 404, not a 5xx. A crash-on-request loop is invisible in status-code metrics.
- It bounds the cure for issue 2725. A precise owner-facing token for `:no_session` would say "not connected" for a session that just crashed under the caller: less false than "doesn't exist", but still not what happened.

**Recommendation:** split at the source, not at the controller. `:noproc`, `:normal` and `:shutdown` stay `:no_session`. Any other exit reason returns a distinct tag (for example `:session_crashed`) that maps to a 5xx token with its own copy, plus a `Logger.error` naming the subject, the network and the request. Issue 2725's decision then has to cover only the genuine "no live session" fact.
**Evidence:** READ. Measure with a `Session` test whose callee raises inside `handle_call`, asserting the facade's return and the controller status.
**Verified by editor:** yes.
**Filed issues:** extends issue 2725; it is the precondition the issue's own "which other `:no_session` producers exist" question leads to. It shares `call_session/4` with issue 2242.

### FAIL-A3. `{:error, :persist_unavailable}` reaches `action_fallback` with no clause, and the fallback's accepted shapes are checked against nothing
**Concern:** failure surfacing
**Severity:** MEDIUM
**Scope:** `lib/grappa/session/persistor.ex:135-137` (returns it); `server.ex:4848-4861` (the PRIVMSG arm), `:5115-5120` (`persist_and_send_fragments/6`), `:4941-4946` (CTCP), all passing `{:error, _}` through; `lib/grappa/session.ex:952-956` (the `send_privmsg/4` spec omits it); `lib/grappa_web/controllers/messages_controller.ex:462-466`; `lib/grappa_web/controllers/fallback_controller.ex` (94 `call/2` clauses, none for it and no catch-all; `grep persist_unavailable lib/grappa_web test/grappa_web` gives 0 hits); also `send_transport_error :: … | :inet.posix()` (`session.ex:250`), which `fallback_controller.ex:831-837` admits is unmapped
**Problem:** a send's failure under SQLite saturation is a typed, deliberate degradation everywhere below the web layer: `:db_unavailable` becomes `:persist_unavailable`, which is logged and counted by the #1429 census. At the web layer it falls off the end. `FallbackController` has a designed `db_unavailable` 503 with `retry-after: 1`, but the atom a send actually returns is the renamed one, so the fallback raises `FunctionClauseError`. Structurally, `action_fallback` dispatch is dynamic, so neither Dialyzer nor the token drift test connects what the facades return with what the fallback accepts. The drift test pins **emitted wire strings**, not **accepted input atoms**. The moduledoc's "unknown shapes intentionally raise" is a sound default that has become the actual handler for a known, expected and retryable state.
**Impact:** during a write-lock hold, a message send answers 500 with Phoenix's status envelope. (The field scale for those holds is the 29 holds of 31.1–94.1 s logged on 2026-09-08.) cic renders the drift-guard text `500 Internal Server Error` instead of the retry copy, and the operator gets a crash report for a state the engine has already logged as transient.
**Recommendation:** add the clause (the same 503 body as `db_unavailable`; no new token, so no protocol bump) and fix the facade spec. Then close the class with a test that collects the error atoms in the `@spec`s of the facade functions controllers call, and asserts that each has a `call/2` clause or sits on a short, commented "handled in the controller" list. That test is only as good as the specs, which is issue 2242's subject.
**Evidence:** READ for the return path and the missing clause. INFERRED: the 500. Measure with a `MessagesController` test with the persist seam forced to `:persist_unavailable`.
**Verified by editor:** yes.
**Filed issues:** new; related to issue 2242 (specs that deny the errors they can return).

### FAIL-A4. A window can stay `:pending` for the life of the session: the in-flight JOIN has a TTL, the state it created does not
**Concern:** failure surfacing
**Severity:** MEDIUM
**Scope:** `server.ex:8728-8762` (`record_in_flight_join/2`, `@in_flight_join_ttl_ms 30_000`, swept lazily on the next record); `lib/grappa/session/window_state.ex` (no expiry verb); `lib/grappa/session/event_router.ex:2133-2170` (failure numerics correlate **only** against `in_flight_joins`; an uncorrelated one has no effect); `cicchetto/src/lib/windowState.ts:88`; `cicchetto/src/Sidebar.tsx:590`
**Problem:** a JOIN writes two things: an `in_flight_joins` entry and `window_state = :pending` (broadcast as `window_pending`). The entry is swept lazily after 30 s, and only when the *next* JOIN is recorded; the sweep just drops it. Nothing moves the window out of `:pending`, and nothing is broadcast. After the sweep, a late failure numeric no longer correlates (#1345 delegates only correlated ones), so the one event that could have ended the wait is routed elsewhere. A grep finds timers for pending auth, ghost recovery, LIST refresh, recover and DCC offers, and none for a pending window.
**Impact:** on upstream silence (a throttled or dropped JOIN, a forward the router does not model, a numeric arriving after 30 s) the sidebar row stays greyed "pending" until the session restarts. cic cannot fix it, because by invariant it never originates state. This is the server-side twin of issue 2723: a question asked with no bound on the answer (T5).
**Recommendation:** make the TTL a transition, not a map eviction. When an in-flight entry expires and the window is still `:pending`, call `set_failed(…, :timeout, nil)` and broadcast `join_failed`. Drive it from the existing sweep points plus one `send_after` armed while the map is non-empty, so no per-join timer is needed. `:failed` already has copy and a retry affordance on the client.
**Evidence:** READ for the absence of any `:pending` exit other than the join echo, a failure numeric or a part. INFERRED: the user-visible stuck row. Measure with a session test against `Grappa.IRCServer` that swallows the JOIN, asserting a terminal window event within the TTL.
**Verified by editor:** yes.
**Filed issues:** new; related to PHASE-A1 (the same symptom across a process restart).

### FAIL-A5. The WebSocket door answers the same failures in a second, vaguer vocabulary, mostly without a log line, and the client discards two of the replies
**Concern:** failure surfacing
**Severity:** MEDIUM
**Scope:** `lib/grappa_web/channels/grappa_channel.ex:1045` (`{:error, _}` → `"lookup_failed"`), `:1467` (`"open_failed"`), `:1514` (`:db_unavailable` → `"close_failed"`), `:1597`, `:1612` (`"save_failed"`), `:2171` (`{:error, _}` → `"persist_failed"` on `Session.send_topic`), against `:2316-2325` (the only catch-all that logs before answering `"upstream_unavailable"`). Client: `cicchetto/src/lib/socket.ts:1036-1051` (`open_query_window` and `close_query_window` pushed with no `.receive`); `cicchetto/src/lib/friendlyChannelError.ts` (the `open_failed`, `close_failed` and `persist_failed` arms)
**Problem:**
- **Two words for one fact.** A session-call timeout is `session_timeout` (504, with `retry-after`) on REST and `lookup_failed` or `persist_failed` on WS. A dead upstream socket is `upstream_unreachable` on REST and `upstream_unavailable` or `persist_failed` on WS. A busy DB is `db_unavailable` (503, retryable) on REST and `close_failed` or `save_failed` on WS. `shared_error_token` holds four tokens, and the transport failures every verb can hit are not among them.
- **Catch-alls that hide the reason from both audiences.** Five of the six `{:error, _}` arms above reply without logging, so the operator cannot tell a timeout from a changeset from a transport error, and the user gets "Try again".
- **Copy that misdescribes.** On `topic_set`, `persist_failed` is reached by `:no_socket | :closed | :timeout | posix` (the spec at `session.ex:1721-1722` contains no persistence error at all), while cic's copy says "Couldn't save that change."
- **Replies nobody hears.** `open_failed` and `close_failed` exist, are pinned, generated and have copy, yet the only client pushes for those events register no `receive`. The close path also relies on the `query_windows_list` broadcast as "the authoritative update"; when the delete fails there is no broadcast either, so the window simply stays.

**Impact:** "one feature, one code path, every door" holds for the success path and not for the failure path. Third-party clients (`docs/CLIENT_PROTOCOL.md`) must special-case the same condition per transport. Dead copy passes `tsc` and the drift test, so the generated contract certifies arms that cannot fire.
**Recommendation:** move the transport-level failures (`session_timeout`, upstream down, `db_unavailable`) into `shared_error_token`, and map them once, in a channel-side twin of `FallbackController` (`GrappaChannel.error_reply/1`) that every `else` arm delegates to. Make its catch-all log, as `:2316` does. The tokens are additive, so this costs one protocol bump. On the client, FAIL-A1's `pushWithReply` gives `open_query_window` and `close_query_window` a listener; otherwise declare them fire-and-forget and have the server stop replying.
**Evidence:** READ. Measure the unlogged arms by grep; a channel test forcing `Session.send_topic` → `{:error, :timeout}` shows the token.
**Verified by editor:** yes (the six arms, the logging catch-all and the two receive-less pushes re-read).
**Filed issues:** new.

### FAIL-A6. The client has a token vocabulary but no error sink: anything that is not an `ApiError` or a `ChannelPushError` has no designed home
**Concern:** failure surfacing
**Severity:** MEDIUM
**Scope:** `cicchetto/src/lib/friendlyError.ts:40-48` (an untyped throw → `"send failed"`); `cicchetto/src/lib/friendlyApiError.ts:71-75` (`errorMessage`: `Error` → `value.message`), `:99-103` (`operatorApiError`: non-`ApiError` → a caller-supplied fallback); `cicchetto/src/lib/api.ts:1730-1764` (`readError`: the status envelope → `code = "Internal Server Error"`); `cicchetto/src/lib/audioPlayer.ts:282`, `lib/opsMenu.ts:30`, `lib/messageMenu.ts:53` (three identical `createToastQueue<{ message: string }>()` failure queues); `cicchetto/src/lib/socket.ts:853-858`, `:923-930`, `:943-949` (a channel join `error` or `timeout` goes to `console.error` only); `cicchetto/src/main.tsx` (no `unhandledrejection` listener; `BootErrorBoundary` covers render-time throws only)
**Problem:** typed server errors are handled well. Everything else is decided per call site, and the classes that fall outside the typed ones are the common ones:
- **Network failure.** `fetch` rejects with a `TypeError`. Depending on the pane, the user reads "send failed", the browser's own string ("Failed to fetch" or "Load failed"), or a per-verb fallback: three policies, none of which says "you are offline".
- **Unmapped server failure.** A 500 becomes `ApiError(500, "Internal Server Error")`, an unknown code, so the drift guard prints `500 Internal Server Error`. The drift guard is doing duty as the 5xx handler (FAIL-A3 is one producer).
- **Push timeout.** Where an arm exists, it rejects with `new Error("timeout")`, which reads "send failed" on the send door and the literal "timeout" elsewhere.
- **Channel join refusal or timeout.** These are logged to the console only. For a per-channel topic, which is the live-row feed, the pane keeps its REST history and receives nothing, with no indicator (INFERRED).
- **Floating promises.** 190 `void fn()` calls and no global rejection handler: a rejection in any of them is a console line at best.
- **No shared "action failed" surface.** `toasts.ts` is a deliberate factory with separate lifetimes, which is sound, but three producers have re-declared the identical failure queue, and 172 `setError` sites each own a private signal. A door with neither (issue 2719's `performJoin`, the ~40 catches in issue 2726) has nowhere cheap to send a failure, so it logs.

**Impact:** issue 2726 audits the catches one by one. Without a sink, each fixed catch needs its own UI, and the next door added will again pick `console.warn` because it is the only zero-cost option. Issue 2726's remedy is per site; the reason the problem recurs is here.
**Recommendation:**
1. One `describeFailure(e: unknown): string` over a closed client-side union (`ApiError | ChannelPushError | offline | timeout | server_fault | unknown`), produced by FAIL-A1's `request()` and `pushWithReply()`, so no call site inspects a `TypeError` or an `Error("timeout")` again. The surface-specific overrides in `friendlyError` and `errorMessage` stay as thin wrappers.
2. One identity-scoped `actionFailures` toast queue (`reportActionFailure(e)`) replacing the three duplicates: the default sink for a user action with no inline error slot.
3. A `window` `unhandledrejection` listener that routes to the same sink, or at least a single loud console prefix, so a floating promise is no longer silent by default.
4. A channel join `error` or `timeout` feeds the existing connection or window state instead of the console.

**Evidence:** READ for the mappers, the queues, the join handlers and the absence of a rejection listener. INFERRED: the dead-pane consequence of a failed channel join (phoenix.js rejoin behaviour not re-read). Measure with vitest rendering each door with `fetch` rejecting a `TypeError`, and an e2e spec with the per-channel join refused.
**Verified by editor:** yes.
**Filed issues:** extends issue 2726, as its structural precondition.

### LOW

### FAIL-A7. Detached tasks whose result *is* the state change leave no trace on that state when they fail
**Severity:** LOW. **Scope:**
- `lib/grappa/session/event_router.ex:3923-3939` and `lib/grappa/avatars.ex:153-171`: `avatar_slug: :pending` is set before the fetch, and a failed fetch logs at `info` and broadcasts nothing. `maybe_query_avatar` skips any nick that has the key, so the fetch is never retried for the life of the session.
- `lib/grappa/visitors/login.ex:249-256` and `lib/grappa/visitors.ex:1236-1262`: a network skipped at visitor autoconnect is only a `Logger.warning`.
- `lib/grappa_web/controllers/session_controller.ex:263`, `:332`: the rollback of a failed attach or revive is discarded with `_ =` and not logged at the site.
- `server.ex:1245-1248`, `:4636-4640` and `lib/grappa/networks.ex:1366-1385`: the terminal `:failed` write runs detached; a crashed task leaves the row in its previous state, so boot respawns the session (see LIFE-A5).

**Recommendation:** for each site, the cheapest honest outcome: reset the avatar key or stamp a retry-after; send a user-topic event for an autoconnect skip; log a warning on the rollback discard; wrap `mark_failed_by_ids` in `BusyRetry` if it is not already (not verified).
**Verified by editor:** partly (the avatar site). **Filed issues:** not filed.

---

## Class 4 — connection-phase windows (`PHASE`)

The phases, as used throughout:
- **P0**: the process is alive and `client: nil` (the backoff wait, `server.ex:1618-1636`; the prod base is 5 s and the cap 300 s, `backoff.ex:184-185`).
- **P1**: the Client is alive, the socket is up or connecting, and `registered_at == nil`.
- **P2**: `registered_at` is set and `autojoin_defer_timer` is a ref (the +r wait, with a 60 s ceiling, `server.ex:285`).
- **P3**: registered, and the join plan has fired.

One fact frames everything: **each connection attempt is one `Session.Server` process.** The Client is started once (`server.ex:1671-1689`), its abnormal EXIT stops the session (`server.ex:3746-3754`), and the supervisor restarts it with fresh `init/1` state. So "a later phase transition" means two different things: 001 in the same process, or a brand-new process after a failed attempt. On a failing network the second is the common one.

Reported: 0 CRITICAL, 2 HIGH, 4 MEDIUM, 3 LOW. Since 2026-11-21 the class received three point fixes: issue 2114 (a queue with no Client), issue 2703 with PR 2720 (hold until 001), and issue 2721 with PR 2727 (PART). None is re-reported.

### HIGH

### PHASE-A1. A held JOIN is answered 202 and dies with the connection attempt
**Concern:** phase windows
**Severity:** HIGH
**Scope:** `server.ex:8487-8548` (`join_channels/3`, `hold_until_registered/3`), `:8663-8666` (`queue_join/3`, process memory only), `:1336` (`queued_joins: []` at init), `:3746-3754` (a Client EXIT stops the process), `:1910-1921` (the abnormal `terminate/2`, which announces nothing for held channels); `lib/grappa_web/controllers/channels_controller.ex:123-146`; `cicchetto/src/lib/windowState.ts:74-90`; `cicchetto/src/lib/userTopic.ts:1673-1694`
**Problem:** issue 2703 holds a pre-001 JOIN in `state.queued_joins` and replies `:ok` (202) after broadcasting `window_pending`. The queue is process memory only. `ChannelsController.create/2` does not write the channel to `autojoin_channels`, and `last_joined_channels` is written only on a real change of the joined set. When the attempt the JOIN was held for fails (connect refused, timeout, TLS error, k-line, the 433 ladder's exit), the Client exits, the session stops, and the restarted process boots with `queued_joins: []` and an empty `WindowState`. The JOIN is gone. The controller doc says "the session holds it and sends it at 001" and leaves "the 400 `not_connected` … to the case the session cannot outlive"; a failed attempt is exactly a case the session does not outlive, and it answers 202.
On the cic side nothing clears the mirror. `windowStateByChannel` is reset only on an identity change, and the `connection_progress "connecting"` arm sets the reconnecting badge and clears lusers, not window state. The `:pending` pseudo-row stays until a page reload, for a JOIN no process remembers.
**Impact:** the scenario issues 2114 and 2703 were filed for (ten JOINs during a backoff wait) is fixed only when the very next attempt registers. Issue 2724 measured these windows as minutes wide on a failing network, which means several attempts. Every attempt boundary silently drops user intent that was acknowledged, and leaves a cic view the server contradicts. It is the same class as the forever-`:pending` window issue 2703 set out to remove, one process later. The same holds for every other in-memory acknowledgement made in P0 or P1 (`:invited` and `:failed` window states, a P0 auto-away, `away_nick_restore`), but the JOIN is the one that comes with a 202 and a visible row.
**Recommendation:** pick one, and do not add a third store:
1. Make a held JOIN durable where the plan already reads from: write it into the snapshot that `init/1` merges (`last_joined_channels`) at hold time, and let the existing PART and failure paths take it out. The +k key is the 20% that does not fit, because keys are not persisted by ruling; a keyed held JOIN would have to fail loudly instead.
2. Or keep it volatile and say so. When `terminate/2` sees a non-empty queue, broadcast a terminal window event per held channel (`join_failed`, with the reason "connection attempt failed"), as `drop_e2e_pending/1` already does for E2E messages that die with the process. This is the cheaper cure and reuses an existing pattern.

Independently of either, cic should drop non-terminal window state for a network on `connection_progress "connecting"`, or the server should broadcast the reset, because the server's `WindowState` really is empty at that moment (T2).
**Evidence:** READ for the queue's lifetime, the init state, EXIT→stop, the controller not persisting and cic having no reset. Measure with a `Grappa.IRCServer` test: spawn with a backoff count above 0, call `Session.send_join` during the wait, make the fake server refuse the connect, and assert on the restarted process's `:sys.get_state(pid).queued_joins` and on the user-topic events seen. Today the expectation is `[]` and no terminal event.
**Verified by editor:** yes, including the cic reset paths.
**Filed issues:** new; related to FAIL-A4.

### PHASE-A2. P1 is treated as writable by every verb except JOIN (and PART, since PR 2727)
**Concern:** phase windows
**Severity:** HIGH
**Scope:** `server.ex:2024-2035` (the `%{client: nil}` refusal, seven verbs, P0 only); `:2037-2047`, `:2064-2069`, `:2176-2186`, `:2210-2227` (persisting sends); `:4848-4861`, `:5046-5120` (`persist_and_send_fragments`); `:2076-2117`, `:9316-9330` (E2E send, ask and answer); `lib/grappa/irc/client.ex:496-502` (`send_line/2` writes whenever it has a Client pid), `:1481`
**Problem:** the only phase gate on the message verbs is `client: nil`, which is P0. Its own comment (`server.ex:2012-2017`) states the rule: "there is nothing to write to, so a row would be a line the operator reads as sent that never left". The rule is equally true in P1, where a Client exists but the ircd has not registered us. The Client has no registration gate, and `grep 451` over `lib/grappa/session` and `lib/grappa/irc` finds only the two comments in the JOIN hold. So in P1:
- `send_privmsg`, `send_ctcp`, `send_notice` and `send_statusmsg` persist a scrollback row, broadcast it to every device, open the query window (`maybe_open_query_window`), return `{:ok, message}`, and write the line to an unregistered socket.
- `send_e2e` is accepted (the reply means ACCEPTED), and its lines are released by the pacer and written. `tell_e2e_dropped/5` fires only on a refused write or a late deadline, so the "never left, despite the 202" promise does not cover a line the ircd discards.
- `e2e_ask` and `e2e_answer`: `send_consent/6` commits the `E2eRequests` row (a live request with a 24 h deadline) for a request that was never delivered.

P1 is not a millisecond window. It spans DNS, the TCP/TLS connect (a 30 s timeout, `client.ex:1545`), CAP and SASL, and the wait for 001. CLAUDE.md records, as a known gap, that a socket which connects but never registers has no watchdog.
**Impact:** a message shown as sent in every client that never reached anybody, with at best an unrelated `$server` line as its trace. For E2E, the consent state machine and the peer disagree for up to 24 h. The JOIN and PART fixes established "pre-001 lines are wrong" as the rule, while four sibling send verbs and three E2E verbs still follow the old one. The family is half migrated, which is the state CLAUDE.md calls worse than not migrated.
**Recommendation:** replace the `%{client: nil}` clause with one phase clause that refuses the same seven verbs whenever the session is not registered (PHASE-A4's predicate), with a reply that says so. Refuse rather than queue: unlike a JOIN, a chat line has no idempotent "desired state", and a multi-minute hold would deliver stale text. `:copy_e2e` and `:e2e_dismiss` stay out, for the reasons their comments already give.
**Evidence:** READ for the code paths (there is no gate between the door and `transport_send`). INFERRED: that the ircd answers 451 and discards (true of bahamut and solanum to the reviewer's knowledge, not measured here). Measure with a `Grappa.IRCServer` session test that withholds 001, calls `Session.send_privmsg/4`, and asserts no row and an error; today the expectation is a row and `{:ok, _}`.
**Verified by editor:** yes.
**Filed issues:** new.

### MEDIUM

### PHASE-A3. A JOIN in P2 skips the +r wait that the same JOIN gets in P1
**Concern:** phase windows
**Severity:** MEDIUM
**Scope:** `server.ex:8487-8491` (`join_channels/3`), `:8561` (`registration_pending?/1`), `:8227-8231` (the issue 2114 comment), `:8237-8256` (`maybe_autojoin_or_defer/1`), `:3851-3861` and `:3942` (the 001 handler runs the plan or arms the defer, then stamps `registered_at`)
**Problem:** `registration_pending?/1` is true only while `registered_at` is nil. The 001 handler arms the defer timer and stamps `registered_at` in the same callback, so from the next message on (P2) a JOIN takes `write_join/3` and goes straight to the wire. The comment on `maybe_autojoin_or_defer/1` states the opposite intent: "A queued JOIN needs the +r wait for exactly the reason the operator set does (a +R channel 477s an unidentified user)". So a `/join #registered-only` typed just before 001 waits for the identify and succeeds, while the same JOIN typed just after 001 is sent unidentified and fails with 477, and nothing retries it when +r lands. P2 lasts until +r or 60 s; issue 2380 logged a 29 s case.
A second-order effect: a P2 JOIN of a channel that is also in `state.autojoin` is written now and again when the plan fires, because `join_plan/1` dedups only against `queued_joins`.
**Impact:** one user action has two outcomes, decided by which side of 001 the request landed on. The invite-link flow (connect, then join) that issue 2703 names is the likeliest to land in P2 on a NickServ-identify credential.
**Recommendation:** the hold condition is "the join plan has not fired", not "001 has not come". Make `join_channels/3` hold in P0, P1 and P2, which is one more arm on the same predicate; `fire_join_plan/1` already drains the queue at the P2→P3 edge. PR 2727's PART gate should then use the same condition for its "do not write PART" branch, and keep the local half unconditional, which it already is (see PHASE-A8).
**Evidence:** READ. Measure with a session test using `auth_method: :nickserv_identify`, a non-empty autojoin and a long `autojoin_defer_ms`: send 001, then `Session.send_join`, and assert the fake server sees no JOIN until the +r MODE echo. Today it sees the JOIN at once.
**Verified by editor:** yes.
**Filed issues:** new.

### PHASE-A4. "Which phase am I in" is re-derived per verb, six different ways
**Concern:** phase windows
**Severity:** MEDIUM
**Scope:** `server.ex:2024` (the `%{client: nil}` head, seven verbs → `:no_socket`); `:2488` (`client: nil` → `:not_connected`, under a comment at `:2474-2476` that equates it with "pre-001, parked, or mid-reconnect"); `:8561` (`Map.fetch(state, :registered_at) == {:ok, nil}`); `:4458`, `:6266`, `:6502`, `:6942` (`Map.get(state, :registered_at)` nil or non-nil, with the opposite hot-reload default); `:8310-8312` (the `autojoin_defer_timer` ref as the P2 flag); `:9369`, `:9708` (`%{client: nil}` in E2E helpers); `:7006-7010` (the registry's `registered?` copy); plus the credential row's `connection_state` and the `connection_progress` broadcast
**Problem:** there is no phase value. Each verb that cares reads a different proxy, and most verbs read none: about 30 `send_*` handlers pass `state.client` to `Client.send_*` and let `{:error, :no_socket}` fall out in P0 and a blind write happen in P1. The proxies disagree:
- `client: nil` cannot see P1, and `registered_at` cannot see P2;
- the two `registered_at` readers treat an absent key in opposite directions on purpose (`server.ex:8553-8559`), so the next author has to know which one to copy;
- `refresh_directory`'s comment equates `client: nil` with pre-001, which is false for all of P1.

The reply vocabulary is just as per-verb. The same "link not usable" fact is `{:error, :no_socket}` (502 `upstream_unreachable`, `fallback_controller.ex:839,1113-1117`), `{:error, :not_connected}` (400), `:ok` with a held action (JOIN), `:ok` with a logged and swallowed failed send (away), `:ok` from a cast that cannot report (PART, `session.ex:3037-3042`), and `:ok` with a blind write (everything in P1).
**Impact:** a new verb is wrong by default. It compiles, passes its P3 tests, and is silently broken in three phases. Issues 2114, 2703 and 2721 are three consecutive point fixes of this one missing value, and PHASE-A2, A3, A5 and A6 are the next ones in line.
**Recommendation:** one derived function and one table, with no new state (T1):
```elixir
@spec link_phase(t()) :: :no_client | :unregistered | :deferring | :ready
```
derived from the three fields that already exist: `client`, `registered_at` (with issue 2703's absent-key rule) and `autojoin_defer_timer`. Then a module-attribute map `verb_tag => policy`, where the policy is a closed set:
- `:needs_registered`: refuse with one error tag;
- `:held_until_plan`: JOIN;
- `:local_until_registered`: PART;
- `:desired_state`: away and nick (mutate, then reconcile at 001);
- `:local`: reads, `decline_invite`, DCC, `copy_e2e`.

A single `handle_call` head consults the table before dispatch. A verb with no entry fails a totality check over the handler tags, at compile time or test time, which is the same shape cic already uses for `Record<WindowState, …>`. `Deps` and the Client stay untouched. This is also the first cut along the seam that the 2026-11-21 review's `Session.Server` cohesion finding (X1) asks for.
**Evidence:** READ (every site listed). Nothing to measure: it is a count.
**Verified by editor:** yes (the proxies at the listed lines exist).
**Filed issues:** new; related to issue 2133. PHASE-A6 and PHASE-A9 are filed under it.

### PHASE-A5. Nick verbs in P0 and P1 are undone at 001, and the auto-away rename is not reconciled
**Concern:** phase windows
**Severity:** MEDIUM
**Scope:** `server.ex:2264-2271` (`send_nick`); `:5918-5934` (`maybe_arm_nick_reclaim/2`); `:5973-5993` (`reclaim_configured_nick/1`); `:6221-6225`, `:6127-6132` (`keep_nick_on_user_nick/2`, `stop_keep_nick/2`); `:10422-10432` (`set_auto_away_internal/1`); `:10454-10464` (`rename_for_away/1`); `:10336-10351` (`maybe_resend_away/1`); `:207`, `:215`
**Problem:** three cells of the matrix share one cause: nick intent is a wire side effect, not state that the 001 handler reconciles.
1. **`/nick X` in P1.** `NICK X` is a line an ircd accepts during registration, so the session registers as X, and the door replied `:ok`. At 001, `maybe_arm_nick_reclaim/2` compares the welcomed nick with `configured_nick/1`, sees a drift, and 12 s later `reclaim_configured_nick/1` sends `NICK <configured>`. With keepnick on, the P1 `stop_keep_nick(:user_renamed)` is a no-op (there is no chain yet, and "nothing records the stop"), and 001 arms the chain, which then asks every 30 s. The same `/nick X` in P3 is honoured. The #1894 and issue 2656 rule ("the subject named the nick they want; do not overrule a choice more recent than ours") holds in P3 and is broken in P1.
2. **An auto-away rename in P1.** This happens when all sockets are hidden while a reconnect is in flight, which is when reconnects happen unattended. `rename_for_away/1` sends `NICK <nick><suffix>` before 001, the session registers decorated, and 001 reads that as drift from the configured nick and reclaims it while the user is still away.
3. **An auto-away rename in P0.** `Client.send_nick(nil, …)` fails and is logged, but `away_nick_restore` is set anyway. At 001, `maybe_resend_away/1` re-sends AWAY but not the rename. The session is away without its suffix, and `restore_away_nick/1`'s equality guard then makes the return a no-op, so nothing ever notices.

Also in P0, `send_nick` returns `{:error, :no_socket}` after it has already cleared `away_nick_restore` and run the keepnick hook (`server.ex:2265`): state is mutated for a verb that reported failure.
**Impact:** a reply of `:ok` followed by a silent reversal 12 s later, and an away-suffix feature whose behaviour depends on which phase the debounce fired in.
**Recommendation:** treat the wanted nick as away is already treated. Hold a small desired-state value (`:configured | {:user, nick} | {:away, nick}`) that the verb writes in any phase and that one function applies at 001 and on each change in P3. `maybe_arm_nick_reclaim/2` then compares against the desired nick instead of the configured one, and cases 1–3 collapse. Under PHASE-A4's table, `send_nick` is `:desired_state`. The same value removes STALE-A3's stale visitor copy.
**Evidence:** READ for grappa's side. INFERRED: that the ircd honours a NICK sent between NICK/USER and 001 (standard, and what the 433 ladder itself relies on); not measured on bahamut with CAP negotiation open. Measure with a session test that withholds 001, calls `Session.send_nick`, sends `001 X`, advances `nick_reclaim_ms`, and asserts that no `NICK <configured>` reaches the fake server.
**Verified by editor:** partly. Grappa's side was re-read (`send_nick` mutates before it sees the send result; the reclaim compares against `configured_nick/1`; `rename_for_away/1` stores the restore regardless of the send result). The ircd's acceptance is not something the editor could verify.
**Filed issues:** new; related to STALE-A3.

### PHASE-A6. Request/reply verbs prime accumulators and arm timers in P0 and P1, then answer inconsistently
**Concern:** phase windows
**Severity:** MEDIUM
**Scope:** `server.ex:2456-2470` (`send_links`); `:2488-2503` (`refresh_directory`); `:2533-2570` (`recover_identity`); `:2416-2438`, `:2599-2618`, `:2652-2747` (info, version, motd, admin, list_mode, whois, whowas, who, names); `:2784-2789` (labeled away)
**Problem:** these handlers mutate state before the send and keep the mutation when the send fails or cannot be answered.
- `send_links` in P0: `Client.send_links(nil, …)` returns `{:error, :no_socket}`, but `links_pending` is stored with a fresh `requested_at` in the same reply tuple. A retry within `@links_stale_ms` (10 s) is refused with `:links_in_flight` for a request that never left. In P1 the reply is `:ok`, and the same 10 s lockout follows.
- `refresh_directory`: the P0 clause is correct. In P1, `LIST` is written, the watchdog is armed and `DirectoryIngest.start/3` is recorded, so `directory_refreshing?` reports a capture in progress (the `:loading` answer of `ChannelDirectory.list/3`) until the watchdog fires.
- `recover_identity` (visitors): in P0 and P1 the `"r" in umodes` gate passes because the umodes are empty. The FSM starts, its lines go nowhere or to an unregistered socket, progress events are broadcast, the reply is `:ok`, and the user gets a failure after `@recover_timeout_ms` (15 s). In P1 its NICK line also changes the registration nick (see PHASE-A5).
- whois, whowas, who, names, list_mode, info, version, motd and admin: the accumulator is primed, and the reply is the transport error in P0 and `:ok` in P1. The modal the client opened waits for a terminator that will not come. This is bounded by the S10 TTL sweep, so it is a UX lie, not a leak.

**Impact:** "done" replies for work that cannot happen, a 10 s false lockout on `/links`, and a directory that reads `:loading` on a link that is not up. Each is small; together they are the long tail that PHASE-A4's table would close in one place.
**Recommendation:** all of these are `:needs_registered` under PHASE-A4: refuse before priming. Separately, and regardless of phase, `send_links` must not keep `links_pending` when the send returned an error. Prime-then-send is fine; keep the primed state only on `:ok`, as `refresh_directory` already does.
**Evidence:** READ. Measure the `/links` case: call `Session.send_links/4` twice inside 10 s on a session held in backoff, and expect `{:error, :no_socket}` and then `{:error, :links_in_flight}`.
**Verified by editor:** partly. `send_links` and `recover_identity` were re-read; the accumulator verbs were not.
**Filed issues:** carried in PHASE-A4's issue, with the `send_links` defect called out as independent of the table.

### LOW

### PHASE-A7. The +r defer waits for an identity edge, never for the identity level
**Severity:** LOW. **Scope:** `server.ex:8237-8256`, `:8233-8235` (the "no already-+r shortcut" comment), `:7266-7315`; `lib/grappa/session/event_router.ex:4126-4132` (`identity_effects/2`).
**Problem:** P2 is released by `{:session_identity_changed, :acquired}`, a 401 for NickServ, or the ceiling, and `:acquired` is a false→true transition. If any identity source (`ACCOUNT`, a self 330, a MODE echo) flips the level during P1, `fire_deferred_autojoin/2` is a no-op (there is no timer yet), and the timer armed at 001 then has no edge left to wait for, so the plan waits the full 60 s. The comment justifies the missing shortcut with "`state.umodes` is empty until the 221", but the level predicate is `IdentityState.identified?/1`, which reads more than the umodes.
**Recommendation:** in `maybe_autojoin_or_defer/1`, test `IdentityState.identified?(state)` before arming, and fire at once when it already holds.
**Verified by editor:** no (LOW). **Filed issues:** not filed.

### PHASE-A8. `state.autojoin` is an init-time copy with one writer per fix
**Severity:** LOW. **Scope:** `server.ex:1322-1323`, `:8449-8459` (`join_plan/1`); PR 2727's `drop_from_autojoin/2`; `lib/grappa/networks/credentials.ex:172`; `lib/grappa_web/controllers/admin/credentials_controller.ex`; `lib/mix/tasks/grappa.update_network_credential.ex`.
**Problem:** this is issue 2724's subject, which was ruled a next-init contract. The P0 wait sits inside the new process, after its `init/1`, so an edit made during the backoff wait misses the attempt that is about to happen; "next connect" in that ruling therefore means the connect after that one. PR 2727 residue: in P2 its gate (`registration_pending?/1`) is false, so a PART of a channel the plan has not joined yet still writes `PART` upstream for a channel we are not in (a 442 on `$server`), while the local half is already complete.
**Recommendation:** re-read the two columns when the plan fires (through the injected-reader pattern `recover_source` uses), or broadcast an `autojoin_changed` info as `credential_profile_changed` does. For the residue, use PHASE-A3's condition (the plan has not fired).
**Verified by editor:** no (LOW). **Filed issues:** not filed; the residue is carried in PHASE-A3's issue.

### PHASE-A9. `send_part` cannot tell the caller anything, in any phase
**Severity:** LOW. **Scope:** `lib/grappa/session.ex:1597-1607`, `:3037-3042`; `server.ex:3328-3430`; `lib/grappa_web/controllers/channels_controller.ex:229-260`.
**Problem:** PART is a cast. Its spec lists `send_transport_error()`, but `cast_session/3` can only return `:ok` or `{:error, :no_session}`. The JOIN door was converted from a cast to a call (`server.ex:3211-3218`) for an ordering reason that applies here too.
**Recommendation:** convert it to a call when PHASE-A4's table lands, so the JOIN/PART pair shares one reply contract; trim the spec now.
**Verified by editor:** yes (the spec against `cast_session/3`). **Filed issues:** carried in PHASE-A4's issue.

---

## 2026-11-21 findings: status

Merged from the four reports; one row (X7) was checked by the editor.

| 2026-11-21 finding | Re-read by | Status at `ec8e66bca` | Basis |
|---|---|---|---|
| DUP-A2: the member list is kept by two state machines; the client MODE walker | STALE | **PARTIAL.** The MODE half is closed: `a200c2469` writes each changed member's modes onto the `:mode` row and `eca7f3244` deletes the client walker. The JOIN/PART/QUIT/KICK/NICK half is open: `cicchetto/src/lib/members.ts:68` still derives the list from rows between `members_seeded` snapshots | read, plus the issue 2692 commits |
| DEP-A3 / issue 2697: SourceAliasManager after Endpoint and SessionSupervisor | STALE, LIFE, FAIL | **OPEN.** `application.ex` unchanged; the arm default is still `{false, :not_armed}` (`source_alias_manager.ex:140`); the `:noproc`/`:timeout` swallow in `release_alias_best_effort/1` remains (`server.ex:1744-1749`). PR 2718 cures it and is not merged; PR 2718 exposes LIFE-A3 and does not address LIFE-A2 | read |
| DEP-A8: ordering and boot-phase prose drift; `Uploads.base_url` seeded after the tree | LIFE | **OPEN.** "both ETS-backed singletons" (`application.ex:288`), "three ambient sweepers" (`:763`) and `@spec bootstrap_child()` detached from its def (`:658` against `:690`) are all still there; `boot_base_url` is still post-tree (`:557-559`). PR 2718 re-attaches the spec only | read |
| DEP-A9: `:persistent_term` written on request paths | STALE | **OPEN.** `endpoint.ex:244` and `:303` unchanged | read |
| BND-A4: `Vhosts` re-derives last-known IP from Accounts' sessions table | STALE | **OPEN.** `vhosts.ex:721-731` still runs its own query | read |
| DUP-A10: server limits mirrored as client literals | STALE | **OPEN** on the one member checked: `cicchetto/src/lib/scrollback.ts:121` `PAGE_LIMIT = 200` | read, one member |
| X7: the registry key hand-spelled outside `registry_key/2` | editor | **CLOSED.** Issue 2696 is closed; `Grappa.Session` now owns the key and every scan of it (`session.ex:487-495`), and `LiveIntrospection` reads through `Session` (`live_introspection.ex:39`). A grep found no hand-spelled key in `lib/` | read |
| X1 / COH-A2: `Session.Server` growth; issue 2133 without a ruling | PHASE, editor | **OPEN, grew.** 10,374 → 10,933 lines in 148 commits (+5.4%; 22 commits touched the file: keepnick, kick-rejoin, the JOIN hold). PHASE-A4 is a first cut along the seam | MEASURED (`wc -l`, `git log`) |
| COH, the Reaper-children item: E2E inbox/request retention sweeps live in `Session.Server`, not in a Reaper | LIFE | **OPEN** (`server.ex:4145-4153`, `:9409`, `:9451`). Lifecycle consequence: the sweep runs only while that subject's session is alive | read |
| 2026-08-15 A13: Bootstrap does several boot jobs | LIFE | not re-measured by 2026-11-21. On this sha Bootstrap installs the pool, spawns credential sessions, spawns visitor sessions and runs a hard-fail validation; LIFE-A4 is the lifecycle face of it | read |
| Prior abstraction A5 (carried in the 2026-11-21 status table): `readError` bypasses | FAIL | **OPEN.** `userSettings.ts:87,140,186,250,302` build `ApiError` from `statusText`, and so do `push.ts:79,165,295`. `readCursor.ts:343-349` advances optimistically, `console.warn`s, and calls `readError` only for the 422 rollback. `serverSettings.ts` has 0 `readError` and a bare `catch {` at `:151`. Paid by FAIL-A1's `request()` | read |
| Prior abstraction A8: `api.ts` size | FAIL | **OPEN**, unchanged in substance; its 105 raw `fetch` sites are the same fact seen from FAIL-A1 | read |

Documented in code as known, still open, and not counted as findings: Bootstrap re-reads credentials on every restart under a saturated pool (`application.ex:634-643`), and the `:spawned` telemetry stall window (`server.ex:1934-1949`).

The 2026-11-21 review had no finding in the phase-window class and no failure-surfacing concern. The phase reviewer's grep of that file for `registered_at`, `client: nil`, `pre-001`, `queued_join`, `451`, `no_socket`, `not_connected`, `2703` and `2114` returned nothing.

---

## Appendix A — stale copies: the family, including the healthy members

OK = every writer reaches the copy, or the copy is re-read. RULED = stale by a written contract.

**Server, `:persistent_term`:**

| Copy | Source | Verdict |
|---|---|---|
| `Admission.Config`, `RateLimit.RequestBudget`, `AdminOverview`, Push VAPID and private hosts, `Avatars`, `Dcc`, `Uploads`, `HttpHosts`, `Cic.Bundle` root, `PasskeyOrigin`, `Net.SourceAlias.Config`, `Themes.BackgroundImage`, `Push.BadgeSource`, `WindowCounts.PushSource`, the `Vhosts.SourceMapping` MAC key | app env / `secret_key_base`, boot only | OK |
| `ServerSettings` auto-away fallback | app env, boot only; the runtime row is read per call and broadcast | OK |
| `OutboundV6Pool` | vhost inventory rows; `Bootstrap` and `Vhosts` re-apply after edits | OK, callers not exhaustively traced; LIFE-A4 for the boot window |
| `SourceAliasManager` arm | prefix row + OS capability | STALE-A8 (issue 2612); DEP-A3 |
| `Health` ready flag | supervision tree | OK |
| `Endpoint` session opts, cic static opts | env / bundle root | OK for staleness; DEP-A9 for the request-path put |

**Server, ETS, Registry and process state:**

| Copy | Source | Verdict |
|---|---|---|
| `Net.PtrCache` | DNS | OK (TTL clamped, negative and error TTLs) |
| `SessionRegistry` value `{nick, label, registered?}` | `state.nick` | OK (one writer at every point `state.nick` moves) |
| `SourceAliasHolders` Registry | live sessions | OK (auto-collected) |
| `SourceAliasManager.refcounts` | the holders | issue 2716; LIFE-A2 |
| `Identd.Bindings` | live sockets | OK, narrow (a restart loses only mid-registration bindings); LIFE-A5 |
| `WSPresence` | live transports | STALE-A2 |
| `Session.Server` plan fields (nick, auth method, password, `sasl_user`, `oper_pass`, perform list, server pass, host/port/TLS, source) | credential + server rows | OK / RULED: re-resolved on every `init/1`; perform and server pass apply at the next connect, documented |
| `state.autojoin` | credential | issues 2721 and 2724; PHASE-A8 |
| `state.configured_nick` | the credential nick | STALE-A3 (visitors) |
| `state.profile`, `avatar_url`, `keep_nick`, `kick_rejoin` | credential | OK (bridge) |
| auto-away debounce, reason, away-nick suffix | user settings + site default | OK (bridge) |
| `state.ignores`, presence map | user settings, notify rows | STALE-A6 |
| `state.show_peer_profiles` | user settings | STALE-A6 |
| `state.services_flavor` | network row | STALE-A7 |
| `userhost_cache` | upstream | OK |
| `peer_profile_cache` | the peer's client | STALE-A9 |
| `members`, `topics`, `channel_modes`, `isupport`, `umodes` | upstream | OK (reset per process; fed by the wire) |

**cic stores holding server-derived state:**

| Store | Refreshed by | Verdict |
|---|---|---|
| `networks`, `channelsBySlug` | events + the reconnect and resume arms | OK |
| `user` (`/me`) and `home` | local writes, attach/detach events | STALE-A5 |
| `windowState`, `members`, `channelTopic`, modes | per-channel after-join snapshot + live | OK; members between snapshots are still derived client-side (DUP-A2 remainder); PHASE-A1 for the attempt boundary |
| `queryWindows`, `notifyWatch`, presence, `umodes`, `supportedUmodes`, `isupport`, identity, invited/rejected windows, `dccOffers`, `serverSettings`, `bundleHash`, pairing offer | user-topic after-join snapshot + live | OK |
| `highlightList`, `aliasList`, `notificationPrefs`, command counts | rejoin hydration, no event | STALE-A6 (counts RULED) |
| display prefs (8 modules) | login only, full-map PUT | STALE-A1 |
| `awayStatus`, `reconnectingStatus` | live event only | STALE-A4 |
| `ignoreList`, `banMaskPref` | settings page open / Shell mount | OK (display only; the server enforces) |
| `scrollback`, `readCursor`, `peerAway`, `railWhois`, `whoisCard`, E2E stores | — | not reviewed in depth |

## Appendix B — lifecycle: the tree, the partial boots, the terminate sites

Root tree at `ec8e66bca`, in start order (stop is the reverse). "External" means state that outlives the BEAM.

| # | Child | Needs at start | Still called while stopping | External state | Finding |
|---|---|---|---|---|---|
| – | `start/2` boot seams (18) | app env | – | – | LIFE-A7 |
| 1–3 | Vault, Repo.LockWatch, Repo | env key; Vault and LockWatch before Repo | every write transaction | sqlite file | LIFE-A8 (LockWatch) |
| 4 | Phoenix.PubSub | – | sessions, channels | – | LIFE-A5 |
| 5–6 | SessionRegistry, SourceAliasHolders | – | sessions; manager reconcile | – | LIFE-A2, A5 |
| 7–9 | Session.Backoff, WSPresence, NetworkCircuit | – | `terminate/2` (Backoff call) | – | STALE-A2, LIFE-A7 |
| 10–13 | AdminEvents, SessionLog, DbLatency, Push.VendorLog | – | session terminate (casts) | `admin_events`, `session_log_events` rows | LIFE-A6, A8 |
| 14–20 | ShareTokens, DailyQuota, FailureWindow, WebAuthnChallengeStore, E2ePairing, TokenBucket, Net.PtrCache | – | – | DNS queries (PtrCache) | – |
| 21–22 | TaskSupervisor, Pusher.Coalescer | – | `credential_failer`, coalescer flush | – | LIFE-A5 |
| 23 | SessionSupervisor → Session.Server (`:transient`, traps exits, 5 s) → linked IRC.Client | 5–8, 21, the pool, the arm gate, Identd.Bindings | – | upstream sockets, OS aliases, DCC spool | LIFE-A2, A3, A4, A5, A9 |
| 24–26 | Identd.Bindings, Acceptors, Listener (optional) | 24 before 25 before 26 | Client connect (cast) | TCP port | LIFE-A5, A6 |
| 27 | Endpoint | 4, 5, 14–20 | – | TCP port | LIFE-A4 |
| 28 | SessionRevocationListener | Endpoint, PubSub | – | – | – |
| 29 | SourceAliasManager | Repo, 6, `Vhosts.boot` | session terminate (`:noproc` today) | OS aliases | issues 2697, 2715, 2716; LIFE-A2, A3 |
| 30–34 | Visitors, Uploads, Avatars, Dcc, Accounts reapers | Repo | – | rows + files, `mkdir_p` | LIFE-A6 |
| 35 | Bootstrap (`Task`, `:transient`) | 5, 23, 29 | – | – | LIFE-A4, A5 |
| – | post-tree: `Health.mark_ready`, `Uploads.boot_base_url` | Endpoint | – | – | DEP-A8 |

| Partial-boot lane | Starts | Touches shared state | Finding |
|---|---|---|---|
| `mix grappa.*` via `start_app_silent/0` (the boot verbs of `bin/grappa`, plus seed and repair tasks) | everything except Endpoint, SessionRevocationListener and Bootstrap | DB, OS aliases (issue 2715), identd port, storage roots, reaper sweeps | LIFE-A1, A6 |
| `mix grappa.migrate`, `check_migrations` | their own boot | DB schema | not traced further |
| release `eval` → migrate / check_migrations / seed_themes / rollback | app loaded, Vault, Repo via `with_repo` | DB | – |
| release `eval` → `Grappa.Release.cli/1` (`create-user`, `add-network`, `remove-network`) | app loaded, Vault, Repo; `add-network` hops to the live node via `LiveNode` | DB; live node over `:erpc` | LIFE-A1 |
| `bin/grappa` rpc verbs | nothing; they run in the live node | live node | – |

| Site with external work at terminate or continue | Work | Finding |
|---|---|---|
| `Session.Server.terminate/2` ×3 (`server.ex:1842`, `:1885`, `:1910`); the only `trap_exit` in `lib/` (`:1277`) | alias release, QUIT, Backoff call | LIFE-A3, A9 |
| `Session.Server.handle_continue({:start_client, _})` (`:1618`) | alias acquire, spawns the Client | LIFE-A2 |
| `IRC.Client.handle_continue({:connect, _})` (`client.ex:1366`) | DNS, TCP/TLS connect (30 s per target), identd cast; blocks the Client mailbox, so a QUIT call during it times out | – |
| `SourceAliasManager.handle_continue(:reconcile)` (`:164`) | lists and unbinds OS aliases | issue 2715 |
| the four telemetry sinks' and LockWatch's `terminate/2` | telemetry detach / `persistent_term` put | LIFE-A8 |

## Appendix C — phase windows: verb × phase matrix

Each cell gives the wire effect / the state and persistence effect / the reply. "Blind" means written to an unregistered socket (INFERRED 451). Bold marks a wrong cell.

| Verb (door) | P0 no client | P1 unregistered | P2 deferring | P3 |
|---|---|---|---|---|
| `send_join` (REST) | none / queue + `:pending` / `:ok`: **lost if the attempt fails (A1)** | same as P0 (A1) | **direct write, skips the +r wait (A3)**; a duplicate with the plan | write / pending / `:ok` |
| `send_part` (REST, cast) | none / local cleanup, autojoin DB removed / `:ok` | before PR 2727: **blind PART**, plan re-joins (issue 2721). PR 2727: local only | before PR 2727: PART for an unjoined channel, plan re-joins. PR 2727: plan fixed, PART still written (A8) | ok |
| `send_privmsg` / `send_ctcp` / `send_notice` / `send_statusmsg` | refused `:no_socket` before persist | **row + broadcast + `{:ok, _}` + blind (A2)** | ok (unidentified; +R/+M channels may 4xx, which is normal) | ok |
| `send_e2e` | `:no_socket` | **accepted, paced, blind, no drop event (A2)**; a channel target is refused (not a member) | ok | ok |
| `e2e_ask` / `e2e_answer` | `:no_socket` | **request row committed + blind (A2)** | ok | ok |
| `e2e_dismiss` | cancel → `:no_socket`; other kinds local | cancel → **blind + row** | ok | ok |
| `copy_e2e` | local, ok | local, ok | ok | ok |
| `send_nick` (REST) | `:no_socket`, **but the restore and keepnick state are already mutated (A5)** | wire accepted (INFERRED) / `:ok` / **reverted by the 001 reclaim (A5)** | ok | ok |
| auto-away (`ws_all_hidden` → debounce) | AWAY fails, state set, re-sent at 001 (correct); **rename never re-applied (A5)** | AWAY blind, then re-sent at 001; **rename reclaimed at 001 (A5)** | ok | ok |
| `set_explicit_away` / unset | state + DB, send fails, `:ok`, reconciled at 001 (the correct model) | the same: blind, then reconciled | ok | ok |
| `send_topic`, `send_topic_clear`, op/deop/voice/devoice/ban/unban/kick/invite, `send_mode`, `send_umode`, `send_lusers` | `:no_socket`, no state | **`:ok`, blind** (the A2 class, without persisted state) | ok | ok |
| whois / whowas / who / names / list_mode / info / version / motd / admin | accumulator primed, `:no_socket` | primed, **`:ok`, blind (A6)** | ok | ok |
| `send_links` | **primed + `:no_socket`, then 10 s of `:links_in_flight` (A6)** | `:ok`, blind, 10 s lockout | ok | ok |
| `refresh_directory` | `:not_connected` (correct) | **LIST blind, watchdog armed, reads `:loading` (A6)** | ok | ok |
| `recover_identity` (WS, visitors) | **FSM started, `:ok`, 15 s timeout (A6)** | the same, plus a NICK that changes the registration nick | ok | ok |
| `send_raw` (`/quote`) | `:no_socket` | written (legitimate for a raw door) | ok | ok |
| `send_oper` | `:no_socket` | `:ok`, blind | ok | ok |
| `send_quit` / `stop_session/3` | transport error swallowed by design; the stop proceeds | QUIT before 001, fine | ok | ok |
| `decline_invite`, DCC accept/refuse/list | local | local | local | local |
| `notify_changed`, `ignores_changed` | map only; the arm at 376 reads the DB (correct) | the same | ok | ok |
| reads (`list_channels`, `list_members`, `get_*`, `session_snapshot`, `connection_info`, `casemapping`, `statusmsg`) | init-time defaults; `casemapping` answers `:ascii` until 005 (a documented gap) | the same | ok | ok |
| keepnick toggle | stored, armed at 001 (correct; reads `registered_at`) | the same | arms now | arms now |

| Inbound in P1/P2 | Effect | Later transition |
|---|---|---|
| an identity signal before 001 | level true, no timer to release | **001 arms the defer and waits the ceiling (A7)** |
| 001 with a nick ≠ configured | reclaim / keepnick armed | **overrides a P1 user or away NICK (A5)** |
| a +r echo / `ACCOUNT` / 330 in P2 | `fire_deferred_autojoin(:identified)` | correct |
| a 401 for NickServ in P2 | release unidentified | correct |
| a Client EXIT in P0/P1/P2 | the process stops | **the queue, window state and pacer contents are gone; only E2E announces it (A1)** |
| a second 001 in one process | timers re-armed, queue already emptied | correct by construction |

## Limits: what the reviewers refuse to claim

- That any of this was observed running. Nothing was executed.
- That `WSPresence` crashes in practice (STALE-A2): the consequence of a restart was found, not a cause of one.
- That any prod session shares a derived address, or that prod runs mode 2 at all. LIFE-A2 and A3 scale with that, and it is unmeasured. Nor that a QUIT written after the alias is unbound is lost on FreeBSD or Linux: the order is read, the kernel behaviour is not.
- That anyone has hit LIFE-A4's window on prod.
- The in-node effects of `remove-server`, `set-network-caps`, `update-network-credential` and `add-server` in the operator task's VM: not traced. Hot code reload and `code_change`: not read. No lifecycle review of cicchetto was done.
- That any await in FAIL-A1 has been observed hanging (the hang is inferred from phoenix.js push semantics and from `fetch` having no deadline), or that FAIL-A3 produces a 500 in practice.
- That a `:pending` window is stuck in production (FAIL-A4): no exit path was found by grep over `lib/grappa/session/`, and an unrecognised path could exist. Which ircd behaviours actually leave a JOIN unanswered was not measured.
- That a refused per-channel join leaves a pane silently dead (FAIL-A6).
- The completeness of the failure census. Counts are grep counts with the stated patterns; multi-line forms and `with … else _ ->` collapses are under-counted. The 258 client catches (issue 2726's territory) and the 79 `_ =` sites (about 30 read) were not audited one by one.
- That any ircd answers 451 and discards for each verb marked "blind". PHASE-A2, A5 and A6's P1 cells rest on it. How wide P1 is in production. That PHASE-A7 happens on Azzurra or Libera.
- What cic shows for the autojoin set during P0–P2; whether PHASE-A1's cic pseudo-row survives a WS reconnect; the test coverage of the matrix cells.
- That PHASE-A4's table is cheap. It was counted, not prototyped, and the hot-deploy concern (`registered_at` absent on pre-2097 processes) is real: issue 2703's absent-key rule must be kept.
- That the stale-copy appendix is exhaustive for cic: about 290 modules under `cicchetto/src/lib`, of which the ones a user-topic event or a settings endpoint feeds were traced, not every modal store.
- Severity relative to the other reviewers' classes.

## Filed as

Filed on 2026-11-25. PHASE-A6 is inside the PHASE-A4 issue. Findings that extend an existing issue were posted there as comments: #2082 (STALE-A4), #2716 (LIFE-A2), #2697 for PR 2718 (LIFE-A3), #2715 (LIFE-A6), #2725 (FAIL-A2), #2726 (FAIL-A6). STALE-A8 is #2612 and LIFE-A8 is #1613/#1334. The LOW findings are not filed.

| Finding | Issue |
|---|---|
| PHASE-A4 | #2728 |
| STALE-A1 | #2729 |
| STALE-A2 | #2730 |
| STALE-A3 | #2731 |
| STALE-A5 | #2732 |
| STALE-A6 | #2733 |
| LIFE-A1 | #2734 |
| LIFE-A4 | #2735 |
| LIFE-A5 | #2736 |
| LIFE-A7 | #2737 |
| FAIL-A1 | #2738 |
| FAIL-A3 | #2739 |
| FAIL-A4 | #2740 |
| FAIL-A5 | #2741 |
| PHASE-A1 | #2742 |
| PHASE-A2 | #2743 |
| PHASE-A3 | #2744 |
| PHASE-A5 | #2745 |
