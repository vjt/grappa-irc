# shottino

Standalone Linux terminal client for grappa's REST + Phoenix Channels surface.

Shottino is intentionally a terminal facade over grappa's JSON API. It does not
parse IRC and does not connect to upstream IRC servers.

## The punk of the scene

grappa and cicchetto are a restoration. The bouncer keeps the protocol honest,
the PWA rebuilds irssi's feel on a modern harness — new plumbing, old soul —
and the project writes the rule down in its own `CLAUDE.md`: **IRC stays text
only.** No pictures in the scrollback. No unfurl cards. No autoplay. A media
URL is a link, and clicking it is the browser's problem.

Shottino runs the other way. It takes the oldest form there is — a curses
client in a terminal — and crams into it everything that has no business being
there:

- pictures render **inline in the terminal**, in colour, with the graphics
  protocol when there is one and character art when there is not;
- clips and GIFs **play** in the scrollback;
- `/voicemsg` records audio and posts it, `/video` does the same with a camera,
  `/dictate` lets you speak a line instead of typing it, and `/stt` turns a voice
  message somebody posted into words;
- right-click a photo for a menu, scroll with the wheel, click a link;
- `/bot` keeps a language model in your channels behind a permission gate;
- `--ircd` turns the whole thing into an IRC server so irssi can connect *to
  the terminal client*, which is either elegant or a war crime.

Some of that is genuinely useful. Some of it is a terminal doing an impression
of a browser because nobody said it couldn't. That is the point: cicchetto
proves the old feel survives new infrastructure, and shottino proves the old
*form* survives anything you throw at it — including every modern feature the
house rules kept out on purpose.

So the rules are broken deliberately, in one place, where the blast radius is a
single client that one person runs. The invariants that actually matter — one
IRC parser and it lives on the server, scrollback is bouncer-owned, the wire is
versioned and additive-only — shottino keeps to the letter. It does not parse
IRC. It does not talk to upstream. It renders what grappa tells it and sends
back what you typed.

Everything else is fair game.

## Install from a package

Shottino ships in grappa's distro packages as `/usr/bin/shottino` — on a host
with the `.deb` or the Arch package installed there is nothing to build. To
build it from source instead, read on.

## Version

```sh
shottino --version        # shottino 0.2.1
```

It is also in the corner, beside the name, on any terminal wide enough to
show all of it — a truncated version number is worse than none, since `0.1`
and `0.1.0` are different releases.

Shottino versions **separately from grappa**. It is a client that talks to
whatever grappa it is pointed at, and compatibility is decided by the wire's
`protocol_version`, not by matching release numbers. One definition lives in
`version.h` and feeds the sidebar, `--version`, `--help`, the `--ircd`
numerics and every HTTP `User-Agent`; a test fails the build if any of them
starts spelling its own.

## Build

```sh
./configure
make
```

Dependencies checked by `./configure`:

- C compiler with C11 support
- `pkg-config`
- `ncursesw`
- OpenSSL (`libssl`, `libcrypto`)
- pthread support

Optional runtime dependencies (only for media link previews — see below):

- `ffmpeg` — fetches and decodes the linked image, or a video/GIF into the
  frames it plays back.
  Required for in-terminal previews; without it a media link opens via
  `xdg-open` instead.
- `chafa` — optional. When present it renders the frame; when absent shottino
  renders it itself as coloured half-block character art.

## Moving pictures

Video and animated GIFs play inline as colour character art, and `/preview`
plays them full-screen too. Up to 64 frames at 10fps, and only frames that are
ON SCREEN are advanced — a scrollback full of GIFs you scrolled past is not a
scrollback full of running animations.

Whether something animates is decided by the DECODER, not by the link: on a
character-art terminal every picture is asked for its frames, so an animated
GIF plays whatever its URL looks like, and a still comes back as the single
frame it has. On a terminal with a graphics protocol the extension is still
consulted, because forcing art there would trade real sharpness for a guess.

Motion is deliberately a character-art capability. A terminal graphics
protocol (kitty/iTerm2/sixel) places a whole picture at the cursor, so
animating one means re-emitting an escape per frame: flicker, bandwidth, and
a separate code path per protocol. Character art goes through ncurses like
text, so it repaints, clips and scrolls with everything else — a clip renders
as art even where a protocol is available. Still images keep using the
protocol when there is one.

`/media still` shows one representative frame instead; `/media anim` turns
playback back on. Both obey the same first-party rule as still images — see
`/media all`.

## Link cards

A link to a **page** — not a picture or a clip — gets a card under it: the
page's own title, a line or two of what it says about itself, and, when it
nominates one, its picture as a small thumbnail beside them (a real bitmap on a
terminal with a graphics protocol, coloured character art everywhere else).
Sites publish exactly this for link previews — the Open Graph tags — and the
card reads those, falling back to `<title>`, the meta description, and finally
the first prose on the page. A page that says nothing gets no card, silently:
most links yield nothing, and a `[loading]` line under every one of them would
be noise.

It is the **same mechanism as inline pictures**, not a second one: the same
slot, claimed when the row is first on screen, decoded lazily on the worker,
and under the **same `/media` policy** — `/media off` stops cards too, and
`/media first-party` limits them to your own deployment's links. Because it is
the same thing: a fetch, on view, of something a stranger linked. Everything
the inline-media section says about what that costs applies here unchanged,
and a card fetches the *page* as well as its picture.

A page is read up to 512 KiB — the tags a card wants live in `<head>`, at the
top — so a link to something large costs that much and yields no card. The
picture a page nominates obeys the same host policy the page did. And a link
that names **this network** — `192.168.…`, `10.…`, `localhost`, a bare LAN name
like `printer` — is never fetched on view at all, picture or page: a stranger
does not get to make this client's requests for it. Only the literal is judged;
a public name that resolves privately is not caught.

`/set cards off` keeps pictures and drops the cards.

## The topic bar

The band at the top is at most **two lines**, whatever the topic says. The
channel label takes only the width it needs (capped at a third of the pane), so
the topic gets the rest rather than starting a third of the way across.

What does not fit on the two lines **scrolls** along the second one, pausing at
each end so it can be read, and pausing entirely while the mouse pointer rests
on the band (the marquee is the way to read a long topic; the pointer is a
courtesy, and needs mouse tracking, which is on by default). A `…` on the left of the second line
says there is more; it reads `(paused)` while you hold it.

## Bridging a normal IRC client (`--ircd`)

`shottino --ircd https://grappa.example.net you` runs headless and listens as
an IRC **server**, so irssi, hexchat, weechat or anything else can connect to
it and reach grappa through it. No terminal is opened, which is why it works
over ssh, in a service unit, or in a container with no tty.

```
export SHOTTINO_PASSWORD=...   # headless: there is no terminal to ask
shottino --ircd              https://grappa.example.net you   # 127.0.0.1:6667
shottino --ircd=6668         https://grappa.example.net you
shottino --ircd=10.0.0.2     https://grappa.example.net you
shottino --ircd=[::1]:6668   https://grappa.example.net you
```

Headless is exactly where the environment variable earns its keep: with no tty
there is nobody to prompt, so without `SHOTTINO_PASSWORD` the only remaining
option is the command line — where `ps` shows it to every user on the host for
as long as the bridge runs, which for a bridge is *permanently*.

The argument is a port, an address, or address:port, v4 or v6; a bare IPv6
address needs no brackets (`--ircd=::1`) but one **with** a port does
(`--ircd=[::1]:6668`), since otherwise the colons are ambiguous. Only the
`--ircd=SPEC` form is accepted — `--ircd 6668` would be indistinguishable from
a positional argument, and the positional it would eat is your password.

