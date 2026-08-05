# Calls in shottino

Audio and video calls, from a terminal, in channels and queries.

This document covers two things: **the invite convention that ships
today** (stage 1), and **what a host has to provide** for the stage that
puts the media in the terminal (stage 2, WHIP/WHEP).

The server side is deliberately **not grappa**. Nothing here touches the
bouncer, its database or its wire protocol. A call is a line of text on
IRC plus, later, an HTTP conversation with a media host that knows
nothing about IRC. The two never meet.

---

## Stage 1 — the invite convention (shipping)

A call is a URL somebody posts and somebody else opens. That is the
whole protocol, and it is deliberately the whole protocol: IRC stays
text, every other client in the channel sees a line it can read, and
shottino is the only one that also treats it as an event.

    📞 https://meet.jit.si/shottino-4f2c8e01…      audio
    📹 https://meet.jit.si/shottino-4f2c8e01…      video

The marker emoji mirrors what `/upload` already ships (`📸`, `🎤`, `🎥`),
so a human reading it in irssi or cicchetto needs no explanation.

### Verbs

| verb | what it does |
|---|---|
| `/call` | mint a room, post `📞 <url>` to this window, open it |
| `/videocall` | the same with `📹`, so the other side knows to expect a camera |
| `/answer` | join the last call that came in — ringing or not |
| `/hangup` | stop a ring. **Local**: the caller is not told |

### Settings

| setting | default | meaning |
|---|---|---|
| `call.base_url` | `https://meet.jit.si` | where a room is made. Any room-per-URL service |
| `call.ring` | `queries` | `off` / `queries` / `all` — when an arriving call interrupts you |

### The rules the implementation actually enforces

**A marker, never a URL pattern.** Ringing at any recognised meeting link
would mean anyone who pastes one — or quotes one, or links a recording of
one — makes every shottino in the channel ring. The marker must *open*
the line and must be followed by whitespace: `📞x` is not an invite, and
neither is `look at 📞 https://…`.

**http and https only.** Answering hands the URL to the desktop opener.
A `file://`, a `javascript:` or anything else with a registered handler,
arriving from a stranger and opened by one keystroke, is a hole rather
than a call.

**A URL that does not fit is refused, never truncated.** Half a room name
is not a shorter link; it is a different room.

**The room name is 128 bits from the CSPRNG.** A room of this shape is
public to whoever knows its name — *the link is the credential*. That
makes the honest privacy statement true: **a call is exactly as private
as the window its link was posted in.** Which is why the ring names the
window it came from, and why `/call` refuses to guess one.

**Queries ring; channels only announce.** A channel doorbell that any
member can press is a doorbell that gets pressed. The invite still lands
in scrollback and `/answer` still reaches it, so the quiet policy loses
the interruption and nothing else.

**Decline says nothing to anyone.** Declining down the wire would post
"no" into whatever window the invite arrived in, a channel included. The
caller learns you did not join by your not being in the room, which is
how a call has always worked.

