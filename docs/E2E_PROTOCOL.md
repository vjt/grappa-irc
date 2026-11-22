# grappa — the end-to-end encrypted query protocol (wire v2)

The interop spec of grappa's **encrypted queries**: a conversation between
two people, each with up to three devices, that grappa carries and cannot
read. It is written for the authors of an endpoint (cicchetto, shottino,
the Python `irc-olm` package, or a client we do not write) and of grappa's
relay. Filed as issue 2691, from the 2026-11-21 architecture review (X2).

**Three layers, three documents.**

| layer | what | where it is specified |
|---|---|---|
| Olm | the double ratchet, pre-key messages, SAS, ECIES | vodozemac 0.11.1, the one crypto both clients link ("One Olm, not two"); not restated here |
| the relay | REST routes, the offline inbox, copies, the pacer, pairing rendezvous, consent requests, an absent nick, file ciphertext, a message on its way | `docs/CLIENT_PROTOCOL.md` §4f, §4g, §4i, §4j, §4k, §4l |
| the endpoint protocol | what an endpoint puts in a payload and in an Olm body, how it checks what arrives, SAS, pairing messages | **this document** |

**The source is authoritative**, as in `CLIENT_PROTOCOL.md`: every section
names the function that implements it, and where this text and the code
disagree, the code wins and this text is the bug. A cicchetto name lives in
`cicchetto/src/lib/e2e/wire.ts` unless its module is named beside it;
shottino's equivalent is in `frontends/shottino/e2e.c` (`e2e_*`).

**Scope.** Direct messages between two nicks, across each side's devices,
and the pairing of a device into its own account. Encrypted **channel**
messages are not covered by this document.

**History.** The protocol was agreed on issue 2430: the v1 rulings
(comments 6252857813, 6252978193, 6253162964, 6263227492), wire v2 for
multi-device (6346236542, reviewed in 6346359924 and 6346384093), its
revision 2 (6346686730, acked in 6348339431) and the base64url `did`
amendment (6348464388). Main has moved past those comments in places —
the certificate signs the list version, for one — and this document
describes main.

**Conformance.** The vectors every implementation is held to are in
`cicchetto/src/lib/e2e/vectors/` (§12). A change to anything they pin
changes a row, and each implementation's suite goes red until it follows.

---

## 1. Encodings