It **detaches into the background** once it is up, printing the pid, the log
path (`~/.local/share/shottino/ircd.log`, or under `$XDG_DATA_HOME` when that
is set — see "Where preferences are kept") and how to stop it. **That log holds
the session's messages in plain text** — headless there is no screen for them,
so every line goes there instead. Mode 0600, in a 0700 directory, and never
rotated: it is the bridge's only diagnostic, and it grows for as long as the
bridge runs. Know it is there before you point a backup at your home
directory. Backgrounding is
the last thing it does: the login, the scrollback, the websocket and the bind
all happen in the foreground first, so a wrong password or a port already in use
is still an error you see and a non-zero exit — not a line in a log file you did
not know to look at. Pass `--foreground` under a service manager, which
supervises the process it started and reads a fork as a crash.

Under docker compose there is a supported service for exactly this shape —
`docker compose --profile ircd up -d`, built from `Dockerfile.shottino`. It
sets `--foreground`, takes the two passwords from the environment, and puts
the log under `runtime/` instead of wherever `$HOME` happens to point. See
"The `shottino --ircd` bridge as a compose service" in `docs/OPERATIONS.md`.

Without a checkout to build from, pull the bridge instead: every release
publishes `ghcr.io/vjt/grappa-shottino` (`:<tag>` + `:latest`, `linux/amd64`
+ `linux/arm64`) alongside the bouncer image. The image carries no CMD, so
you supply the whole command — the invocation, and what the compose service
handles for you that a bare `docker run` will not, are in
"Pulling the bridge instead of building it" in `docs/OPERATIONS.md`.

**One connection is one network.** An IRC client has one nick, one MOTD and one
channel namespace per connection, while grappa has several networks at once and
`#ops` on two of them is two different rooms. So the client names the network it
wants in `PASS`, and a user with three networks opens three connections — the
way people already use bouncers:

```
/connect localhost 6667
/quote PASS azzurra:<password>     # or set the server password to azzurra:<password>
```

With one network bound, `PASS azzurra` (or nothing at all, on loopback) is
enough. Naming a network that does not exist is answered with the list.

**Off loopback, a password is required.** The bridge hands over the whole IRC
session — every channel, every DM, and the ability to speak as you. On
`127.0.0.1` that is bounded by who can run processes as you; on any other
address it is bounded by nothing, so a non-loopback bind without
`SHOTTINO_IRCD_PASS` refuses to start rather than listening quietly. Set it and
the clients must send it: `PASS <network>:<password>`.

What the client gets on connect: the nick grappa uses on that network (a
different one is corrected with a `NICK`, as a real server would), `001`–`005`
with the network's real `PREFIX`, a `JOIN` for every channel grappa already
holds open with its topic and names, and a replay of the recent conversation.
With `server-time` the replay is stamped when things were **said** rather than
when you reconnected. See the capability list under Chat history.

Your own messages are not echoed back unless the client negotiates
`echo-message` — a client prints what it sends, and echoing doubles every line.
The cost is that messages you send from cicchetto or from shottino's own UI do
not appear; `echo-message` is how a client asks to see those.

### Chat history

The bridge speaks `CHATHISTORY`, so a client can ask for what it missed instead
of being told once at connect time:

```
/quote CHATHISTORY LATEST #chan * 50
/quote CHATHISTORY BEFORE #chan msgid=1234 50
/quote CHATHISTORY AFTER  #chan timestamp=2026-07-29T08:00:00.000Z 50
/quote CHATHISTORY BETWEEN #chan msgid=1200 msgid=1250 50
/quote CHATHISTORY AROUND #chan msgid=1234 50
/quote CHATHISTORY TARGETS * * 50
```

Clients that support it (senpai, goguma, Halloy, recent weechat) do this on their
own when you scroll up. Replies come as a `chathistory` **batch**, each message
tagged with `@time` (when it was said) and `@msgid` (what to point at next).

Capabilities offered: `server-time`, `message-tags`, `batch`, `multi-prefix`,
`echo-message`, `draft/chathistory`.

**Where history comes from.** By default the bridge answers from what it has
seen this session — the scrollback fetched from grappa at startup and on each
join, plus everything live since (a thousand messages). That covers the question
a client actually asks on reconnect, and costs nothing.

`--ircd-archive` lets a request reach past it into grappa's stored scrollback.
One rule decides the source, so it stays predictable: **the session's history
answers when it can answer fully, and anything short of that becomes a REST
query.** It is opt-in because that query is not free — one round trip per
request, against a table that can be very large, driven by whatever a client
asks for while someone scrolls.

`msgid=` selectors map exactly: grappa pages on integer message ids, and a
`msgid` IS that id. `timestamp=` has no server-side equivalent, so it is
resolved through the nearest id this session knows and filtered by time after
the fetch — exact where the bridge has seen that stretch of the conversation,
approximate where it has not.

`JOIN`, `PART`, `PRIVMSG`, `NOTICE`, `NAMES`, `WHO`, `WHOIS`, `TOPIC`, `PING`
and the registration commands are handled here. **Everything else is forwarded
to the real server in the words you typed** — `MODE`, `INVITE`, `KICK`, `OPER`,
`LIST` and whatever else that network knows — so anything you can type still
works. Their replies reach grappa's other clients rather than coming back as
numerics, which is the one place this is a bridge rather than a server.

## Panes

`/split` divides the chat area into two stacked panes; `/splitv` (or
`/splitw`) divides it side by side; `/unsplit` closes the focused one. A new
pane opens on the same window it was split from — splitting asks for another
view, and which conversation goes in it is the next thing you say (`/win`,
Ctrl-N).

Each pane scrolls independently, so two panes on the same channel are two
independent views of it. The focused pane's header is accented and marked
`*`, because the input box is nowhere near either header and "where does my
typing go" has to be answerable at a glance.

| key | does |
|---|---|
| `Ctrl-Alt-Up` / `Ctrl-Alt-Down` | move focus between panes |
| `Ctrl-Alt-Tab` | cycle focus |
| `Ctrl-Alt-+` / `Ctrl-Alt--` | grow / shrink the focused pane |
| `Ctrl-Up` / `Ctrl-Down` | scroll the chat one line |

Terminals disagree about what Ctrl-Alt sends, and some send nothing at all
for Ctrl-Alt-Tab (a desktop usually eats Alt-Tab before the terminal sees
it). Both the CSI dialect (`\033[1;7A`) and the ESC-prefix dialect (ESC then
the key) are accepted; `Ctrl-Alt-Up/Down` is the pair to rely on. Run
`/keys` to print the code your terminal actually sends for a key — a
binding that does not fire is then a bug report with a number in it.

### Scrolling past the beginning

A window opens with its last 80 messages, and the client holds **one ring
of 20000 lines shared by every window**. Two different things happen when
you scroll up, and it is worth knowing which is which:

- **Inside the ring**, scrolling is a moving window over what is already
  here. No round trip, however far back you go.
- **At the oldest row the ring holds for that window**, it asks grappa
  for the 80 before it — the same gesture cicchetto pages on, and the
  same `?before=` cursor underneath. Nothing to turn on and nothing to
  type. Pressing `PgUp` in a window already showing everything it has
  counts as reaching the top, so a short window can be paged too.

The new rows land **above** what you were reading, so the view does not
jump — the offset is measured from the bottom, and what arrives arrives
over your head.

Two things stop the fetching, and they say different things:

- The server answers with an empty page. That is the beginning of the
  channel, and the window stops asking for the session.
- The ring fills. The client says `scrollback buffer full (20000 lines) —
  older history stops here` rather than letting you believe you reached
  2019. `/clear` frees it; the bouncer still has everything.

A failed request is neither: it says so and leaves the question open, so
scrolling up again asks again.

