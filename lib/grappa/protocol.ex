defmodule Grappa.Protocol do
  @moduledoc """
  Single source of truth for the grappa REST + Phoenix-Channels wire
  PROTOCOL version — the integer a third-party client negotiates against
  (#447). Distinct from `Grappa.Version`, which is the human-facing
  *software* release string (`X.Y.Z-<sha>`, the CTCP VERSION reply); this
  is the *contract* number that governs whether two peers can talk at all.

  ## Two numbers

    * `version/0` — the protocol the server currently SPEAKS.
    * `min_version/0` — the OLDEST client protocol the server still
      accepts. The WS handshake rejects a client that declares below this
      with a `426 Upgrade Required` (`GrappaWeb.UserSocket`) rather than
      accepting the socket and feeding it frames it will mangle;
      `GET /api/config` publishes both so a client learns them BEFORE it
      connects.

  A client that declares no version at all is treated as current (the
  server sends nothing new to a silent client), so existing clients
  (cicchetto, shottino) keep working untouched — the negotiation is opt-in
  on the client side.

  ## Evolution: additive on the WIRE, and `version/0` moves anyway (#1393d)

  New frame kinds, new event types, and new fields may still appear at ANY
  time — a client MUST ignore verbs and fields it does not recognise
  (unknown-is-never-fatal, in BOTH directions: an unknown client verb earns
  a non-fatal error frame and the socket stays open), and existing fields
  are NEVER repurposed. That half of #447 is what keeps an OLD client
  working against a NEW server.

  **Removal is no longer "never", it is "only on a ruling" (v8, #1626).**
  One field has been taken back: `row_count` on the archive entry, because
  emitting it forced the listing to visit the whole partition and no
  amount of query work could buy the complexity class back while it
  stayed. The bar that removal has to clear, set by that case: the field
  must be the thing standing between the server and a property it cannot
  otherwise have, the break has to be measured on the real client rather
  than argued, and it takes a ruling — not a judgement call inside the
  slice. Everything short of that is still additive-only.

  What changed on 2026-08-21 is the other half. This moduledoc used to say
  such a change lands *"WITHOUT a version bump"*, and it was true right up
  until a client started REQUIRING one of those additive fields. #1393d is
  that client: cic now rejects an `isupport_changed` whose
  `list_modes_queryable` is missing rather than inventing one. Nothing
  about that is expressible additively — it is a NEW client that can no
  longer talk to an OLD server — and it is exactly the case the bump was
  reserved for.

  **So `version/0` now bumps on EVERY wire-shape change, additive
  included** (vjt's ruling, 2026-08-21). The reason is that the number is
  only useful if it is TOTAL: a client comparing against a floor is
  entitled to read "server >= N" as "server has everything N had", and one
  un-bumped field addition makes that reading false forever after. A floor
  that lies is worse than no floor, because the client believes it checked.
  Measured: `@protocol_version` sat at `1` from #447 (2026-07-27) through
  five additive fields — `recoverable`, `inviter`, `list_modes_queryable`,
  `chantypes`, `prefix_order` — every one of which cic later came to
  require.

  `min_version/0` is a DIFFERENT axis and does NOT follow: it moves only
  when old clients can no longer be SERVED. An additive field strands
  nobody, so a bump under the new rule leaves the floor where it is —
  which is why `version/0` has moved repeatedly while `min_version/0` has
  never left 1. (Deliberately not restating either number in prose: this
  paragraph outlived two bumps naming the old one.)

  The rule is written for client authors in `docs/CLIENT_PROTOCOL.md` and
  restated as an invariant in `CLAUDE.md`.

  ## Boundary

  Standalone top-level boundary, mirroring `Grappa.Version`: the web
  surface (`GrappaWeb.ConfigController`, `GrappaWeb.UserSocket`,
  `GrappaWeb.GrappaChannel`) reads these constants without crossing a
  deeper boundary edge. They are compile-time integers — no runtime state,
  no filesystem access.
  """

  use Boundary, top_level?: true, deps: [], exports: []

  # Protocol v5 (#1675) — v1 was the initial published contract (#447), v2
  # the ruling that made the bump unconditional (#1393d), v3 added
  # `tls_verify` to `Grappa.Networks.Servers.AdminWire.t` (#1677), v4 added
  # the `GET /boot` envelope (`GrappaWeb.BootJSON.index/1`): networks, every
  # network's channel tree, and each channel's head page in one round trip
  # (#1679). v5 adds the `failing` value to
  # `NETWORKS_CREDENTIAL_CONNECTION_STATE` and the `link_failure` key to the
  # scrollback meta allowlist.
  #
  # A fourth value in a literal union is the additive case the #1393d
  # ruling is about, and it is the direction that bites: a client that
  # starts REQUIRING `failing` (to grey a hammering network, say) cannot
  # be served by a server that never emits it, and nothing on the server
  # side would express that break without this number moving. Which
  # version it lands in is not a judgement call either — `mix
  # grappa.wire_pin --update` refuses to rewrite the digest while the
  # number stands still, so a moved shape either bumps or stays red.
  #
  # v5 and not v4 because this branch was written against v3 and #1679
  # landed v4 first: the rebase put TWO wire changes in one digest, and the
  # pin recomputed against the union rather than against either half.
  #
  # Purely ADDITIVE — no existing endpoint changed shape, and a v3 client
  # that never calls `/boot` is served exactly as before. It bumps anyway,
  # which is the rule working rather than a cost to route around: the moment
  # a client stops fanning out and starts REQUIRING `/boot`, it can no longer
  # talk to a server predating it, and that break runs new-client → old-server
  # — the direction the number exists for.
  #
  # Not adjudicated by hand: `mix grappa.wire_pin --check` went red on the
  # digest and named `3 -> 4` (see `Mix.Tasks.Grappa.WirePin`). Worth
  # recording that it was SILENT until `GrappaWeb.BootJSON` was added to the
  # codegen's `@extra_modules` — the routed, rendered, tested endpoint agreed
  # with protocol 3 at rc=0 beforehand, because the digested set is a glob
  # over `lib/grappa/**` plus a hand-kept list of web-layer envelopes.
  #
  # v6 (#1766) adds `show_bottom_bar` to the `display_prefs` object on
  # `GET/PUT /me/settings/display-prefs` — the mobile window bar's per-user
  # off switch. Additive, and it bumps for the #1393d reason: a client that
  # comes to REQUIRE the key cannot be served by a server predating it, and
  # nothing server-side would express that break without this number moving.
  #
  # ⚠️ `mix grappa.wire_pin --check` did NOT force this one and could not, so
  # do not read a green pin as "no bump needed". The digest spans the codegen
  # artefacts, whose sources are `lib/grappa/**/*wire.ex` plus a hand-kept
  # `@extra_modules` list of web-layer envelopes, and
  # `GrappaWeb.UserSettingsJSON` is not on it. That is the SAME silence #1679
  # hit with `BootJSON` — recorded there as a gap in the detector, not as a
  # boundary of the rule, and still open for every hand-written `*_json.ex`.
  # Widening the digest is a COVERAGE change, which the pin deliberately
  # cannot tell from a shape change (its moduledoc: delete and re-create, no
  # `--force`), so it is not smuggled in alongside a product change.
  #
  # v7 (#1769) adds an INBOUND shape rather than an outbound one: the
  # per-channel topic now reads a join param, `%{"presence" => false}`, and a
  # socket that sends it stops being pushed peer join/part/quit. Additive in
  # both directions — only the literal `false` suppresses, so a client that
  # joins the way it joins today receives what it receives today — and it
  # bumps for the #1393d reason all the same: the break it expresses runs
  # new-client → old-server. A cic that has come to rely on the pause will
  # ask an old server for it, be silently served the full flood, and have no
  # way to know except this number.
  #
  # ⚠️ `mix grappa.wire_pin --check` was SILENT here too — measured, with the
  # channel change already applied it answered `wire shape and protocol 6
  # agree.` It could not have done otherwise: the digest spans the codegen
  # artefacts, and a join param read in `GrappaWeb.GrappaChannel.join/3` is
  # in no `*wire.ex` and on no `@extra_modules` list. Third recorded instance
  # of the same detector gap (#1679 `BootJSON`, #1766 `UserSettingsJSON`,
  # this one a channel callback), and the first where the un-covered surface
  # is INBOUND — which no widening of the outbound codegen digest would ever
  # reach. Filed as #1787. The bump here is the RULE, not the gate.
  #
  # v8 (#1626) is the FIRST version that takes a field BACK:
  # `row_count` is gone from `Grappa.Scrollback.Wire.archive_wire_entry`.
  # Every bump before this one was additive, and the moduledoc's promise
  # that "existing fields are NEVER repurposed or removed" is what makes
  # this one different in kind rather than in degree. It is taken on a
  # ruling (vjt, 2026-08-26) with the price named up front: an exact
  # per-group count has to VISIT the group's rows, so while the field was
  # emitted the archive listing stayed bound to the size of the account
  # rather than to its number of targets. Keeping it meant keeping a
  # complexity class; the field is what was paid.
  #
  # @min_protocol_version STILL stays at 1, and here that is an argument
  # rather than the usual "additive strands nobody". Three measurements,
  # in the order that decides it:
  #
  #   1. The break is REAL and runs old-client → new-server, which is
  #      exactly this floor's axis: cic's generated schema declares
  #      `row_count` REQUIRED (`wireSchema.ts`), and `wireValidate`'s
  #      `walkObject` REJECTs an object missing a required key. An old
  #      bundle therefore throws away every archive response a v8 server
  #      sends. Measured, not inferred — `api.test.ts` carries a case
  #      named "listArchive rejects an entry missing `row_count`".
  #   2. Its blast radius is ONE listing, and it is contained: cic's
  #      `loadArchive` catches and leaves the previously rendered entries
  #      in place, and the renderer reads an absent slug key as "not
  #      loaded yet". Nothing else in the client degrades, the socket is
  #      untouched, no other endpoint changes shape.
  #   3. This floor is not endpoint-scoped. Raising it to 8 refuses the
  #      WHOLE SOCKET with 426 to every client declaring 1..7, including
  #      the ones that never call `/archive` at all — converting a quiet
  #      one-modal failure into a total refusal for clients the change
  #      does not touch. Matching a session-wide gate to an
  #      endpoint-scoped break is a category error, and it is the reason
  #      this stays put.
  #
  # So: "can no longer be SERVED" is read as the client, not as one of its
  # calls. A v1..v7 client is still served; one of its listings is not.
  # The honest signal for that is `version/0` moving, which a client can
  # see in `GET /api/config` and in the user-topic join reply, and which
  # cic already compares against its own floor.
  #
  # The mirror obligation on the cic side does NOT fire either, and that
  # was measured too: cic's `MIN_SERVER_PROTOCOL_VERSION` rises when the
  # bundle starts REQUIRING a newer field, and this change makes it
  # require one FEWER. A v8 bundle still talks to a v7 server, because
  # `walkObject` drops undeclared keys rather than rejecting them
  # (additive-only, #447) — so the `row_count` an old server still sends
  # is simply ignored. It stays at 2.
  # v9 (#1865) is additive again, and on three surfaces at once: the
  # per-network profile (`age`, `gender`, `location`, `languages`,
  # `custom`) plus `avatar_url` join `Grappa.Networks.Wire`'s credential
  # and network-with-nick payloads, `avatar_url` joins the WHOIS bundle,
  # and `whois_avatar_ready` is a NEW event arm on the user topic —
  # emitted once the peer's avatar has been fetched server-side, which is
  # inherently later than the bundle that named it.
  #
  # The bump is the rule, not the gate (see the #1782 paragraph above):
  # additivity describes what the server EMITS, and a floor that moves
  # only when something breaks is a floor that lies about what a client
  # is talking to. `mix grappa.wire_pin --check` is what makes it
  # non-optional.
  #
  # @min_protocol_version stays at 1 and this one is the ordinary case,
  # not the argued one: every field here is new, none is repurposed or
  # taken back, and cic's `walkObject` DROPS undeclared keys rather than
  # rejecting them — so a v1..v8 bundle pointed at a v9 server ignores
  # the profile fields and the new event arm and is otherwise untouched.
  # The mirror obligation on the cic side does not fire either:
  # `MIN_SERVER_PROTOCOL_VERSION` rises when the bundle starts REQUIRING
  # a newer field, and cic renders the profile only when present. It
  # stays at 2.
  # v10 (#1044) — the server `PASS` gets its own credential slot, and with
  # it a write door: `GET`/`PUT /networks/:network_id/server_pass`, carrying
  # `server_pass_set` and never the secret.
  #
  # ⚠️ `mix grappa.wire_pin` did NOT demand this bump, and that is exactly
  # why it is written down. The digest spans the GENERATED artefacts, which
  # come from `Grappa.*.Wire` typespecs; a REST endpoint whose shape lives in
  # a controller is invisible to it. So the gate stays green either way and
  # the number moves on the RULE, not on the tooling: reason (1) applies
  # literally here — a cic bundle that grows a gate-secret editor REQUIRES
  # this route and gets a 404 from any server predating it, which is the
  # new-client-to-old-server direction the number exists to express.
  #
  # @min_protocol_version stays at 1: the route is purely additive and no
  # existing client asks for it, so every v1..v9 bundle is served unchanged.
  # v11 (#1883) — the pre-upload confirm becomes a per-user setting, and with
  # it a read/write door: `GET`/`PUT /me/settings/upload-confirm-enabled`,
  # carrying `upload_confirm_enabled`.
  #
  # ⚠️ Same shape as v10 above, and the gate is green either way for the same
  # reason: the digest spans the GENERATED artefacts, and a settings endpoint
  # whose shape lives in a controller is invisible to it (`mix
  # grappa.wire_pin --check` said "wire shape and protocol 10 agree" with this
  # route already in the router). The number moves on the RULE: reason (1)
  # applies literally — a cic bundle that renders the opt-in CALLS this route
  # at boot and gets a 404 from any server predating it, which is the
  # new-client-to-old-server direction the number exists to express.
  #
  # @min_protocol_version stays at 1: purely additive, and the client treats a
  # failed read as the server's own default (`false`), so every v1..v10 bundle
  # is served unchanged.
  # v12 (#1946) — the `/notify` presence fallback for ircds with neither
  # MONITOR nor WATCH (IRCnet). `presence_changed.source` gains a third value,
  # `"ison"`.
  #
  # ⚠️ Unlike v10 and v11, `mix grappa.wire_pin` DOES demand this one: `source`
  # is a closed set in a `Grappa.Session.Wire` typespec, so it lands in the
  # generated artefacts and moves the digest. And the break is not theoretical
  # — it was MEASURED on the running dev stack before the bump: an old bundle
  # against the new server logged "This client could not read a
  # presence_changed update from the server and discarded it", because
  # `wireSchema.ts` drops a payload whose enum value is outside the set it
  # knows. New-server-to-old-client, which is the additive direction, and it
  # still breaks — a closed set gaining a member is a wire-shape change.
  #
  # @min_protocol_version stays at 1: an old client drops presence_changed
  # frames it cannot read and keeps every other pane, so it is degraded rather
  # than unserviceable — and only on the one network that needs ISON at all.
  # v13 (#1850) — `POST /admin/reload` gains a third refusal token,
  # `stale_code_path`: the beams a hot deploy just built are in a lib
  # directory the running node never reads.
  #
  # ⚠️ Same mechanism as v12 and NOT the same consequence, and the difference
  # is worth stating rather than inheriting. `GrappaWeb.ErrorTokens` is a
  # generated-artefact source, so a token lands in `REST_ERROR_TOKENS` /
  # `wireSchema.ts` and MOVES THE DIGEST — `mix grappa.wire_pin --check` demands
  # the bump, it is not a judgement call. But v12's measured break does NOT
  # reproduce here: the endpoint is loopback-gated, so no browser can reach it
  # and no bundle, old or new, will ever be handed this token. The number moves
  # because the shape moved and the floor must stay TOTAL — a client reading
  # `server >= N` as "has everything N had" is entitled to that, and one
  # un-bumped addition makes the reading false forever after.
  #
  # @min_protocol_version stays at 1: nothing a client can reach changed.
  # v14 (#162) — `/ignore`. The REST surface gains `/networks/:id/ignores`
  # and `FallbackController` a 422 `invalid_mask` token. The routes alone
  # would be a v10/v11-style bump; what moves the pin is the token, because
  # `rest_error_token` is a closed set that `gen_wire_types` renders into
  # cic's `KnownApiErrorCode` union and its runtime literal list.
  #
  # @min_protocol_version stays at 1: no bundle predating v14 knows the
  # `/ignore` verb, so none can send the request that earns the new token —
  # the only frame an old client could fail to read is one it cannot cause.
  #
  # v15 (#2029) — `display_prefs` grows a FIFTH key, `strip_formatting`: the
  # per-viewer opt-in that renders message bodies with the mIRC control codes
  # stripped. Same carrier as v6's `show_bottom_bar`, same reason it counts:
  # `display_prefs` is a client-facing REST payload and its shape changed,
  # which under the #1393d ruling is enough on its own.
  #
  # 🔴 `mix grappa.wire_pin --check` DID NOT force this bump, and the run is
  # on the record rather than inherited from v6: with the key already added to
  # `Grappa.UserSettings` and this number still reading 14, the gate answered
  # `wire shape and protocol 14 agree.` at rc=0. The digest spans the codegen
  # artefacts, whose sources are `lib/grappa/**/*wire.ex` plus a hand-kept
  # list of web envelopes, and `GrappaWeb.UserSettingsJSON` is on neither —
  # the same silence #1679 hit with `BootJSON`. v6 recorded that as a gap in
  # the DETECTOR; a second carrier hitting it identically makes it a property
  # of every hand-written `*_json.ex`, so the bump here is a deliberate manual
  # act and the next one will be too, until the digest's coverage widens.
  #
  # @min_protocol_version stays at 1, and deliberately: the key is absent-
  # tolerant in BOTH directions (`fetch_optional_display_bool/3` server-side,
  # `?? DEFAULT_DISPLAY_PREFS` client-side), so a bundle carrying it degrades
  # against an older server instead of breaking. cic's
  # MIN_SERVER_PROTOCOL_VERSION does not move for the same reason.
  #
  # cic's OTHER constant does: `CLIENT_PROTOCOL_VERSION` (socket.ts) moves
  # 14 → 15 in lockstep, because it says what cic SPEAKS rather than what it
  # requires. #1973's `protocol_test.exs` pin is what caught the half-done bump
  # here — and with `wire_pin --check` blind to this payload, that pin was the
  # ONLY automatic guard standing on this change.
  # v16 (#2037) — TWO shape changes, one number, because they ship together and
  # the version names a wire STATE rather than counting edits.
  #
  # (A) the gap-probe response (`GET …/messages/count?after=`) grows
  # `messages` + `events` beside the existing `count`. Three numbers because the route answers two questions:
  # `count` stays the THRESHOLD's raw feed (`isFarBehind`, out of scope per
  # the #2037 ruling) and the new pair is the DISPLAY split, so the
  # far-behind bar renders the same quantity the sidebar's bold pill already
  # shows instead of a third opinion on it.
  #
  # 🔴 `mix grappa.wire_pin --check` DOES NOT force this bump either, and the
  # reason is the one v15 recorded and generalised: the digest spans the
  # codegen artefacts, whose sources are `lib/grappa/**/*wire.ex` plus a
  # hand-kept list of web envelopes, and `GrappaWeb.MessagesJSON` is on
  # neither. That is now THREE carriers (`BootJSON` #1679,
  # `UserSettingsJSON` #2029, this) hitting the same silence, which is what
  # v15 predicted when it called it a property of every hand-written
  # `*_json.ex` rather than an accident. Bumped deliberately, by hand.
  #
  # (B) `display_prefs` grows a SIXTH key, `show_event_badge` — the opt-in the
  # same ruling puts the `!messaggi` badge behind. Same carrier as v15's
  # `strip_formatting` and v6's `show_bottom_bar`, and the same reason it
  # counts. It is the first display pref whose DEFAULT takes something away,
  # which is a product change and not a protocol one; the wire only sees a
  # sixth boolean.
  #
  # @min_protocol_version stays at 1. Both are purely additive and cic
  # reads them absent-tolerantly (a missing `messages` falls back to `count`,
  # the pre-#2037 number), so a new bundle against an older server degrades
  # to the old behaviour instead of breaking. cic's
  # `CLIENT_PROTOCOL_VERSION` moves 15 → 16 in lockstep because it says what
  # cic SPEAKS, not what it requires.
  #
  # v17 (issue 2046) — the channel-directory `status` union is re-spelled:
  # `empty` and `refreshing` OUT, `no_results`, `unknown` and `loading` IN.
  #
  # 🔴 This is the FIRST bump that is not purely additive, and it is NOT the
  # #1626 field-removal carve-out either — that one is about taking a field
  # off a payload, and every key here stays exactly where it was. What moved
  # is the set of VALUES a closed union may carry, which the additive rule
  # never covered: it speaks of frame kinds, event types and fields.
  # `status` is a closed set by construction (`gen_wire_types` renders it as
  # a TS literal union and `wireSchema` as a runtime enum), so a value can
  # only ever be added by widening it and removed by narrowing it.
  #
  # The two that left could not be kept, and this is the measured half:
  # `refreshing` MEANT "rows present, `captured_at` still NULL", a state that
  # only existed because the ingest wrote mid-stream. With persistence
  # deferred there is no such row — the stamp is written WITH the row — so
  # the clause was not deprecated, it was unreachable, and it went out under
  # the standing "less code" order rather than being left to lie. `empty`
  # conflated three answers (search matched nothing / never captured /
  # capture in flight) and the ruling names all three separately; keeping it
  # as a synonym for one of them would have shipped two spellings of the
  # same state, which is the half-migration this codebase forbids.
  #
  # What an OLD bundle does, stated rather than assumed: cic's generated
  # `wireSchema` rejects a `status` outside its enum, so a pre-v17 bundle
  # throws away every directory page a v17 server sends. That is a real
  # break for exactly one pane, it is why the number moves, and it is why
  # `min_protocol_version` is the axis to watch if we ever have to serve
  # both — see below.
  #
  # @min_protocol_version STAYS at 1, deliberately, and the reasoning is
  # the uncomfortable one. A client below v17 IS degraded — its directory
  # pane breaks — but raising the floor would 426 it out of the WS
  # handshake entirely, taking away every OTHER surface to protect one. A
  # broken pane beats a refused socket. The bundle and the server ship
  # together on this deploy, so the window in which a v16 bundle meets a
  # v17 server is a cache miss away from closing.
  @protocol_version 17
  @min_protocol_version 1

  @doc "The protocol version the server currently speaks."
  # A literal (not `pos_integer()`) so the spec matches the success typing of
  # the literal constant under Dialyzer `:underspecs` — the codebase idiom
  # for a constant-returning function (`Grappa.Notify.max_entries/0 :: 64`,
  # `Grappa.IRC.Identifier.max_nick_length/0 :: 30`). A bump edits the spec
  # alongside `@protocol_version`; the spec doubles as the bump tripwire,
  # and now that the bump is routine the tripwire is what keeps it from
  # being done half-way.
  @spec version() :: 17
  def version, do: @protocol_version

  @doc """
  The oldest client protocol version the server still accepts. A client
  declaring below this is refused at the WS handshake with 426.
  """
  @spec min_version() :: 1
  def min_version, do: @min_protocol_version
end
