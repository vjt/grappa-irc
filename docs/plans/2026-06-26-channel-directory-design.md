# Channel directory — `/list` discovery (#84)

**Date:** 2026-06-26
**Status:** design, approved by vjt
**Issue:** vjt/grappa-irc#84 (REST + command + homepage link)
**Unblocks (separate follow-ups, NOT built here):** #83 (AI theme gallery),
#85 (preconfigured channel links / one-click join curated set)

## Goal

Give cic a way to **discover channels the user is not in** on a connected
network — upstream IRC `LIST`, surfaced as a paginated/searchable REST resource
and a `/list` compose command, rendered as a homepage-reachable discovery pane
with one-click join. This establishes the homepage-discovery surface +
one-click-join wiring that #83 and #85 will reuse; it does not build either.

## Why this is non-trivial (the shape problem)

Upstream IRC `LIST` is **async, streamed, and potentially huge**: the server
replies `RPL_LISTSTART (321)` → `RPL_LIST (322)` once per channel → `RPL_LISTEND
(323)`, and on large networks that's 10k–50k entries arriving over many seconds.
Many networks throttle or flag frequent `LIST` as abuse. None of that maps
cleanly onto a synchronous REST GET. The design below resolves the mismatch
with a **per-user persisted snapshot + lazy refresh + live streaming during the
refresh**.

## What already exists (grounding)

- **No structured LIST capture today.** Numerics 321/322/323 currently fall
  through to `$server` scrollback as plain `:notice` rows
  (`lib/grappa/irc/numeric_router.ex:178` — the HIGH-3 2026-05-14 note). No
  accumulator. The IRC client never *sends* `LIST`.