**What a frame costs.** A pane measures the rows it is showing, not the
rows it is holding: the draw walks back from the newest and stops as soon
as it has covered the region. That is what let the ring grow — it used to
measure every row in scope, every frame, into arrays as long as the
buffer. Sitting at the bottom of a full 20000-line ring is now cheaper
than sitting at the bottom of the old 2000-line one.

**What the ring costs.** About 26MB of client, ten times the history for
none of the memory: a row keeps a two-byte number for its window instead
of spelling `[azzurra/#sniffo]` out beside itself in a field sized for
the longest name IRC allows. The spellings are kept once, in a table
swept of whatever the rows have stopped referring to.

## The sidebar

Windows are listed by network, and only the network of the window you are IN
is spelled out. Every other network **folds to one row** — `+libera (2)` when
something there mentions you, `+ircnet [7]` for how many lines are waiting,
just the name when nothing is. Click the row and you land on the window in it
that most wants you (a mention first, then unread, then the first one), which
unfolds it: the open network is the focused window's, derived, never stored.

The reason is the roster under the list. With three networks the window list
ate the whole sidebar and the users of the room you were reading were left two
rows or none; windows keep priority over the roster (a channel you cannot see
is one you cannot reach), so the list had to get shorter instead. Window
numbers stay global — `/window 9` reaches a folded window as it always did.

`/set sidebar.collapse off` is the full list.

A network that **joins or leaves the session while shottino runs** — bound
from cicchetto's home, or detached there — appears or disappears here without
a restart. The server announces only *which* network moved (`network_attached`
/ `network_detached`, protocol v28); the listing owns the rest, so shottino
re-reads it, opens the new network's `$server` and channels and subscribes to
them, or closes every window of the one that left. It used to need a restart
to notice either.

## The userlist

`Ctrl-U` hands the arrow keys to the member list; `Esc` gives them back.
While it holds them, `Up`/`Down` move a line, `PgUp`/`PgDn` ten, `Home` and
`End` go to the ends, and anything else — a letter, `Enter`, `Tab` — returns
to the input line and is typed as usual. The header says which mode you are
in (`^U` when the chat has the keys, `↑↓` when the list does).

| key | does |
|---|---|
| `Ctrl-U` | give the arrows to the userlist, or take them back |
| right-click a name | query, whois, ping, block — plus kick/ban where you hold `@` — or type the nick |
| `Ctrl-Shift-Up` / `Ctrl-Shift-Down` | scroll it without changing mode |
| `Shift-PgUp` / `Shift-PgDn` | the same, by ten |
| wheel over the list | scrolls it |
| wheel over the chat | scrolls the pane under the pointer |

The modifier shortcuts are a convenience, not the way in: `Ctrl-Shift-Up` and
`Ctrl-Shift-Down` are the terminal's OWN scrollback shortcut in
gnome-terminal, konsole, kitty and terminator, which keep the key and never
forward it. No client can bind what it is not sent. `Ctrl-U` and plain arrows
are the two things every terminal delivers, which is why the way in is a mode
rather than a modifier.

## Replying

Right-click a message for a menu: reply to it, or open a query with whoever
sent it. `Ctrl-R` opens the same thing from the keyboard — the last 20 messages in the
focused pane's window, newest first. Type to search: the filter matches nick
**or** message text and runs over the window's WHOLE buffer, not just the
twenty on offer, because the point of a search is to reach what is not in
front of you. `Up`/`Down` to choose (the list scrolls under the selection),
`Enter` to reply, `Esc` to cancel.

Replying prefills the input with the address **and a citation of the message
you picked**:

```
alice: «the meeting is at four» 
```

IRC has no threading, so carrying a piece of the original is the only way to
say which message you are answering — and it stays readable in every client
that will see it. The citation is flattened to one line, stripped of
formatting codes, and cut on a word boundary with `…` when the original runs
long: an IRC line is ~450 usable bytes, and the point is to jog a memory, not
to repeat the channel back at it.

Anything already typed is kept after the citation rather than thrown away, and
picking a different message replaces the citation instead of stacking a second
one in front of the first.

Right-click works on a **name in the userlist** too, where the menu offers what
a person can do rather than what a message can: open a query, whois them, ping
them, block them, or type their nick into the input. Replying is offered only
on a message, since it quotes what was said.

**Kick**, **Ban** and **Kick and ban** appear only where they would work: in a
channel, and only while you hold `@` there. **Kill** appears when your own
umodes say you are an IRC operator (`+o`, `+O`, `+a`, `+A`) — read from what the
server told grappa, not from whether you typed `/oper` — and it is offered in
query windows too, since a KILL is network-wide. It PREFILLS `/kill <nick> `
rather than firing: a kill needs a reason, and it should not happen on one
click. The client reads that off the
roster the server sent, so the menu never offers an action the server would
answer with 482.

The menu takes the mouse: the pointer highlights what it is over, a click
chooses it, the wheel walks the list, and a click anywhere outside the box
closes it — the same as Esc. Right-click needs mouse reporting, which is on by
default; `Ctrl-R` works either way.

## Delete for me

The message menu ends with **Delete for me…** on any message grappa stored.
It asks first — the second box puts **Cancel** on top, so `Enter` by reflex
deletes nothing — and then removes the line from this terminal. It is a
**local** removal, like `/block`: grappa keeps the message and every other
device still shows it. The deleted ids are saved in the state directory
(`<key>.hidden`, keyed by server and identity), so the line stays gone after a
restart and whichever fetch would have brought it back.

## Selecting and copying

Drag with the left button over the chat to select **messages**: the rows go
reverse-video as the pointer moves, and releasing copies them, one per line,
without the `[network/channel]` prefix and without colour codes. Only the
window you started in is selected, so the sidebar and the userlist never come
along — which is what the terminal's own Shift-drag does, because it copies
screen lines. A plain click selects nothing; any click dismisses a selection.

The copy goes out as OSC 52, which the terminal itself puts on the clipboard
(kitty, foot, wezterm, alacritty, iTerm2, xterm when allowed — and it works
over ssh), and also through `wl-copy`, `xclip` or `xsel` when one is installed,
for terminals that ignore OSC 52. Shift-drag still gives you the terminal's
selection when you want screen text instead.

## Days and the scrollback cache

A row shows only `HH:MM`, so the chat draws a line where the day changes —
`── Friday 25 September 2026 ──`, in your locale, in the accent colour so it is
not mistaken for the unread divider.

A window's history is read **once**: at startup, or the first time a window
opens. After that the websocket keeps it current and a reconnect fetches only
what came after the last message seen (`?after=`), so switching windows costs
no request at all. `/clear` empties a window and lets the next focus read it
again.

## The settings panel

`/settings` opens it. Every preference `/set` knows is listed there, with its
current value — the rows are **derived from the same table** the command reads,
so the panel cannot show a subset that quietly stops mentioning whatever was
added last.

```
  ↑↓        pick a preference        (when the input line is empty)
  Enter     edit it
  Space     toggle a switch
  right-click  open it: a list of its values, or a field to type one
  PgUp/PgDn scroll, and the mouse wheel
  click     select the row under the pointer
  Esc       back to chat
```

**Right-click a preference** to open it in a modal. A switch or a choice
setting lists the values it accepts, with the one in force marked and
`Up`/`Down`/`Enter` to pick; anything else opens a **text field** holding what
is set now, edited in place — the modal asks the question, so it takes the
answer, rather than sending you back to the input line.

The list is built from the same table `/set` validates against, so it cannot
offer a word the command would reject, and cannot quietly stop offering one
that gets added. A token's field opens **empty**: showing a secret in a box on
screen shows it to whoever is behind you, and saving without typing then clears
it rather than writing back a mask.

