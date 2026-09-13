# grappa — client protocol

A guide for authors of **third-party clients**. grappa is a REST + Phoenix
Channels bouncer designed to be spoken by clients we don't write
(`cicchetto` and `shottino` are ours; a third one is the point). This
document describes the wire contract; **the source is authoritative** —
every section points at `file:line` and, where they disagree, the code
wins (line numbers drift; the module + function names are the stable
anchors). Filed for GH #447.

> **Credit.** The contract *shape* here is lifted, with attribution, from
> [amiantos/lurker](https://github.com/amiantos/lurker) (MPL-2.0) —
> an independently-built bouncer with the same "the client never speaks
> IRC" premise. We copied the shape, not the code (different stacks
> entirely); the casing and naming are grappa's own (see "Wire format").

---

## 1. First contact — `GET /api/config`

Hit this **before** you authenticate or open a socket. It is
unauthenticated, carries no secrets, and is cacheable.

```
GET /api/config
→ 200 application/json
{
  "server": "grappa",
  "version": "1.4.2-abc1234",
  "protocol_version": 2,
  "min_protocol_version": 1,
  "push_content_encoding": "aes128gcm"
}
```

> The numbers above are an ILLUSTRATION, not a specification. Since
> 2026-08-21 `protocol_version` moves on every wire-shape change (§2a), so
> any figure written into a document is stale by design. Read them from
> this endpoint; the server's own source of truth is `Grappa.Protocol`.

| field | meaning |
|-------|---------|
| `server` | server identity / edition. Always `"grappa"` for this implementation. |
| `version` | human-facing **software release** string (the CTCP VERSION value). Diagnostic only — **never** key compatibility off this. |
| `protocol_version` | the wire protocol the server currently speaks. |
| `min_protocol_version` | the oldest client protocol the server still accepts. If your protocol is below this, the server will refuse your WebSocket (see §3). |
| `push_content_encoding` | the HTTP content coding this server encrypts Web Push payloads under. `"aes128gcm"` is RFC 8291 over the RFC 8188 coding — salt and server key live in the body header, so the body decrypts standalone. |

> **Web Push clients: check `push_content_encoding` before you blame
> your decryptor.** A server older than 2026-08-14 answers without this
> field, and what it sends is the superseded
> draft-ietf-webpush-encryption-04 `aesgcm`, whose salt and server key
> travel in the `encryption:` and `crypto-key:` HEADERS. Any transport
> that drops headers — UnifiedPush does, by design — hands you a body
> you cannot decrypt no matter how correct your key material is. So:
> **field absent, or any value other than `"aes128gcm"`** ⇒ that server
> cannot deliver you a self-contained payload, and the honest thing to
> show the user is "this server is too old for encrypted push", not a
> decryption error. Treating an absent field as `"aes128gcm"` will make
> you diagnose your own crypto for someone else's bug.
>
> This is a **capability, not a version**: the coding switched without
> moving `protocol_version` (it changes nothing about the WebSocket
> wire), and `version` is off-limits for feature gating per the rule
> above. That is exactly why the field exists.

> **Operator note — this endpoint is public by design.** It requires no
> auth and carries no secrets, so `version` (the software release string —
> `X.Y.Z` on a released build, `X.Y.Z-<shortsha>` on an unreleased one) is
> disclosed to anyone who can reach the URL. That is the same value grappa
> already hands any IRC user via `CTCP VERSION`, and a discovery endpoint
> that hid what it is would be self-defeating — so the exposure is
> deliberate, not a leak. Self-hosted operators who consider even that a
> concern can front `/api/config` however they like; grappa treats it as
> public.

Source: `lib/grappa_web/controllers/config_controller.ex:43`
(`show/2`), routed at `lib/grappa_web/router.ex:233`. The two numbers come
from `Grappa.Protocol` (`lib/grappa/protocol.ex:64` `version/0`, `:71`
`min_version/0`) and the push capability from
`Grappa.Push.content_encoding/0` (`lib/grappa/push.ex:141`) — each the
single source of truth for its own value.

---

## 2. Versioning + the additive-only rule

There are **two** numbers, and they mean different things:

- **`protocol_version`** — what the server speaks *now*.
- **`min_protocol_version`** — the floor. A client below it is refused.

**The WIRE is additive-only.** Both sides MUST follow it:

- New **frame kinds**, new **event types**, and new **fields** may appear
  at ANY time.
- An **unknown verb or field is never fatal, in BOTH directions.** A
  client MUST ignore fields and events it does not recognise. The server,
  symmetrically, replies to an unknown client verb with a non-fatal error
  frame and keeps the socket open.
- **Existing fields are never repurposed.** A field means the same thing
  forever.
- **Removal is not "never" — it is "only on a ruling" (2026-08-26).**
  See §2b. Design your client as if a field could go, i.e. do not make a
  hard requirement of one you do not actually read.

That half is what keeps an OLD client working against a NEW server.

### 2a. `protocol_version` moves on EVERY wire-shape change (2026-08-21)

⚠️ **This reverses what this section said until 2026-08-21.** It used to
say an additive change lands *"WITHOUT a `protocol_version` bump"*, and
that `protocol_version` moves only for a change the additive rule cannot
express. **Both sentences are withdrawn.** The number now moves for every
change to the wire shape, additive included.

**Why, because the reason is the part you need:** additivity describes
what the SERVER emits, and it says nothing about what a CLIENT requires.
The moment a client stops tolerating a missing field and starts requiring
it, that client can no longer talk to a server predating the field — and
no additive statement can express that, because nothing was added or
removed *on the server*. The direction of the break is new-client →
old-server, which is precisely the direction `protocol_version` exists to
describe.

The second reason is that the number is only worth comparing against if
it is **total**. A client testing `server_protocol >= N` is entitled to
read that as *"the server has everything N had"*. One un-bumped field
addition makes that reading false, and it stays false forever after. A
floor that lies is worse than no floor, because the client believed it
checked.

Measured, and it is why the rule changed: `protocol_version` sat at `1`
from its introduction (2026-07-27) through **five** additive field
additions — `recoverable`, `inviter`, `list_modes_queryable`,
`chantypes`, `prefix_order` — every one of which the reference client
later came to require. Under the old rule that was all correct, and the
number told nobody anything.

**`min_protocol_version` is a different axis and does NOT follow.** It
rises only when old clients can no longer be *served*. An additive field
strands nobody, so the ordinary bump leaves the floor exactly where it
is: `protocol_version` has moved several times under this rule while
`min_protocol_version` has never left `1`. (The current pair is not
written here on purpose — see the note under `GET /api/config`; the
moving number is stale the moment it is typed, and it has been, twice.)

### 2b. One field has been REMOVED, and what that costs you

⚠️ `row_count` is gone from the archive entry
(`GET /networks/:slug/archive`) as of protocol **v8**. It is the first
and so far only field this wire has taken back.

**Why it was allowed.** An exact per-target row count has to visit that
target's rows, which is the whole `(subject, network)` partition, so
while the field was emitted the listing's cost was bound to the size of
the account rather than to its number of targets. The field was the only
thing standing between the server and a listing that seeks once per
target. Nothing else about the entry changed: `target`, `kind` and
`last_activity` mean what they always meant.

**The bar for a future removal**, so you can judge how likely another is:
the field must be what blocks a property the server cannot otherwise
have; the break must be measured against a real client rather than
argued; and it takes an explicit ruling. Ordinary tidying does not
qualify — nothing has ever been removed for being unused.

**What it means for your client, concretely.** Validate *permissively*:
tolerate an absent field you do not read, and never make a hard
requirement of one you only pass through. The reference client got this
wrong in exactly the way to learn from — it rendered `target` and `kind`
only, never `row_count`, yet its generated schema listed the field as
required, so a v8 server's response failed validation wholesale and its
archive pane went blank. It never used the value it insisted on.

`min_protocol_version` did **not** move for this, deliberately: it gates
the whole socket, and this break is one listing. A pre-v8 client is
still served everything else. The signal you get is `protocol_version`,
in `GET /api/config` and in the user-topic join reply.

### 2b. What this means for you, as a client author

