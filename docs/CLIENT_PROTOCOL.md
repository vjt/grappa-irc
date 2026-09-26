# grappa — client protocol

A guide for authors of **third-party clients**. grappa is a REST + Phoenix
Channels bouncer designed to be spoken by clients we don't write
(`cicchetto` and `shottino` are ours; a third one is the point). This
document describes the wire contract; **the source is authoritative** —
every section points at a **module + function**, and where they disagree,
the code wins. Anchors are deliberately NOT `file:line`: line numbers
drift the moment `main` moves, and five of the six this document used to
carry had rotted into unrelated prose by the time anyone checked. A
function name survives a refactor or fails loudly; a line number rots
silently. Filed for GH #447.

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

Source: `GrappaWeb.ConfigController.show/2`, routed as `get "/config"`
in the `scope "/api"` block of `GrappaWeb.Router`. The two numbers come
from `Grappa.Protocol.version/0` and `Grappa.Protocol.min_version/0`, and
the push capability from `Grappa.Push.content_encoding/0` — each the
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
(`GET /networks/:network_id/archive`) as of protocol **v8**. It is the first
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

### 2c. What this means for you, as a client author

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
`GrappaWeb.UserSocket` (`connect/3`, `extract_token/1`)
+ `GrappaWeb.Endpoint` (`auth_token: true`).

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
  (§2c), and the socket opening tells you nothing about it.

Source: `GrappaWeb.UserSocket`
(`check_protocol_version/1`) → returns `{:error, :upgrade_required}`,
which the endpoint's `error_handler`
(`GrappaWeb.UserSocket.handle_ws_error/2`, wired on the `socket "/socket"`
declaration in `GrappaWeb.Endpoint`) turns into the 426. The version check runs
**before** auth, so a too-old client is refused regardless of its
credential.

### 3c. The initial payload

The first topic to join is the user topic `grappa:user:{user}`. Its join
reply is your **initial payload** and carries `protocol_version`, so a
client that skipped `/api/config` still learns it on connect:

```
join "grappa:user:vjt" → {:ok, {"protocol_version": 2}}   ← illustrative, see §2a
```

Source: `GrappaWeb.GrappaChannel`, the `join_reply({:user, _}, _)`
clause — it answers `%{protocol_version: Grappa.Protocol.version()}`.

---

## 4. Topics

Topics are user-rooted (single source of truth
`Grappa.PubSub.Topic`):

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

Fetching the file is **not** on this prefix (protocol v21, issue 2127):

| route | answer |
|---|---|
| `GET /dcc_files/:slug[.ext]` | the bytes — top level, **no auth**, same surface as `GET /uploads/:slug` |

The 26-char base32 slug IS the access token, exactly as it is for an
upload: whoever holds the URL fetches the file, with no bearer, until the
retention reaper removes it. You do not build this URL — the server mints
it absolute into the delivery row's body and you render it as an ordinary
link. It moved off `/networks/:network_id/dcc_files/:slug` because that
route required an `Authorization` header, and a link tapped out of
scrollback opens a tab that carries none, so the row's link only ever
collected a 401.

An optional extension may follow the slug (`<slug>.mp4`), derived from the
peer's declared filename and whitelist-normalised. It is **decoration**:
the lookup uses the 26 characters alone, so `<slug>`, `<slug>.mp4` and
`<slug>.zip` all fetch the same bytes. The response is always
`application/octet-stream` + `Content-Disposition: attachment` +
`X-Content-Type-Options: nosniff`, with no branch — never treat the
extension as a content type. Every miss (unknown slug, malformed slug,
reaped file) is the same 404 `{"error": "not_found"}`.

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

Check `protocol_version >= 21` before relying on the surface as a whole,
and note that it is not one floor but three: the two event kinds landed at
**19**, the `not_held` token at **20**, and the top-level
`GET /dcc_files/:slug` door at **21** (issue 2127 — before that, fetching
was `GET /networks/:network_id/dcc_files/:slug`, behind auth). So a v20
server gives you the prompt and the consent verbs but NOT a link a browser
tab can open, which is the half a client notices last.

⚠️ This paragraph read *"20 is the floor for the surface as a whole"* until
2026-09-18, in the same revision that added the v21 route move directly
above it — the sentence was simply not revisited. A client that trusted it
would have rendered 📥 links against a v20 server and collected 401s.

