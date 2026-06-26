# Channel directory — `/list` discovery (#84)

**Date:** 2026-06-26
**Status:** design, approved by vjt
**Issue:** vjt/grappa-irc#84 (REST + command + homepage link)
**Unblocks (separate follow-ups, NOT built here):** #83 (AI theme gallery),
#85 (preconfigured channel links / one-click join curated set)

## Goal

Give cic a way to **discover channels the user is not in** on a connected
network — upstream IRC `LIST`, surfaced as a server-side paginated/searchable
REST resource and a `/list` compose command, rendered as a dedicated 📇
channels pseudo-window with a live-populating list and one-click join. This
establishes the discovery surface + one-click-join wiring that #83 and #85 will
reuse; it does not build either.

## Why this is non-trivial (the shape problem)

Upstream IRC `LIST` is **async, streamed, and potentially huge**: the server
replies `RPL_LISTSTART (321)` → `RPL_LIST (322)` once per channel → `RPL_LISTEND
(323)`, and on large networks (libera ≈ 25k) that's tens of thousands of entries
arriving over many seconds. Many networks throttle or flag frequent `LIST` as
abuse. None of that maps cleanly onto a synchronous REST GET. Resolved with a
**per-user persisted server-side snapshot + lazy refresh + a live-populating
window driven by tiny push pings**.

## What already exists (grounding)

- **No structured LIST capture today.** Numerics 321/322/323 currently fall
  through to `$server` scrollback as plain `:notice` rows
  (`lib/grappa/irc/numeric_router.ex:178` — the HIGH-3 2026-05-14 note). No
  accumulator. The IRC client never *sends* `LIST`.
- **REST pattern:** `scope "/networks/:network_id"` with `resolve_network`
  (`router.ex:246`). Existing `/channels` is the **joined-channels** resource
  (index/create=join/delete=part). The discovery directory is a *different
  noun* → new `/directory` resource.
- **Scrollback is the precedent for this whole feature's shape:**
  bouncer-owned, sqlite-indexed, server-side paginated, consumed by a thin cic
  that never holds or queries the dataset. The directory follows the same spine.
- **Wire convention:** per-context `*.Wire` module, atoms→strings and
  DateTime→ISO8601 at the boundary.
- **PubSub topics** are user-rooted (`Grappa.PubSub.Topic`). The directory is a
  network-level concern → reuse the **network** topic for the progress pings.
- **cic homepage exists** (`HomePane.tsx`) — gets a "Browse channels" link per
  connected network.
- **cic `/join` is text-only** → `compose.ts` `parseSlash` → `postJoin` → POST
  `/channels`. One-click join = the same `postJoin` behind a row tap.