**Enter puts `/set <name> <current>` in the input line** rather than running
anything: you see exactly what will happen, you can edit it, and it lands in
command history like anything else you typed. There is one validation and one
save path, not a second one behind the panel. Tokens are never prefilled —
they are shown masked, and writing the mask back would set your token to
`********`.

Panels scroll now. They did not before, and the settings panel is taller than
a terminal, so the bottom of it was simply not drawn.

### /unset, and Tab

`/unset <name>` puts one preference back to what it was **at startup**, before
any config file was read. For a value with no meaningful default — a token, a
URL, a system prompt — that means **clearing** it, and the confirmation says
which value it left behind so you can see which of the two happened. Not to a constant in a table: several defaults are
computed from the machine — inline media follows whether `ffmpeg` is installed,
`stt.local` follows whichever whisper binary is on PATH — so the boot values are
captured once and handed back. `/unset` cannot disagree with the defaults
because it is holding them.

Tab completes both halves of `/set`:

```
/set voice.so<TAB>     → /set voice.source
/set media <TAB>       → on  off  all  first-party
/set mouse of<TAB>     → /set mouse off
/set stt.model <TAB>   → completes to what is set now, for editing
```

Same source as everything else, so what completes is what would be accepted.
A token never completes — a secret must not appear in the input line because
somebody pressed Tab.

### Where preferences are kept

Two files under `~/.local/share/shottino`, both mode 0600:

Everything shottino keeps between runs — these files, the cached tokens, the
block list and the `--ircd` log — lives in one directory: `$XDG_DATA_HOME/shottino`
when that variable is set, and `~/.local/share/shottino` when it is not, which
is what the XDG specification says the fallback is. Setting `XDG_DATA_HOME` is
how a service unit or a container puts that state somewhere other than a home
directory it did not choose; an empty value counts as unset.


| file | holds |
| --- | --- |
| `llm.conf` | `llm.*` — the model transport's own configuration |
| `shottino.conf` | everything else `/set` knows |
| `*.conf~` | the version before the last write |
| `<key>.hidden` | message ids deleted "for me" on one server, one per line |

**Every write keeps the previous version**, and the new file arrives by rename
rather than by truncating in place — so a crash mid-write leaves the old file
intact instead of half a file. Both are written wholesale from memory, which
means anything wrong in memory becomes wrong on disk in one step; that has gone
wrong three times in this client's own history, each time for a different
reason, and each time what was missing was somewhere to look afterwards.

A config **older than the binary** is safe too: a key it does not mention keeps
whatever default the client just set, rather than being zeroed. Adding a setting
used to delete that setting from every existing install, silently, the first
time it read its own config.


Until recently only the first existed, so an STT endpoint, its token, the
capture devices and the three display toggles were set-and-lose while the
panel presented both halves identically. Both halves persist now, and the
short verbs (`/mouse`, `/media`) write the same file `/set` does — a
preference that survives only when you spell it the long way is a preference
nobody can trust.

A field you never set is written as **nothing**, not as the value the listing
displays for it: `stt.local` shows the whisper binary it *found* and `bot.dir`
shows the per-identity path it *derives*, and storing either would freeze a
probe result into an explicit setting — or pin one identity's bot directory
onto every other.

## /llm

Ask a language model, from the client.

```sh
/llm set backend claude-cli          # or: openai
/llm set model  claude-sonnet-4      # openai also needs url + token
/llm <prompt>                        # reply lands in the $llm window
/llm -p <prompt>                     # reply goes to the CURRENT window — everyone reads it
/llm                                 # show the config; the token is masked
```

Two backends. **openai** is any OpenAI-compatible endpoint (`url` + `token` +
`model`). **claude-cli** drives a local `claude` binary headless over pipes —
it needs no url and no token, and shottino does not touch its environment:
it runs under **your own claude login**, the same one your shell uses. Nothing
secret lands in shottino's config at all.

Both backends get the same tools. On openai they go in the `tools` array; on
the CLI they cannot, because `--tools` selects *built-in* tools by name and no
flag registers a function definition. **MCP is the only door**, so shottino
serves one: it re-executes itself as `shottino --mcp-shim`, a stdio MCP server
that advertises the same tool table. Same tools, same handlers, same approval
gate — the shim only *advertises*, and every call is executed here, where the
app state and the gate are.

**The CLI's own tools are not used at all** — `--tools ''`. Everything the model
is offered is implemented in shottino and registered over MCP, so an
openai-compatible endpoint gets exactly the same set. A capability that exists
on one transport and not the other is one nobody can build on, and the CLI's
built-ins never passed shottino's approval gate.

The tools, and whether they are on without asking:

| tool | default | what it does |
| --- | --- | --- |
| `read_scrollback`, `list_windows`, `names` | **on** | read the client's own windows |
| `send_message`, `join_channel`, `part_channel`, `send_ctcp` | **on** (asks) | act on IRC |
| `remember` | **on** (asks) | keep a note for later |
| `web_fetch` | **on** | fetch a URL and return its text, tags stripped |
| `web_search` | **on** | needs `llm.search_url` |
| `read_file`, `glob`, `grep` | off | read this machine |
| `write_file`, `shell` | off (asks) | change this machine; `shell` returns its output |
| `browser_control` | off (asks) | drive a Chrome started with `--remote-debugging-port`; needs `llm.cdp_url` |

`/set llm.tools <names>` names exactly which are offered; empty means each
tool's own default. The write tools still ask the owner every time, and a tool
that is off is not advertised at all — a tool the model cannot see is one it
cannot be argued into trying.

```sh
/set llm.tools                                   # the defaults
/set llm.tools read_scrollback,web_fetch,shell   # exactly these
/set llm.cdp_url    http://127.0.0.1:9222        # for browser_control
```

### web_search, and why not Google

`llm.search_url` is a template with `%s` where the query goes, and it defaults
to **`https://html.duckduckgo.com/html/?q=%s`** — chosen because it is what
answers a plain socket, not out of preference.

Google was tried and measured. `https://www.google.com/search?q=…` returns
**200 with 90 KiB of JavaScript** saying *"please click here if you are not
redirected"* and no results at all; DuckDuckGo's `html` endpoint exists for
readers without JavaScript and returns the results themselves.
`lite.duckduckgo.com` answers 202 with a bot challenge. A client that speaks
HTTP and not DOM cannot do anything with the first two.

Point it wherever you like — a SearxNG instance is the other good answer:

```sh
/set llm.search_url https://searx.example/search?q=%s
/set llm.search_url https://www.google.com/search?q=%s   # will not return results
```

If an endpoint answers with a consent wall or a bot challenge, `web_search`
**says so** rather than handing the model a page about clicking a button — that
failure looks exactly like a search that found nothing, which is the worst
thing a tool can look like.

### shell

`shell` returns what the command printed, **stdout and stderr both**, with the
exit status in front of it. A model given only stdout would be told a failing
command produced nothing. It shares `/exec`'s capture — the same byte bound and
the same timeout — and says when it hit either.

The legacy `llm.cli_tools` setting still exists and still names the CLI's own
built-ins, but nothing is passed to `--tools` any more; leave it empty.

```sh
/set llm.cli_tools WebFetch,WebSearch          # the default
/set llm.cli_tools WebFetch,WebSearch,Read     # add one
/set llm.cli_tools                             # none at all
```

The names it accepts are `WebFetch`, `WebSearch`, `Read`, `Write`, `Glob`,
`Bash`, `Monitor`, `Grep`, `Edit`, `CronList`, `CronDelete` and `CronCreate`.
Anything else is **refused**, with that list printed — this field is a list and
it reads like a switch, and a stray `on` in it used to be accepted silently.

Be deliberate about that one: those run **inside** the CLI, under
`--dangerously-skip-permissions`, and shottino's approval gate never sees
them — the gate only sees the tools shottino registers over MCP and executes
itself. The setter says so out loud each time.