- **A bump is not a breakage notice.** Under this rule most bumps carry
  nothing you must react to. Read `min_protocol_version` for that — it is
  the only number that can refuse you.
- **Compare, don't equal.** Test `protocol_version >= N` for the newest
  feature you require; never `== N`, and never gate on the `version`
  release string.
- **Keep ignoring what you don't recognise.** The wire is still
  additive-only, so a server ahead of you sends you fields you can drop.
- **If you make a server field mandatory, you have raised your own
  floor.** Record the `protocol_version` that introduced it and refuse —
  or degrade, loudly — below it. A client that silently invents a value
  for a field an old server never sent is putting a fact in that server's
  mouth; that is the failure this rule was written after.

---

## 3. The WebSocket handshake

The realtime surface is Phoenix Channels at `/socket/websocket`. Two
signals ride the handshake:

### 3a. Authentication — the bearer, via subprotocol

Your session bearer (obtained from `POST /auth/login`) rides the
`Sec-WebSocket-Protocol` header as `base64url.bearer.phx.<token>`, NOT the
URL. This keeps the credential out of access logs. The phoenix.js client
does this for you via `new Socket(url, {authToken: token})`; a raw client
sends the bearer subprotocol alongside `"phoenix"`. A missing/invalid
bearer is rejected with **403**. Source:
`lib/grappa_web/channels/user_socket.ex` (`connect/3`, `extract_token/1`)
+ `lib/grappa_web/endpoint.ex` (`auth_token: true`).

### 3b. Protocol version — the `client_proto` query param

Declare the protocol version your client speaks as the **`client_proto`
query parameter** on the upgrade URL:

```
wss://host/socket/websocket?client_proto=1&vsn=2.0.0
```

- `client_proto` — YOUR protocol version. This is public, not a secret,
  so it rides the URL (unlike the bearer). Do NOT confuse it with `vsn`,
  which is phoenix's own transport-serializer version — a different thing.
- If you declare **below** `min_protocol_version`, the server refuses the
  upgrade with a clean **`426 Upgrade Required`** whose JSON body names
  the floor:
  ```
  426 { "error": "upgrade_required", "protocol_version": 2, "min_protocol_version": 2 }
  ```
  This is DISTINCT from the 403 you get for a bad bearer — a 426 means
  "upgrade your client," a 403 means "fix your credential."
- If you **omit** `client_proto` entirely, you are treated as **current**
  (the server sends you nothing new). This is the zero-friction path and
  is exactly what our own clients do until they need to negotiate.
- If you send a value the server **cannot read as an integer** — a stray
  suffix (`1/websocket`), a non-numeric string, or an array form
  (`?client_proto[]=1`) — you are ALSO treated as current, and the connect
  succeeds. Your declaration is discarded, so you get none of the
  negotiation you asked for: **an accepted socket is not evidence that your
  version was understood.** Since #1416 the server records which of the
  three it saw (`client_proto=absent|declared|unreadable` on the connect
  log line and in the `[:grappa, :ws, :connect]` telemetry metadata), so
  ask your operator to grep that key if a declaration is not taking
  effect. This is the trap that bit our own reference client: phoenix.js
  concatenates the transport path onto the endpoint string, so a query
  baked into the endpoint URL becomes part of a parameter VALUE — put the
  version in the Socket's `params`, not in the endpoint.
- There is **no upper bound**: declaring a version higher than the server
  speaks is accepted, and the socket opens.
  ⚠️ **Accepted is not the same as safe, and this bullet used to conflate
  the two.** It read *"a newer client tolerates an older server"* — an
  inference from wire additivity that holds for the server's emissions and
  not for your requirements. The server cannot know which of its fields
  you made mandatory, so it cannot refuse you on that basis; there is no
  `max_protocol_version` and there will not be one. Comparing
  `protocol_version` from `/api/config` against the version that
  introduced the fields you require is **your** side of the handshake
  (§2b), and the socket opening tells you nothing about it.