- **#81 synthetic-window discipline:** synthetic/pseudo-windows must NOT trigger
  `/messages` fetches, or the 404s cascade into a fail2ban ban
  (`fix(cic): don't fetch /messages for synthetic windows`, grappa-irc#81). The
  📇 window is exactly such a synthetic window.

## Decisions (forks resolved with vjt)

1. **Source = upstream `LIST` passthrough.** Real discovery (channels you're not
   in), not "enumerate what grappa already knows."
2. **Per-user snapshot, NOT shared.** A shared network-global snapshot was
   designed first then **rejected**: it forces a secret-channel-leak apparatus
   (strip the issuer's memberships, the just-joined race, and a self-oper guard
   for `RPL_YOUREOPER`/usermode `+o` since an opered session sees `+s`/`+p`
   channels it isn't in — and `RPL_LIST` carries **no modes**, so we can't filter
   them from the data). Per-user isolation deletes that whole class **by
   construction**: a user's snapshot only holds what their own connection is
   authorized to see; nothing crosses users, so nothing leaks.
   - Accepted cost: upstream `LIST` no longer dedups across users. With the 48h
     TTL each user fires ≈ one `LIST` / 48h plus manual refreshes, and grappa is
     a small-user bouncer. If user count grows, a shared public-only layer can be
     bolted back on. **YAGNI now.**
3. **100% server-side storage AND query.** A client-side-search variant was
   considered and **rejected**: cic must stay a lean shell over a fat server —
   the codebase spine is *server owns state, sqlite-indexed, paginated; the
   client is a thin typed-event consumer that never holds or queries a big
   dataset* (scrollback). A client-held directory would be the first divergence
   and would metastasize. Search / sort / pagination all live in SQL; the client
   ever holds **one page**. One search implementation, no duplication.
4. **Ingest the whole list server-side.** All 322s → sqlite. The long tail
   (niche/small channels) is kept *server-side* so name search finds them; the
   client just never *sees* all of it. "Don't send the entire list" is a
   client-delivery rule, not an ingest rule.
5. **Lazy refresh, 48h staleness threshold; auto-refresh ONLY on empty.** On
   window select: **empty** → auto-trigger; **fresh (< 48h)** → show, no refresh;
   **old (> 48h)** → show + a staleness indicator, **no** auto-refresh; the
   manual refresh button always nukes + restreams. No background poll (periodic
   `LIST` is anti-social + needs an elected issuer).
6. **Live-populating window via push ping + top-window re-fetch.** The server
   emits a tiny `directory_progress {count}` on the network topic on a
   **server-side ~1s throttle** (NOT a client timer — cic stays reactive, so we
   don't violate "don't poll REST"). On each ping cic re-GETs its current view
   and updates a **live total-channel counter**. Default sort `user_count DESC`,
   so the biggest channels bubble into the visible top as they arrive.
7. **Viewport stays put while rows move.** Pagination is NOT locked during a
   refresh. On each progress-driven re-fetch, cic preserves scroll position
   (record container `scrollTop` anchored on the top visible row's `offsetTop`,
   restore after render). Rows reshuffle *under* a stationary viewport;
   `overflow-anchor` backs it up for above-viewport growth. Rows are expected to
   move; the viewport is not.
8. **Search + sort work mid-refresh** against the **partial** snapshot — they're
   just GETs with `q`/`sort` params; one server-side implementation.
9. **Scope = directory only.** #83 and #85 are separate follow-ups.

## Design

### New modules

- **`Grappa.ChannelDirectory`** (context) — public API:
  - `list(subject, network, opts)` → `{:ok, %{entries, next_cursor, total,
    captured_at, status}}`. `opts`: `:sort` (`:users | :name`), `:q` (substring),
    `:cursor`, `:limit`. `total` = row count in the (partial or complete)
    snapshot, for the live counter. `status` is a typed atom union:
    - `:fresh` — snapshot `< 48h`.
    - `:empty` — no completed snapshot (a refresh was/should be fired).
    - `:refreshing` — a refresh is in-flight (partial rows may be present).
    - `:stale` — `> 48h` but not auto-refreshed; serving old data honestly.
  - `replace_start(subject, network)` → nuke the snapshot rows for that pair,
    mark in-flight.
  - `ingest(subject, network, entries)` → batched insert of streamed 322s.
  - `finalize(subject, network)` → stamp `captured_at`, clear in-flight (called
    on 323). A snapshot counts as "present" only once `captured_at` is set, so a
    failed/timed-out refresh (no stamp) reads as `:empty` → next open
    auto-refreshes cleanly.
  - `@spec`s written first; closed-set atoms (`status`, `sort`), never bare
    strings.
- **`Grappa.ChannelDirectory.Entry`** (schema) — fields `subject_type`
  (`:user | :visitor`), `subject_id`, `network_id`, `name`, `topic`,
  `user_count`, `captured_at`. Indexes `(subject_type, subject_id, network_id,
  user_count DESC, name)` and `(subject_type, subject_id, network_id, name)` for
  the two sort orders. All writes via `Ecto.Changeset`.
- **`Grappa.ChannelDirectory.Wire`** — `Entry` → `%{name, topic, user_count}`.
  `joined` is annotated **client-side** (cic owns the viewer's joined set), not
  stored.
- **`GrappaWeb.DirectoryController`** — thin: `index` (GET, server paginated +
  search + sort), `refresh` (POST, triggers a `LIST`). `{:error, _}` via
  `FallbackController`.

### Touched modules

- **`Grappa.Session.Server`** — gains transient refresh state:
  `directory_refresh :: nil | %{started_at, requested_by, count}` + a per-session
  in-flight guard. On a refresh: `replace_start`, send `LIST` upstream; accumulate
  322 batches → `ingest`; emit `directory_progress {count}` on a ~1s throttle; on
  323 → `finalize` + `directory_complete`. Transient working memory only — the
  snapshot is sqlite-owned; a crash mid-refresh discards the in-flight flag and
  leaves an unstamped (→ `:empty`) snapshot.
- **IRC numeric routing** (`numeric_router.ex:178`) — when a refresh is
  in-flight for that session, route 321/322/323 to the directory accumulator
  instead of `$server` scrollback. grappa only ever *sends* `LIST` for a refresh,
  so this is unambiguous; absent an in-flight refresh, behavior is unchanged.
- **`config/config.exs` + `lib/grappa/application.ex`** — `directory_ttl_ms`
  (48h), `directory_refresh_timeout_ms`, `directory_progress_throttle_ms` (~1s),
  `directory_ingest_batch` read at **boot** and injected via `Session.Server`
  `start_link` opts. No runtime `Application.get_env`. (A `config/*.exs` change
  forces a COLD deploy.)
- **`Grappa.PubSub.Topic`** — no new topic; reuse `network(u, slug)`. New event
  **kinds** only.
- **`infra/nginx.conf`** + **`cicchetto/e2e/nginx-test.conf`** — allowlist
  `/networks/.../directory` in **both** the `:80` and `:443` blocks, or the route
  404s at the proxy.

### Data flow

**Read — `GET /networks/:network_id/directory?sort=&q=&cursor=&limit=`:**
1. `ChannelDirectory.list/3`. **No completed snapshot (empty)**: when a live
   `Session.Server` exists → fire an async refresh (fire-and-forget), return an
   empty page with `status: :refreshing`; no live session → `status: :empty`.
2. **Fresh (< 48h)** → return the requested page with `status: :fresh` +
   `captured_at` + `total`.
3. **Old (> 48h)** → return the page with `status: :stale` + `captured_at` +
   `total` (no auto-refresh; cic shows the staleness indicator).

**Refresh — `POST /networks/:network_id/directory/refresh` (or auto on empty):**
1. In-flight guard; already running → `202`, no-op.
2. No live `Session.Server` → `{:error, :session_not_connected}`
   (FallbackController → clear status code, **not** a silent 404). GET still
   serves the last completed snapshot if one exists.
3. `replace_start` (nuke), `Session.Server` sends `LIST`, accumulates 322 into
   batches → `ingest`.
4. Emit `directory_progress {count}` on the ~1s server-side throttle.
5. **On 323** → `finalize` (stamp `captured_at`), emit `directory_complete
   {captured_at, total}`.
6. **Timeout** (`directory_refresh_timeout_ms`) → clear in-flight, leave the
   snapshot unstamped (reads `:empty`), emit `directory_failed {reason}`. Honest
   failure surfaced to the client, per the no-silent-swallow rule.

### REST surface

```
scope "/networks/:network_id" (pipe_through [:api, :authn, :resolve_network])
  get  "/directory",         DirectoryController, :index
  post "/directory/refresh", DirectoryController, :refresh
```

`index` response:
```json
{ "entries": [{"name":"#grappa","topic":"…","user_count":42}, …],
  "next_cursor": "…|null",
  "total": 12431,
  "captured_at": "2026-06-26T…Z|null",
  "status": "fresh|stale|refreshing|empty" }
```

Cursor pagination is stable for deep scroll on a *completed* snapshot. During an
active refresh the client re-requests its current top-window on each ping
(paging a mutating sorted set is transient — exact mechanics are a plan-stage
detail); scroll position is preserved across the swap.

### Streaming events (network topic — pings only, no row data)

| kind | payload |
|------|---------|
| `directory_progress` | `{ count }` |
| `directory_complete` | `{ captured_at, total }` |
| `directory_failed`   | `{ reason }` |

cic dispatches these via the existing `subscribe.ts` narrow pattern (add a
`wireNarrow.ts` shape per kind). No `directory_entries` — the GET is the only
data door; the pings are pure "there's more, re-fetch" signals.

### cic surface

- **📇 channels pseudo-window** (per network): a sidebar pseudo-row directly
  below the network name, emoji-prefixed, always visible (same family as the
  `$server` window). **Excluded from the `/messages` fetch path** (#81). Contents:
  - **Search bar top-left** (top, not bottom, so it isn't mistaken for a compose
    input — there is **no** compose bar in this window).
  - **Refresh button top-right** beside the search bar.
  - **Live total-channel count** (from `directory_progress` / final `total`).
  - **"Last refreshed N ago"** muted line below the search bar; turns **red** +
    "tap refresh to update" when `> 48h`.
  - **Sort button** opening a select (by name / by users); the button **icon
    reflects the active sort**.
  - **Channel rows** — name · user_count · topic; tap a row → join via the
    existing `postJoin`. Rows the viewer is already in are **badged "joined" +
    join disabled** (annotated client-side against `windowStateByChannel`; no
    extra rows, no injection — discovery is for channels you're *not* in).
  - **Refresh** nukes the displayed list + restreams; the **viewport stays put**
    while rows populate/reshuffle under it (scroll position preserved).
- **Homepage** (`HomePane.tsx`): a "Browse channels on `<network>`" link per
  connected network → selects that network's 📇 window (auto-refresh fires if
  the snapshot is empty).
- **`/list` compose command** (`compose.ts` `parseSlash`): REST-first wrapper —
  selects/opens the focused network's 📇 window.
- **`api.ts`:** `listDirectory(token, network, {sort, q, cursor})` +
  `refreshDirectory(token, network)`, following the existing
  fetch+`buildHeaders`+`readError` pattern.
- **directory store** (new): holds the current page + `total` + `status` +
  `captured_at` for the focused network; re-GETs on each progress ping with
  scroll preserved; resets on `directory_failed`.

## Testing

- **Server (ExUnit + `Grappa.IRCServer` fake):** emit 321/322×N/323 →
  `replace_start` → batched `ingest` → `finalize` stamps `captured_at`. TTL
  boundary (fresh / stale / empty), auto-refresh-only-on-empty, in-flight guard
  (second refresh → `202` no-op), `:session_not_connected` error path, refresh
  **timeout** leaves an unstamped (→ `:empty`) snapshot + emits `directory_failed`.
- **Pagination/search/sort:** StreamData property test on each cursor boundary
  (`user_count DESC, name` and `name`) + `?q=` substring; never returns a row
  twice across pages; empty `q` = unfiltered; `total` reflects the snapshot.
- **Progress throttle:** assert `directory_progress {count}` is emitted on the
  throttle cadence and `directory_complete {total}` is terminal.
- **cic (vitest):** directory store re-fetches on `directory_progress`, updates
  the live count, finalizes on `directory_complete`, resets on `directory_failed`;
  "joined" annotation derives from `windowStateByChannel`; scroll-position
  preservation reducer holds `scrollTop` across a data swap.
- **e2e:** 📇 window renders from a seeded snapshot, search filters, sort toggle
  flips order + icon, one-click join transitions a row to "joined"; selecting the
  window fires **no** `/messages` request (#81 regression guard). (Grep
  `cicchetto/e2e/tests` for any rendered strings touched.)
- `mix test --warnings-as-errors`; Dialyzer; Credo strict; Sobelow; format.

## Out of scope

#83 AI theme gallery; #85 curated preconfigured links; shared cross-user
snapshot + its leak apparatus; client-side search/sort; background periodic poll;
upstream `LIST` filtering (`ELIST`/`LIST >N`) — we ingest the full list
server-side instead; surfacing the directory over the Phase 6 downstream IRCv3
facade (mechanical later).