- **grappa already holds topic + member count for JOINED channels** — `state.topics`
  (332/333) and `state.members[channel]` cardinality in `Session.Server`. Not
  reused here: discovery is about channels you're *not* in, where only upstream
  `LIST` has the data. (Recorded so a future reader doesn't conflate the two.)
- **REST pattern:** `scope "/networks/:network_id"` with `resolve_network`
  (`router.ex:246`). Existing `/channels` is the **joined-channels** resource
  (index/create=join/delete=part). The discovery directory is a *different
  noun* → new `/directory` resource.
- **Wire convention:** per-context `*.Wire` module, atoms→strings and
  DateTime→ISO8601 at the boundary (`Grappa.Scrollback.Wire`,
  `Grappa.QueryWindows.Wire`).
- **PubSub topics** are user-rooted: `grappa:user:{u}`,
  `grappa:user:{u}/network:{slug}`, `…/channel:{chan}`
  (`Grappa.PubSub.Topic`). The directory is a network-level concern → reuse the
  **network** topic.
- **cic homepage exists** (`HomePane.tsx`), branches registered vs visitor —
  natural slot for a "Browse channels" entry.
- **cic `/join` is text-only** → `compose.ts` `parseSlash` → `postJoin` → POST
  `/channels` (`api.ts`). One-click join = the same `postJoin` behind a button.
- **cic theme system already exists** (`data-theme` + CSS `--` tokens). Relevant
  only to #83 feasibility, not built here.

## Decisions (forks resolved with vjt)

1. **Source = upstream `LIST` passthrough.** Real discovery (channels you're not
   in), not "enumerate what grappa already knows."
2. **Per-user snapshot, NOT shared.** A shared network-global snapshot was
   designed first, then **rejected**: it forces a secret-channel-leak apparatus
   (strip the issuer's memberships, close the just-joined race, and a self-oper
   guard for `RPL_YOUREOPER`/usermode `+o` since an opered session sees `+s`/`+p`
   channels it isn't in — and `RPL_LIST` carries **no modes**, so we can't filter
   them out of the data). Per-user isolation deletes that entire class of
   problem **by construction**: a user's snapshot only ever holds what their own
   connection is authorized to see; nothing crosses users, so nothing leaks.
   - Accepted cost: upstream `LIST` no longer dedups across users — N browsers =
     up to N `LIST`s. With the 48h TTL each user fires ≈ one `LIST` / 48h plus
     manual refreshes, and grappa is a small-user bouncer. If user count ever
     grows, a shared public-only layer can be bolted back on. **YAGNI now.**
3. **Lazy refresh, 48h TTL.** On read: snapshot **empty or `captured_at` > 48h**
   → auto-trigger a refresh; **fresh (< 48h)** → serve cached, manual button
   forces a new `LIST`. No background poll (periodic `LIST` is the anti-social,
   abuse-throttle-risking option, and needs an elected issuer).
4. **Delivery = persisted snapshot + live stream during refresh.** Snapshot for
   instant subsequent loads; during the (rare) refresh, stream batches live so
   the pane fills progressively instead of a 30s spinner. Atomic replace at 323.
5. **Server-side pagination + search.** Cursor on `user_count DESC` + `?q=`
   substring in SQL; the browser never holds 50k rows.
6. **Scope = directory only.** #83 and #85 are separate follow-ups.

## Design

### New modules

- **`Grappa.ChannelDirectory`** (context) — public API:
  - `list(subject, network, opts)` → `{:ok, %{entries, next_cursor, captured_at,
    status}}` where `status` is a typed atom union:
    - `:fresh` — snapshot `< 48h`.
    - `:empty` — no rows yet (a refresh was fired).
    - `:refreshing` — empty/stale and a refresh is now in-flight.
    - `:stale` — `> 48h` but **could not** refresh (no live session); serving old
      data honestly rather than pretending it's current.

    Paginated (cursor on `user_count DESC, name ASC`), `opts[:q]` substring filter
    on name/topic.
  - `stale?(subject, network)` → boolean against the injected TTL.
  - `replace_snapshot(subject, network, entries)` → atomic DELETE-old +
    INSERT-staging in one transaction; stamps `captured_at`. The stored snapshot
    never goes half-populated.
  - `@spec`s written first; closed-set `status` is a typed atom union, never a
    bare string.
- **`Grappa.ChannelDirectory.Entry`** (schema) — fields `subject_type`
  (`:user | :visitor`), `subject_id`, `network_id`, `name`, `topic`,
  `user_count`, `captured_at`. Index `(subject_type, subject_id, network_id,
  user_count DESC, name)`. All writes via `Ecto.Changeset`.
- **`Grappa.ChannelDirectory.Wire`** — `Entry` → `%{name, topic, user_count}`.
  `joined` is annotated **client-side** (cic owns the viewer's joined set), not
  stored.
- **`GrappaWeb.DirectoryController`** — thin: `index` (GET, paginated+search),
  `refresh` (POST, triggers a `LIST`). `{:error, _}` via `FallbackController`.

### Touched modules

- **`Grappa.Session.Server`** — gains transient refresh state:
  `directory_refresh :: nil | %{staging: [...], started_at, requested_by}` plus a
  per-session in-flight guard. On a refresh request it sends `LIST` upstream; it
  accumulates 322 into `staging`; on 323 it calls
  `ChannelDirectory.replace_snapshot/3` and broadcasts completion. This state is
  transient working memory ("what I need for my next message"), not source of
  truth — the snapshot lives in sqlite. A crash mid-refresh just discards the
  staging and clears the flag.
- **IRC numeric routing** (`numeric_router.ex:178`) — when a refresh is
  in-flight for that session, route 321/322/323 to the accumulator instead of
  `$server` scrollback. grappa only ever *sends* `LIST` for a refresh, so this
  is unambiguous; absent an in-flight refresh, behavior is unchanged
  (defensive: unsolicited 322 still falls through to today's path).
- **`config/config.exs` + `lib/grappa/application.ex`** — `directory_ttl_ms`
  (48h) and `directory_refresh_timeout_ms` read at **boot** and injected via
  `Session.Server` `start_link` opts. No runtime `Application.get_env`. (Note:
  any `config/*.exs` change forces a COLD deploy.)
- **`Grappa.PubSub.Topic`** — no new topic; reuse `network(u, slug)`. New event
  **kinds** only.
- **`infra/nginx.conf`** + **`cicchetto/e2e/nginx-test.conf`** — allowlist
  `/networks/.../directory` in **both** the `:80` and `:443` blocks, or the
  route 404s at the proxy.

### Data flow

**Read — `GET /networks/:network_id/directory?cursor=&q=&limit=`:**
1. `ChannelDirectory.list/3`. If **empty or stale (> 48h)**: when a live
   `Session.Server` exists → fire an async refresh (fire-and-forget) and return
   the current page with `status: :refreshing` (or `:empty` if no rows yet);
   when no live session exists → return the old page with `status: :stale` (or
   `:empty`), since there's no connection to `LIST` over.
2. **Fresh (< 48h)** → return the page with `status: :fresh` + `captured_at`.

**Refresh — `POST /networks/:network_id/directory/refresh` (or auto):**
1. In-flight guard; if already running → `202`, no-op.
2. No live `Session.Server` (network parked/failed) → `{:error,
   :session_not_connected}` (FallbackController → clear status code, **not** a
   silent 404). GET still serves the last stale snapshot if one exists.
3. `Session.Server` sends `LIST`; accumulates 322 into `staging`.
4. **Batched streaming:** every ~200 entries (or ~250ms, whichever first),
   broadcast `kind: "directory_entries"` (an array of wire entries) on
   `grappa:user:{u}/network:{slug}`.
5. **On 323** → `replace_snapshot/3` (atomic), then broadcast `kind:
   "directory_complete"` with `captured_at` + total.
6. **Timeout** (`directory_refresh_timeout_ms`) → discard `staging`, clear the
   flag, retain the old snapshot, broadcast `kind: "directory_failed"` with a
   reason. Honest failure surfaced to the client, per the no-silent-swallow rule.

### REST surface

```
scope "/networks/:network_id" (pipe_through [:api, :authn, :resolve_network])
  get  "/directory",         DirectoryController, :index
  post "/directory/refresh", DirectoryController, :refresh
```

`index` response shape:
```json
{ "entries": [{"name":"#grappa","topic":"…","user_count":42}, …],
  "next_cursor": "…|null",
  "captured_at": "2026-06-26T…Z|null",
  "status": "fresh|stale|refreshing|empty" }
```

### Streaming events (on the network topic)

| kind | payload |
|------|---------|
| `directory_entries`  | `{ entries: [{name, topic, user_count}, …] }` |
| `directory_complete` | `{ captured_at, total }` |
| `directory_failed`   | `{ reason }` |

cic dispatches these via the existing `subscribe.ts` `narrowChannelEvent`
pattern (add a `wireNarrow.ts` shape per kind) into a directory store.

### cic surface

- **Discovery pane** (per network): paginated/searchable list; row = name ·
  user_count · topic; **annotate** entries the viewer is already in as "joined"
  (disable that row's join button) against cic's own `windowStateByChannel` —
  no extra rows, no client-side injection (discovery is for channels you're
  *not* in; your own channels live in the sidebar). One-click join = existing
  `postJoin`. Live `directory_entries` append during a refresh; `directory_complete`
  finalizes; `directory_failed` shows an inline error + retry.
- **Homepage** (`HomePane.tsx`): a "Browse channels on `<network>`" entry per
  connected network → opens that network's pane.
- **`/list` compose command** (`compose.ts` `parseSlash`): REST-first wrapper —
  opens the discovery pane for the focused network (auto-refresh fires if the
  snapshot is empty/stale).
- **`api.ts`:** `listDirectory(token, network, {cursor, q})` +
  `refreshDirectory(token, network)`, following the existing fetch+`buildHeaders`
  +`readError` pattern.

### Open detail-decisions (proposed defaults; correct at spec review)

- **(a)** Endpoint noun `/directory` (distinct from joined-`/channels`).
- **(b)** Discovery renders as a **per-network pane** opened from homepage +
  `/list`, not a modal.

## Testing

- **Server (ExUnit + `Grappa.IRCServer` fake):** emit 321/322×N/323 → assert
  accumulator → atomic `replace_snapshot` → `captured_at`. TTL boundary (fresh
  vs stale), in-flight guard (second refresh is a no-op `202`),
  session-not-connected error path, refresh **timeout** discards staging +
  retains old snapshot + emits `directory_failed`.
- **Pagination/search:** StreamData property test on the cursor boundary
  (`user_count DESC, name`) + `?q=` substring; never returns a row twice across
  pages; empty `q` = unfiltered.
- **Streaming:** assert batched `directory_entries` then terminal
  `directory_complete`; batch size/flush honored.
- **cic (vitest):** directory store accumulates `directory_entries`, finalizes
  on `directory_complete`, clears on `directory_failed`; "joined" annotation
  derives from `windowStateByChannel`.
- **e2e:** pane renders from a seeded snapshot, search filters, one-click join
  transitions a row to "joined". (Grep `cicchetto/e2e/tests` for any rendered
  strings touched.)
- `mix test --warnings-as-errors`; Dialyzer; Credo strict; Sobelow; format.

## Out of scope

#83 AI theme gallery; #85 curated preconfigured links; shared cross-user
snapshot + its leak apparatus; background periodic poll; surfacing the directory
over the Phase 6 downstream IRCv3 facade (mechanical later); reusing joined-channel
topic/member-count state for discovery (different domain).