**Three guards at the ingest, shared with `/bot`:** not from history (a
scrollback fetch must not ring you with yesterday's calls), not from a
blocked person, and not from a presence row — a join is not an
invitation. Your own invite, echoed back by the server, does not ring
you either.

### Known limitation of the default target

`meet.jit.si` now requires the **moderator** to authenticate (Google,
Facebook or GitHub) before a room will start. Joining a room that is
already running is still anonymous, so an invite you *receive* always
works; one you *place* may ask the browser for a login the first time.
Point `call.base_url` at a service without that gate and the behaviour is
identical — nothing in the call code knows what jitsi is.

---

## Stage 2 — WHIP/WHEP, and what the host must provide

Stage 1 hands the URL to a browser. Stage 2 joins the call *in the
terminal*: audio through the system devices, video decoded by ffmpeg and
drawn as colour art by the renderer that already draws animated clips.

The protocol choice is **WHIP** (WebRTC-HTTP Ingestion Protocol, RFC
9725) for sending and **WHEP** for receiving, because it is the only
option whose signalling costs *no new dependency and almost no code*:

```
POST <base>/<room>/whip          Content-Type: application/sdp
  body: SDP offer
→ 201 Created
  Location: <resource-url>
  body: SDP answer

DELETE <resource-url>            hang up
```

That is one HTTP request shape over the OpenSSL shottino already links.
The SDP is generated and consumed by libdatachannel — the one new
dependency, and the same one whether the signalling is WHIP, Jitsi's
XMPP/Jingle, or CTCP over IRC. **The signalling choice costs code, not
dependencies**, and WHIP is the cheapest code.

### The dependency, measured

libdatachannel is vendored as a pinned git submodule
(`vendor/libdatachannel`, **v0.24.5**) and linked **statically** into the
helper. Configured for media without the parts we do not use:

```sh
cmake -S vendor/libdatachannel -B vendor/build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DUSE_GNUTLS=OFF -DUSE_NICE=OFF \
  -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON
```

`USE_GNUTLS=OFF` takes the OpenSSL that is already linked; `USE_NICE=OFF`
takes the bundled libjuice rather than adding a system libnice. That
produces four static archives totalling ~6.7 MB of which only the reached
code is linked in:

| archive | size |
|---|---|
| `libdatachannel.a` | 5.4 MB |
| `libusrsctp.a` | 824 KB |
| `libjuice.a` | 364 KB |
| `libsrtp2.a` | 138 KB |

**The result, verified by linking and running a C11 smoke program** that
creates a real peer connection: a **4.5 MB** self-contained binary whose
runtime dependencies are

```
libssl.so.3  libcrypto.so.3  libm.so.6  libc.so.6  libz.so.1  libzstd.so.1
```

— which is **exactly the set shottino already links**. No libstdc++, no
GStreamer, no new runtime dependency of any kind.

Two details make that work and are easy to get wrong:

- libdatachannel is C++ inside, so the helper is **compiled as C11 but
  linked with the C++ driver** (`c++`), with `-static-libstdc++
  -static-libgcc`. Linking with `cc` fails on `__cxxabiv1` vtables, and
  linking without the static flags adds a `libstdc++.so.6` runtime
  dependency that the whole point was to avoid.
- The helper is **not built by `make all`**. The packaging path runs
  `make -C frontends/shottino` and must keep producing one binary with no
  new dependencies; building the helper additionally needs cmake and a
  C++ compiler, which the .deb and AUR builders are not asked for.

### The helper, as it stands

`shottino-call` is built **opt-in** — `make call`, never `make all`, so
the packaging path is untouched:

```sh
git submodule update --init --recursive frontends/shottino/vendor/libdatachannel
make -C frontends/shottino call
```

```
usage: shottino-call [--whip <url>] [--whep <url>] [options]
  --whip <url>     publish here. Alone, the session is sendrecv
  --whep <url>     subscribe here. With --whip, publishing becomes
                   sendonly and this is the receiving session
  --stun <url>     a STUN server, e.g. stun:stun.example:19302
  --video          negotiate a video track as well as audio
  --timeout <ms>   how long to wait for ICE and for the answer (default 15000)
  --verbose        interleave '#' notes on stderr
  --protocol       print the helper protocol version and exit
```

**Output contract**, fixed now because the media stage depends on it:
**stdout is reserved for the raw frame stream and nothing else writes
there**; events are one JSON object per line on **stderr**, and
`--verbose` notes are `#` comment lines a parser skips on the first
character — **every** line of a note, not just its first, because the
reader decides line by line and a note can carry a whole SDP body. `--protocol` exists so shottino can refuse a helper left
behind by an older install rather than misbehaving with it.

It does the full signalling round trip — gather ICE, build the offer,
POST it, resolve the session resource, apply the answer, report the
connection state, DELETE on the way out — and it now carries **media**.

**The split: ffmpeg does codecs and packetisation, the helper does
transport.** Nothing in the helper encodes, decodes, packetises or times
a frame. Each direction is an ffmpeg process joined to a libdatachannel
track by a loopback UDP socket:

```
send:  ffmpeg -f pulse -i default … -f rtp rtp://127.0.0.1:P
           → helper drains P → rtcSendMessage(track)

recv:  track callback → helper sends to 127.0.0.1:Q
           → ffmpeg -i <sdp describing Q> … → speakers, or rgb24
```

The video receive leg writes rgb24 **straight to the helper's own
stdout** — no copy, no framing layer to desynchronise — using the same
scale-and-pad convention as shottino's inline decoder, so a call frame is
byte-identical in shape to a clip frame. That is why stdout is reserved.

Mute is local and instant: the capture keeps running and its packets are
dropped on the way to the track. Tearing ffmpeg down instead would make
unmuting take as long as a device open.

**Verified end to end without an SFU**, using ffmpeg's synthetic sources
(`lavfi`) through a loopback that exercises everything except the
transport libdatachannel owns: **118 RTP packets captured and forwarded →
117 frames of rgb24 decoded**, and the audio leg producing Opus RTP.

Five bugs that cost real time and are worth not repeating:

- **`-framerate` / `-video_size` are demuxer-specific.** v4l2 takes them;
  lavfi refuses them outright and the capture dies with its stderr
  discarded — a silent leg producing nothing. Rate and size belong in the
  **filter graph**, which works for every input and also pins the
  geometry whatever the device felt like giving.
- **ffmpeg needs `-nostdin`.** Handed `/dev/null`, it reads EOF and quits
  before a single packet arrives, reporting "Output file does not contain
  any stream" — which reads like a codec problem and is not.
- **Drain the socket, never one datagram per wakeup.** A video frame is a
  BURST of RTP packets; one-per-poll delivers a fraction of each, no
  keyframe ever assembles, and the far end fails every packet.
- **No `-fflags nobuffer` / `-flags low_delay` on the receive leg.** They
  look like the obvious choice for a call and they cost the whole
  picture: they make the demuxer discard rather than reorder, so any
  jitter loses the keyframe. Measured both ways — **0 frames with them,
  117 without**, same packets. The tens of milliseconds are not worth a
  blank window.
- **The receive SDP cannot be unlinked right after the spawn.** The child
  may not have exec'd, and the decoder then reads nothing, silently.

The offer it generates, captured against a stub endpoint:

```
m=audio 48832 UDP/TLS/RTP/SAVPF 111     a=rtpmap:111 opus/48000/2   a=sendrecv
m=video 48832 UDP/TLS/RTP/SAVPF 96      a=rtpmap:96 VP8/90000       a=sendrecv
```

Both m-lines on one port — BUNDLE with rtcp-mux — which is what an SFU
expects and what makes the single-UDP-port firewall rule below possible.

**One or two sessions, because SFUs come in two shapes.** This is the
thing to get right before blaming the network:

| invocation | sessions | for |
|---|---|---|
| `--whip` alone | one `sendrecv` | a single-endpoint SFU — Galène, LiveKit |
| `--whip` + `--whep` | `sendonly` + `recvonly` | **MediaMTX**, whose WHIP is publish-ONLY and WHEP read-only |
| `--whep` alone | one `recvonly` | watch a room; no camera or microphone is opened |

Posting a lone `sendrecv` offer to MediaMTX's WHIP does not fail — it is
accepted as a publish and simply never sends anything back, which is a
call with no sound and no error. Hence the pair.

Verified against a stub that reports the direction attributes of each
offer: `--whip` alone negotiates `sendrecv`; the pair negotiates
`sendonly` on the WHIP endpoint and `recvonly` on the WHEP one; `--whep`
alone negotiates `recvonly`. Exactly one session is wired to the
decoders — feeding both would hand your own echo to the speakers.

**Vanilla ICE, not trickle.** WHIP is one POST with one body, so there is
nowhere to trickle a late candidate to: the offer has to be complete
before it is sent. The spec has a PATCH for trickle and server support
varies; needing it is not worth a second code path here.

Two bugs this found on its first real run, both worth knowing if you
touch the request path: the `Host` header must carry the **port** when it
is not the scheme's default (omitting it reaches the right socket and
then the wrong vhost, and an SFU behind a reverse proxy routes on that
header), and the session resource exists from the moment the endpoint
answers `201`, so **every** exit after that owes it a `DELETE` — a
rejected answer and a media path that never came up included.

