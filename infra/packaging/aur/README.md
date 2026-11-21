# Grappa Arch/AUR packaging (self-hosting Part 2, #419 R2)

The **Arch renderer** for grappa, built on the format-agnostic packaging
substrate in [`..`](../README.md) (FHS layout, systemd unit, openssl secret
bootstrap, the `grappa` operator wrapper with the #419 packaged migrate).

Unlike the `.deb` (a **binary** package built once from a glibc ERTS via
[nfpm](../nfpm.yaml)), this is a **source** package: `makepkg` builds the
`mix release` + cicchetto SPA **on the target host**, so the bundled ERTS and
crypto NIFs link against the user's own Arch libraries. That is the AUR
convention (rebuild-on-upgrade) and it sidesteps the cross-distro ERTS
problem that deferred the `.rpm` — there is no "built on the wrong distro"
payload, because the user's own Arch toolchain does the build.

## Files

| File               | Role                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `PKGBUILD`         | the recipe (source build → FHS staging)                               |
| `.SRCINFO`         | machine-readable metadata; **regenerated** from `PKGBUILD` (see below) |
| `grappa.install`   | pacman scriptlet: user/dirs, secrets, migrate, systemd enable         |
| `grappa.sysusers`  | `sysusers.d` — the `grappa` system user (declarative)                 |
| `grappa.tmpfiles`  | `tmpfiles.d` — `/var/lib/grappa` state dirs (declarative)             |

The recipe reuses the **verbs, not the nouns**: the shared substrate provides
the FHS layout, the systemd unit, `gen-secrets.sh`, and the `grappa` wrapper
(installed straight from the source tarball's `infra/packaging/`); Arch's
**native** mechanisms replace the .deb's imperative maintainer scripts —
`sysusers.d`/`tmpfiles.d` for the user + state dirs, and `grappa.install`
for the genuinely-imperative first-install steps (env-file bootstrap, secret
generation, the packaged migrate, `systemctl enable`).

## `arch=(x86_64)` only

`bun` — the cicchetto build toolchain — is in the official `extra` repo for
**x86_64 only**, not for Arch Linux ARM (a separate project with its own
repos). Mainline Arch is x86_64 anyway, so x86_64 is both the canonical AUR
target and the only arch with an official `bun`. An ARM user can still build
by providing `bun` out-of-band (e.g. the upstream installer), but the recipe
does not claim `aarch64` it cannot satisfy from official repos.

## Building locally

`makepkg -s` auto-installs the build deps — `elixir`, `erlang-headless`, `bun`.
`erlang-headless` is the full headless OTP the `mix release` bundles
(public_key, ssl, inets, runtime_tools): Arch's `elixir` pulls only
`erlang-core`, which does NOT carry them (#527). Without `-s`, install those
three first.

```sh
cd infra/packaging/aur
# Derive the version from the VERSION file (#538/#652) + refresh checksums/.SRCINFO
# against the tag tarball. The committed pkgver is the @GRAPPA_VERSION@
# sentinel and nothing is known to catch it downstream (#1592), so regen.sh is
# REQUIRED first — and makepkg downloads the vX.Y.Z source tarball anyway, so
# the tag must already exist:
./regen.sh
# builds the mix release + cicchetto, stages FHS, produces the package.
# -s auto-installs makedepends (elixir, erlang-headless, bun) via pacman:
makepkg -sf
# → grappa-<version>-<rel>-x86_64.pkg.tar.zst  (NOT installed, NOT published)
```

`regen.sh` rewrites `PKGBUILD`/`.SRCINFO` in place; do **not** commit the
result — the committed recipe stays the `@GRAPPA_VERSION@` sentinel template.

Install what you built (runs the scriptlet: user, secrets, migrate, theme
seed, enable):

```sh
sudo pacman -U grappa-*-x86_64.pkg.tar.zst
sudoedit /etc/grappa/grappa.env      # set PHX_HOST=your.host
sudo systemctl start grappa
curl http://127.0.0.1:4000/healthz
```

Everything after install — first user, `grappa migrate`, secret rotation,
backup of `GRAPPA_ENCRYPTION_KEY` — is documented in
[`../README.md`](../README.md); the `.deb` and the Arch package share the
same FHS paths, wrapper, and operator model.

## Publishing to the AUR — a **human** step

**This tree builds recipes; it never publishes them.** No AUR credentials
live here, and nothing here pushes to `aur.archlinux.org`. To publish a
release, a maintainer:

1. Cuts the `vX.Y.Z` git tag this `PKGBUILD` pulls (matching the repo-root
   `VERSION` file — the CI release gate asserts tag ↔ `VERSION`; `pkgver`
   DERIVES from `VERSION`, so there is no second number to keep in sync).
2. Regenerates the recipe against the now-existing tag tarball — one script
   derives the version and refreshes checksums + metadata (#538), so the
   version is never a manual step a publisher can forget:

   ```sh
   cd infra/packaging/aur
   ./regen.sh    # derive pkgver from VERSION, updpkgsums, regenerate .SRCINFO
   ```

3. Copies **`PKGBUILD`, `.SRCINFO`, `grappa.install`** into the AUR git repo
   and pushes there. (`grappa.sysusers` / `grappa.tmpfiles` are **not**
   copied — they ship inside the source tarball and are installed from it by
   `package()`, keeping this repo their single source of truth.)
4. Publishes the CLIENT recipe too, as a **second AUR package** (#1447):
   `shottino/PKGBUILD` + `shottino/.SRCINFO` go into the `shottino` AUR repo,
   not into `grappa`'s. The same `regen.sh` run in step 2 derived both.
   Off the GitHub release they arrive as **`shottino.PKGBUILD`** and
   **`shottino.SRCINFO`** — an asset is keyed by basename and two files
   called `PKGBUILD` would clobber each other, so rename them back to
   `PKGBUILD`/`.SRCINFO` in that repo.

**Why two recipes and not one split package.** `PKGBUILD(5)` § PACKAGE
SPLITTING lists what a `package_*()` function may override, and `pkgver` is
not on that list: a split shares one version across both halves. The client
keeps its own line (`frontends/shottino/version.h`) so that
`shottino --version` and the package version agree, and two version lines
need two pkgbases. Its recipe carries a second sentinel, `_grappaver`, for
the tag whose tarball holds the source — the client's number never names a
tag, because there is only ever one.

The committed `PKGBUILD`/`.SRCINFO` are a **template**, turned into the
concrete publishable recipe by `regen.sh`:

- `pkgver=@GRAPPA_VERSION@` is a sentinel marking "not derived yet" (#538).
  It was documented here as a value `makepkg` bars, so that an underived
  build would fail loudly rather than silently ship
  `grappa-@GRAPPA_VERSION@`. **It is not** — the pkgver lint accepts `@`
  (#1592, measured), and which stage would stop such a build is unmeasured.
  Treat running `regen.sh` as mandatory procedure, not as something a tool
  will remind you about. `regen.sh` fills it from the repo-root `VERSION`
  file, the single source of truth — **through `pkgver.sh`, which is the
  identity on a bare `X.Y.Z` and not on a pre-release** (#1591: `makepkg`
  refuses the hyphen too, so `1.3.0-rc1` becomes `1.3.0rc1`). That is why
  this recipe also carries `_grappaver=@GRAPPA_VERSION@`, and why every
  mention of the tag — `source`, `_srcdir` — is spelled with it: once the
  two can differ, `v${pkgver}` names a tag nobody cut. The spelling is a
  measured constraint, not a convention — see `pkgver.sh`'s header.
- `sha256sums=('SKIP')` is a placeholder: the `vX.Y.Z` tarball does not exist
  until the tag is cut, so its real hash cannot be known yet. `regen.sh` runs
  `updpkgsums` to fill it at release.

Both files are committed so the recipe is reviewable in-tree. `.SRCINFO` is
**derived** — `regen.sh` regenerates it in full (`makepkg --printsrcinfo`) at
release, filling the real `pkgver`/`sha256sums`; never commit that concrete
output — the committed copy stays the `@GRAPPA_VERSION@`/`SKIP` sentinel
template. Do not hand-edit its DERIVED fields (`pkgver`, `sha256sums`). Its
STRUCTURAL fields (`makedepends`, `depends`, …) ARE mirrored by hand from
PKGBUILD, since `regen.sh` only runs at release: a PKGBUILD dep change must be
copied here too to keep the committed snapshot honest (e.g. #527's
`erlang-headless`). The guard test
`test/grappa/version_single_source_test.exs` fails if either carrier stops
being the `@GRAPPA_VERSION@` sentinel — and, since #1447, if the client
recipe's `pkgver` stops being `@SHOTTINO_VERSION@` or its `_grappaver` stops
being `@GRAPPA_VERSION@`, and since #1591 if the BOUNCER recipe loses its
`_grappaver` or goes back to spelling its source `v${pkgver}`. What that
guard does NOT do is compare a `PKGBUILD` with its `.SRCINFO` field by
field: the structural mirroring above stays a human discipline, and the
only full regeneration is `regen.sh`'s.

## Publishing a PRE-RELEASE to the AUR — read this first (#1591)

The release job builds and proves an Arch package for a pre-release tag,
and `regen.sh` derives a legal `pkgver` for it (`1.3.0-rc1` → `1.3.0rc1`).
Pushing that to the AUR is still a human decision, and one worth taking
deliberately:

- The mapped number sorts **below** its own release — measured, `vercmp
  1.3.0rc1 1.3.0 = -1` — so a user who installs the rc is offered `1.3.0`
  when it lands. That is the whole reason the hyphen is DELETED rather
  than replaced with the conventional `_`, which measures `+1` and would
  strand them. Do not "tidy" that spelling.
- The AUR has one recipe per package, not a channel per track: publishing
  a pre-release means every `grappa` AUR user gets it. `optdepends` and
  `epoch` do not help. If that is not wanted, build it, prove it, and do
  not push it — the CI leg being green is the deliverable.

## Version reporting (bare `X.Y.Z`, #419 R3)

`Grappa.Version` reports the **bare `X.Y.Z`** for an AUR build. The base
version is the compiled `VERSION`-file constant (#652 — read at compile time,
baked into a module attribute; NOT `Application.spec(:grappa, :vsn)`, which
goes stale across a hot deploy), and the #391 git suffix is applied **only
when `.git` is present at build**. A GitHub tag **tarball has no `.git`**, so
`makepkg`'s build sees `nil` git facts and reports the package version with no
suffix — the released code self-reports as released.

This replaces R2's `-dev` caveat: earlier `Grappa.Version` read `@version`
from `mix.exs` at runtime and folded git state, so a tarball build degraded
to `X.Y.Z-dev`. #419 R3 removed the runtime `mix.exs` read; #652 kept the read
at **compile** time and moved the number into the repo-root `VERSION` file —
the tarball always carries `VERSION`, and the version is baked into the
artifact, not read from a file at runtime. The release CI asserts the
built Arch package reports the bare version — see
[`.github/workflows/release.yml`](../../../.github/workflows/release.yml).

## What is proven, and what R3 CI must still exercise

Honest status (the recipe is real; not every layer was built locally):

**Proven locally — the load-bearing constraint.** The #419 risk is the
migrate model on the Arch **toolchain versions**: grappa dev-pins Elixir 1.19
/ OTP 28, but Arch ships **Elixir 1.20.2 / OTP 29.0.1**. That delta is
distro-independent (Elixir-compiler + OTP release-boot behavior on a glibc
bundled ERTS), and it was proven on the official `elixir:1.20.2-otp-29` image
(native, Debian/glibc, the exact Arch versions): `mix release` compiles clean,
`bin/grappa eval 'Grappa.Release.migrate()'` applies **72 migrations** on the
bundled OTP-29 ERTS, `gen-secrets.sh` (openssl) fills every secret, and the
release boots to a green `/healthz`. R1 proved the same model on the OTHER end
(Elixir 1.19 / OTP 28, the `.deb`), so the migrate path is now bracketed
across both toolchains. Note: `mix release` must run **without**
`--warnings-as-errors` on Arch — Elixir 1.20 emits `xref:`-deprecation
warnings from deps (mint/finch) that a strict build would false-fail; the
`PKGBUILD` deliberately omits it.

**Statically validated.** `PKGBUILD` passes `namcap` and `makepkg
--printsrcinfo` (the committed `.SRCINFO` is its output); `grappa.install`
passes `shellcheck`.

**NOT built locally — deferred to R3 CI (be honest about it).** A full
`makepkg` → `pacman -U` on real Arch was **not** run on this dev host: Arch is
x86_64-only and this arm64 host cannot emulate it (qemu-user cannot run the
OTP-29 ERTS — the `prim_tty` NIF is undefined, crashing even `mix`), while
native Arch Linux ARM's mirrors were too slow to pull the toolchain
(`erlang-core` stalled at <1 B/s). So the `makepkg` assembly and the
`pacman`-invoked `grappa.install` scriptlet are exercised end-to-end only by
**R3 CI on a real x86_64 Arch runner** — treat that as the gate, not this
local run. The scriptlet's core operations ARE covered, but by two proofs kept
distinct: the gate above ran `Grappa.Release.migrate()` via `bin/grappa eval`
+ `gen-secrets.sh` **directly** on the OTP-29 ERTS (the version delta), while
the `/usr/bin/grappa` wrapper's `runuser`-drop against a root-owned,
read-only release tree is the exact mechanism R1's `.deb` proved (on OTP 28).
Only the pacman transaction wrapper (sysusers/tmpfiles hooks, file extraction)
is genuinely CI-only.

## Deferred (tracked follow-ups)

- **Tag-driven release CI (R3)** — **shipped**, see
  [`.github/workflows/release.yml`](../../../.github/workflows/release.yml).
  On a `vX.Y.Z` tag it runs `updpkgsums` + `makepkg --printsrcinfo`, builds
  the package with the full `makepkg` → `pacman -U` path on a real x86_64
  Arch container (secrets + migrate proven on the installed artifact), and
  attaches the package + regenerated `PKGBUILD`/`.SRCINFO` to the GitHub
  Release. Publishing to the AUR stays a human decision (no AUR creds
  in-tree).
- **`.rpm` (#438)** — **shipped.** nfpm renders it from the same substrate,
  but the bundled ERTS is glibc/libssl-specific, so it is built inside a
  pinned Fedora container, with the `.tool-versions` Elixir/OTP compiled
  there (the `rpm` job in `release.yml`; Fedora's own was dropped in issue
  2669). Fedora-family only — a Fedora ERTS is not a valid
  RHEL/Rocky/Alma payload. See [`../README.md`](../README.md) "Building the
  `.rpm`".
- **`grappa create-user` subcommand** — see [`../README.md`](../README.md)
  "First user"; needs a release-callable entry point.