### 4c. Standing consent for DCC, per network (issue 2143, v22)

The prompt in §4b is the default, not the only mode. A per-`(subject,
network)` opt-in lets the server accept an offer without asking, and it is
off unless the operator turns it on:

| route | answer |
|---|---|
| `GET /networks/:network_id/dcc-auto-accept` | 200 `{"enabled": true \| false}` |
| `PUT /networks/:network_id/dcc-auto-accept` with `{"enabled": true \| false}` | 200 with the stored value |

`enabled: true` does NOT mean "accept anything". It means *auto-accept from
people I already talk to on this network* — the server still decides who
qualifies, and an offer from a stranger keeps going through the consent
prompt. So do not present the switch as "accept all files"; your copy has
the same honesty problem the × button has in §4b.

What changes for your event handling is less than it looks: an
auto-accepted offer still emits `dcc_offer` followed by
`dcc_offer_resolved` with `"accepted"`. There is no third resolution and no
flag distinguishing "a human said yes" from "the setting said yes" — if you
draw the banner on `dcc_offer` you may see it appear and resolve in one
breath. Drive the UI off `dcc_offer_resolved` exactly as before.

Check `protocol_version >= 22`. An older server 404s both routes, which is
a fine "the feature is not here" signal.

### 4d. The subject's remembered leave and away text (issue 2150, v23)

Two user-topic pushes carry settings the operator edits elsewhere, so a
second device learns about the change:

```json
{"kind": "quit_part_reason_changed", "quit_part_reason": "back later"}
{"kind": "auto_away_reason_changed",  "auto_away_reason": null}
```

🔴 **The key is ALWAYS PRESENT and `null` is a MEANING, not an absence.**
This is the one place in this document where the ordinary "absent key =
default" reading is wrong. `null` is how *"I cleared it"* travels: for
`quit_part_reason` it means QUIT falls back to its own
`"user-disconnect"` and PART goes bare; for `auto_away_reason` it means
the bouncer keeps its built-in text. A client that coalesces `null` into
its last known value will show a reason the server will not send, and will
never render a clear.

Both are `string | null`. Check `protocol_version >= 23`.

### 4d-bis. The auto-away nick rename (#1894, v32)

A third user-topic push on the same axis, carrying the suffix the bouncer
appends to the subject's nick while it holds them auto-away:

```json
{"kind": "away_nick_suffix_changed", "away_nick_suffix": "-away"}
```

Same always-present-key rule as the pair above, and `null` again means
something rather than nothing — but a DIFFERENT something. For the two
reasons `null` hides a server-owned string the client must not print. Here
`null` hides nothing at all: the rename is OFF, the nick is left alone, and
that is the default every subject has until they set a suffix.

The rename rides auto-away only. An explicit `/away` never renames. On the
way back the bouncer restores the nick it took; if the bare nick has since
been taken it stays decorated and the refusal numeric routes to the
subject, rather than a retry ladder running underneath them.

A client MUST NOT derive the away nick itself. The server decides whether
the rename happens at all — a target that would exceed the network's
`NICKLEN` is skipped and the nick left alone — so a client that renders
`nick + suffix` will show a nick nobody is using.

`string | null`. Check `protocol_version >= 32`.

### 4e. A network left or joined the session (issue 2219, v28)

`DELETE /session/networks/:slug` detaches a network from the caller's own
session: it parks and quits the network, then marks the binding detached.
Everything the subject authored survives — nick, SASL user, the stored
secrets, the perform list and the autojoin set — and `POST
/session/networks` on the same slug brings all of it back. It is the
inverse of the accretion verb, not a delete.

204 on success. 404 covers both a slug this deployment does not carry and
one the caller does not hold attached, deliberately: one answer for every
reason, so the route cannot be used to enumerate networks. 403 for a
visitor, whose identity lives on the credential.

The detach is announced on the user topic:

```json
{"kind": "network_detached", "network_id": 7, "network_slug": "libera"}
```

🔴 **This is NOT a `connection_state_changed`, and it carries no state.**
Detaching a network that was already parked moves no `connection_state` at
all, so there is no transition to report. Re-read the two surfaces that
own the answer instead: `GET /networks` for the sidebar and `GET /me` for
the `$home` rows. Both stop returning the network, and every
`/networks/:slug/...` route answers 404 for it from that moment — so a
client still showing a `[Reconnect]` chip for it is one tap from a refusal.

