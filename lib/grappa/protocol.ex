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
  # v18 (issue 1480) — `notification_prefs` grows `notification_sound`, the
  # name of the in-app beep preset. Purely additive, and additive still
  # bumps (#1393d).
  #
  # 🔴 `mix grappa.wire_pin --check` is blind to it, for the FOURTH time and
  # for the reason v15 generalised: the digest spans the codegen artefacts
  # plus the `@spec`s the hand-written `GrappaWeb.*JSON` views export, and
  # `UserSettingsJSON.notification_prefs/1`'s spec names the REMOTE type
  # `UserSettings.notification_prefs()`, which is digested as the reference
  # TEXT. Growing the type behind that name moves no byte the gate can see —
  # measured before the bump, not assumed: `notification` appears 0 times in
  # either generated artefact (positive control: `server_time`, 2 hits).
  # Bumped by hand, and the gate will then read `:pin_stale` rather than the
  # violation, so `--update` is the correct next step.
  #
  # This is the SECOND time `UserSettingsJSON` has been the silent carrier
  # (v16's `show_event_badge` was the first), which is worth naming: a key
  # added inside `notification_prefs()` or `display_prefs()` will ALWAYS be
  # invisible here, because both are remote types behind a view spec.
  #
  # 🔴 The behaviour change rides ALONGSIDE the wire one and is not what the
  # number describes: the default is `"none"`, i.e. SILENCE, for every
  # existing subject (vjt's ruling — «suono deve essere opt-in»). No client
  # can detect that from the version; it is a product change, and the entry
  # in DESIGN_NOTES is where it lives.
  #
  # @min_protocol_version stays at 1. The field is additive and BOTH sides
  # are absent-tolerant on purpose — cic falls back to `none` when the
  # server does not send it, and the server treats an absent key on the PUT
  # as UNCHANGED rather than as a reset — so a new bundle against an older
  # server is silent instead of broken, and an old bundle cannot mute a
  # subject who opted in.
  # v19 (issue 2089) — two new user-topic event kinds for DCC RECEIVE:
  # `dcc_offer` (a peer offered a file; the bouncer is HOLDING it, awaiting
  # consent) and `dcc_offer_resolved` (it left the held set — accepted,
  # refused or expired). Purely additive, and additive still bumps (#1393d).
  #
  # Unlike v18, this one IS visible to `mix grappa.wire_pin --check`: both
  # payloads are named `@type`s on `Grappa.Session.Wire`, which the codegen
  # renders into both artefacts, so the digest moves. The gate should read
  # `:pin_stale` after this edit — the rule held, the file has not caught
  # up — and `--update` is the correct next step.
  #
  # ⚠️ This bump also RECORDS a scope extension that is not a wire fact: the
  # issue body says v1's surface is the synthesised message alone and defers
  # "a richer interface". A consent banner IS interface. It was extended on
  # vjt's ruling, knowingly — see DESIGN_NOTES and the PR body — because
  # holding an offer for explicit consent, which the same ruling requires,
  # has no door to say yes through without one.
  #
  # @min_protocol_version stays at 1. A client that does not know these
  # kinds ignores them (unknown-is-never-fatal) and simply never accepts a
  # DCC offer — which is the pre-2089 behaviour, so an old bundle is
  # unchanged rather than broken.
  #
  # v20 (issue 2089, same slice as v19) — ONE new REST error token,
  # `not_held`, enrolled in `GrappaWeb.ErrorTokens.rest_error_token/0`: the
  # four DCC consent doors answer it (404) when the offer id names nothing
  # in the session's held set, because it expired, was already answered, or
  # was never ours. It is a member added to a CLOSED SET the codegen renders
  # into the client artefacts, so the wire shape moved and the number owes a
  # bump even though nothing was taken away.
  #
  # Measured, not deduced: with `:not_held` removed and NOTHING else
  # touched, `mix grappa.wire_pin --check` returns rc=0 «agree» — the digest
  # moves for this token alone.
  #
  # 🔴 Additive is not a reason to hold the number still (#1393d). «No
  # client reads it today» is the exact argument that kept
  # `@protocol_version` at `1` through five additive fields that cic later
  # came to REQUIRE — the failure CLAUDE.md cites as measured. Additivity
  # describes what the SERVER emits and says nothing about what a CLIENT
  # requires; the break this number exists to catch runs new-client →
  # old-server, and a floor that skipped one addition is a floor that lies.
  # The sibling token `:not_invited`, on the twin consent door, took its own
  # bump on the same grounds.
  #
  # @min_protocol_version stays at 1. A client that has never heard of
  # `not_held` reads a 404 with an unfamiliar token and falls back to its
  # generic error path — the same thing it already does for every token
  # added since v1 — so an old bundle is degraded in wording, not broken.
  #
  # v21 (issue 2127) — the accepted-DCC-file door MOVES. `GET
  # /networks/:network_id/dcc_files/:slug` behind `:authn` +
  # `ResolveNetwork` becomes `GET /dcc_files/:slug[.ext]` at top level on
  # `pipe_through [:api]`, the same public surface as `GET /uploads/:slug`,
  # with the 26-char base32 slug as the access token.
  #
  # ⚠️ Same shape as v10 and v11, and the gate is green either way for the
  # same reason they record: the digest spans the GENERATED artefacts,
  # which come from `Grappa.*.Wire` typespecs, and a route whose shape
  # lives in a controller is invisible to it. Measured here too — `mix
  # grappa.wire_pin --check` answered «wire shape and protocol 20 agree»
  # with the moved route already in the router, and the same command
  # answered rc=1 when a named `@type` was perturbed, so the green is a
  # live gate's silence rather than a dead one's.
  #
  # So the number moves on the RULE. This is a STRONGER case than v10/v11,
  # which were purely additive: a path was TAKEN AWAY, so the break runs
  # both ways. A client holding the old path gets a 404 from this server,
  # and a client built for the new one gets a 404 from any server
  # predating it — and reason (1) covers the second direction exactly.
  #
  # 🔴 Two consequences stated rather than left for someone to find.
  #
  # The route is now UNAUTHENTICATED: whoever holds the URL reads the
  # bytes, with no login, until `Grappa.Dcc.Reaper` expires the row. That
  # is the posture `/uploads/:slug` has had since UX-6-B1 on the same 128
  # bits, and it is the POINT of the change rather than a cost of it —
  # `GrappaWeb.Plugs.Authn` reads only a bearer HEADER, so a tapped
  # scrollback link collected a 401 and the delivery row was unusable by
  # the one person it was minted for.
  #
  # Delivery rows ALREADY IN SCROLLBACK carry the old relative path and
  # now point at a route that does not exist. Nothing usable is lost —
  # those strings never linkified (no scheme, no `host.tld`) and 401'd
  # when pasted — so they go from one kind of dead to another, and no
  # migration rewrites them. Not measured against production: the prod
  # jail is not reachable from here, so the row COUNT is unknown.
  #
  # @min_protocol_version stays at 1. No client has ever CONSTRUCTED this
  # URL — the server mints it into the scrollback body and cic only
  # linkifies what it is handed — so no bundle predating v21 asks for the
  # old path, and every one of them renders the new absolute URL as an
  # ordinary link. The break is real but it is new-client → old-server,
  # which is the axis this number carries and not the floor.
  #
  # v22 (issue 2143) — the per-network DCC auto-accept opt-in gets its door:
  # `GET`/`PUT /networks/:network_id/dcc-auto-accept`, carrying a single
  # `enabled` boolean. Purely additive; no existing endpoint changed shape.
  #
  # ⚠️ Same shape as v10, v11 and v21, and MEASURED here rather than
  # inherited from them. `mix grappa.wire_pin --check` was run on BOTH sides
  # of this branch — on the merge base and on the finished tree — and
  # answered `wire shape and protocol 21 agree.` at rc=0 both times. The
  # digest genuinely does not move: the routes' shape lives in
  # `GrappaWeb.DccAutoAcceptController`, which is no `*wire.ex`, is on no
  # `@extra_modules` list, and exports no `GrappaWeb.*JSON` view for the
  # third component to read. The two runs are a BEFORE and an AFTER rather
  # than one green, so the silence is a live gate's and not a dead one's.
  #
  # So the number moves on the RULE. Reason (1) applies literally: a cic
  # bundle that renders this switch CALLS these routes and gets a 404 from
  # any server predating them, which is the new-client → old-server
  # direction the number exists to express. That the switch has no client
  # control in this cut does not weaken it — waiting for the client is
  # exactly the argument that held `@protocol_version` at `1` through five
  # additive fields cic later came to require.
  #
  # @min_protocol_version stays at 1: additive, and no bundle predating v22
  # asks for a route it has never heard of, so every one of them is served
  # unchanged.
  #
  # v23 (issue 2150) — two new user-topic push kinds for the remembered
  # leave reasons: `quit_part_reason_changed` (the message sent when the
  # subject leaves without typing one) and `auto_away_reason_changed` (the
  # one the bouncer sends when IT marks them away). Both carry a single
  # `string | null` field named after the key, and `null` is a VALUE — it
  # is how "I cleared it" travels — so the key is always present.
  #
  # Purely additive, and the number moves anyway: that is the #1393d rule,
  # and the reason applies literally here. cic's `userTopic.ts` grows an
  # arm that REQUIRES each payload to validate against its generated
  # schema, so a bundle built against v23 cannot be served by a server
  # predating it — new-client → old-server, the axis this number carries.
  #
  # MEASURED, not assumed: `mix grappa.wire_pin --check` was run BEFORE
  # touching this line and reported the digest moving
  # `sha256:74cb9003…628fdb` -> `sha256:75e60cc5…c9764` with the protocol
  # «21 (unchanged)». The bump is that gate's verdict rather than a
  # judgement call — had the digest stood still, the honest act would have
  # been to leave the number alone and say so. That BEFORE digest is the
  # one v22 left standing (measured on `origin/main`'s own `shape.pin`,
  # `74cb9003…628fdb`), so the rebase onto v22 put no second shape change
  # into the number and `75e60cc5…c9764` is this slice's contribution
  # alone.
  #
  # ⚠️ 22 IS NOT OURS, and the gap in this comment's history is deliberate.
  # #2143 claimed it concurrently; the collision was visible only to
  # whoever held both branches, and the orchestrator ruled this one to 23
  # rather than have two branches merge the same number. The number must
  # stay MONOTONIC on main, so #2143 had to land FIRST — landing this one
  # while main still read 21 would have walked the published version
  # backwards the moment 22 arrived behind it. It has landed: main carried
  # `@protocol_version 22` when this branch was rebased onto it, and 23
  # now sits exactly one above.
  #
  # @min_protocol_version stays at 1. Both events are pushes a client may
  # simply not have an arm for, and an unrecognised `kind` has always been
  # ignorable (unknown-is-never-fatal); no bundle predating v23 is left
  # unable to talk to this server.
  #
  # ---------------------------------------------------------------------------
  # 24 — issue 2167: `bold_mentions`, a seventh key on `display_prefs`
  # ---------------------------------------------------------------------------
  #
  # The GET/PUT `/me/settings/display-prefs` body grows one boolean. Purely
  # additive, and the bump is owed under #1393d rather than demanded by the
  # shape gate: `mix grappa.wire_pin --check` was GREEN at 23 before this
  # branch touched anything, and the display-prefs body is hand-typed
  # (`userSettings.ts`) rather than generated, so the pin's digest does not
  # move for this key. Those are two DIFFERENT verdicts and they are recorded
  # as different ones — the number moves because the rule says every
  # wire-shape change moves it, not because a gate went red.
  #
  # The reason #1393d exists applies squarely here: a cic bundle that comes to
  # REQUIRE `bold_mentions` cannot talk to a server predating it, and nothing
  # server-side would express that without the number. Its six predecessors
  # (#1766, #2029, #2037 …) each bumped for the same reason.
  #
  # @min_protocol_version stays at 1. The key is absent-tolerant in BOTH
  # directions by construction — the server fills it from
  # `default_display_prefs/0` on the way in, cic coalesces it against the same
  # default on the way out — so a bundle predating v24 keeps working, and this
  # server keeps serving it.
  #
  # v25 (issue 2176) — `meta.structural`, a new allowlisted key on the
  # scrollback `meta` map. The server sets it to `true` on a `:mode` row whose
  # token changed the CHANNEL (a ban, a key, a limit, a flag) rather than a
  # member's status prefix, so a denoised window can fold the `+o` churn and
  # still show the `+b`. Purely additive: the key is absent on every other row
  # and on every row written before it existed, and absence means exactly what
  # it meant yesterday.
  #
  # The number moves anyway — #1393d — and reason (1) applies literally. cic's
  # `presenceFilter.ts` now REQUIRES the tag to render a ban on a denoised
  # channel; a bundle built against v25 talking to a server predating it gets
  # the old behaviour silently, which is the new-client → old-server direction
  # this number exists to express. Reason (2) is the load-bearing one: a client
  # reading `server >= N` is entitled to read it as "has everything N had", and
  # one un-bumped addition makes that false forever.
  #
  # MEASURED, not assumed: `mix grappa.wire_pin --check` was run with this
  # number still reading 23 and reported «The wire shape changed and the
  # protocol version did not» — digest `sha256:75e60cc5…c9764` (the one
  # `origin/main` carries) -> `sha256:30ae99e3…28caaf`, protocol «23
  # (unchanged)». The addition lands in `SCROLLBACK_META_TKEY`, the generated
  # literal union of the meta allowlist. Had the digest stood still the honest
  # act would have been to leave the number alone and say so. The gate named
  # `23 -> 24`; the number below is 25 for the reason in the next paragraph,
  # which the gate cannot see.
  #
  # ⚠️ 24 IS NOT OURS, and the gap it leaves in this file's narration is a
  # collision resolved by ORDER rather than by argument. PR #2186 (issue 2167)
  # claimed 24 while this branch was being written; the clash was visible only
  # to whoever held both branches, and the published number must stay MONOTONIC
  # on main, so that one landed first and this one sits exactly above it. Same
  # posture as the v22/v23 gap recorded earlier. The reservation was declared
  # CONDITIONAL while #2186 was still in gate — "if it does not land, come back
  # down to 24 rather than leave a hole" — and the condition is discharged:
  # measured on `origin/main` at rebase time, all THREE sites read 24
  # (`@protocol_version`, `@spec version()`, and `CLIENT_PROTOCOL_VERSION` in
  # socket.ts), which is also the check the three-sites warning below demands.
  #
  # @min_protocol_version stays at 1, and the key is absent-tolerant BY
  # CONSTRUCTION: a bundle that has never heard of `meta.structural` reads a
  # `:mode` row exactly as it did before, because the pre-2176 rule IS what
  # absence encodes. No client is left unable to talk to this server.
  #
  # ---------------------------------------------------------------------------
  # 26 — issue 2175: `per_user_cap_bytes` + `per_visitor_cap_bytes` on the
  #      upload settings view
  # ---------------------------------------------------------------------------
  #
  # ⚠️ This branch was WRITTEN claiming 25 and REBASED onto a main that had
  # already published 25 (issue 2176, the block directly above). Same collision
  # as the 24/#2186 one that block records, resolved the same way — by ORDER,
  # not by argument: the published number stays MONOTONIC on main, the branch
  # that landed first keeps the number, this one sits exactly above it. It is
  # worth naming the shape, because it is now the third occurrence and it is
  # structural: a number claimed at WRITE time against a main that moves is a
  # reservation, not a fact, and it has to be re-measured at rebase time.
  #
  # Measured on `origin/main` at rebase time, all THREE sites read 25
  # (`@protocol_version`, `@spec version()`, and `CLIENT_PROTOCOL_VERSION` in
  # socket.ts) — the check the three-sites warning below demands. Only site 1
  # conflicted; sites 2 and 3 merged clean at 25 and had to be moved BY HAND,
  # which is exactly the failure that warning predicts.
  #
  # The per-subject upload quota adds two `ServerSettings` keys, and both land
  # on `Grappa.ServerSettings.Wire.upload_view/1` — the projection shared by
  # `GET /api/server-settings`, `GET /admin/settings` and the WS
  # `server_settings_changed` push. Generated shape, so unlike #2167 this bump
  # is demanded by the gate as well as by the rule: `upload_view` is a `*.Wire`
  # typespec, `wireTypes.ts`/`wireSchema.ts` move with it, and the
  # `priv/wire/shape.pin` digest spans both.
  #
  # ⚠️ They are on the wire for the ADMIN, not for cic. A client cannot act on
  # them: vjt's 2026-09-14 ruling routes a per-subject refusal through the
  # EXISTING `:insufficient_storage` → 507, so cic cannot even distinguish
  # "the instance is full" from "you are at your quota". Publishing them is
  # what makes the admin knob readable — an `apply_upload_key` clause whose
  # value the operator can set and never verify is half a setting. Keeping
  # them off `public_view/0` and building an admin-only subtree inline (the
  # `addressing` shape) was considered and refused: it is a third pattern for
  # exposing a setting and it would leave the admin `upload` map diverging
  # from its own generated type.
  #
  # @min_protocol_version stays at 1. Two additive fields on a response body;
  # a bundle predating v26 ignores them and keeps working, and this server
  # keeps serving it.
  # ---------------------------------------------------------------------------
  # 28 — issue 2219: the `network_detached` / `network_attached` pair +
  #      `detached_at` on the admin credential row (27 skipped, see below)
  # ---------------------------------------------------------------------------
  #
  # The accretion verb finally has an inverse (`DELETE /session/networks/:slug`),
  # and it puts three additive things on the wire. Two new user-topic event
  # kinds, `network_detached` and `network_attached` (`network_id` +
  # `network_slug` each), because neither direction is a state transition and
  # so neither can honestly ride `connection_state_changed`: detaching an
  # already-parked network moves no state at all, and the `:parked →
  # :connected` flip an attach DOES emit refreshes `GET /networks` and never
  # the `/me` envelope the `$home` rows come from. And one field on
  # `Credentials.AdminWire.t()`, `detached_at`, so the operator console can say
  # why a credential it lists answers no REST call and spawns at no boot.
  #
  # ⚠️ 27 IS SKIPPED, AND THE GATE IS WHY. This branch pinned 27 for the
  # detach half, then vjt's review asked for `network_attached` — announcing
  # the detach while the attach stayed silent is worse than announcing
  # neither, because a second tab keeps offering a network it already holds.
  # The obvious move was to fold the new event into the still-unpublished 27,
  # and `mix grappa.wire_pin --update` REFUSED: the shape had moved and the
  # number had not.
  #
  # The refusal is right and the argument for folding was wrong. The rule is
  # total by design — a shape change bumps, full stop — and "unpublished"
  # is exactly the kind of carve-out that makes a floor stop meaning
  # anything, because the next reader inherits the carve-out and not the
  # reasoning. The cost is a gap: main goes 26 → 28 and no server ever spoke
  # 27. That is harmless in the direction the number exists for, since no
  # client can require a version nothing ever published, and it is written
  # down here so the gap reads as a decision rather than as a lost commit.
  #
  # Both are generated shapes — the event is a `Networks.Wire` typespec and the
  # field lands on an `AdminWire` one — so `wireTypes.ts` / `wireSchema.ts` move
  # with them and `priv/wire/shape.pin` spans both. The gate demands this bump
  # as well as the rule does.
  #
  # Nothing was taken away and no field changed meaning. What a client CANNOT
  # see from the number alone is the read-side change underneath: a detached
  # credential stops appearing in `GET /networks`, in `GET /boot` and in the
  # `$home` envelope, and every `/networks/:slug/…` route answers the iso 404
  # for it. That is a row going absent, which the wire has always permitted —
  # an unbind has looked exactly like it since #105 — so it is not a shape
  # change and does not reach `min_protocol_version`.
  #
  # @min_protocol_version stays at 1. An old bundle ignores event kinds it
  # does not know (unknown-is-never-fatal, both directions) and ignores an
  # extra key on an admin row; it keeps working against this server, and this
  # server keeps serving it.
  #
  # ---------------------------------------------------------------------------
  # 29 — issue 2270: `date_format`, an eighth key on `display_prefs`
  # ---------------------------------------------------------------------------
  #
  # The GET/PUT `/me/settings/display-prefs` body grows one closed-set string,
  # `"auto" | "dmy" | "mdy" | "ymd"`. Five cic sites rendered dates with a bare
  # `toLocaleString()`, so the notation came from the browser's UI LANGUAGE
  # rather than the viewer's region; the reported device is an iOS phone whose
  # Language is English and whose Region is Italy, with its own Date Format set
  # to `19/08/2026`. The web exposes no region, so no default can recover that
  # setting — the preference is the only channel that can carry it.
  #
  # MEASURED, and the two verdicts are recorded as two because they are
  # different: `mix grappa.wire_pin --check` was GREEN at 28 with this key
  # already added server-side. The display-prefs body is hand-typed in
  # `cicchetto/src/lib/userSettings.ts` rather than generated, and no
  # `GrappaWeb.*JSON` `@spec` spells its shape, so the digest cannot see this
  # field at all. The number moves because #1393d says every wire-shape change
  # moves it — not because a gate went red. Its seven predecessors on this same
  # body (#1766, #2029, #2037 B, issue 2167 …) moved it for the same reason.
  #
  # Reason (1) of #1393d is literal here: a cic bundle that comes to REQUIRE
  # `date_format` cannot talk to a server predating it, and nothing server-side
  # would express that without the number.
  #
  # @min_protocol_version stays at 1. The key is absent-tolerant in BOTH
  # directions by construction — the server fills it from
  # `default_display_prefs/0` on the way in (a PUT omitting it is ACCEPTED, not
  # 422'd), and cic coalesces it against the same default on the way out — so a
  # bundle predating v29 keeps working and this server keeps serving it.
  #
  # ---------------------------------------------------------------------------
  # 30 — issue 2282: `?cap=` on `/messages/count`, a THRESHOLD-only response
  # ---------------------------------------------------------------------------
  #
  # `GET /networks/:slug/channels/:name/messages/count` grows one optional
  # request param. With `cap` present the response is `{"count": N}` alone,
  # saturating at `cap`; without it the three-key `{count, messages, events}`
  # body of #693 + #2037 is byte-identical to what it was at v29.
  #
  # The route answers two questions with different costs, and only one of them
  # gates cic's paint. Measured on a 372,651-row synthetic corpus at a
  # 200,014-row gap: the pair is 82 ms / 12,963,811 VM steps, the display split
  # alone 57 ms, and the same threshold answered with `cap = 201` is 1 ms /
  # 4,304 steps — a class change, on the same covering index, only the `LIMIT`
  # moving. cic's `isFarBehind(gap) === gap > PAGE_LIMIT` needs the boolean and
  # nothing else, so the split can follow AFTER the rows are on screen.
  # Synthetic, mac, warm cache: an ORDERING and an attribution, never a latency
  # a phone would see — #2228's 738 ms is the field anchor.
  #
  # MEASURED, and NOT the v29 verdict — the first draft of this block claimed
  # it was, by copying v29's reasoning without checking that it applied. It
  # does not. **`wire_pin` SAW this change and went red on it**, and the pin
  # was stale in both fields at once (`:pin_stale`, not the violation):
  #
  #     shape digest  pinned sha256:b0e5d018…  now sha256:e4ce7cff…
  #     protocol      pinned 29                now 30
  #
  # The digest's THIRD component is `json_view_spec_text/0` — the `@spec`s of
  # the exported functions of every `GrappaWeb.*JSON`, read from BEAM chunks —
  # and #2037 added it after measuring the hole on `MessagesJSON.count/1`,
  # which is this very function. This change widens that `@spec` (a `| nil`
  # argument, a second return alternative), so it is squarely inside the
  # coverage that was built for it. In the same job
  # `mix grappa.gen_wire_types --check` answered `is in sync.` on all three
  # artefacts, which is the pin earning its existence rather than a blind spot.
  #
  # v29's claim was true of v29 for a reason that is absent here: a
  # `display_prefs` key moves no `*JSON` `@spec` at all. The lesson worth
  # keeping is that the invisibility argument is PER CHANGE and has to be
  # measured each time, never inherited from the entry above it.
  #
  # Reason (1) of #1393d, literally: a cic bundle that comes to REQUIRE the
  # capped mode — which is exactly what a bundle built on it does — cannot get
  # it from a server predating this, and nothing server-side would say so.
  #
  # @min_protocol_version stays at 1, and the degradation is why. `cap` is a
  # REQUEST param, so an old server IGNORES it and answers the uncapped body;
  # the capped caller reads `count` out of that body and gets the SAME boolean,
  # slower. An old client never sends `cap` and cannot tell this server from
  # v29. Both directions keep working, so nothing here refuses anybody.
  # v31 (issue 2294) — the `/ignore` list grew a second, OPTIONAL dimension:
  # an entry may carry a glob over the message TEXT beside its
  # `nick!user@host` mask, and a PRIVMSG/NOTICE is dropped when both match.
  # It is what makes a relay bot's individual authors ignorable — every line
  # a bridge relays wears the BRIDGE's prefix, so #162 could only silence all
  # of them at once.
  #
  # Additive on the wire, twice over. `GET/POST/DELETE
  # /networks/:network_id/ignores` keep answering with `masks`, the same list
  # of strings in the same order; the new `entries` array is a SECOND
  # projection of the same list carrying `{mask, text_pattern}`. `POST` takes
  # an optional `text_pattern` beside `mask`, `DELETE` takes it as a query
  # parameter, and a request that never mentions it behaves exactly as it did
  # at v30. Turning `masks` into a list of objects was the obvious shape and
  # is the one thing forbidden outright — a repurposed field, not an added
  # one (#447, and the #1626 bar for taking one back is a RULING, which this
  # slice does not have and does not need).
  #
  # MEASURED, and the measurement changed the diff. `mix grappa.wire_pin
  # --check` was run on the FIRST cut, which added `entries` to the
  # controller's inline `json/2` map: it answered `wire shape and protocol 30
  # agree.` at rc 0 — GREEN on a wire-shape change. Positive control on the
  # same tree, same session: one word changed in a `GrappaWeb.*JSON` view's
  # `@spec` took it RED with the digest moving
  # `sha256:e4ce7cff…6ba4db` -> `sha256:6c795fc0…89be8`, and reverting
  # returned it byte-identical. The pin digests what the `*JSON` views
  # DECLARE (#2037), so an inline render is outside it. The rendering
  # therefore moved into `GrappaWeb.IgnoresJSON`, and the same gate then went
  # RED by itself: `sha256:e4ce7cff…6ba4db` -> `sha256:d009b819…40bd41`, with
  # the protocol «30 (unchanged)». The bump below is that gate's verdict.
  #
  # @min_protocol_version stays at 1, and both directions say why. An old
  # bundle never sends `text_pattern` and reads only `masks`, which still
  # carries every entry's mask — including a targeted one, so no rule
  # disappears from its view. A new bundle talking to an old server sends a
  # `text_pattern` that server drops, and would then show an entry it cannot
  # honour; that is the new-client → old-server break the NUMBER expresses,
  # and it is expressed by bumping it, not by refusing to serve v1 clients.
  @protocol_version 31
  @min_protocol_version 1

  @doc "The protocol version the server currently speaks."
  # A literal (not `pos_integer()`) so the spec matches the success typing of
  # the literal constant under Dialyzer `:underspecs` — the codebase idiom
  # for a constant-returning function (`Grappa.Notify.max_entries/0 :: 64`,
  # `Grappa.IRC.Identifier.max_nick_length/0 :: 30`). A bump edits the spec
  # alongside `@protocol_version`; the spec doubles as the bump tripwire,
  # and now that the bump is routine the tripwire is what keeps it from
  # being done half-way.
  #
  # 🔴 THE NUMBER LIVES IN THREE PLACES, AND A REBASE WALKS PAST TWO OF
  # THEM. Measured on issue 2150 rebasing onto v22:
  #
  #   1. `@protocol_version` above        — CONFLICTS. The prose around it
  #      diverges between branches, so git stops and a human decides.
  #   2. `@spec version() :: N`, below    — MERGES CLEAN. The line is
  #      byte-identical on both sides, so there is nothing to conflict on:
  #      git took the base's `:: 22` with no marker and the tree compiled.
  #   3. `CLIENT_PROTOCOL_VERSION` in     — NEVER CONSIDERED. Another file,
  #      `cicchetto/src/lib/socket.ts`       another language. No merge will
  #      ever raise it, in either direction.
  #
  # So this spec is a tripwire against a half-done bump TYPED BY HAND, and
  # not against a rebase — one you never step on cannot trip. Site 3 is
  # worse: on issue 2150 it was simply never edited, the pair stayed unequal
  # from the wire commit onward, and the ONLY thing that said so was
  # `protocol_test.exs` — which runs in `scripts/check.sh` and in no
  # targeted suite, so five commits carried the inequality with no red.
  #
  # The rule, for whoever is mid-rebase: a conflict on ONE site of a
  # duplicated constant is positive evidence that the OTHER sites were
  # decided for you. Grep every site for the OLD number before continuing,
  # including the ones that are not Elixir.
  @spec version() :: 31
  def version, do: @protocol_version

  @doc """
  The oldest client protocol version the server still accepts. A client
  declaring below this is refused at the WS handshake with 426.
  """
  @spec min_version() :: 1
  def min_version, do: @min_protocol_version
end