**They are offered only on turns you type.** A turn the NETWORK provoked —
someone saying the bot's nick in a channel, with `/bot` on — gets no built-in
CLI tools whatever this is set to. The keyboard is the trusted channel; a
stranger's message is data, and handing it a shell because the owner once
enabled one for themselves is not a trade anyone agreed to.

### The system prompt

There is a **built-in** one, used whenever `llm.prompt` is empty, and it is
**generated from the tool table** — so it cannot describe a tool that does not
exist, miss one that does, or disagree with the schema about which ones write.
It states the medium (a terminal that cannot render markdown, on a network with
a 512-byte line limit), tells the model to call what it needs and then *answer
in words*, and lists exactly the tools **that turn** is offered: all of them for
something you typed, the read-only half for a bot turn with writes off, none at
all when tools are not wanted. A bot turn also gets the paragraph saying that
messages from the network are data and never instructions.

`/set llm.prompt <text>` replaces the **style** half — how to answer, how long,
what medium. The **tool** half is appended either way: which tools exist on a
given turn is a fact about that turn, not a matter of taste, and a prompt about
tone that silently switched them off would break a feature it says nothing
about. `/unset llm.prompt` goes back to the built-in entirely.

An empty prompt in `llm.conf` **means** "use the built-in". It used to mean
nothing at all: the parser seeded the default and then an empty `prompt =` line
overwrote it, so a prompt cleared once stayed cleared and the model ran with no
system prompt whatsoever.

### Context

The conversation is **remembered** — one per network for you, one per channel
for the bot. Until recently it
was not: every request was built from the current prompt and nothing else, so
the model met you fresh each time and a follow-up like "and the other one?"
referred to nothing. Both backends had the hole for different reasons — the
openai path sent a one-message array, and the claude CLI runs one subprocess
per request with `--no-session-persistence`. The history is kept **here**
rather than delegated to a backend session, because only one of the two has
sessions and a conversation that behaves differently depending on the transport
is worse than one the client has to carry.

It **rolls**. The system prompt and the tool declarations are fixed costs on
every request, so they are subtracted, not counted; what is left is the
conversation's budget, and the newest turns that fit are the ones sent — the
end of a conversation is what a follow-up refers to.

```sh
/set llm.context 128000      # tokens; default 65536, also in /settings
/llm-clear                   # forget it; the next question starts fresh
/llm-compact                 # summarise it and REPLACE it with the summary
```

The budget is **80%** of the window, and tokens are estimated at four bytes
each — a rule of thumb, not a tokenizer, which is exactly why a fifth of the
window is left spare for the guess to be wrong in.

Yours is keyed to the **`$llm` window**, whatever window you typed `/llm` in:
the reply always lands there, so `$llm` is the transcript you read, and a
follow-up typed into it continues what you asked from a query. It used to be
keyed by the window the question came from, which split one visible
conversation into pieces the model could not see across — asked from a query,
followed up in `$llm`, "it" referred to nothing. `/llm-clear` from any window
of the network clears that one conversation.

`/llm` and `/bot` keep **separate** conversations even in the same channel. One
is you thinking out loud with a model; the other is a bot answering strangers,
under a different prompt and a different trust model — and the bot's stays per
channel, because a stranger in one room is not a stranger in another. Letting
either read the other's history would be neither.

It runs on its **own thread**, never the job worker: a model call takes seconds
to minutes, and sharing the worker would park scrollback fetches and sends
behind somebody's prompt. Requests queue (depth 8) and run one at a time.

Config lives in `~/.local/share/shottino/llm.conf`, mode 0600. `/llm set token`
never echoes the value, and the config display masks it to a fixed-width
`********` — showing a prefix, a suffix or even the length leaks something
about a secret. A `-p` reply is capped like `/exec`, and says so when cut.

The `/bot` trust model — network text is data and never instruction, write
tools ask inline unless a (person, tool) pair is pre-approved — is written down
in `llm.h`, next to the code that has to obey it.

## /bot — and how it is kept safe

`/bot on` lets the model answer the network. What bounds it:

- **Network text is data, never instruction.** Inbound messages reach the model
  quoted and attributed, labelled verified-owner or NOT-verified. The only
  unconditional instruction channel is your own input line.
- **The owner is an identity, not a nick.** `/bot owner <nick>` is recognised
  only while that nick is *authenticated to services*, checked from WHOIS
  facts — a bare nick match authorises nothing, because a nick freed by a
  netsplit is anybody's. Unverifiable falls back to local-input-only.
- **It answers the verified owner or a direct mention. Nothing else.** A bot
  that answers every line floods the channel and feeds every stranger's text
  to something that can act.
- **Write tools ask inline**: `/approve`, `/approve always`, `/deny`; silence
  for 60 s denies. `always` records a grant for **that person and that tool**
  — approving alice to speak does not let her make your client join channels.
  `/bot grant|revoke <nick> <tool>` manages them; `/bot show` lists them.
  Grants **persist**, in the same per-identity directory as the notes, mode
  0600: an "always" that forgets at the next restart is not a grant but a
  longer session, and one the owner must re-answer every morning is one they
  learn to answer by reflex.
- **A grant belongs to a person, not to a nick.** It carries the services
  account it was given to and applies only while that nick is identified as
  that account again — the same rule the owner check follows, and for the same
  reason: a nick is borrowed furniture, and approving `alice` once must not
  approve whoever holds `alice` after it expires. A grant given to somebody
  services cannot vouch for is honoured **for the session only** and never
  written down; `/approve always` says which of the two you just gave. Grants
  written before this rule existed are dropped on load rather than migrated,
  with a line saying so — those are exactly the ones that could be inherited. `/bot on` and the owner deliberately do **not**
  persist — a client that starts up already answering the network, to a nick
  it decided was the owner before any WHOIS could confirm it, is not something
  anyone asked for.
- **When writes are off, the write tools are not advertised at all.** A tool
  the model cannot see is one it cannot be argued into trying.
- **`/exec`, `/quote` and the operator verbs are never tools**, at any
  approval level.

### AGENT.md and the notes

```sh
/set bot.dir ~/somewhere        # default: per-identity, under the state dir
/bot memory                     # list the notes
/bot forget <name>              # remove one
```

Put an **`AGENT.md`** in that directory and it becomes the bot's prompt,
re-read on every turn — so editing it takes effect on the next message, not the
next restart. It wins over `/bot prompt`, and `/bot show` tells you which one is
in force rather than leaving you to wonder why an edit did nothing.

The `remember` tool writes short notes as `.md` files under `<dir>/memories/`,
and they are prepended to every later turn. It is gated like a write tool for a
sharper reason than the others: a note is the only thing here that **outlives
the conversation that planted it**, so a stranger who talks the bot into keeping
one has bought influence over tomorrow. They come back labelled as the bot's own
notes, never as instructions from you.

Where all this lives is **per identity**, keyed by (bouncer, account) exactly
like the cached session tokens — several shottinos under one unix user is
normal, and two accounts on one laptop get two bots that cannot read each
other's notes. The same identity opened twice deliberately shares one directory,
so every note is written whole (temp file + rename) and never half-seen by the
other session.

The prompt is mitigation, not containment: a model can be argued into
anything. What contains it is the tool allowlist, the per-pair grant and the
rate limit. The full model is in `llm.h`, beside the code that obeys it.

## Voice and video messages, and speaking instead of typing

```sh
/voicemsg          # or /vmsg — record from the microphone
/video             # record from the camera
/stt               # pick from the audio posted in this window, newest first
/stt <url>         # transcribe a voice message posted in the channel
/stt <file>        # or an audio file on disk — the words land in the WINDOW
/dictate           # speak; the words land in the INPUT LINE, for you to send
```

