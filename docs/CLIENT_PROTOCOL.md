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
  "protocol_version": 1,
  "min_protocol_version": 1
}
```

| field | meaning |
|-------|---------|
| `server` | server identity / edition. Always `"grappa"` for this implementation. |
| `version` | human-facing **software release** string (the CTCP VERSION value). Diagnostic only — **never** key compatibility off this. |
| `protocol_version` | the wire protocol the server currently speaks. |
| `min_protocol_version` | the oldest client protocol the server still accepts. If your protocol is below this, the server will refuse your WebSocket (see §3). |

> **Operator note — this endpoint is public by design.** It requires no
> auth and carries no secrets, so `version` (the software release string —
> `X.Y.Z` on a released build, `X.Y.Z-<shortsha>` on an unreleased one) is
> disclosed to anyone who can reach the URL. That is the same value grappa
> already hands any IRC user via `CTCP VERSION`, and a discovery endpoint
> that hid what it is would be self-defeating — so the exposure is
> deliberate, not a leak. Self-hosted operators who consider even that a
> concern can front `/api/config` however they like; grappa treats it as
> public.

Source: `lib/grappa_web/controllers/config_controller.ex:35`
(`show/2`), routed at `lib/grappa_web/router.ex:233`. The two numbers come
from `Grappa.Protocol` (`lib/grappa/protocol.ex:64` `version/0`, `:71`
`min_version/0`) — the single source of truth.

---

## 2. Versioning + the additive-only rule

There are **two** numbers, and they mean different things:

- **`protocol_version`** — what the server speaks *now*.
- **`min_protocol_version`** — the floor. A client below it is refused.

**The contract is additive-only.** Both sides MUST follow it:

- New **frame kinds**, new **event types**, and new **fields** may appear
  at ANY time, WITHOUT a `protocol_version` bump.
- An **unknown verb or field is never fatal, in BOTH directions.** A
  client MUST ignore fields and events it does not recognise. The server,
  symmetrically, replies to an unknown client verb with a non-fatal error
  frame and keeps the socket open.
- **Existing fields are never repurposed or removed.** A field means the
  same thing forever.

Because of this, `protocol_version` bumps **only** for a change the
additive rule cannot express (a field's meaning changes, or a frame is
withdrawn). Such a change also raises `min_protocol_version` when clients
below it can no longer be served. **Practical consequence for you:** pin
the LOWEST `protocol_version` whose features you use, ignore everything
you don't recognise, and you will keep working across additive upgrades
without a code change.

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
`lib/grappa_web/channels/user_socket.ex` (`connect/3:101`, `extract_token`)
+ `lib/grappa_web/endpoint.ex:87` (`auth_token: true`).

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
- There is **no upper bound**: declaring a version higher than the server
  speaks is fine (additive-only — a newer client tolerates an older
  server).

Source: `lib/grappa_web/channels/user_socket.ex:135`
(`check_protocol_version/1`) → returns `{:error, :upgrade_required}`,
which the endpoint's `error_handler`
(`user_socket.ex:166` `handle_ws_error/2`, wired at
`endpoint.ex:90`) turns into the 426. The version check runs **before**
auth, so a too-old client is refused regardless of its credential.

### 3c. The initial payload

The first topic to join is the user topic `grappa:user:{user}`. Its join
reply is your **initial payload** and carries `protocol_version`, so a
client that skipped `/api/config` still learns it on connect:

```
join "grappa:user:vjt" → {:ok, {"protocol_version": 1}}
```

Source: `lib/grappa_web/channels/grappa_channel.ex:332`
(`join_reply({:user, _})`).

---

## 4. Topics

Topics are user-rooted (single source of truth
`lib/grappa/pubsub/topic.ex`):

| topic | shape | source |
|-------|-------|--------|
| user | `grappa:user:{user}` | `topic.ex:64` |
| network | `grappa:user:{user}/network:{slug}` | `topic.ex:70` |
| channel | `grappa:user:{user}/network:{slug}/channel:{chan}` | `topic.ex:92` |

Channel segments are case-folded under rfc1459 server-side, so join with
any casing and you land on the canonical window. Events push on the
matching topic as `"event"` frames; treat unknown `kind` values as
ignorable per §2.

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
IRCv3 `account-notify`, numeric 330 RPL_WHOISLOGGEDIN). `account` is the
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