### What the host has to run

**1. An SFU that speaks WHIP and WHEP.**

| option | notes |
|---|---|
| **MediaMTX** | single Go binary, no dependencies, WHIP+WHEP native, **and it serves a browser page per path** — which preserves the "post a link a browser user can click" property for free. The recommended starting point. |
| **LiveKit** | a real room/participant model, WHIP ingest, single binary for one node. More capable, more moving parts. |
| **Janus** | mature, plugin-based; needs the WHIP server plugin. |
| **Galène** | small, self-hostable, has a browser UI; its own protocol plus a WHIP endpoint. |
| hosted | Cloudflare Realtime, Millicast and others speak WHIP if you would rather not run a host at all. |

**2. TLS.** Not optional in practice: browsers refuse `getUserMedia` on
plain HTTP, so any host that also serves the browser page needs a real
certificate. Let's Encrypt via the SFU's own ACME support or a reverse
proxy in front.

**3. Ports.**

- **TCP 443** — WHIP/WHEP signalling and the browser page.
- **UDP** for the media itself. Prefer an SFU configured for a **single
  UDP port mux** (MediaMTX defaults to `8189/udp`) over a wide range;
  one hole in the firewall is one hole to get wrong.
- Optionally **TCP 443 for ICE-TCP**, as the fallback for clients on
  networks that block UDP entirely.