`/voicemsg` and `/video` open a **modal timer**: Enter ends the recording and
sends it, Esc throws it away. There is no third outcome and no way to leave one
running in the background — an always-recordable client is one nobody trusts.
The recording is uploaded exactly like `/upload` and its **link** is posted, so
IRC stays text; the row leads with 🎤 or 🎥 instead of 📸 so scrollback says
which it was without opening it. Recordings are capped at 300 seconds.

Note `/voicemsg`, not `/voice` — `/voice` is the IRC +v verb and keeps that
meaning.

Nothing blocks the client: the recorder is stopped with ffmpeg's own `q` (a
signal would leave an mp4 with no index — a file nothing plays), the overlay
says *finishing…* while the trailer is written, and the upload happens on the
worker thread. `/upload` moved onto the same path, so a slow network no longer
freezes the client mid-keystroke either.

ffmpeg does the capture. The devices are settings, because there is no portable
answer:

```sh
/set voice.source pulse:default        # ffmpeg format:input
/set video.source v4l2:/dev/video0
```

The two are one engine and one setting, and differ in whose voice it is and
where the words go. Transcribing is reading: somebody else's audio becomes a
line in the window, like any other fact about the conversation. Dictating is
composing: your voice becomes text in the input line, which you check and send.
Putting a transcript of someone else's message into your input line — which is
what the old `/stt` did — is one Enter away from saying their words as your own.

**Right-clicking an audio link** offers `Transcribe it` beside `Play it`.

**Tab cycles through the media in this window** for the verbs that take a URL —
`/preview`, `/view` and `/stt` — newest first, wrapping at the end. `/stt` only
ever offers audio, since a candidate it cannot transcribe is a keypress wasted.
A URL you typed yourself is never replaced: Tab starts a fresh cycle rather
than discarding it.

**Local transcription needs a model file.** `whisper.cpp` will not go looking
for one: with no `-m` it tries `models/ggml-base.en.bin` relative to the working
directory, fails to initialise and exits non-zero having printed nothing useful.
shottino looks in the usual places and otherwise says so plainly:

```sh
/set stt.local_model ~/.local/share/whisper/ggml-base.bin
```

Get one from `huggingface.co/ggerganov/whisper.cpp` — `ggml-base.bin` is a
reasonable start. Audio is converted to 16 kHz mono WAV with ffmpeg first,
since that is the only thing whisper.cpp reads and anything posted in a channel
is an m4a, an ogg or an mp3.

**`/stt` is off by default**, and that is a decision rather than a shrug:
turning it on means audio from this machine may leave it.

```sh
/set stt.enabled on
/set stt.url https://api.openai.com/v1    # audio is SENT here
/set stt.token <bearer>                   # masked, never echoed
/set stt.model whisper-1
/set stt.local whisper-cli                # or leave empty to auto-detect
```

With `stt.url` set, that endpoint transcribes — and if it does not answer, a
local whisper picks up the job, which can only ever be more private than what
you asked for. With `stt.url` empty, a **local whisper** does it from the
start — `whisper-cli` (whisper.cpp) or `whisper` (openai-whisper),
whichever is on PATH, each with its own flags — and nothing leaves the machine.
That is why local is the fallback rather than an afterthought. The setter says
which of the two is in force when you switch it on.

The transcript lands in the **input line**, not on the network: speech
recognition misreads names, and a client that sends what it thought it heard
publishes your mistakes. Read it, fix it, press Enter.

## Calls

```sh
/call              # audio: mint a room, post the link here, open it
/videocall         # the same with a camera
/answer            # join the last call that came in — ringing or not
/hangup            # stop a ring. LOCAL: the caller is not told
```

A call is **a URL somebody posts and somebody else opens**, and that is
deliberately the whole protocol. IRC stays text, everyone else in the channel
sees a line they can read, and shottino is the only client that also treats it
as an event. The marker mirrors what `/upload` already ships:

```
📞 https://meet.jit.si/shottino-4f2c8e01…      audio
📹 https://meet.jit.si/shottino-4f2c8e01…      video
```

**Only a marked line rings.** Ringing at any recognised meeting link would mean
anyone who pastes one — or quotes one, or links a recording of one — makes every
shottino in the room scream. The marker has to *open* the line, and the scheme
has to be http or https, because answering hands the URL to your desktop opener
and a stranger must not be able to put a registered handler one keystroke away.

**Queries ring; channels only announce.** A channel doorbell that any member can
press is a doorbell that gets pressed. The invite still lands in scrollback and
`/answer` still reaches it — `/set call.ring off|queries|all` decides.

**Declining says nothing to anyone.** Declining down the wire would post "no"
into whatever window the invite arrived in, a channel included. The caller
learns you did not join by your not being in the room, the way a call has always
worked.

The room name is 128 bits from the CSPRNG, because a room of this shape is
public to whoever knows its name — **the link is the credential**. Which makes
the honest statement true: a call is exactly as private as the window its link
was posted in, and the ring says which window that was.

`/set call.base_url` defaults to our own SFU, which is the only default that
works **both** ways: the room page for a browser, and WHIP/WHEP under the same
prefix for the terminal. A public jitsi cannot do the second at all — it speaks
XMPP, not WHIP. Any deployment of `web/room.html` + `web/nginx-call.conf` serves
the same shape.

**A second `/call` where one is already running joins it** rather than minting a
second room — otherwise two people end in two rooms, each having told the
channel to come somewhere else. And a call arriving in a query while you are
already in one is answered **busy** in plain text, so the caller is told rather
than left listening to nothing.

Putting the call itself **in the terminal** — audio through the system devices,
video decoded by ffmpeg and drawn as colour art by the renderer that already
draws animated clips — is the next stage, over WHIP/WHEP. What a host has to
provide for it is written down in [docs/CALLS.md](docs/CALLS.md).

## /exec

`/exec <command>` runs it in a shell and **sends its stdout to the current
window** — everyone in the channel sees it. It runs on the worker thread (a
blocking command must never freeze the UI), stdin comes from `/dev/null` so a
command that reads gets EOF instead of hanging, and stderr is discarded.

Output is capped at 20 lines / 16 KiB and the command is killed after 15
seconds; whatever was cut is reported locally, because a channel that saw half
the output must not look like it saw all of it. It refuses in `$server`, which
is read-only server-side.

## Audio

An audio link **never plays on arrival** — it is a clickable link like any
other, and nothing is fetched until you ask. Click it (or `/preview <url>`,
`/view <url>`, or pick the `♪` row from the bare `/preview` / `/view` list) and
it plays out of band: `mpv --no-video`, else `ffplay -nodisp`, else your
desktop's handler. The player runs with stdin, stdout and stderr on
`/dev/null` — output would scribble over the screen, and a player left on the
terminal would eat the keystrokes meant for the compose line.

Recognised: `mp3 m4a m4r aac wav flac ogg oga opus`. That list is deliberately
wider than what `/upload` can send (the server's MIME allowlist refuses
`ogg`/`opus`): sending and playing are different questions. Audio is
classified **before** the `/uploads/` heuristic that otherwise marks anything
this deployment hosts as a picture — an uploaded `.mp3` is audio, not a broken
image.

## Seeing what the socket is doing

Every client push carries the join_ref of the `phx_join` that opened its
channel — Phoenix discards a frame whose join_ref does not match, silently, so
this is the difference between a verb that works and one that vanishes.
`ws_v2_frame` is the only place a frame is built.

Websocket framing lives in `ws.c`: bytes in, whole messages out. It is a buffer
rather than a read because a frame does not arrive in one piece — an incomplete
one consumes nothing and waits for the rest. It reassembles messages split
across frames, answers PING with PONG, and tolerates a masked frame from a
proxy. `test_ws` feeds every case a byte at a time, which is the only way that
property gets tested at all.