Source: `lib/grappa_web/channels/user_socket.ex`
(`check_protocol_version/1`) → returns `{:error, :upgrade_required}`,
which the endpoint's `error_handler`
(`user_socket.ex` `handle_ws_error/2`, wired on the `socket "/socket"`
declaration in `endpoint.ex`) turns into the 426. The version check runs
**before** auth, so a too-old client is refused regardless of its
credential.

### 3c. The initial payload

The first topic to join is the user topic `grappa:user:{user}`. Its join
reply is your **initial payload** and carries `protocol_version`, so a
client that skipped `/api/config` still learns it on connect:

```
join "grappa:user:vjt" → {:ok, {"protocol_version": 2}}   ← illustrative, see §2a
```

Source: `lib/grappa_web/channels/grappa_channel.ex:332`
(`join_reply({:user, _})`).

---

## 4. Topics

Topics are user-rooted (single source of truth
`lib/grappa/pubsub/topic.ex`):

| topic | shape | source |
|-------|-------|--------|
| user | `grappa:user:{user}` | `Topic.user/1` |
| network | `grappa:user:{user}/network:{slug}` | `Topic.network/2` |
| channel | `grappa:user:{user}/network:{slug}/channel:{chan}` | `Topic.channel/3` |

The channel segment is ASCII-folded server-side — `A-Z` only, so join with
any casing and you land on the canonical window, but `#foo[1]` and
`#foo{1}` are DIFFERENT topics and non-ASCII case (`#CAFÉ` vs `#café`) is
NOT folded. The fold is shape-blind: a DM window's segment is the peer
nick and folds the same way, so the topic for a query with `Guest87449`
is `…/channel:guest87449`. Events push on the matching topic as `"event"`
frames; treat unknown `kind` values as ignorable per §2.

**Window state is a USER-topic event, not a per-channel one.** The
transitions that open, fail, or close a window — `window_pending`,
`window_invited`, and the three terminal kinds `joined`, `join_failed`,
`kicked` — are broadcast on your **user** topic. The per-channel topic
emits them only once, to your socket alone, as the join-time snapshot of
a window that already reached that state before you subscribed. So:
subscribe to the user topic at connect and drive window state from there;
if you wait on the per-channel topic for a live `joined`, it never
arrives. Everything the per-channel topic broadcasts in its own right —
messages, members, topic, modes, read cursor — is post-join by
definition, which is precisely why window state cannot live there. This
is a topic-selection fact you cannot derive from the payloads, which are
byte-identical on both carriers.