**4. The public IP, declared.** This is the classic misconfiguration and
it fails *silently*: the SFU advertises ICE candidates, and if it
advertises a private address (because it is behind NAT and nobody told
it otherwise) the handshake simply never completes. MediaMTX calls this
`webrtcAdditionalHosts`; LiveKit calls it `rtc.node_ip`. Set it.

**5. STUN, and TURN only if needed.** A publicly reachable SFU is
typically ICE-lite, so a client needs STUN only to discover its own
reflexive candidate — any public STUN server does. **TURN** (coturn,
listening on 443/TCP) is needed only for participants behind symmetric
NAT or a UDP-blocking firewall. It relays media, so it costs real
bandwidth; treat it as the fallback it is, not the default path.

**6. Auth.** WHIP carries `Authorization: Bearer <token>`. Two shapes fit
this design:

- **No auth, unguessable room path.** Consistent with stage 1, where the
  link already *is* the credential. Anyone who knows the path can
  publish — which is exactly the bargain the invite convention already
  makes, and the 128-bit room name is what makes it acceptable.
- **A shared or per-room bearer**, if the host is shared with people who
  are not in the channel.

**7. Codecs — forward, do not transcode.** Opus for audio. **VP8** for
video is the safest common denominator: universally supported and free
of the licensing baggage that keeps H.264 out of some distributions.
Because the terminal renders ASCII art, the useful resolution is tiny
(320×240 at 10 fps is generous), so the SFU should be configured to
forward streams untouched — transcoding would burn CPU to produce
detail the renderer immediately throws away.

### The one thing WHIP/WHEP does not give you, and why it does not matter here

WHIP and WHEP are deliberately just publish and subscribe. They carry no
roster: nothing in the protocol tells you *who else is in the room*.
Normally you fill that gap with an SFU-specific room API, which is
exactly the vendor lock-in the standard was meant to avoid.

**IRC already provides the roster.** The channel membership *is* the
participant list, and the invite convention is the room announcement. A
participant publishes to `<room>/<nick>` and subscribes to the paths of
the other members shottino already tracks in its nicklist. The thing
WHIP leaves out is the thing an IRC client has had all along.

### Bandwidth, for sizing the host

Because the display is coloured half-blocks in a terminal, the numbers
are small enough to be worth stating:

- audio, Opus: **~24 kbps** per participant
- video at 320×240 / 10 fps, VP8: **~150 kbps** per participant