`/wire` echoes websocket traffic: `wire -> whois (network_id=7)` when a verb
goes out, `wire <- event kind=whois_bundle` when an answer comes back, and the
topic of every join. It logs frames by NAME only — never their payloads, which
carry the `/oper` password and every `IDENTIFY` typed through `/quote`. `/wire`
again stops it.

It exists for one question: when a command "does nothing", did it reach the
server, and did the server answer? That was unanswerable from inside the client.

### Which protocol this speaks

The upgrade URL declares `client_proto=<N>`, where `N` is `WIRE_PROTOCOL_VERSION`
in `wire.h` — `Grappa.Protocol`'s number at the time these parsers were last
taught the wire. Below the server's floor the handshake answers 426 and the log
says so as "this shottino is too old", which is a different repair from the 403
a bad bearer earns. Omitting the parameter is legal and means "current", which
is what shottino used to do — a claim a client last taught the wire at v21
cannot make.

At first contact `GET /api/config` is compared against that number and one line
says which way the gap runs. A newer server is not an error — the wire is
additive — but whatever it grew since is what this build will not show, and
the line names that rather than leaving "cicchetto has it and shottino does
not" to a code read.

The number is pinned to `lib/grappa/protocol.ex` by `test_commands`: when the
server bumps, the test reddens, and whoever bumps it reads what moved (`git log
-p lib/grappa/protocol.ex`), teaches `wire.c` the new fields or decides a
terminal does not care, and moves the constant. Nine bumps went by unnoticed
before that pin existed.

**A matching integer is not the contract, though**, and the 2026-09-22
architecture review measured that: five pieces of the wire had drifted under a
green pin, two of them closed sets that made shottino drop an event whole. So
two more gates sit beside it, and they compare the thing rather than a number:
the **closed sets** (`connection_state`, the server-reply sources) are pinned
to the Elixir that declares them, value by value and in order, because the C
enums are ordinal; and **every event kind cicchetto narrows must be known to
`wire.c`**. A kind a terminal has no use for — a peer's avatar — is still
narrowed and dropped on purpose, so the unrecognised-kind path keeps meaning
"the server grew something nobody here has looked at".

## Tests

```sh
make check
```

Builds and runs every suite. The pure modules — the JSON reader, the wire
narrowers, alias expansion, mIRC formatting, and colour quantisation — are
deliberately kept free of app state and terminal state so they can be tested
without a TTY. Suites build with ASan and UBSan; override `SANITIZE=` on a
toolchain without the sanitizer runtime.

## Install from source

```sh
./configure --prefix=/usr/local
make
make install
```

## Run

```sh
frontends/shottino/shottino --user https://grappa.example.net USER
```

It asks for the password. Or put it in the environment, which is what a
service file wants:

```sh
SHOTTINO_PASSWORD=... frontends/shottino/shottino --user https://grappa.example.net USER
```

Or use an explicit grappa login email unrelated to the IRC nickname:

```sh
frontends/shottino/shottino --user --login-email user@example.net https://grappa.example.net
```

**Don't put the password on the command line.** It still works, and it still
warns you, because breaking every existing invocation over it would be its own
outage — but for as long as the client runs it is readable by every other user
on the host through `ps` and `/proc/<pid>/cmdline`, and your shell has already
written it to history. The order is: the argument if you insist,
`SHOTTINO_PASSWORD` if not, and a prompt if neither.

Auth modes:

- `--user` logs in as a registered grappa user. Plain `USER` is sent as
  `USER@shottino.local` because grappa's current account classifier routes
  email-like identifiers to user login and uses the local part as the account
  name.
- `--login-email EMAIL` uses `EMAIL` as the grappa login identifier. The IRC
  nickname remains the one configured in grappa's network credential; it is not
  derived from the email.
- `--visitor` logs in through grappa's visitor nick flow.
- `--auto` preserves the server's default classifier behavior.
- `--share https://grappa.example.net/share/<token>` consumes a visitor
  session-share link instead of logging in. Both the server origin and the token
  are read from the URL; no identifier or password is needed.

Use `--user` for multi-machine reattach. The user subject is durable on the
server, so channels/query windows/scrollback state are shared across clients.
Visitor mode needs the saved bearer token to reattach without spawning a new
visitor session.

## Visitor session sharing

Visitors have no password, so a registered-user login on a second device is not
available to them. The share link closes that gap — it lets a visitor attach
another device to the *same* session (shared scrollback and state):

1. On the first device (any visitor client, e.g. cic or a shottino visitor
   session), run `/share`. Shottino mints a short-TTL link
   `https://<host>/share/<token>` via `POST /me/share-token` and prints it.
   `/share` is visitor-only; a registered user gets a friendly rejection.
2. On the second device, run
   `shottino --share https://<host>/share/<token>`. Shottino consumes the token
   (`POST /auth/share/consume`), mints a fresh per-device session for the same
   visitor, and saves the bearer so subsequent launches reattach without
   re-consuming the (one-shot, already-spent) link.

Key bindings:

- `Enter` sends the input line to the current window.
- `Tab` completes commands, windows, networks, and known nicks.
- `Up` / `Down` browse input history.
- `PageUp` / `PageDown` scroll the active chat buffer.
- `Ctrl-N` / `Ctrl-P` cycle windows.
- `/help` lists supported commands.

Media link previews:

- **Inline media is on for every host by default**, and off entirely when
  `ffmpeg` is not installed — it decodes every picture and clip, so a default
  that promised pictures without it would deliver "[image could not be decoded]"
  on every row.
- **Know what that costs.** An inline picture is *fetched* when its row scrolls
  into view — no click, no confirmation. So any URL any stranger posts becomes a
  request from your machine the moment you read past it: **that host learns your
  IP address and roughly when you read the channel**, which is a working
  tracking pixel in a text-only IRC client. It also hands bytes of their
  choosing to ffmpeg's demuxers.
- That is a deliberate trade, not an oversight: a client whose pictures mostly
  do not appear is a client whose picture feature does not work, and this is a
  single-user terminal client rather than a default imposed on strangers. If you
  would rather not pay it, `/media first-party` limits fetching to your own
  deployment's uploads and `/media off` stops it entirely. shottino says which
  of the three is in force every time it starts.
- **Click a window in the sidebar** to switch to it. The whole row is the
  target, number included — aiming at a channel name in a 14-column sidebar is
  finicky, and there is nothing else on the line to hit by accident. It goes
  through the same verb `/window` uses, so the unread reset and the read cursor
  happen exactly as they do from the keyboard.
- `/preview` opens a picker over the last 20 pictures and clips posted in this
  window, newest first, each URL once — type to filter, `Enter` to open, `Esc`
  to cancel. `/preview <url>` skips the list. Press any key to return to the
  chat.
- `/view` offers the same list but hands the file to the DESKTOP: it downloads
  it and opens whatever your system uses for that file type. This is what
  `/open` cannot do — `xdg-open` on a URL picks the handler from the *scheme*
  and so always opens a browser; picking it from the file type means having the
  file. Downloads go to a temporary directory that is removed when shottino
  exits.
- Hovering an image or video link shows a `click to preview:` hint and
  left-clicking opens the same preview (mouse tracking, on by default).
- A terminal with a graphics protocol (Kitty, iTerm2, Sixel, WezTerm) shows a
  real bitmap. **Every other terminal gets coloured character art instead** —
  the frame is rendered as half-block glyphs, two pixels per cell, in truecolor
  or 256 colours depending on what the terminal advertises, degrading to a
  luminance ramp where there is no usable colour. Only `ffmpeg` is required;
  `chafa` is used when installed but is not needed.
