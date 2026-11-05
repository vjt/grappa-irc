# Grappa distro packaging (self-hosting Part 2)

Builds native Linux **`.deb`** and **`.rpm`** packages for grappa from a
`mix release` + the built cicchetto SPA, via
[nfpm](https://nfpm.goreleaser.com/). The release bundles Erlang/OTP, so
the target host needs **no Elixir/mix toolchain** — install the package,
set one hostname, start the service.

This is the packaging **substrate** (`build.sh`, the FHS layout, the
maintainer scripts, the openssl secret bootstrap, the migrate command) +
its nfpm **renderers** (`.deb` and `.rpm`, selected by
`GRAPPA_PKG_FORMAT`). The substrate is format-agnostic; Arch/AUR and the
tag-driven release CI ship it too — see **Building the `.rpm`** and the
shipped list below.

## FHS layout

| Path                                   | What                                                        |
| -------------------------------------- | ---------------------------------------------------------- |
| `/usr/lib/grappa/`                     | the mix release (self-contained ERTS + compiled app)       |
| `/usr/lib/grappa/bin/grappa`           | the release boot script                                    |
| `/usr/bin/grappa`                      | operator CLI wrapper (sources env, drops to `grappa` user) |
| `/usr/share/grappa/cicchetto-dist/`    | built SPA (`CIC_DIST_ROOT`), served by the BEAM            |
| `/usr/share/grappa/grappa.env.example` | env template                                               |
| `/usr/share/grappa/gen-secrets.sh`     | openssl secret generator                                   |
| `/usr/lib/systemd/system/grappa.service` | systemd vendor unit                                      |
| `/etc/grappa/grappa.env`               | secrets + `PHX_HOST` (created on first install, `0640`)     |
| `/var/lib/grappa/`                     | state: `grappa.db`, `uploads/` (owned by `grappa`)         |

The `grappa` system user (nologin, home `/var/lib/grappa`) is created by
the package.

### The terminal client

`shottino` (`frontends/shottino`, C + ncurses) has **its own package**,
built from `nfpm-shottino.yaml` (GH #1447).

It used to ship only inside the bouncer package, and the reason written
here was that splitting it "would add a second thing to maintain and buy
nothing: it is a client for the server you just installed." **That premise
was wrong, and the host it is wrong about is the ordinary one:** a machine
that wants to *talk to* a grappa somewhere else is not the machine running
it. Today that user has to take a self-contained ERTS and a built SPA —
37.0 MB of `.deb` at v1.2.0, essentially none of which the client uses —
and `postinstall.sh` enables a systemd unit they never asked for. The
client is one C binary against ncursesw and OpenSSL. A second yaml is a
smaller price than that.

The standalone package is deliberately thin: **one file**, no maintainer
scripts, no system user, no unit, and none of the bouncer's ERTS-side
dependencies. It carries the WIDE `libncursesw6` (NOT the `libncurses6`
ERTS wants — Debian ships them separately; Fedora folds both SONAMEs into
`ncurses-libs`), OpenSSL, and `ca-certificates`, because the client calls
`SSL_CTX_set_default_verify_paths()` and verifies with `SSL_VERIFY_PEER`.

It keeps **its own version line** — `frontends/shottino/version.h`, read by
`version.sh shottino` — rather than the grappa tag. Two artifacts, two
cadences: `shottino --version` and the package version agree, which they
could not if the package were stamped with a bouncer release number.

Its metadata takes `/usr/bin/shottino` over from the bouncer with
`Replaces:` / `Breaks: grappa (<< 1.3.0~)` (nfpm maps `replaces` to RPM's
`Obsoletes`). That boundary is historical — the first release that stops
shipping the file — so it is written as a constant and must not become
`${GRAPPA_VERSION}`: at 1.4.0 that would assert grappa 1.3.0 shipped a file
it did not. `deb.breaks` is also absent from nfpm's env-expansion list, so
an interpolation there reaches the control file verbatim.

**The trailing `~` is part of the boundary, not punctuation (#1594).** nfpm
stamps a `1.3.0-rc1` VERSION file as `1.3.0~rc1`, and `~` sorts below the
empty string in both dpkg and rpm ordering — so a bare `1.3.0` boundary
captures 1.3.0's own release candidate, and cutting `v1.3.0-rc1` made the
two packages mutually uninstallable (apt 100, dnf 1). `1.3.0~` means
"everything strictly before 1.3.0, its pre-releases excluded". Any future
`X.Y.Z` boundary written as a constant has the same hole and is written
`X.Y.Z~`.

### `pkgversion.sh` — the version nfpm stamps

`version.sh <component>` answers *which file carries the number*.
`pkgversion.sh <deb|rpm> <component>` answers *what the packager writes
down*, and the two differ for any pre-release. The release workflow asserts
all four packages (bouncer + client, deb + rpm) against it; before #1594 the
bouncer's stamped number had no assertion in either format, so a restamp was
invisible. The map (first `-` → `~`, and on rpm every further `-` → `_`) is
measured against the pinned nfpm 2.43.0 — the table is in the script header
and in `docs/DESIGN_NOTES.md` under #1594.

**Where the split stands.** Done, in both halves at once. The bouncer
package no longer ships `/usr/bin/shottino` — it is out of `nfpm.yaml`'s
`contents:` and out of the AUR bouncer recipe — and the standalone package
is **published** from `dist-shottino/`, through an upload step of its own
rather than a glob over a shared directory. The two halves had to land
together: dropping the file alone takes the client away from everyone who
has it, and publishing alone ships a pair that cannot be co-installed.

**The upgrade path is `Recommends:`, and it is not decoration.** The file
leaves the bouncer package in 1.3.0, so without a pointer `apt upgrade`
would delete `/usr/bin/shottino` from every host that has it today and pull
nothing back. apt installs Recommends by default and dnf installs weak deps
by default, so on both the replacement arrives in the same transaction.
**pacman has no equivalent**, so the Arch recipe uses `optdepends`, which is
advisory by construction — an Arch user is told where the client went and
installs it deliberately. That difference is pacman's, not a choice made
here.

**Two AUR recipes, not one split package.** `aur/PKGBUILD` is the bouncer,
`aur/shottino/PKGBUILD` the client, and the reason is a constraint rather
than a preference: `PKGBUILD(5)` § PACKAGE SPLITTING lists the variables a
`package_*()` function may override and `pkgver` is not among them, so a
split would stamp the client with the bouncer's number — the exact
disagreement the own-version-line ruling above forbids. The client recipe
therefore carries two sentinels: `pkgver=@SHOTTINO_VERSION@` from its own
carrier, and `_grappaver=@GRAPPA_VERSION@` naming the tag whose tarball
holds the source. `aur/regen.sh` fills both and regenerates both
`.SRCINFO`s; `test/grappa/version_single_source_test.exs` pins all of it.

Since #1591 the **bouncer** recipe carries `_grappaver` too, for a
different reason: `makepkg` refuses the hyphen a semver pre-release spells
its suffix with, so `aur/pkgver.sh` maps `1.3.0-rc1` onto `1.3.0rc1` and
`pkgver` stops being the tag. There it is a different SPELLING of the same
number; in the client recipe it is a different number. Both recipes route
their `pkgver` through the mapper, which is the identity on a bare
`X.Y.Z`. Why that spelling and not the Arch-conventional underscore — a
measured ordering property, not taste — is in `aur/pkgver.sh`'s header and
`docs/OPERATIONS.md` § "A pre-release `VERSION` and the Arch `pkgver`".

Both halves are pinned by `test/infra/packaging_shottino_pkg_test.bats`,
and the release audit (`release_assets.sh`) now expects the client's
packages **by name** — a release that builds the bouncer and loses the
client fails loudly instead of publishing a set that looks complete.

Every package builds the client from source so it links the build host's
ncurses/openssl, the same constraint that governs the ERTS payload.
`SKIP_SHOTTINO=1` opts both the build and the client package out; without
that opt-out a failed client build FAILS the package build, because a
package that silently ships without a binary it advertises is worse than
one that refuses to build.

The build **prints the binary's size** (`==> shottino binary: N bytes`)
instead of recording it here. This paragraph carried "one ~180 KB binary"
for a long time with nothing behind it; a number in prose goes stale in
silence, while one in the build log is always that build's, on that host.

`build.sh` snapshots and restores `config.mk` around `./configure`:
that file is tracked, and leaving it modified makes the tree dirty, which
`Grappa.Version` reads as unreleased (`-<shortsha>` instead of the bare
tag) and would fail the release workflow's version proof.

## Building the `.deb`

The build needs Elixir 1.19 / OTP 28 **on glibc** (not the alpine dev
image — musl ERTS will not run on a Debian/Ubuntu target) plus `bun`.

### Locally, in an isolated container

Runs in a throwaway container with its own `_build`, so it never touches
the dev compose stack's shared `_build`:

```sh
docker run --rm -v "$PWD:/src" -w /src elixir:1.19-otp-28 bash -c '
  apt-get update -q && apt-get install -y -q --no-install-recommends curl unzip &&
  curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH" &&
  infra/packaging/build.sh'
```

The `.deb` lands in `./dist/`.

### In CI (R3)

The tag-driven release workflow
([`.github/workflows/release.yml`](../../.github/workflows/release.yml))
runs `build.sh` on a `setup-beam` runner (Elixir 1.19 / OTP 28) with `bun`
installed, **installs** the built `.deb` (so postinstall's openssl secrets +
packaged migrate run for real), asserts the migration count and that the
artifact reports the bare `X.Y.Z`, then uploads `dist/*.deb` to the GitHub
Release. `build.sh` downloads a pinned nfpm if it is not on PATH.

**The glibc floor is Debian trixie (13), and CI proves it (#2553).** The
bundled ERTS and `shottino` link the glibc of the runner that builds them,
so both `deb` legs run on one PINNED Ubuntu release (`ubuntu-24.04` /
`ubuntu-24.04-arm`), never `ubuntu-latest` — that label moved to 26.04 and
the amd64 packages of 1.6.1 and 1.6.2 needed `GLIBC_2.43`, which no Debian
stable carries. Before uploading, the job also runs
[`deb_floor_proof.sh`](deb_floor_proof.sh): both packages installed on a
stock `debian:trixie`, the BEAM and the client started there. So the `.deb`
is proven on Ubuntu 24.04 and Debian 13, the two installs CI performs;
bookworm (glibc 2.36) and Ubuntu 22.04 (2.35) are not supported. Run the
floor proof locally against any built pair:

```sh
infra/packaging/deb_floor_proof.sh debian:trixie dist/grappa_*.deb dist-shottino/shottino_*.deb
# a foreign-arch pair: prefix DOCKER_DEFAULT_PLATFORM=linux/amd64
```

## Building the `.rpm`

Same substrate, same `build.sh` — set `GRAPPA_PKG_FORMAT=rpm`. The ONLY
hard constraint is the **payload**, not the packager: the release bundles
its own ERTS + the crypto/exqlite NIFs, all linked against the *build
host's* glibc/libssl. A Debian-built payload is a valid `.deb` and an
`.rpm` that installs cleanly and then dies at boot on Fedora. So the
`.rpm` **must** be built inside a Fedora userland with Fedora's own
Elixir/OTP:

```sh
docker run --rm -v "$PWD:/src" -w /src fedora:43 bash -c '
  dnf install -y --setopt=install_weak_deps=False \
    elixir erlang git gcc make pkgconf-pkg-config ncurses-devel \
    openssl-devel tar gzip unzip findutils sqlite openssl util-linux &&
  curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH" &&
  GRAPPA_PKG_FORMAT=rpm infra/packaging/build.sh'
```

The `.rpm` lands in `./dist/`.

- **Fedora's own toolchain, never setup-beam.** `erlang` is Fedora's
  full-OTP metapackage. Like Arch (#527), Fedora splits OTP into per-app
  subpackages, and `mix release` needs the whole transitive app tree
  (`public_key`/`ssl`/`inets`/`runtime_tools`) at build time — so pull the
  meta, don't rely on `elixir`'s dep chain and don't enumerate subpackages
  (that list drifts as deps add OTP apps).
- **Per-format deps live in `nfpm.yaml` under `overrides.{deb,rpm}`** —
  one config, no duplicate file. The RPM names are the Fedora/RHEL twins of
  the Debian SONAME deps (`openssl-libs`, `ncurses-libs` — one package for
  both the narrow + wide ncurses, unlike Debian's split —, `libstdc++`,
  `libgcc`, `ca-certificates`, `shadow-utils`).
- **The maintainer scripts handle both arg conventions.** dpkg passes a
  string `$1` (`configure`/`remove`/`purge`); rpm passes a number
  (`1`/`2` install/upgrade, `0` uninstall). `scripts/*.sh` branch on both,
  so `%post`/`%preun`/`%postun` actually run on rpm (a deb-only
  `case $1 in configure)` would silently no-op → a package that installs
  and does nothing).
- **Fedora-family only.** A Fedora-built ERTS is NOT automatically valid
  on RHEL/Rocky/Alma (older glibc). The CI `rpm` job pins the *oldest
  still-supported* Fedora carrying Elixir 1.19 (glibc is
  backward-compatible, so the oldest floor = widest validity), and
  RHEL-family is explicitly out of scope. Widening that is a future matrix
  entry (a manylinux-style oldest-glibc build), not a one-line bump.

In CI the tag-driven release workflow's `rpm` job does exactly the above
in a pinned `fedora:43` container, `dnf install`s the built `.rpm` (so
`%post`'s openssl secrets + packaged migrate run for real), asserts the
migration count + the bare `X.Y.Z` + that shottino links Fedora's libs,
then uploads `dist/*.rpm` to the Release.

## Installing

```sh
sudo apt install ./grappa_<version>_<arch>.deb
sudoedit /etc/grappa/grappa.env          # set PHX_HOST=your.host
sudo systemctl start grappa
curl http://127.0.0.1:4000/healthz
```

`postinstall` creates the state dirs, copies the env template, generates
the secrets (openssl), runs migrations, seeds the built-in theme gallery
(#1167 — the palettes ship compiled into the release, but the gallery
reads the DB, so the package has to unpack them itself), and **enables
but does not start**
the service (it cannot start until you set a real `PHX_HOST`).

## First user

```sh
sudo grappa create-user you --admin
# password for you: (typed, not echoed)
```

No running node needed — this is the first-run door, so it opens the
database itself (#1158). `--admin` grants the operator bit in the same
command; without a password flag the password is read from the terminal,
so it stays out of shell history and out of the process table.

Give that account a network the same way:

```sh
sudo grappa add-network you azzurra \
  --server irc.azzurra.chat:6697 --nick you --auth sasl --autojoin '#grappa'
sudo grappa remove-network you azzurra   # the undo
```

An account alone cannot connect: a network needs at least one enabled
server, which is why `add-network` creates the network and the server
when they do not exist yet, and refuses rather than write access that
would fail at spawn time.

## Managing

```sh
sudo grappa migrate        # apply pending migrations (no mix needed)
sudo grappa seed-themes    # (re)materialise the built-in theme gallery
sudo grappa gen-secrets    # (re)generate missing secrets in the env file
sudo grappa version        # release version
sudo grappa remote         # IEx into the running node
sudo systemctl status grappa
journalctl -u grappa -f
```

Rotate a secret: reset it to `REPLACE_ME` in `/etc/grappa/grappa.env`,
run `sudo grappa gen-secrets`, then `sudo systemctl restart grappa`. Back
up `GRAPPA_ENCRYPTION_KEY` separately — it encrypts stored IRC
credentials at rest; losing it makes them unrecoverable.

## Secrets model

A packaged host has no mix, so `gen-secrets.sh` generates everything with
**openssl only**, matching the mix generators' shapes byte-for-byte:

| Var                     | How                                                            |
| ----------------------- | ------------------------------------------------------------- |
| `SECRET_KEY_BASE`       | `openssl rand -base64 48`                                      |
| `SECRET_SIGNING_SALT`   | `openssl rand -base64 32`                                      |
| `RELEASE_COOKIE`        | `openssl rand -hex 32`                                         |
| `GRAPPA_ENCRYPTION_KEY` | `openssl rand -base64 32` (≡ `Base.encode64(rand_bytes(32))`)  |
| `VAPID_*`               | `openssl ecparam prime256v1` → base64url(65-byte point / 32-byte scalar) |

This keeps first-boot secret generation **off** the release `eval` path.

## Caveat — the migrate/eval proof

`grappa migrate` reaches `Ecto.Migrator` via
`bin/grappa eval 'Grappa.Release.migrate()'` — the same migrator the
FreeBSD/Docker deploys call. On the FreeBSD jail this works; but
`infra/linux/install.sh` documents that on a **native-Linux, asdf-built**
ERTS the release `eval`/`remote`/`rpc` boot variant crashes at kernel
start (a `persistent_term`/`code_server` badarg — even `eval '1 + 1'`),
and sidesteps it with `mix ecto.migrate`. A packaged host has no mix, so
`grappa migrate` **must** work through `eval` on the **packaged** ERTS.

Since #1158 the account verbs (`create-user`, `add-network`,
`remove-network`) ride the same `eval`, so they inherit this caveat
whole: they are the FIRST thing a fresh install runs, and on a substrate
where `eval` is broken they fail the same way `migrate` does, for the
same reason.

⚠️ **The same badarg has a second, unrelated cause — check this one first
(#1267).** ERTS dies at kernel start with the *identical*
`persistent_term`/`code_server` trace when the working directory it is
launched from lacks the **search (`x`) bit for the effective user**. Measured:
cwd `0700` dies, `0711` and `0555` boot; it reproduces on bare
`erl -boot .../start_clean` with no grappa module loaded, and it has nothing to
do with how the ERTS was built. Debian 13 ships `HOME_MODE 0700` and `/root` is
`0700`, so it fires from the operator's own login directory. `grappa-wrapper.sh`
`cd /`s before exec'ing the release since #1267; on an older package the
operator workaround is `cd /` before any `grappa` subcommand. Do not read a
`code_server` badarg as the asdf caveat below until the cwd has been ruled out.

R1's job is to prove exactly that on a package built by `build.sh`
(bundled ERTS, not asdf): install the `.deb` in a clean container, run
`sudo grappa migrate` against a fresh DB, confirm the service boots and
`/healthz` is green. If `eval` proves broken on the packaged ERTS too, the
fallback is a boot-time migrate flag — a separate design, **not** silently
bolted on here.

## Tracked follow-ups (status per item)

- **`.rpm`** — **shipped (#438)**, see **Building the `.rpm`** above. nfpm
  renders it from the same config; the bundled ERTS is glibc/libssl-specific,
  so it is built inside a Fedora container with Fedora's own Elixir/OTP.
  Fedora-family only (a Fedora ERTS is not a valid RHEL/Rocky/Alma payload).
- **Arch `PKGBUILD` + AUR recipe** — **shipped (R2)**, see
  [`aur/`](aur/README.md). A source package (`makepkg` builds on the target),
  which reuses this substrate's FHS paths + maintainer logic and sidesteps
  the cross-distro ERTS problem the binary `.rpm`/`.deb` face (build-host
  glibc/libssl) by compiling on the target.
- **Tag-driven release CI** (R3) — **shipped**
  ([`.github/workflows/release.yml`](../../.github/workflows/release.yml)):
  builds + proves + uploads per tag; regenerates the AUR recipe
  (`updpkgsums` + `makepkg --printsrcinfo`) and runs the full `makepkg` →
  `pacman -U` on a real x86_64 Arch runner. Publishing (AUR push) stays a
  human decision.
- **`grappa create-user`** subcommand — see First user.
- **`priv/static` single-tarball** — declined for packaging: the
  `CIC_DIST_ROOT`-relocatable model (Part 1) ships the dist as a separate
  payload, which is exactly what packaging needs.