An SFU forwards rather than mixes, so a room of N costs the host roughly
`N × (N−1) × stream`. A five-way video call is under 3 Mbps of forwarding
in total — which is also why a full peer-to-peer **mesh** remains viable
here well past the point it stops being viable for a normal video app,
and is the reason a query call needs no host at all.

---

## Running a call in the terminal

```sh
/set call.base_url http://sfu.example:8889   # a WHIP/WHEP SFU, not jitsi
/set call.mode terminal
/call                                        # or /videocall
```

`call.mode` defaults to **browser**, and that is not a lesser path — it
works with any room-per-URL service and needs nothing installed. The
terminal mode is opt-in because **nothing can tell from a URL whether a
service speaks WHIP**; it has to be declared.

shottino spawns `shottino-call`, looking for it in this order: the
`call.helper` setting, then **beside the shottino binary** (they are
built and installed together, so this is the usual answer), then
`~/.local/share/shottino/bin/`, then PATH. If none is found, `/call`
says so and opens the browser instead — the fallback is automatic, not
an error.

The invite still carries the ROOM URL; `whip` and `whep` are appended to
it, so one link serves the browser and the terminal both.

| verb | while a call runs |
|---|---|
| `/hangup` | ends it. Asks the helper first so it can DELETE the session — killing it outright leaves the SFU holding the slot |
| `/mute`, `/unmute` | the microphone. Local and instant |

Events from the helper are drained by a reader thread and shown in the
window. That thread exists whether or not anyone reads the messages: an
undrained stderr pipe fills and then BLOCKS the helper mid-call.

Their picture is drawn **picture-in-picture**, top-right over the chat
and under any overlay. Not a pane of its own: a call is temporary, and
reserving layout for it would move everybody's scrollback the moment the
phone rang.

The frames go through the **same half-block renderer that draws clips** —
a call is not a second kind of picture — which is also what clamps it, so
a terminal that shrank mid-call letterboxes rather than writing past the
region. The box is a share of the width (16–40 cells, 4:3 in pixels,
where the pixel height is `rows*2` because half blocks pack two pixel
rows per cell row), measured in shottino and handed to the helper as
`--frame WxH`; the helper has no terminal and must never guess one.

It is fixed for the call: the helper is told a size at exec and there is
no way to retell it. A resize letterboxes rather than tearing.

For an audio call the frame stream goes to /dev/null and must never
inherit the terminal — rgb24 bytes painted over ncurses is a screen
nobody can recover.

## Proven against a real SFU

MediaMTX 1.19.3 on a public host, both sessions up, video decoded:

```
{"event":"state","value":"publish connected"}
{"event":"state","value":"subscribe connected"}
{"event":"media","value":"audio+video"}
```

Three bugs that ONLY a real server showed. A stub answers the same
either way, which is exactly why they survived until now:

- **The subscribe must wait for the publish to CONNECT.** MediaMTX
  answers WHEP with `404` when a path has no active publisher, and the
  publisher is not active the moment its own POST returns — ICE still
  has to finish.
- **Capture must start when the publish is ACCEPTED, not when it
  connects.** MediaMTX allows about two seconds from peer-connection to
  first RTP, then drops the publisher with *"deadline exceeded while
  waiting tracks"* — after which every read is a 404 and it looks like a
  subscribe bug. ffmpeg cannot fork, exec, open a device and encode a
  frame inside that window from a standing start.
- **No ICE UDP mux on our side.** One local port looked tidy and is a
  collision with TWO peer connections in one process: both ask libjuice
  for the same muxed socket and the second never completes ICE, which
  the server reports as *"deadline exceeded while waiting connection"*
  and the user experiences as sound one way. The mux that matters is the
  SERVER's `webrtcLocalUDPAddress`; dialling out from ephemeral ports is
  what every browser already does.

### Known, not yet fixed

The receive leg emits far more frames than asked for — measured ~486/s
against a `fps=10` filter. shottino only ever draws the newest frame, so
it wastes CPU rather than corrupting anything, but the rate bound on the
decode side is not doing its job and wants an explicit output rate.

