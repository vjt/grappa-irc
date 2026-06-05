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

## Install

```sh
./configure --prefix=/usr/local
make
make install
```

## Run

```sh
tools/shottino/shottino --user https://grappa.example.net USER PASSWORD
```

Or use an explicit grappa login email unrelated to the IRC nickname:

```sh
tools/shottino/shottino --user --login-email user@example.net https://grappa.example.net PASSWORD
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

Use `--user` for multi-machine reattach. The user subject is durable on the
server, so channels/query windows/scrollback state are shared across clients.
Visitor mode needs the saved bearer token to reattach without spawning a new
visitor session.

Key bindings:

- `Enter` sends the input line to the current window.
- `Tab` completes commands, windows, networks, and known nicks.
- `Up` / `Down` browse input history.
- `PageUp` / `PageDown` scroll the active chat buffer.
- `Ctrl-N` / `Ctrl-P` cycle windows.
- `/help` lists supported commands.