A detached network reappears in `home_data.available_networks`, whether or
not the operator put it in the self-serve tier: your own detached binding
is always re-attachable. One `POST /session/networks` with that slug
restores the credential and spawns the session.

The other direction has its own event, and you need it:

```json
{"kind": "network_attached", "network_id": 7, "network_slug": "libera"}
```

It fires whenever a network JOINS the session — a fresh accretion or the
re-attach of something detached — for both subject kinds. 🔴 **Do not try
to infer an attach from `connection_state_changed`.** That event fires on
the `:parked → :connected` flip, but it describes a LINK and the
attachment set is a different fact: a client that refreshes only its
network list on it will keep showing the network under
`available_networks` with no attached row. Re-read the same two surfaces
this event's twin asks for.

Neither event carries state, and that is the contract: they name what
moved, and `GET /networks` plus `GET /me` own the answer.

Check `protocol_version >= 28`. ⚠️ There is no 27 — the shape moved twice
before this version was published, and the pin gate requires a number per
move. Nothing ever spoke 27.

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
- **`:network_id` in a path is a SLUG, not a number.** Every per-network
  route is mounted under `scope "/networks/:network_id"`, and
  `GrappaWeb.Plugs.ResolveNetwork` resolves that segment with
  `Grappa.Networks.get_network_by_slug/1`. The parameter is named for an
  id and carries a slug; this document used to spell the same segment
  three ways (`{slug}`, `:slug`, `:network_id`) and a reader could not
  tell whether they were one axis or three. They are one. Send the slug.

### 5a. Sending to someone other than the window (#640, #1225)

`POST /networks/:network_id/channels/:channel_id/messages` normally sends a PRIVMSG
to `:channel_id` and echoes it there. Two optional, mutually exclusive fields
relay the frame elsewhere while keeping `:channel_id` as the **source window**
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

### 5d. Which `:mode` rows changed the CHANNEL (issue 2176, v25)

A `:mode` row carries `meta.structural: true` when the token it reports
changed the **channel** — a ban, a key, a limit, a flag — rather than a
member's status prefix. It lets a denoised window fold the `+o`/`+v`
churn and still show the `+b`.

| field | value |
|---|---|
| `meta.structural` | `true` on a channel-affecting `:mode` row |

The key is **absent** otherwise, with no `null` form, so presence is the
test — and absence means exactly what it meant before the key existed,
which is why this was additive. It is absent on every row written before
v25, so do not read absence as "not structural" on old history; read it as
"unknown, treat as before".

Check `protocol_version >= 25`.

---

### 5e. Ask `/messages/count` only the THRESHOLD (issue 2282, v30)

`GET /networks/:network_id/channels/:channel_id/messages/count?after=<id>`
answers **two** questions in one body, and they cost very different amounts:

| key | question | cost |
|---|---|---|
| `count` | raw rows after the anchor — "can I page this gap contiguously?" | cheap-ish |
| `messages` + `events` | the content / presence split the bar renders | the expensive half |

Add **`&cap=<positive int>`** to ask the first one ALONE. The response is
then `{"count": N}` — one key — with `N = min(true_count, cap)`. `N == cap`
means "at least `cap`"; below `cap` the number is exact.

```
GET …/messages/count?after=41234&cap=201   →   {"count": 201}
GET …/messages/count?after=41234           →   {"count": 3412, "messages": 2880, "events": 532}
```

**Why you want it.** If your branch is a threshold — grappa's own client
asks `gap > 200` — you do not need the count. Measured on a 372,651-row
corpus at a 200,014-row gap: the two-question body costs 12,963,811 SQLite
VM steps, the capped one **4,304**. Same covering index; only the `LIMIT`
moves.

**`cap` does not shrink what is counted.** It is a limit on rows the
predicate already selected, so your presence filter, the subject narrowing
and the channel-or-DM shape all still apply. A window holding one visible
message in a thousand hidden joins answers `1`, not `201`.

**The split is not gone, it is deferred.** Ask again without `cap` when you
need the labels — after you have painted, which is the whole point.

**Both directions degrade, so you can adopt this before the server has it:**

- capped client → older server: the unknown param is ignored and you get the
  three-key body. Read `count` out of it; the threshold is the same boolean,
  just paid for in full.