**A path per person, and the roster decides who to read.** Everyone
publishes to `<room>/<nick>/whip`; a query reads the one person the
window names, a channel reads every member. Members not in the call have
no publisher, the SFU says so, and the helper steps over them — that
same tolerance is what lets a late joiner work at all.

Capped at 8 peers: a mesh of subscribes is cheap when the render target
is ASCII, but it is not free, and a cap makes "the channel had forty
people in it" a clear message rather than a machine that stops
responding.

Proven three-way against the live SFU, and the result names the
remaining gap exactly:

| peer | joined | subscribes connected |
|---|---|---|
| ann | 1st | 0 — nobody was publishing yet |
| bob | 2nd | 1 |
| cid | 3rd | **2**, plus 109 decoded frames |

Everyone subscribed to whoever was ALREADY publishing when they joined,
so the last to arrive saw everyone and **the first saw nobody, for the
whole call**. A subscribe refused with a 404 was final.

**Fixed by the resubscribe loop.** Every five seconds one absent peer is
asked again — round-robin, ONE per tick, because session_negotiate is
synchronous and gathers ICE before it posts, so retrying a channel's
worth of absent members in a single pass would stall the control verbs
behind it. A query has one peer and so retries every interval; a large
channel cycles.

Success needs no further wiring: the new session's RTP starts arriving,
the supervisor sees the packets on its next tick, and both mixes rebuild
to include them. Verified against the live SFU with the first caller
alone for fifteen seconds:

```
# subscribe 0: not in the call          <- the initial 404
# subscribe 0: publishing VP8 (payload type 96)
# subscribe 0: joined late
{"event":"peer","value":"joined"}
{"event":"tiles","value":"160x120;0,0,0,160,120"}
# audio: mixing 1 voice
```

579 frames for the first caller where there had been none, with
MediaMTX's log confirming both directions reading.

One consequence worth spelling out: **the AUDIO mix had to become
dynamic too.** It was built once at connect over a contiguous 0..n-1,
so a peer who joined afterwards landed on a slot nobody had prepared
and was audible to no one. Fixing only the subscribe would have given
late joiners a picture and no voice. Both mixes are now owned by the
same supervisor and rebuilt from whoever's RTP is actually arriving.

### Mixed-codec rooms

A room does NOT have one codec. Because an SFU does not transcode, the
codec belongs to each **publisher** — a browser sending H.264 and a
terminal sending VP8 in the same call is an ordinary situation, and a
subscriber that offered only its own preference would see a black tile
for half the room, with no error anywhere.

Since every peer is a separate WHEP session, each one negotiates
separately. So the two directions are not symmetric:

- **Sending** is a choice, because we have to encode *something*:
  `call.video_codec`, VP8 by default.
- **Receiving** has no setting and needs none. Each subscribe offers a
  video m-line naming every codec we can decode; the answer says which
  one that peer publishes and under which payload type. That pair is
  stored **per leg** and used to write that peer's decoder SDP — the
  legs no longer share a codec, so one call can decode VP8 in one tile
  and H.264 in the next.

The multi-codec m-line is built by hand (`media_video_offer_mline`)
because `rtcAddTrackEx` takes one codec per track. Verified offline that
libdatachannel accepts it and that the offer it then produces still
carries both rtpmaps, the H.264 fmtp and the rtcp-fb lines:

```
m=video 9 UDP/TLS/RTP/SAVPF 96 97
a=rtpmap:96 VP8/90000
a=rtpmap:97 H264/90000
a=fmtp:97 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1
```

If that m-line were ever refused, the helper falls back to the single
configured codec and says so rather than losing video. An answer naming
nothing we decode leaves that leg on the default and reports it — not
fatal, because their audio still works, and dropping the peer would turn
an unexpected codec into a person who vanished.

### Group video: one decoder, and the wall it hits