- Sixel support cannot be probed reliably. Set `SHOTTINO_GRAPHICS=1` to force
  the bitmap path on a terminal you know supports it.
- **Mouse tracking is ON by default**: click a link, right-click a message,
  scroll the userlist with the wheel. The cost is the terminal's own click-drag
  selection, because the terminal forwards button and motion events to shottino
  instead of selecting — **hold Shift to select text as usual**, which works in
  xterm, vte (gnome-terminal), konsole, kitty, alacritty and iTerm2. `/mouse
  off` gives selection back unconditionally and turns click-to-preview off with
  it; bare `/mouse` toggles. Everything reachable by mouse is also reachable by
  keyboard (`/preview`, `Ctrl-R`, `Ctrl-U`), so turning it off costs no
  features.

## Commands

`/help` lists every verb. Beyond the basics:

- **Channel ops** — `/op` `/deop` `/voice` `/devoice` `/kick` `/kb` `/ban`
  `/unban` `/banlist` `/invite` `/mode [#chan] +modes [params]`
- **Server info** — `/whois` `/whowas` `/who` `/names` `/lusers` `/links`
  `/motd` `/info` `/version` `/stats [query]` `/rehash [opt]`

  Their answers land in the window you asked from, and stay filed there: switch
  away and they do not follow you, switch back and they are still there.
- **Operator** — `/kill` `/kline` `/unkline` `/wallops` `/globops` `/locops`
  `/trace` `/squit` `/sconnect` `/die` `/restart`. None of these grant anything:
  they are raw lines, `/quote` could always send them, and the ircd's O:line is
  what decides. What the verbs add is tab-completion, a `/help` topic that
  states the arguments, and one place where the argument shapes are written
  down — `KILL nick :reason`, `KLINE [seconds] mask :reason`, `WALLOPS :text`.
  A verb missing a required argument prints its usage instead of sending a line
  the server would only reject, and what did go out is echoed into the window
  you typed it in. `CONNECT` is spelled `/sconnect` because `/connect` already
  means "connect a network" here. `/die` and `/restart` have no confirmation
  step.
- **People** — `/ctcp <nick|#chan> <VERB> [args]` sends any CTCP query (VERSION,
  TIME, FINGER…); the verb upcases, the arguments go verbatim, and the reply
  lands as a card in the window you asked from. `/ping <nick>` is the timed
  special case.
  The answer is matched against the pings still outstanding, so it reports
  correctly whether it arrives live or turns up when the query window's
  scrollback is backfilled; one that never arrives is reported as such after
  30 seconds rather than silently forgotten. An inbound CTCP query (somebody
  pinging *you*) is shown as `--- CTCP PING from nick`, not as the raw control
  characters it is on the wire. **shottino does not ANSWER a CTCP query** —
  that belongs to the bouncer, which is awake when no client is attached, and
  grappa currently answers VERSION only. Until it answers PING, a ping aimed at
  your own session (including pinging yourself) will not come back.
  `/block [nick]` (`/ignore`) hides somebody's messages **in this client
  only** — nothing is sent to the server, they keep talking, grappa keeps
  storing it, and the PWA on your phone keeps showing it. Bare `/block` lists
  who is blocked; `/unblock <nick>` (`/unignore`) lifts it. The list lives in
  `~/.local/share/shottino/blocked` and survives a restart.
- **Files offered to you** — grappa receives `DCC SEND` and never dials until
  a human says so, so an offer arrives as a line in the window the server
  names (usually `$server`, since a CTCP from a stranger opens no window) and
  waits: `alice offers a file: holiday.jpg (12345 bytes)`. Bare `/dcc` lists
  what is being held; `/dcc accept <nick|id>` takes one — *admitted*, not
  arrived: the file lands later as a 📥 link in scrollback, or a server line
  says why not; `/dcc ignore <nick|id>` lets it lapse and **sends nothing to
  the peer** — no `DCC REJECT`, which would tell a stranger the nick is online
  and a human read them. An offer expires on its own, and a decision taken on
  any device takes the line's meaning down here. `/dcc auto on|off` is the
  per-network standing consent: files from people you already talk to on that
  network are taken without asking; a stranger's offer still asks. The
  download link carries no auth — whoever holds it fetches the file, exactly
  as for an upload.
- **Watching** — `/notify [nick…|del nick|list]` watches *people*;
  `/hilight <pattern>` and `/dehilight <pattern>` watch *words*. Different
  lists, despite the shared irssi heritage.
- **Services** — `/cs` `/ns` `/ms` `/os` `/hs` `/rs`; the bare form sends HELP.
- **Aliases** — `/alias <name> <expansion>` with `$1`…`$9` and `$*`; an
  expansion containing no placeholder gets the arguments appended. An alias
  may shadow any built-in except `/alias` and `/unalias` (#427), which stay
  reachable so a shadow can always be undone. `/unalias <name>`, bare
  `/alias` lists.
- **Files** — `/upload <path>` posts a file and shares its link. IRC stays
  text: the link is a clickable URL, never an inline embed.
- **Directory** — `/list [query]` browses the channel directory,
  `/list -refresh` starts a new background scan.
- **Archive** — `/archive` lists archived windows, `/archive open <target>`
  reopens one, `/archive purge <target>` deletes its history.

## Diagnosing a missing or misplaced line

A scrollback row's height is computed twice — once to size the scroll
region, once to draw it — and every "a line went missing" bug so far has
been those two disagreeing. The screen shows you the symptom, not which
pass was wrong, so shottino can dump both:

```sh
SHOTTINO_LAYOUT_LOG=/tmp/shottino-layout.log shottino …
```

Reproduce the problem, quit, and read the last frame. Each row shows its
reserved height (`h`), its text-only height (`text`), and any attached
image with its decode state. The `END` line shows the scroll budget:

```
   row=13 h=11 text=1 media=0 READY :: [net/#chan] <bob> pic https://…
   row=14 h=1  text=1 media=-1      :: [net/#chan] <carol> the next message
   END max_off=9 skip=9 used=18/18 drawn=8/17
```

`used` greater than the region height is flagged `*** OVERFLOW ***` and
means the budget was exceeded — the bottom of the buffer got clipped.
The log is written only when the variable is set.

## Window state

A window is identified by its **folded** name, so `#Chan`, `#chan` and `#CHAN`
are one window and not three — as are `Alice` and `alice`. The fold is the
ircd's: ASCII, `A-Z` only, which leaves `[ ] \ ~` alone (bahamut advertises
`CASEMAPPING=ascii`, so `foo[1]` and `foo{1}` are two different people, and
`#CAFÉ` is not `#café`). The window keeps whatever spelling it was first
opened with; only the matching folds.

Traffic addressed to the network's own name — azzurra's ircd sends its global
notices from a source spelled `AzzuRRa` — is the server talking, and lands in
that network's `$server` window rather than opening a tab named after the
network.

Windows mirror the server's state machine and shottino never originates a
transition. A non-joined window is greyed with a marker — `.` joining, `?`
invited, `!` join failed, `x` kicked, `~` network parked — and the status line
says why (`kicked by op: flooding`, not just an inert window). An invite
declined from any client (`window_invite_declined`) closes the `?` tab here,
which is the banner's terminal form; a window you are actually in under that
name is not touched.

If the server **severs the web session** — you sent past the flood ladder's
429s — the sidebar reads `severed` instead of a reconnect countdown. This is
not a netsplit: the bouncer keeps you on every channel, but this client's login
is revoked, so the cached token is deleted and shottino stops reconnecting
(every retry would be a 403 on a backoff). Restart it to sign in again.

Unread state is server-owned per (subject, network, channel): reading a window
here moves the cursor for every device attached to the same session, and the
`unread` divider marks where you left off no matter which client you were using.