- old client → this server: never sends `cap`, gets a byte-identical body.

`cap=0` is `400 bad_request` — a count that saturates at zero reads "near"
for every gap — as are negatives, non-integers and `?cap[]=1`.

Check `protocol_version >= 30`, or just send it: the fallback above is why
you do not have to.

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
  "channels": { "<slug>": [ … ] },            // identical to GET /networks/:network_id/channels
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

Source: `GrappaWeb.AuthController`
(`account_login/3`), `GrappaWeb.Plugs.RequireFullSession`,
`GrappaWeb.ClientTokenController`.

---

## 8. Settings surfaces worth knowing about

### 8a. `display_prefs` has EIGHT keys (issue 2270, v29)

`GET` / `PUT /me/settings/display-prefs` carries the per-user display
object. As of v29 it has eight keys, the eighth being `date_format`:

```
time_format · colored_nicklist · presence_filter · show_bottom_bar ·
strip_formatting · show_event_badge · bold_mentions · date_format
```

It is absent-tolerant in BOTH directions by construction — the server
fills a missing key from its own defaults on the way in, so a `PUT` that
omits keys does not erase them, and a client predating a key simply never
sees it. That is why the object can keep growing without a floor move.
Treat the set as open: a key you do not recognise is one you drop, per §2.
`min_protocol_version` did not move for this.

**Absent-tolerant is not value-tolerant, and `date_format` is where the
difference first bites.** Six of the eight keys are booleans and the
seventh (`time_format`) has been there since the object shipped;
`date_format` is the first CLOSED-SET string added after the fact, so it
is the first key that can be both optional and wrong. Omit it and you get
the default; send a value outside
`"auto" | "dmy" | "mdy" | "ymd"` and the `PUT` is **rejected with a 422**
carrying `field_errors.display_prefs`. It is not coerced to `"auto"` —
a coerce would read back as a preference the user never chose while the
write reported success. `"auto"` is a REAL key meaning "follow the
viewer's resolved locale", never the absence of one.

Source: `Grappa.UserSettings` (the `display_prefs` typespec and
`default_display_prefs/0`), served by
`GrappaWeb.UserSettingsController.show_display_prefs/2` /
`update_display_prefs/2`.

### 8b. The per-subject upload caps are visible but NOT actionable (issue 2175, v26)

`Grappa.ServerSettings.Wire.upload_view/1` — the projection shared by
`GET /api/server-settings`, `GET /admin/settings` and the
`server_settings_changed` push — grew two keys at v26:

| field | meaning |
|---|---|
| `per_user_cap_bytes` | total upload bytes one account may hold |
| `per_visitor_cap_bytes` | the same for a visitor |

🔴 **Read them; do not build a quota UI on them.** They are on the wire for
the ADMIN console, and a client cannot act on them: a per-subject refusal
is routed through the **existing** `:insufficient_storage` → **507**, the
same status the instance-full case returns. So you cannot distinguish "this
server is out of space" from "you are at your own quota" — both are a bare
507, and a client that guesses will tell the user the wrong thing. The
honest copy for a 507 is "the upload was refused for lack of space",
without attributing the cause.

They are published so the operator's own knob is readable in the admin
surface; that is the whole reason, and it is recorded here so a client
author does not read their presence as an invitation.

### 8c. An `/ignore` entry is a PAIR, and `masks` no longer tells you all of it (issue 2294, v31)

`/networks/:network_id/ignores` is the per-network ignore list
(`GrappaWeb.IgnoresController`, rendered by `GrappaWeb.IgnoresJSON`). A
message is DROPPED before it exists — no scrollback row, no badge, no push —
when the sender matches an entry.

Until v31 an entry was a `nick!user@host` glob and nothing else. It now
carries an OPTIONAL second glob over the message TEXT, and a PRIVMSG/NOTICE
is dropped when **both** match. That exists for relay bots: every line a
Telegram↔IRC bridge relays wears the BRIDGE's prefix, with the real author
inside the body as `<Nick> text`, so a mask-only rule could only silence the
whole bridge.

**The additive seam, and what an old client keeps getting.** Every response
still carries `masks` — the same array of mask strings, same order. Beside
it is `entries`, the same list as objects:

| field | meaning |
|---|---|
| `mask` | the normalised `nick!user@host` glob |
| `text_pattern` | the text glob, or `null` — the key is ALWAYS present |