Video is composited like the audio is mixed — ONE ffmpeg reading every
peer, rather than a process per picture. It composites an **even grid**
(`media_grid_layout`), and the grid does NOT depend on who is focused.
That is the load-bearing choice: an earlier version put the focused
peer full-frame with the rest as thumbnails, which meant every focus
change rebuilt the filter graph and restarted the decoder — seconds,
every time, for "show me the other person".

Now the helper opens its inputs once per call and publishes the grid as
a contract:

```
{"event":"tiles","value":"160x120;0,0,0,80,60;2,80,0,80,60;5,0,60,80,60"}
                          frame     slot,x,y,w,h ...
```

shottino keeps the slot→nick mapping (it built the subscribe list, and
that order *is* the slot number), so a cell can be labelled. Which peer
is big is then purely a drawing decision: it samples the focused cell
into a large box and the others into a strip. `/focus` moves an index
and nothing else — no message to the helper, no process restarted,
visible on the next frame drawn.

The tile map is adopted **all or nothing**. A cell that does not fit the
frame it claims to belong to would sample somebody else's pixels, so a
line that fails validation leaves the previous grid in place: a stale
picture beats a mislabelled one.

The filter graph (`media_mix_filter`) and the grid are both pure
functions and unit-tested; the graph was additionally verified by
composing synthetic colour sources through real ffmpeg and reading the
output pixels back to confirm each tile lands where the layout said.

Membership is measured, never assumed. A filter graph STALLS forever on
an input that produces no frames, so a peer whose camera is off would
freeze everybody's picture. `video_supervise()` therefore decides who is
in the mix from arriving RTP: added on the first packet, dropped after
three quiet seconds, and the mix is rebuilt when the set changes. The
same rebuild serves a focus change and a window resize, because they are
the same operation — new tiles, new decoder, the same loopback ports.

**The wall: ffmpeg opens live RTP inputs sequentially**, and each open
blocks long enough that the sockets already opened overflow and have to
resync. Time from spawning the mix to its first composited frame, idle
8-core box:

| pictures | 1 | 2 | 3 | 4 | 6+ |
|---|---|---|---|---|---|
| first frame | 0.3s | 2.2s | 5.7s | 12.4s | never (>15s) |

That is roughly a doubling per picture, and it is the *opening* rather
than the compositing: four inputs opened with **no filter graph at all**
and only one of them mapped still took 14s. It is unaffected by
`-analyzeduration`/`-probesize` in either direction, by `setpts`
alignment of the inputs, by the keyframe interval (shorter is *worse*),
and by whether the helper or a hand-run shell spawns it.

So the mix is capped at **three pictures** (`CALL_TILE_MAX`), where the
curve is still tolerable. Everyone beyond that stays in the call with
their audio and is reported as not drawn — the same honest degradation a
peer with their camera off already gets.

The cap is a symptom, not a fix — but it is now paid **once per call**
rather than once per focus change, which is what the fixed grid bought.
The decoder still restarts when the SET changes (somebody turns their
camera on or off, or joins), and that is unavoidable: the inputs are
genuinely different. It no longer restarts for anything the viewer does.

Still open: the startup cost itself. Something in ffmpeg's sequential
opening of live RTP inputs is the cause, and nothing tried so far moves
it. Worth another look if group video is used in anger.

## Roadmap

- **Stage 1 — shipping.** Invite convention, ring, answer/decline, hand
  off to the browser. Remains the permanent fallback when no media
  helper is installed.
- **Stage 2.** `shottino-call`, a separate helper *process* (not a
  plugin `.so`): no ABI to keep stable, no GStreamer or C++ in
  shottino's address space, the ASan gate stays pure C, and a crash in
  WebRTC drops the call rather than the IRC session. Receive-only audio
  first — it proves the signalling, which is the risky half.
- **Stage 3.** Send audio (real mute/unmute), then receive video into
  the existing renderer, then the camera.

The packaging consequence of the helper being a separate process is that
the `grappa` package is untouched: still four dependencies, still zero
new ones, with the helper as an `optdepends`-shaped runtime download —
exactly the shape ffmpeg already has.
