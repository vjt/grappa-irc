# shottino

Standalone Linux terminal client for grappa's REST + Phoenix Channels surface.

Shottino is intentionally a terminal facade over grappa's JSON API. It does not
parse IRC and does not connect to upstream IRC servers.

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

- `chafa` — renders the preview, auto-detecting the terminal graphics protocol
  (Kitty, iTerm2, Sixel, or Unicode symbols).
- `ffmpeg` — fetches and decodes the linked image/video into a single frame.

If either is missing, clicking a media link falls back to opening it with
`xdg-open` and logs a one-line hint.

## Install

```sh
./configure --prefix=/usr/local
make
make install
```

## Run

```sh
frontends/shottino/shottino --user https://grappa.example.net USER PASSWORD
```

Or use an explicit grappa login email unrelated to the IRC nickname:

```sh
frontends/shottino/shottino --user --login-email user@example.net https://grappa.example.net PASSWORD
```

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

- Moving the mouse over an image or video link shows a `click to preview:`
  hint on the chrome line.
- Left-clicking the link opens a full-screen preview (a still frame for video);
  press any key to return to the chat.
- Requires `chafa` + `ffmpeg` on `PATH` and a graphics-capable terminal; without
  them the link opens via `xdg-open` instead.
- While shottino runs, mouse reporting is enabled, which suppresses the
  terminal's native text selection (Shift-drag still works in most terminals).