A client that only knows `masks` is unaffected and still sees every rule,
including targeted ones (it sees the mask, not the narrowing). A client that
wants the pattern reads `entries`. `masks` was NOT turned into a list of
objects: that would be a repurposed field, which §2 forbids outright.

**Two entries may share a mask.** That IS the bridged-author case
(`relay!*@*` matching `<A>*` and `<B>*` are two rules), so `masks` can carry
the same string twice and the identity of an entry is the PAIR. A client
keying a map on `mask` alone WILL collapse two rules into one and delete the
wrong one.

**The two mutations:**

* `POST` — body `{"mask": "...", "text_pattern": "..."}`. `text_pattern` may
  be omitted or `null`; either is the pre-v31 entry. A blank-after-trim or
  CR/LF-bearing pattern is **422 `invalid_text_pattern`**, a token distinct
  from `invalid_mask` because the operator typed two things.
* `DELETE /ignores/:mask?text_pattern=...` — the pattern rides the QUERY
  string, since the mask already owns the path segment and a pattern carries
  spaces. **Omitting it removes the entry with NO pattern**, not every entry
  sharing the mask: a removal is the exact inverse of the add that wrote it.

Both answer `{masks, entries, mask, text_pattern, outcome}` — the resulting
list plus the NORMALISED entry acted on, so a client renders the list and
reconciles nothing.

**Matching rules, so a client can explain them to a user:** glob (`*`, `?`)
like the mask; **absolutely anchored**, so `<SomeNick>*` matches a body that
STARTS with that and a bare `spam` matches only the body that IS `spam` (a
"contains" is `*spam*`); **ASCII-case-insensitive** (`CAFÉ` and `café` stay
distinct, exactly as for a nick); and a CTCP **ACTION** is matched on the
UNWRAPPED text (`waves`, not `\x01ACTION waves\x01`), while any other CTCP
frame is matched raw.

## 9. Event kind inventory (issue 2260)

Every `"event"` frame carries a `kind`. This is the complete set the server
can push to a client, so you can see at a glance what exists rather than
meeting a kind on the wire and guessing. It is held by
`scripts/client-protocol-gate.sh`: a kind emitted with no row here fails CI.

**The `topic` column tells you where to listen**, and getting it wrong is
the one mistake that costs you hours:

* **`user`** — `grappa:user:{user}`. Subscribe at connect.
* **`channel`** — the per-channel topic. Post-join-handshake traffic only.
* **`requester`** — the user topic, but delivered **only to the connection
  that issued the command** (#1088). Not a broadcast; your other devices do
  not see it. If your socket dies before the ircd answers, the reply dies
  with it — re-issue.

🔴 Window state (`joined`, `join_failed`, `kicked`, `window_pending`,
`window_invited`) is on the **user** topic, not the channel topic. §4 explains
why; a client waiting on the per-channel topic for a live `joined` waits
forever.

| `kind` | topic | what it is |
|---|---|---|
| `archive_changed` | user | the archive listing for a network changed — refetch it |
| `archive_purged` | user | archived scrollback for one target was deleted |
| `auto_away_debounce_changed` | user | the subject's auto-away debounce setting changed |
| `auto_away_reason_changed` | user | the subject's remembered auto-away text changed |
| `away_nick_suffix_changed` | user | the subject's auto-away nick suffix changed (`null` = rename off) |
| `away_confirmed` | user | upstream acked an AWAY / BACK |
| `banlist_bundle` | requester | the folded `+b` / `+e` / `+I` list for one channel (§5c) |
| `bundle_hash` | user | a new cic bundle is live — hash + version |
| `channel_created` | channel | 329 RPL_CREATIONTIME for the window |
| `channel_modes_changed` | channel | the channel's mode set changed (§5d) |
| `channels_changed` | user | the active channel set changed |
| `connection_progress` | user | transient connect-progress badge (`connecting` / `connected`) |
| `connection_state_changed` | user | a credential's `connection_state` moved; refreshes `GET /networks` |
| `dcc_offer` | user | an inbound `DCC SEND` awaiting consent (§4b) |
| `dcc_offer_resolved` | user | that offer left the held set (§4b) |
| `directory_complete` | user | the `/LIST` channel-directory scan finished |
| `directory_failed` | user | the `/LIST` scan failed or timed out |
| `directory_progress` | user | `/LIST` scan progress count |
| `invite_ack` | user | 341 RPL_INVITING — an INVITE you sent was accepted by the ircd |
| `isupport_changed` | user | the network's 005 capability set (§5c, §5) |
| `join_failed` | user | the window reached `:failed`, with reason + numeric |
| `joined` | user | the window reached `:joined` |
| `kicked` | user | the window reached `:kicked`, with `by` + reason |
| `links_bundle` | requester | `/LINKS` answer |
| `lusers_bundle` | user | `/LUSERS` answer — **fans out to every connection**, because the server also emits it unsolicited at connect (§4) |
| `members_seeded` | channel | pre-sorted member list on 366 RPL_ENDOFNAMES |
| `mentions_bundle` | user | cross-channel mention summary, fired on the auto-away → present transition |
| `message` | channel | a scrollback row; its own `message.kind` (`privmsg`, `notice`, `join`, `part`, `quit`, `nick_change`, `mode`, …) is a **different axis** from this one |
| `names_reply` | requester | `/NAMES` answer |
| `network_attached` | user | the subject re-attached a network binding (§4e) |
| `network_detached` | user | the subject hid a network binding (§4e) |
| `notify_list` | user | the subject's notify / watch list |
| `own_nick_changed` | user | our own nick changed — carries `network_id`, not a slug |
| `peer_away` | user | a peer's away text |
| `presence_changed` | user | our presence / away state changed |
| `presence_error` | user | upstream watch-list rejection (`ERR_MONLISTFULL`, `ERR_TOOMANYWATCH`) |
| `presence_snapshot` | user | cold-join presence snapshot, pushed to your socket alone |
| `query_windows_list` | user | the full DM window list; also the "rename fully applied" barrier after a peer NICK |
| `quit_part_reason_changed` | user | the subject's remembered quit / part text changed (§4d) |
| `read_cursor_set` | channel | the read cursor moved — `last_read_message_id` + badge count |
| `recover_progress` | user | ghost-recovery progress |
| `recover_result` | user | ghost-recovery outcome (`succeeded` / `failed` + reason) |
| `server_reply` | requester | MOTD and other server text |
| `server_settings_changed` | user | operator-owned server settings changed (§8) |
| `session_identity_changed` | user | the NickServ identification verdict — gate on `identified`, never a mode letter (§4) |
| `supported_umodes_changed` | user | the umode letters this ircd supports |
| `topic_changed` | channel | the channel topic changed |
| `umode_changed` | user | our own user modes changed |
| `web_session_severed` | user | the flood ladder severed this bearer (§6); the socket is about to close |
| `who_reply` | requester | `/WHO` answer |
| `whois_avatar_ready` | user | a peer avatar finished caching; carries the route to it |
| `whois_bundle` | requester | `/WHOIS` answer |
| `whowas_bundle` | requester | `/WHOWAS` answer |
| `window_counts` | channel | unread + mention counts for the window |
| `window_invite_declined` | user | the operator refused an invite — drop the `:invited` banner |
| `window_invited` | user | an inbound INVITE opened a not-joined window (§4) |
| `window_pending` | user | a join is in flight |

### 9a. What is deliberately NOT in this table

**`parted` does not exist.** An own-PART archives the window by **removing**
it from the window-state map: absence IS the signal, and the `:part` row that
ships alongside is the feed line. There is no `kind: "parted"` and there never
was — if you are waiting for one, you are waiting for nothing. (Issue 2260
listed it as undocumented; it was a regex matching the server comments that
say it is not emitted.)

**Admin events are not here.** `grappa:admin:events` is a separate topic on a
separate channel (`GrappaWeb.AdminChannel`) with its own 29 kinds. It is an
operator surface, not a client one.

**Message kinds are a different axis.** `join`, `part`, `quit`, `nick_change`,
`mode`, `privmsg`, `notice`, `action` are values of `message.kind` **inside** a
`kind: "message"` event — which is why §4a can talk about suppressing `join` /
`part` / `quit` while none of them appears above.

**One name, two payloads:** `web_session_severed` exists on both the admin
topic and your user topic, with different shapes. The row above describes the
client one.

---

*This document tracks a live contract. When it disagrees with the code,
the code is right — start from the module + function anchors above, and
grep for the function name rather than trusting any line number,
including one you may be tempted to add.*