| thing | encoding | example |
|---|---|---|
| Ed25519 / Curve25519 key | vodozemac `to_base64()`: standard base64, **unpadded**, 43 characters, in vodozemac's canonical spelling (`canonical_ed25519` / `canonical_curve25519`) | `11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo` |
| Ed25519 signature | standard base64, unpadded, 86 characters | — |
| `did` (device id) | **base64url** (RFC 4648 §5), unpadded, of the first 8 bytes of SHA-256 over the **raw 32 key bytes** (never over the key's base64 text); 11 characters | `If4x36FUomE` |
| `msgid` | standard base64, unpadded, of 8 random bytes (`Grappa.IRC.E2e.new_msgid/0`): 11 characters. grappa accepts 1 to 24 bytes of standard base64, `=` included (`E2e.msgid?/1`) | `q83vEjRWeJA` |
| payload | a JSON object, sent as its **compact** text: no spaces, every byte printable ASCII 0x21–0x7E (`encodePayload`; grappa's `E2e.chunk?/1`) | `{"v":2,"ref":"q83vEjRWeJA"}` |
| identifier fold | ASCII `A`–`Z` → `a`–`z` and nothing else (CASEMAPPING=ascii): grappa's `Identifier.canonical_target/1`, cic's `fold`, shottino's `e2e_fold` | `NiCk[]\~` → `nick[]\~` |

- **An endpoint judges numbers by value.** `v: 2.0` is version 2; a list or
  certificate version written `1.0` is 1 (`validVer`). `true` is not an
  integer. grappa, which casts a PUT list's `ver` as an integer, refuses
  `1.0` there (§3).
- **The `did` is a routing label.** No trust rests on it; it is derived
  from the key, never chosen. grappa derives it (`Grappa.E2eKeys.Device.did/1`)
  and, for a frame address, accepts only the **canonical** spelling of 8
  bytes (`E2e.did?/1`: the standard alphabet's `/Uw/z3+OAsk` and the
  nonzero-trailing-bits `If4x36FUomF` are no dids). An endpoint checks the
  **shape** (11 characters of `[A-Za-z0-9_-]`), at the one place it meets a
  did it did not derive: a key of `bodies` (§4).
- **Keys must be canonical where this document says so** (§6): a key that
  decodes but is not in vodozemac's spelling is refused, never normalised.
  The one exception is MSG's `ck`, which a receiver canonicalises.

## 2. The frame (on IRC)

What travels on IRC is CTCP inside a PRIVMSG to the peer's nick:

```
\x01E2E <VERB> <msgid> <i>/<n> <from> <to> <chunk>\x01
```

**Endpoints never see a frame.** grappa cuts a payload into lines on the
way out (`Grappa.IRC.E2e.fragment/5`) and joins the chunks back on the way
in (`E2e.parse/1`, reassembly in `Grappa.Session.E2eReassembly`), so an endpoint hands
grappa one payload and receives one `e2e_message` per whole message and
device (`CLIENT_PROTOCOL.md` §4f). This section is for the relay and for
an endpoint predicting the line count.

- `VERB` is upper case on the wire, lower case in every JSON event.
- `1 <= i <= n <= 64` (`E2e.max_fragments/0`). The whole payload is at most
  32 KiB (`E2e.max_payload_bytes/0`).
- `chunk` is a non-empty slice of the payload text; since the payload holds
  no space, a line has exactly seven fields. The closing `\x01` is
  optional on receipt, as for every CTCP frame.
- A v1 line (no addresses) is malformed.

**Addressing** (`E2e.addressed?/3`, one table for the parser and the send
door): `did` is a device id. As a sender, `*` is "the user, spoken for by
grappa". As a recipient it is "every listed device" for PKMSG and MSG, and
the user (that is, the peer's grappa) for KEYREQ and the consent verbs.

| verb | `from → to` | who sends it |
|---|---|---|
| `KEYREQ` | `did → *` | an endpoint; grappa answers it and never delivers it |
| `KEYS` | `* → did` | grappa only, from the bundle it hosts |
| `PKMSG`, `MSG` | `did → did`, `did → *` | an endpoint |
| `NACK` | `did → did` | an endpoint |
| `NACK` | `* → did` | grappa: the message reached none of the listed devices |
| `REQUEST`, `CANCEL` | `did → *` | grappa, on an endpoint's REST call (consent, §4) |
| `ACCEPT`, `REFUSE` | `did → *` or `* → did` | grappa, on an endpoint's call; `* → did` also when the user's standing consent ACCEPTs, or for a REFUSE sent without a line |

**Line arithmetic** (`E2e.fragment/5`; mirrored by cic's `linesNeeded` and
shottino's `e2e_lines_needed`). The line budget is the network's published
`frame_budget_base` minus the byte length of the target nick
(`LineSplit.frame_budget/2`). A line's head is the bytes of
`\x01E2E VERB msgid n/n from to ` plus the closing `\x01`, and it widens
with the digits of `n`. The message takes the smallest `n` whose `n` lines
of room (`budget − head(n)`, which must be positive) cover the payload;
grappa then cuts exactly `n` lines. No `n` up to 64 means refused (413 at
the send door). Example, pinned in `lines_needed.json`: with a budget of
384 (a `frame_budget_base` of 394 less the 10 bytes of `vjt-claude`) and
an 11-byte msgid, a MSG from
one did to another holds 334 bytes per line up to `9/9` and 332 from
`10/10`, so 64 lines hold 21,248 bytes and one byte more is refused.

## 3. Identity

One subject holds **one identity per network**:

- a **master** Ed25519 key `M`, which vouches for devices and is what a
  peer pins;
- up to **three devices** (`DEVICE_CAP`; grappa's
  `E2eKeys.DeviceList.max_devices/0`, issue 2576), each a vodozemac account
  with an Ed25519 key `E` and a Curve25519 key `K`.

A receiver takes a list or a message naming up to **four** devices
(`MAX_DEVICES`), the wire's own limit: a list of four signed before the cap
still reads. Raising the four is a new wire version.

**The id block** of a device: `{"curve25519": K, "ed25519": E, "sig": S1}`,
where `S1 = E.sign(id text)`.

**The list**: `{"ver": N, "devices": [E1, E2, …]}` with
`sig = M.sign(list text)`. The rules an endpoint applies (`validMasterList`):

- 1 to 4 keys on the wire, each canonical; sorted **strictly ascending in
  plain byte order**; no two keys with the same `did`;
- `N` an integer in 1..2³¹−1, rising with every new list;
- the master key itself canonical.

grappa applies a stricter set when a list is PUT
(`DeviceList.changeset/2`, `E2eKeys.put_list/3`): at most 3 keys, `ver` an
integer (a JSON `1.0` is refused), rising above the held list's (the very
list held, put again, is accepted and changes nothing), and every key a
device registered there.

A key that an accepted list named and a later accepted list drops is
**revoked** in the receiver's memory, with its curve, until a newer
accepted list names it again.

**The certificate** of a device: `C = M.sign(cert text)`, where `N` is the
version of the first list that named the device. The master's own device
gets its certificate when the identity is created, and every other device
at pairing (§9); a device keeps it and sends it in every PKMSG.

**One-time keys**: `{"key": O, "fallback": bool, "sig": E.sign(otk text)}`.
`fallback` is true only when it is literally `true`.

### Signed and hashed strings

Every string is plain concatenation; nothing is JSON-canonicalised.
Versions are decimal. `|` and `:` are literal.

| name | exact text | signed / hashed by | cic | shottino |
|---|---|---|---|---|
| id (S1) | `irc-e2e:v2:id:` + K + `:` + M | signed by the device's E | `idSigText` | `e2e_id_sig_text` |
| one-time key (S2) | `irc-e2e:v1:otk:` + O | signed by E | `otkSigText` | `e2e_otk_sig_text` |
| list | `irc-e2e:v2:list:` + N + `:` + E1 `,` E2 … (array order) | signed by M; **the one signature grappa verifies** (`DeviceList.signed_string/2`) | `listSigText` | `e2e_list_sig_text` |
| certificate | `irc-e2e:v2:dev:` + N + `:` + E | signed by M | `certSigText` | `e2e_cert_sig_text` |
| binding (`fb`) | base64 (unpadded) of the first 16 bytes of SHA-256 over `irc-e2e:v2:bind:` + E_from + `:` + E_to; 22 characters | hash | `fb` | `e2e_fb` |
| SAS emoji info | `irc-e2e:v1:sas:` + A_curve `\|` A_key `\|` B_curve `\|` B_key `\|` tx | the `info` of vodozemac's emoji derivation (the bindings' `emoji_indices(info)`, `vz_established_sas_emoji_indices`) | `sas.ts` `info` | `e2e_sas_info` |
| SAS device MAC info | `irc-e2e:v1:sas-mac:` + first_curve `\|` second_curve `\|` tx | `calculate_mac(E, info)` | `sas.ts` | `e2e_sas_mac_info` |
| SAS master MAC info | `irc-e2e:v2:sas-mmac:` + first_curve `\|` second_curve `\|` tx | `calculate_mac(M, info)` | `sas.ts` | `e2e_sas_mac_info` |
| SAS commitment | base64 (unpadded) of SHA-256 over B_key + `\|` + tx; 43 characters | hash | `sas.ts` | `e2e_sas_commitment` |
| pairing channel | `irc-e2e:v2:pair` (no trailing colon) | the ECIES `info` on both sides | `PAIRING_INFO` (`pairingMessages.ts`) | `E2E_PAIRING_INFO` |
| order line | lower-case hex SHA-256 of the UTF-8 PRIVMSG body | hash | `orders.ts` | `e2e_line_sha256` |

## 4. Payloads

Every payload is a JSON object with `"v": 2`. A receiver refuses another
version and **ignores fields it does not know**. A payload that does not
parse as one JSON object (an array or a scalar, `NaN` or `Infinity`,
broken text) is undecodable. Shapes are checked first (cic's `parseKeys` / `parsePkmsg` /
`parseMsg` / `parseNack`, shottino's `e2e_payload_parse`), meaning second
(§6).

**`bodies`** (PKMSG, MSG): an object of 1 to 4 entries, each keyed by the
recipient device's `did` (shape-checked, §1) with a string value, the Olm
body for that device. The frame's `to` is that `did` when there is one
body and `*` when there are several; grappa hands a `*` message to every
listed device and each decrypts only its own. Every payload has its own
msgid.

**PKMSG or MSG is chosen per session**, never mixed in one payload: a body
goes in a PKMSG while the sender's newest session to that device has not
yet received a message, and in a MSG after. A device with no session gets
nothing yet: the message waits and a KEYREQ goes out. Each kind goes out
in payloads of at most 4 bodies, and a group too long for 64 lines goes as
one payload per body (cic `Engine`, shottino `e2e_send`).

| verb | payload | notes |
|---|---|---|
| `KEYREQ` | `{"v":2}` | grappa answers from the bundle it hosts (`Grappa.E2eKeys.answer/3`) and never reads or delivers it |
| `KEYS` | `{"v":2,"master":{"ed25519":M,"list":{"ver":N,"devices":[E…]},"sig":S},"devices":[{"id":<id block>,"otk":<one-time key>}…]}` | written by grappa only: the signed list and one key per listed device that has one; at most 4 entries. `list.ver` must be a number and `devices` strings at parse; the list rules (§3) judge them after |
| `PKMSG` | `{"v":2,"id":<id block>,"master":{"ed25519":M,"cert":C,"ver":N},"bodies":{…}}` | the sender's identity travels once; `master.ver` must pass `validVer` at parse |
| `MSG` | `{"v":2,"ck":K,"bodies":{…}}` | `ck` is the sender device's Curve25519 key |
| `NACK` | `{"v":2,"ref":<msgid>}` | names the msgid a device could not read; from `*` when grappa says it reached none of the peer's devices |
| consent (`REQUEST`, `ACCEPT`, `REFUSE`, `CANCEL`) | an endpoint's: `{"v":2,"master":M}`, a hint; grappa's own: `{"v":2}` | at most 1024 bytes, never parsed by grappa; sent through the requests resource of `CLIENT_PROTOCOL.md` §4i, never by an endpoint on IRC |

## 5. Inner messages

The plaintext of an Olm body is a UTF-8 compact JSON object with a string
`t`. Two fields are added by the sending engine, never by the caller, and
removed by the receiving one before anything else sees the message:

- **`lv`**, the sender's own list version, on every message except a copy
  to a sibling. A receiver whose stored list for that master is older asks
  for the new one (`listreq`).
- **`fb`**, the binding (§3), on every message that travels in a **pre-key**
  body. The receiver recomputes it from the PKMSG's `id.ed25519` and its own
  key; a mismatch refuses the message (`inner-key-mismatch`). A MSG body's
  `fb` is not checked.

A `t` the receiver does not know is **ignored**: no row, no NACK; `lv` is
still honoured. Unknown fields are ignored and passed on.

| `t` | fields | sent by |
|---|---|---|
| `text` | `body`: string. `/me` is `body` = `\x01ACTION …\x01` | a person |
| `file` | `url` (this grappa's own `/uploads/<26-character slug>`, no query or fragment), `key` (base64 of 32 bytes), `iv` (base64 of 12 bytes), `name` (non-empty), `mime` (a `type/subtype`), `size` (integer ≥ 0, plaintext bytes), `category` (`image` / `video` / `document` / `audio`), `expires_at` (a date string); the blob is AES-256-GCM. Only these fields are passed on | a person; optional — cicchetto implements it (`fileInner.ts`), shottino ignores it as an unknown type |
| `copy` | `peer` (non-empty), `body` (string), `file` (optional: a `t:file` object, `"t":"file"` included) | one of the account's devices to its siblings: what it sent `peer`, through the copy door (`CLIENT_PROTOCOL.md` §4f) |
| `list` | `master`: `{"ed25519","list":{"ver","devices"},"sig"}` | the engine, to ONE device, at most once per (nick, did) per minute: the answer to a `listreq`, or unasked to a peer device that addressed a device our list does not name |
| `listreq` | none | the engine, at most once per nick per minute: to the ONE device whose `lv` is above the stored list, or to every device of a master just pinned or verified by SAS |
| `chal` | `network`, `channel` (non-empty strings), `sender_mask` (string, may be empty), `line_sha256` (64 lower-case hex), `nonce` (non-empty), `expires_at` (integer, unix seconds) | a bot asking whether this user really sent a line (orders) |
| `ack` | `nonce` | the endpoint, to the CHAL's device only, when the CHAL's sender is a master it has verified and its own send log holds the line |
| `sas.start` | `tx` (11 base64 characters) | §8 |
| `sas.accept` | `tx`, `commitment` (43) | §8 |
| `sas.key` | `tx`, `key` (43) | §8 |
| `sas.mac` | `tx`, `mac` (43), `mmac` (43) | §8 |
| `sas.cancel` | `tx`, `reason` | §8 |

## 6. Receiving

The first check that fails decides. "NACK" means the endpoint answers
`{"v":2,"ref":<msgid>}` to the sending device; everything else is dropped
without an answer. cic: `Engine` in `engine.ts`; shottino: the `e2e_*`
receive path.

**PKMSG.** Shape (§4) → the id keys and the master key canonical → `did`
of `id.ed25519` equals the frame's `from` → a body for our own `did`
(otherwise NACK `not-for-our-devices`, unless a device on our own list has
a body: then silently not for us) → the body is base64 → the certificate
verifies under `master.ed25519` → S1 verifies → the master check (§7) →
the device's standing (§7) → the curve: not ours or a sibling's, the key
not already bound with another curve, the curve not bound to another
device that proved it (one that only claimed it gives it up) → decrypt: with a held
session, failure is NACK `decryption-failed`; otherwise an inbound session
is created, and a pre-key session id seen before is NACK `replayed-session`,
a creation failure NACK `session-creation` → the inner message (§5),
whose failure throws the new session away without a NACK.

**MSG.** Shape → `ck` canonicalised → a body for our own `did` (as above)
→ the body is base64 → `ck` is not a revoked curve of the pinned master →
if a trusted device of the pinned master has `ck`: its `did` must equal
`from`, then decrypt (failure: NACK `no-session` with no session,
`decryption-failed` otherwise) → if `ck` belongs to any other device:
dropped → otherwise NACK `no-session`.

**NACK received.** The sender looks up its record of the msgid. A message
goes out at most twice: it is re-sent once, to that one device only,
re-keying (at most once a minute per nick) when the failed session was its
newest. The message is **lost** — tell the user, do not re-key on your own
(`CLIENT_PROTOCOL.md` §4f) — when the NACK comes from `*`, from a device it
did not go to that is unknown under that master, or from a device it went
to that the master no longer vouches for. A NACK from a device it did not
go to that is bound or listed is ignored.

**KEYS received.** Only when asked for. Shape → the list rules (§3) → the
master check (§7) → per entry: S1, the device's standing, the curve, the
one-time key's S2, then an outbound session.

**Copies** (`own: true`) come from the account's own devices: the master
must be ours and the device on our list; a copy is never NACKed.

## 7. Trust

- **The peer is its master key, never its nick.** The first master seen
  for a nick is pinned, unverified (trust on first use). A different
  master for a pinned nick raises the **key alarm**: a message under it is
  dropped, and the user decides by re-pinning by hand. A SAS (§8) runs
  against the master already pinned and marks it verified. Our own master
  in a peer's message is refused.
- **A device is trusted** when its S1 verifies and either the stored list
  names it, or (a device not listed yet, as after a pairing the receiver
  has not seen) its certificate verifies under the pinned master with a
  version ABOVE the stored list's and the key was never revoked. A
  certificate whose version is not above the stored list's, for a device
  that list does not name, is **stale**. A device learnt from KEYS is
  trusted by the list, which KEYS carries.
- **The stored list is refreshed** (`listreq`) when a message's `lv` is
  above it, and when a master is pinned or verified.
- **Siblings** (our own other devices) are trusted through our own
  master's signed list and their S1.

## 8. SAS — verifying a peer

Between two people, over the encrypted conversation, with vodozemac's SAS:

1. A sends `sas.start {tx}` to every device of B's master; `tx` is 8 random
   bytes, base64 unpadded.
2. B answers `sas.accept {tx, commitment}` (the commitment over B's SAS key, §3).
3. A sends `sas.key`; B sends `sas.key`; A checks the commitment.
4. Both derive **7 emoji**: vodozemac's emoji indices for the `info` of §3
   (the bindings' `emoji_indices(info)` and `vz_established_sas_emoji_indices`)
   into the 64-entry SAS emoji table (cic `sasEmoji.ts`, shottino
   `e2e.c`; the two tables are identical).
5. After the human confirms a match, each side sends `sas.mac {mac, mmac}`:
   the device MAC over its own `E` and the master MAC over its own `M`, the
   info strings of §3 with the SENDER's curve first.
6. Verified when the human confirmed and both of the peer's MACs check. The
   master is then marked verified.

The first step that names a `tx` fixes the peer device; another device of
that master is told `sas.cancel {reason: "other-device"}`. Two starts at
once: the smaller `tx` (byte order) wins on both sides. A SAS times out
after 600 s. Reasons sent in `sas.cancel`: `user`, `mismatch`, `timeout`,
`unexpected-message`, `commitment-mismatch`, `mac-mismatch`, `page-gone`,
`bad-key`, `other-device`; a receiver takes any string.

## 9. Pairing — a device joins its own account

The rendezvous and its REST doors are `CLIENT_PROTOCOL.md` §4g; grappa
relays opaque base64. Between the two devices:

1. The holder (the device that holds the master key; no other device can
   offer) opens a rendezvous with an ephemeral Curve25519 key; grappa offers it to the account's devices.
2. The joiner opens vodozemac's ECIES channel to that key with info
   `irc-e2e:v2:pair`, sending `hello`; it shows the **2-digit check code**
   (`check_code`, `00`–`99`) and posts the initial message base64url.
3. The holder opens the inbound channel, requires a `hello`, and asks its
   user to type the joiner's code; a wrong code ends the pairing with
   nothing sent.
4. `offer` → `join` (on the joiner user's tap) → `signed` → `done`.

Messages are compact JSON with `"v": 1`, and every one is ECIES-encrypted:
`hello` is the plaintext of the channel's initial message, every later one
is `encrypt` on the established channel.

| `t` | fields |
|---|---|
| `hello` | none |
| `offer` | `networks`: `[{"network": slug, "master": M}]`, `full`: `[slug]` |
| `join` | `devices`: `[{"network", "id": <id block>}]`, `skipped`: `[{"network", "reason"}]` |
| `signed` | `devices`: `[{"network", "cert", "list": {"ver","devices","sig"}}]`, `refused`: `[{"network", "reason"}]` |
| `done` | `paired`: `[slug]` |

`reason` is one of `full`, `paired`, `list-changed`, `failed`. An unknown
`t` or `reason` fails the pairing; unknown fields are ignored. The holder
signs (cic `issueDevice`, shottino `e2e_pair_issue`): the joiner's keys
canonical and its S1 over the holder's master, else `failed`; already
listed: `paired`; the list at the cap: `full`; otherwise the list at
`ver + 1`, sorted, and a certificate at `ver + 1`. The joiner accepts
(`acceptSigned`) only a list that passes the list rules under the offered
master, names the device, and comes with a certificate that verifies.

## 10. Limits

| limit | value | grappa | cic | shottino |
|---|---|---|---|---|
| wire version | 2 | `"v"` | `WIRE_VERSION` | `E2E_WIRE_VERSION` |
| devices per list / bodies per message (wire) | 4 | — | `MAX_DEVICES` | `E2E_MAX_DEVICES` |
| devices an identity holds | 3 | `DeviceList.max_devices/0` | `DEVICE_CAP` | `E2E_DEVICE_CAP` |
| lines per message | 64 | `E2e.max_fragments/0` | `MAX_FRAGMENTS` | `E2E_MAX_FRAGMENTS` |
| payload bytes | 32,768 | `E2e.max_payload_bytes/0` | — | — |
| list version (grappa); list and certificate version (endpoints) | 1..2³¹−1 | `DeviceList.changeset/2` | `validVer` | `e2e_valid_ver` |
| hosted one-time keys per device | 50 | `E2eKeys.max_one_time_keys/0` | `MAX_HOSTED_ONE_TIME_KEYS` (`keyBundle.ts`) | `E2E_MAX_HOSTED_ONE_TIME_KEYS` |
| consent payload, request lifetime | 1,024 bytes, 24 h | `E2eRequests.Request`, `E2eRequests.ttl_seconds/0` | — | — |
| pairing rendezvous | 300 s, 16 KiB a message, 64 KiB / 64 messages | `E2ePairing` | — | `E2E_PAIRING_LIFETIME_S` |
| SAS timeout | 600 s | — | `SAS_TIMEOUT_MS` (`sas.ts`) | `E2E_SAS_TIMEOUT_MS` |

Engine pacing (KEYREQ retry 30 s, out-queue 90 s / 16, re-key and
`listreq` once a minute, a sent message remembered 30 min and re-sent at
most once, 5 sessions per peer device) is each endpoint's own; the values agree today
(`engine.ts` constants, `e2e.h` `E2E_*`).

## 11. Versioning

`"v": 2` is the wire version of every payload, pinned by every receiver;
the signed strings carry their own `v1`/`v2` tags and keep them. The
client-facing REST/WS contract around it is versioned separately by
`protocol_version` (`CLIENT_PROTOCOL.md`); a change to a payload, a signed
string or a limit in §10 is a change to this document AND to the corpus.

## 12. The conformance corpus

`cicchetto/src/lib/e2e/vectors/*.json`, read by three suites, each running
its own production code against the same rows:

| file | pins | grappa (`Grappa.E2eVectorsTest`) | cicchetto (`e2eVectors.test.ts`) | shottino (`test_e2e.c`, `corpus_*`) |
|---|---|---|---|---|
| `did.json` | derivation; keys that are not keys; each spelling's **shape** and **canonical** answers | derivation, not-keys, canonical | derivation, not-keys, shape (via `bodies`) | derivation, not-keys, shape |
| `fb.json` | the binding, both directions | — | yes | yes |
| `signed_strings.json` | id, list, certificate, one-time key texts | the list | all | all |
| `lines_needed.json` | the line count, the 64-line edge, a budget with no room | `E2e.fragment/5` | `linesNeeded` | `e2e_lines_needed` |
| `payloads.json` | per verb: accepted, refused, undecodable | — (grappa never parses a payload) | yes | yes |
| `fold.json` | the identifier fold | `canonical_target/1` | `fold` | `e2e_fold` |
| `limits.json` | the limits of §10 every side applies without asking | `device_cap`, `max_hosted_one_time_keys`, `max_fragments`, `max_payload_bytes` | `wire_version`, `max_devices`, `device_cap`, `max_fragments`, `max_hosted_one_time_keys` | the same five as cicchetto |

**Adding a case** to an array is the whole procedure: every suite picks it
up. A new `limits.json` key, or a new kind of signed string, also needs a
line in each suite that reads it (each enumerates them). A row one
implementation fails is a divergence to fix in that implementation, never
a row to delete. The corpus does not pin Olm itself, the SAS emoji
derivation, or the pairing check code: those are vodozemac's, linked once.
The files live beside cicchetto's other shared truth table
(`shouldNotifyTruthTable.json`) because the bun container mounts only
`cicchetto/`; grappa reads them through the mounted `cicchetto/src`, and
shottino through `read_repo_file` (`tests/test.h`).