**Not every user-topic event reaches every connection (#1088).** The reply
to an informational command you issued — `who_reply`, `names_reply`,
`whois_bundle`, `whowas_bundle`, `server_reply`, `banlist_bundle`,
`links_bundle` — is delivered on your user topic **only to the connection
that issued the command**. Nothing changes for the client that asked: same
topic, same `"event"` frame, same payload. What changed is that your other
devices no longer receive it, so do not treat one of these as a cue to
refresh shared state — it is an answer to a question this socket asked.

Two consequences worth designing for: if your socket drops before the ircd
answers, the reply is dropped with it (re-issue the command); and `lusers_bundle`
is the one member of the family that still fans out to every connection,
because the server also emits it unsolicited at connect — gate it on your own
consume-once request flag.

**Never re-derive services identity from a mode letter (#388).** Whether
the operator is identified to NickServ arrives as one user-topic event:

```json
{"kind": "session_identity_changed", "network_id": 3,
 "identified": true, "account": "vjt"}
```

`identified` is the verdict and the ONLY thing to gate on; the server folds
every flavour's evidence behind it (bahamut's `+r` umode, OFTC's `+R`,
IRCv3 `account-notify`, numeric 330 RPL_WHOISLOGGEDIN, and numeric 900
RPL_LOGGEDIN — which on a SASL login is the only one of the four that
arrives at all). `account` is the
services account name when the ircd exposes one and `null` otherwise —
including while `identified` is `true`, which is the normal bahamut case.
It is display data; absence of an account is not absence of identity.

A client that instead reads the `umode_changed` letters and tests for `"r"`
gets a bahamut-only answer: solanum (Libera) assigns no registered umode at
all, so it reads permanently unidentified, and on OFTC lowercase `r` is an
unrelated oper notice mode, so it reads identified for the wrong reason.
The event is pushed on both the live edge and the user-topic cold snapshot,
so a reload re-learns the verdict; the REST twin is the `registered` field
of `GET /networks`' `connection` object.

### 4a. Muting peer presence on a channel you are not reading (#1769)

A per-channel topic accepts ONE join param. Join with

```json
{"presence": false}
```

and the server stops pushing you `join`, `part` and `quit` rows for that
channel — the three whose only consumer is the member list. Everything else
on that topic is delivered exactly as before: messages, `window_counts`, the
read cursor, topic and mode changes, and the cold-subscribe snapshots.

**You do not have to do anything.** Omit the param and you get everything, as
you do today. Only the literal `false` suppresses — `true`, a string, or a
misspelled key all mean the default — so a server that predates this reads
your params and ignores them, and a client that never learns about them is
unaffected. That is why this is a join param and not a negotiated capability:
there is no flag day and nothing to coordinate.

Three things are NEVER suppressed, and they are the reason the drop set is
three kinds rather than five:

* **`nick_change`** — you need it to migrate anything keyed by a nick
  (scrollback, read cursors, an open query window). Miss one and your caches
  point at a nick nobody holds, silently.
* **`mode`** — channel-mode state outlives the pause.
* **your OWN `join`/`part`/`quit`** — an own PART is how you learn the window
  is gone. The server matches your live nick with the same ASCII fold it uses
  everywhere else and follows it across a rename.

The intended use is a window the operator has stopped looking at: leave the
topic joined (leaving it would make the window blind, not quiet — it carries
the messages too), re-join with `{"presence": false}` when the window goes
cold, and re-join without the param when it comes back. **Re-join, plural:
the param is read once, at join.** Changing your mind means joining the topic
again — Phoenix closes the previous channel for you — and the events that
arrive between the two joins are not replayed, so refetch the member list on
resume and backfill messages from your last known id.

Check `protocol_version >= 7` before relying on it. An older server will
accept the join and quietly send you everything.

### 4b. A peer offered the operator a file (issue 2089)

grappa RECEIVES `DCC SEND`. It never listens, and it never dials until a
human says so — so an inbound offer reaches you as a **consent prompt**,
on the USER topic, and waits.

```json
{"kind": "dcc_offer", "network": "azzurra", "channel": "$server",
 "offer_id": "n4xk…", "from": "alice",
 "filename": "holiday.jpg", "size": 12345}
```

```json
{"kind": "dcc_offer_resolved", "network": "azzurra", "channel": "$server",
 "offer_id": "n4xk…", "resolution": "accepted"}
```

Four things you cannot derive from those payloads, and one of them will
cost you a bug if you guess:

**🔴 An offer is NOT window state, and there is deliberately no `state`
field.** An offer sits IN a window; it is not one. If you mirror it into
whatever store drives your sidebar, you will draw a pseudo-window for a
file nobody has accepted. `channel` says where to RENDER the prompt and
nothing more — and it is very often `$server`, because a CTCP from a
stranger mints no window (the same rule a VERSION probe obeys). Render the
banner in the window named; do not create one.

**It expires on its own.** The server holds an offer for a bounded window
and then resolves it with `"expired"`, whether or not anyone was looking.
Do not treat a banner as durable UI, and do not keep one on screen after
`dcc_offer_resolved` — that event is your only signal on every device, and
a decision taken on a phone has to take the laptop's banner down.
`resolution` is closed at three (`accepted` / `refused` / `expired`); a
client that understands the kind and ignores the reason still behaves
correctly, which is why it is one event and not three.

**`accepted` means ADMITTED and started, never ARRIVED.** The transfer runs
detached. The outcome lands as an ordinary scrollback row — a `privmsg`
from the peer carrying a 📥 link when the bytes arrive, a `server_event`
from grappa when they do not. Do not render progress you are not being
sent.

**The cold path is real and you need it.** The offer event is broadcast
once and PubSub does not replay, so a reload loses the banner while the
hold keeps running. Two doors serve the same fact: the user-topic
after-join snapshot re-pushes every held offer as the SAME `dcc_offer`
payload (no second code path), and `GET /networks/:network_id/dcc_offers`
returns `{"offers": [...]}` of the same shape for a client not yet on the
socket.

Acting on one:

| route | answer |
|---|---|
| `POST /networks/:network_id/dcc_offers/:offer_id/accept` | **202** `{"ok": true}` — admitted, not arrived |
| `DELETE /networks/:network_id/dcc_offers/:offer_id` | 200 `{"ok": true}` |
| `GET /networks/:network_id/dcc_files/:slug` | the bytes |

404 `{"error": "not_held"}` on either write door means the handle names
nothing — resolved on another device, or the hold elapsed. 429 and 507 on
the accept are the daily allowance and the spool budget respectively.

**🔴 Refusing sends NOTHING to the peer, and your copy must not imply
otherwise.** IRC does have a `DCC REJECT`; grappa deliberately does not
emit one, because it would confirm to an unsolicited stranger both that the
nick is online and that a human read their offer. Label the × with what it
does — "ignore this offer" — never "tell them no".

The file route always answers `application/octet-stream` +
`Content-Disposition: attachment` + `nosniff`, for any file. These bytes
came off a stranger's socket and the sender declared no MIME type at all,
so **do not sniff, preview, inline or auto-open them** — hand the download
to the browser.

Check `protocol_version >= 20` before relying on any of this. The two event
kinds landed at 19 and the `not_held` token at 20, so 20 is the floor for
the surface as a whole.

---

## 5. Wire format

- **JSON, UTF-8.** IRC bytes are decoded to UTF-8 at the server boundary;
  you never parse IRC.
- **snake_case, without exception.** Every key on every surface is
  snake_case (`protocol_version`, `server_time`, `read_cursor`, …).
  grappa's TypeScript wire types are the mirror
  (`cicchetto/src/lib/wireTypes.ts`); there is not a single camelCase key
  in the contract, and new fields MUST be snake_case. (This is a
  deliberate divergence from #447's issue text, which used camelCase; see
  `docs/DESIGN_NOTES.md` 2026-07-27 for why.)
- **REST for resources, Channels for events.** State changes are pushed
  over Channels, not polled over REST.

### 5a. Sending to someone other than the window (#640, #1225)

`POST /networks/{slug}/channels/{channel}/messages` normally sends a PRIVMSG
to `{channel}` and echoes it there. Two optional, mutually exclusive fields
relay the frame elsewhere while keeping `{channel}` as the **source window**
the echo renders in:

| field | wire verb | echo row |
|---|---|---|
| `ctcp_target` | `PRIVMSG <target> :\x01VERB args\x01` | `kind: "privmsg"`, `meta.ctcp_target` |
| `notice_target` | `NOTICE <target> :<body>` | `kind: "notice"`, `meta.notice_target` |

Both may name a nick; `notice_target` may also name a **channel**. Neither
opens a query window for the recipient — a CTCP query is a probe and a NOTICE
is the verb you must not reply to, so the echo belongs where the operator is
looking. A POST carrying **both** fields is `400 bad_request`.

Read the recipient off `meta`, never off the row's `channel`: `channel` is the
source window. A `:notice` row **without** `meta.notice_target` is inbound.

### 5b. Ops-only / voice-only delivery (#218, #1247)

An inbound message addressed to a **STATUSMSG target** (`@#chan` ops-only,
`+#chan` voice) reaches only the members at that level. grappa routes it to
the CHANNEL window like any other channel message (#218) and records the level
it was delivered at in `meta.statusmsg`:

| field | value |
|---|---|
| `meta.statusmsg` | the membership sigil, verbatim from the wire — `"@"`, `"+"`, or whatever the network's ISUPPORT `STATUSMSG=` advertises (`"%"` on a `@%+` network) |

The key is **absent** on an ordinary channel message; there is no `null` form,
so presence is the test. It rides `:notice` and `:privmsg` rows alike, and the
persisted row (REST) and the live push carry the same value.

Render it. Without it an ops-only broadcast is indistinguishable from one the
whole channel saw — which is the defect #1247 exists to fix. The sigil set is
per-network and open-ended, so treat an unrecognised level as "restricted",
never as "everyone".
### 5c. Channel list modes — ask the server which ones exist (#1251)

A type-A channel mode is a LIST, not a flag, and WHICH letters are type A is
per-network 005 data. Two fields carry this:

| where | field | meaning |
|---|---|---|
| `isupport_changed` | `chanmodes_a` | every type-A letter the network advertises |
| `isupport_changed` | `list_modes_queryable` | the subset grappa can actually QUERY |
| `banlist_bundle` | `mode` | which list this bundle answers for |

Query one with the `"banlist"` channel verb, whose optional `"mode"` field
defaults to `"b"`: `{"network_id": 3, "channel": "#bofh", "mode": "z"}`. The
reply is a `banlist_bundle` on your user topic (see §4 — it reaches only the
socket that asked) carrying the same `mode`.

**Offer `list_modes_queryable`, not `chanmodes_a`.** The difference between
the two is a letter the network has and grappa cannot read the replies for;
asking for it earns `unsupported_list_mode` rather than a request that never
terminates. Do not derive the set from the letters yourself — the numeric
table behind it is server knowledge, and it is not a constant: `728/729`
carry bahamut's restrict list (`z`) on one network and solanum's quiet list
(`q`) on another.

The names are historical. The event is `banlist_bundle` and the verb is
`"banlist"` because the contract is additive-only (§2) and renaming a
published kind is a removal; both have carried every list since #1251.

---

## 6. Rate limiting & flood protection (#630)

grappa applies a **coarse per-subject inbound budget** across BOTH doors —
every WS `handle_in` verb AND every authenticated non-admin REST write
(`POST`/`PUT`/`PATCH`/`DELETE`). It is a shared budget: you cannot dodge it
by switching surface. (The `is_admin`-gated `/admin/*` console + `AdminChannel`
are exempt — operator surfaces, not the untrusted flood vector.)
(A finer per-`(subject, network)` bucket also guards message sends, #340.)
A well-behaved client never notices it; a flood does.

**Over budget → refuse + retry hint (additive, snake_case):**

| door | response |
|------|----------|
| REST write | HTTP `429` with body `{"error":"rate_limited","retry_after_ms":<int>}` and a `Retry-After` header (seconds) |
| WS verb | the push reply errors with `{"error":"rate_limited","retry_after_ms":<int>}` (the socket stays open) |

Back off for at least `retry_after_ms` before retrying; nothing was queued.

**Sustained abuse → the web session is severed.** If a client keeps
flooding past the 429s, grappa:

1. pushes a `web_session_severed` **event** on your user topic —
   `{"kind":"web_session_severed","code":"rate_limit_flood"}` (the
   snake_case sever/close code); then
2. **revokes your auth session** (bearer) — a reconnect with the OLD
   credentials is refused (`401`/socket-connect refusal) until you
   **re-authenticate**; then
3. **closes the socket.**

Re-authenticate (fresh login → fresh bearer) to recover. 🔴 Your **IRC
session is NOT touched** — the bouncer stays connected on your behalf and
your presence in channels is unaffected; only the *web* session dies. A
client should treat `web_session_severed` as "drop to the sign-in screen
and tell the user they were disconnected for sending too fast," not as a
netsplit or an IRC event.

Per §2 all of the above is additive: a client that does not recognise the
`rate_limited` token or the `web_session_severed` frame still degrades
safely (the 429 status / the socket close remain unambiguous).

### 6a. Cold boot — do NOT fan out; ask `GET /boot` (#1679)

🔴 **The budget above does not protect you here, and the thing that stops
you is not grappa.** The budget meters write methods only, so a boot — pure
`GET` — passes it untouched. What a deployment actually puts in front of
grappa is a reverse proxy with a `limit_req` zone, and that answers **`503`,
not `429`**, with no `retry_after_ms` and no `Retry-After` to back off on.

This is not hypothetical. A client that fetched the channel list per network
and then a backlog page per channel presented **81+ requests at once** on a
seven-network account, and a proxy at `burst=50` rejected 31 of them; the
user saw a blank window. The same shape had already, on an earlier occasion,
tripped a `fail2ban` jail and got the client's IP **firewall-banned**. A
boot whose request count scales with the size of the account will find a
limiter somewhere, and every operator's is configured differently — so the
client has to be well-behaved at defaults rather than assume a tuned proxy.

**One request answers the whole picture:**

```
GET /boot
→ 200 application/json
{
  "networks": [ … ],                          // identical to GET /networks
  "channels": { "<slug>": [ … ] },            // identical to GET /networks/<slug>/channels
  "heads":    { "<slug>": { "<chan>": [ … ] } } // newest page per channel
}
```

The three values are the SAME shapes the per-request endpoints return — one
decoder, not two. `channels` carries one key per network you hold; `heads`
carries one key per channel that HAS history (a channel with none is absent,
like a missing `read_cursors` key, rather than mapped to `[]`).

Pair it with `GET /me` — which already answers `read_cursors`,
`unread_counts` and `badge_count` in bulk — and a cold boot is **two
requests, flat in the size of the account**, however many networks and
channels it holds.

The per-channel endpoints are unchanged and stay for everything that is not
boot: paging further back (`?before=`), resuming a gap (`?after=`), and
measuring one (`/messages/count`). `/boot` replaces the fan-out, not them.

> Note the reconnect path too. A WebSocket resume that re-fetches a backlog
> page for every channel it re-joins presents the same burst as a cold boot,
> from the same account size — the limiter cannot tell the two apart.

---

## 7. Per-client tokens (#1196)

If the account you connect as has a second factor armed — TOTP or a
passkey — `POST /auth/login` with the account password answers **202
`two_factor_required`**, and there is nothing an unattended client can
do with that: a TOTP code rotates every thirty seconds, WebAuthn needs
an authenticator and an origin, and a recovery code is single-use.

A **per-client token** is the credential to use instead. Its owner mints
it from a browser session and pastes it into your config; **you send it
in the `password` field of `POST /auth/login`, exactly where the account
password would go.** Nothing else about your login changes:

```
POST /auth/login  { "identifier": "vjt", "password": "<the token>" }
200               { "token": "<the same token>", "subject": {...} }
```

Three properties worth designing around:

- **The reply is the token you sent.** The token IS the bearer, so a
  reconnect does not mint a new session; store it once and reuse it. You
  may also skip `/auth/login` entirely and present it directly as
  `Authorization: Bearer <token>` / the WS bearer subprotocol (§3a).
- **It does not expire while idle.** A browser session dies after seven
  days of silence; a client token does not. Only revocation ends it —
  by its owner, or by an operator resetting the account's factors or
  rotating its password. Its owner arming, disarming or changing a
  second factor does NOT (#1284), so minting the token first and arming
  the factor afterwards is a safe order. Expect a `401`, and surface it
  as "this token was revoked", not as a transient network error.
- **It is scoped.** A client token can read and send as the account, and
  that is all. The account's own credential surfaces — `/admin/*`,
  `/me/totp*`, `/me/passkeys*`, `DELETE /me`, and the token routes
  themselves — answer **403 `client_token_scope`**. That is not a
  credential problem and retrying will not help: the operation needs a
  browser session. Do not treat it like a `401`.

A wrong token is indistinguishable from a wrong password: same `401
invalid_credentials`, same login throttle (`429 too_many_attempts` after
ten failures from one address in fifteen minutes). Back off accordingly.

Minting, listing and revoking are the account owner's job, from a
browser session, and are documented here only so a client author knows
what to tell them: `POST /me/client-tokens {label, password}` returns
`token` **once**; `GET /me/client-tokens` lists `{handle, label,
created_at, last_seen_at, ip, user_agent}` and never the secret again;
`DELETE /me/client-tokens/:handle` revokes one.

Source: `lib/grappa_web/controllers/auth_controller.ex`
(`account_login/3`), `lib/grappa_web/plugs/require_full_session.ex`,
`lib/grappa_web/controllers/client_token_controller.ex`.

---

*This document tracks a live contract. When it disagrees with the code,
the code is right — start from the `file:line` anchors above.*
