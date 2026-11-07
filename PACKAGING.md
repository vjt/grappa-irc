# Packaging grappa

This file is the contract between grappa's release pipeline and anyone who
packages grappa downstream: the community AUR packages today, distro packages
tomorrow. Everything it lists is a public interface. It changes only under the
[change policy](#change-policy) below, and every change is announced in the
release notes. Anything a release produces that this file does not list can
change or disappear without notice.

Read this file **at the tag you package**
(`https://github.com/vjt/grappa-irc/blob/v<VERSION>/PACKAGING.md`). The copy on
`main` may already describe the next release.

## Releases and versions

- A release is a git tag `vX.Y.Z` on
  [vjt/grappa-irc](https://github.com/vjt/grappa-irc) plus a GitHub Release of
  the same name. The number has semver's form, `X.Y.Z`, and is the content of
  the repo-root `VERSION` file at the tag. It does not carry semver's promise:
  an incompatible packaging change can ship in a minor release
  ([Change policy](#change-policy)). On an installed host, read it from the
  package manager (`dpkg-query -W grappa`, `rpm -q grappa`, `pacman -Q grappa`).
- A pre-release is tagged `vX.Y.Z-<pre>` (for example `v1.3.0-rc2`) and is
  marked as a pre-release on GitHub (`infra/packaging/prerelease_flag.sh`).
  GitHub's "Latest" release is never a pre-release. If you package stable
  releases only, skip any tag with a `-` in it.
- The terminal client, `shottino`, ships inside every grappa release but has
  **its own version** (`frontends/shottino/version.h`). Its asset names carry
  that version, not the grappa tag: v1.6.2 ships `shottino 0.3.1`.

## Release assets

Every asset downloads from

```
https://github.com/vjt/grappa-irc/releases/download/v<VERSION>/<asset>
```

`<V>` is the grappa version and `<S>` the shottino version. Both are bare
`X.Y.Z` on a stable release.

| Asset | What | Architectures |
| ----- | ---- | ------------- |
| `grappa_<V>_amd64.deb`, `grappa_<V>_arm64.deb` | bouncer, Debian package | amd64, arm64 |
| `shottino_<S>_amd64.deb`, `shottino_<S>_arm64.deb` | client, Debian package | amd64, arm64 |
| `grappa-<V>-1.x86_64.rpm`, `grappa-<V>-1.aarch64.rpm` | bouncer, RPM package | x86_64, aarch64 |
| `shottino-<S>-1.x86_64.rpm`, `shottino-<S>-1.aarch64.rpm` | client, RPM package | x86_64, aarch64 |
| `grappa-<V>-1-x86_64.pkg.tar.zst` | bouncer, Arch package | x86_64 |
| `shottino-<S>-1-x86_64.pkg.tar.zst` | client, Arch package | x86_64 |
| `PKGBUILD`, `default.SRCINFO` | bouncer, Arch source recipe and its metadata | — |
| `shottino.PKGBUILD`, `shottino.SRCINFO` | client, Arch source recipe and its metadata | — |
| `SHA256SUMS` | checksums of every asset on the release ([Checksums](#checksums)) | — |

The set is the expected-asset table in `infra/packaging/release_assets.sh`,
plus `SHA256SUMS`, which the publish job adds from the first release after
v1.6.2 on. The pipeline refuses to **create** a release when an expected
package is missing (#1591). If a later run tops up an existing release with
a package still missing, the release notes open with a "Partial release"
warning that names it.

Two spellings are GitHub's, not ours. Use the published name:

- **`default.SRCINFO`.** The pipeline uploads the bouncer's recipe metadata
  as `.SRCINFO`, and GitHub renames an asset whose name starts with a dot.
- **Pre-release names.** Inside the packages a pre-release version is
  `X.Y.Z~<pre>` for deb and rpm (`infra/packaging/pkgversion.sh`) and
  `X.Y.Z<pre>` for Arch (`infra/packaging/aur/pkgver.sh`). GitHub then
  replaces the `~` with `.` in the asset name. v1.3.0-rc2 published
  `grappa_1.3.0.rc2_amd64.deb`, `grappa-1.3.0.rc2-1.x86_64.rpm` and
  `grappa-1.3.0rc2-1-x86_64.pkg.tar.zst`. Take pre-release names from the
  release or from `SHA256SUMS`; do not construct them.

The client's recipe files carry a `shottino.` prefix and the bouncer's do
not. A release asset is keyed by file name, so two files called `PKGBUILD`
would overwrite each other.

**Not part of the contract:**

- `shottino-debug-<S>-1-x86_64.pkg.tar.zst`, a by-product of `makepkg`'s
  debug packages. It is on the release today and may go away.
- The container images `ghcr.io/vjt/grappa` and `ghcr.io/vjt/grappa-shottino`.
  The same pipeline publishes them, but they are not release assets;
  [`INSTALL.md`](INSTALL.md) documents them.
- An AUR package built from the source recipe. The recipe
  ([`infra/packaging/aur/`](infra/packaging/aur/)) is attached to every
  release as above, but this project does not publish it to the AUR.

### The source archive

The Arch source recipe builds from the tag archive GitHub generates:

```
https://github.com/vjt/grappa-irc/archive/refs/tags/v<VERSION>.tar.gz
```

It unpacks to a single directory, `grappa-irc-<VERSION>/`. GitHub
generates it, so it is not a release asset and is not covered by
`SHA256SUMS`. The released `PKGBUILD` pins its sha256 instead.

## Checksums

`SHA256SUMS` is in `sha256sum` format: one `<sha256><two spaces><name>` line
per asset, under the asset's **published** name, sorted by name. It covers
every asset on the release except itself, including assets outside the
contract. To verify whatever subset you downloaded:

```sh
sha256sum -c --ignore-missing SHA256SUMS
```

The publish job builds it after the upload from the per-asset digests GitHub
reports. It refuses unless every file the run built matches one of those
digests (`infra/packaging/sha256sums.sh`). GitHub exposes the same digest per
asset in its API (the `digest` field of a release asset).

`SHA256SUMS` is **not signed**. It catches a corrupted or truncated
download; it does not protect against someone who can modify the release.

## Bouncer package layout

The `.deb`, `.rpm` and Arch packages install the same files. This was
measured on the v1.6.2 assets: the file lists match outside the bundled
release and frontend trees. The rows marked "Arch only" are the exceptions.
The two `apply-upgrade` rows are newer than v1.6.2; they are read from
`infra/packaging/nfpm.yaml` and the `PKGBUILD`, not measured on an asset.

| Path | What |
| ---- | ---- |
| `/usr/lib/grappa/` | the Elixir release: its own Erlang runtime (ERTS) and the compiled app. No system Erlang or Elixir is needed at runtime. |
| `/usr/lib/grappa/bin/grappa` | the release command. The unit runs `start`. |
| `/usr/bin/grappa` | operator command: loads `/etc/grappa/grappa.env`, `cd /`, drops to the `grappa` user and runs the release command ([Commands](#commands-the-install-steps-use)) |
| `/usr/lib/systemd/system/grappa.service` | the systemd unit |
| `/usr/share/grappa/cicchetto-dist/` | the web frontend, served by grappa itself (`CIC_DIST_ROOT`) |
| `/usr/share/grappa/grappa.env.example` | the configuration template |
| `/usr/share/grappa/gen-secrets.sh` | the secret generator (needs only `openssl`) |
| `/usr/share/grappa/apply-upgrade.sh` | applies an upgrade to the running service ([Install and upgrade](#install-and-upgrade)) |
| `/usr/share/doc/grappa/README.md` | the operator README for packaged installs |
| `/etc/grappa/` | configuration directory, `root:grappa 0750`. deb and rpm own it; on Arch the install script creates it. |
| `/var/lib/grappa/` | state, `grappa:grappa 0750`: the SQLite database `grappa.db` and `uploads/`. deb and rpm own it; on Arch `tmpfiles.d` creates it. |
| `/usr/lib/sysusers.d/grappa.conf` | Arch only: declares the `grappa` user |
| `/usr/lib/tmpfiles.d/grappa.conf` | Arch only: declares `/var/lib/grappa` and `uploads/` |
| `/usr/share/libalpm/hooks/grappa-apply.hook` | Arch only: runs `apply-upgrade.sh` at the end of a pacman transaction that upgrades grappa |
| `/usr/share/licenses/grappa/LICENSE` | Arch only |

`/etc/grappa/grappa.env` is **not in any package**. The first install
creates it from the template ([Install and upgrade](#install-and-upgrade)),
and no upgrade ever replaces it. For the same reason the `.deb` declares no
conffiles.

Below `/usr/lib/grappa/`, only `bin/grappa` is part of the contract. The rest
is internal to the Elixir release. In particular the `releases/0.0.0/`
directory name is frozen on purpose (`@otp_vsn` in `mix.exs`) and is **not**
the grappa version. Neither is the output of `grappa version`: it prints the
same frozen value from `releases/start_erl.data`. Read the version from the
package manager.

### Client package layout

`shottino` installs one file, `/usr/bin/shottino` (plus
`/usr/share/licenses/shottino/LICENSE` on Arch). It has no maintainer
scripts, no user and no unit. It needs the wide-character ncurses, OpenSSL
and the CA certificates. Since grappa 1.3.0 it is its own package. The deb
declares `Replaces`/`Breaks` and the rpm `Obsoletes` against
`grappa (<< 1.3.0~)`, the bouncer versions that still shipped
`/usr/bin/shottino` (`infra/packaging/nfpm-shottino.yaml`).

## Runtime user and directories

- A system user and group named `grappa`, with home `/var/lib/grappa` and no
  login shell. deb and rpm create them in `preinstall.sh` (shell
  `/usr/sbin/nologin`); Arch declares them in `sysusers.d` (shell
  `/usr/bin/nologin`).
- The service runs as `grappa:grappa` with working directory
  `/var/lib/grappa`. Under the unit's `ProtectSystem=strict`, that is the
  only path it can write.

## The systemd unit

The unit is `grappa.service`, installed at
`/usr/lib/systemd/system/grappa.service`. These properties are the contract:

- `Type=exec` with `ExecStart=/usr/lib/grappa/bin/grappa start`. The release
  runs in the foreground, so the main PID is the BEAM.
- `ExecStartPre=/usr/lib/grappa/bin/grappa eval 'Grappa.Release.migrate()'`.
  Every start applies the pending migrations before the release boots, and a
  failed migration fails the start.
- `TimeoutStartSec=300`. It bounds the migration as well as the boot.
- `User=grappa`, `Group=grappa`, `WorkingDirectory=/var/lib/grappa`.
- `EnvironmentFile=/etc/grappa/grappa.env`. systemd reads it as root before
  dropping privileges.
- `Environment=LANG=C.UTF-8` and `Environment=RELEASE_TMP=/var/lib/grappa`.
- `Restart=on-failure`, `ProtectSystem=strict`,
  `ReadWritePaths=/var/lib/grappa`.

Operators override it with drop-ins in
`/etc/systemd/system/grappa.service.d/`, not by editing the vendor file.

## Install and upgrade

The packages run these steps from their maintainer scripts: deb and rpm in
`infra/packaging/scripts/`, Arch in `infra/packaging/aur/grappa.install`. A
package that repackages the payload **without** those scripts must perform
the same steps itself:

1. Create the `grappa` system user and group.
2. Create `/var/lib/grappa/` and `/var/lib/grappa/uploads/`
   (`grappa:grappa 0750`), and `/etc/grappa/` (`root:grappa 0750`).
3. **First install only:** copy `/usr/share/grappa/grappa.env.example` to
   `/etc/grappa/grappa.env` with `root:grappa 0640`. Never overwrite an
   existing file.
4. As root, run `/usr/share/grappa/gen-secrets.sh`. It is idempotent: it
   fills only secrets that are missing, empty or `REPLACE_ME`, which also
   covers a secret a newer version introduces.
5. **If the service is not running** (always the case on a first install):
   run `grappa migrate`. It applies only pending migrations. A failure must
   fail the install.
6. **If the service is not running:** run `grappa seed-themes`. A failure is
   reported but must not fail the install.
7. **If the service is running** (an upgrade): run
   `/usr/share/grappa/apply-upgrade.sh` instead of steps 5 and 6, once every
   file of the new release is on disk. Exit status 1 must fail the upgrade,
   as a failed migration would.
8. `systemctl enable grappa.service`, but **never start it** from the
   install. The operator must set `PHX_HOST` before the first start.

**An upgrade applies itself to a running service; the operator does
nothing.** `apply-upgrade.sh` asks the running node which build it runs,
compares that with the new release, and reloads the new code in place when
nothing in between needs a restart (a hot reload, which applies the pending
migrations itself). Anything else is applied by `systemctl restart`, and
the unit migrates before the new release boots. The script exits 1 when a
restart was needed and did not take, and prints what failed and how to
retry. It also exits 1, without restarting, when the reload is refused
because two migration files claim one version: a restart would migrate
into the same defect and leave the service down, so the running service
keeps the previous release until a fixed package arrives. A service that
is not running is left stopped: its next start
runs the new release and migrates first. Removal stops and disables the
service and leaves `/var/lib/grappa` and the `grappa` user in place. A
Debian `purge` also deletes `/etc/grappa/grappa.env`.

What failing the upgrade means differs by format, by each package manager's
documentation. dpkg leaves the package half-configured. rpm reports the
scriptlet failure and keeps the new package installed. pacman runs the hook
after the transaction has committed, and a hook at that point cannot abort
it (alpm-hooks(5)), so it prints the error and the new package stays
installed.

**An upgrade that changes the toolchain is applied by restart.** The
release in `/usr/lib/grappa/` carries its own ERTS and OTP and Elixir
applications, and the rpm and Arch packages are built with their builder's
Erlang and Elixir, so two consecutive versions can bundle different ones.
`apply-upgrade.sh` compares the running node's ERTS with the new release's
before it contacts the node at all, and restarts when it moved. When only
an application moved, `POST /admin/reload` refuses with
`409 stale_toolchain` (issue 1112) and the script restarts. Before the
script runs there is a window in which the service runs from a removed
ERTS directory: on deb, from the moment dpkg removes the old files while it
unpacks until the postinst, and on Arch, until the hook runs at the end of
the transaction. On rpm there is none, because rpm runs the new package's
`%post` before it removes the old package's files. These orders are the
package managers' documented ones, not measured here. A node left running
from a removed ERTS was measured to halt the first time it restarted its
native DNS resolver. If that happens inside the window, systemd starts
the service again (`Restart=on-failure`) and the script's restart follows.
The window is accepted.

## Configuration

`/etc/grappa/grappa.env` uses systemd `EnvironmentFile=` syntax: `KEY=VALUE`
lines, no quoting, no `export`, no shell expansion. The template
`/usr/share/grappa/grappa.env.example` is the authoritative list of keys:

| Key | Template value | Set by |
| --- | -------------- | ------ |
| `PHX_HOST` | `REPLACE_ME` | the operator. The service does not start until it is a real hostname. |
| `PORT` | `4000` | template |
| `SECRET_KEY_BASE`, `SECRET_SIGNING_SALT`, `RELEASE_COOKIE`, `GRAPPA_ENCRYPTION_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `REPLACE_ME` | `gen-secrets.sh` |
| `VAPID_SUBJECT` | `mailto:operator@example.org` | template; the operator may change it |
| `DATABASE_PATH` | `/var/lib/grappa/grappa.db` | template |
| `UPLOADS_STORAGE_ROOT` | `/var/lib/grappa/uploads` | template |
| `CIC_DIST_ROOT` | `/usr/share/grappa/cicchetto-dist` | template |
| `LOG_LEVEL` | `info` | template |

The template also carries these keys commented out, all optional:
`PUSH_ALLOWED_PRIVATE_HOSTS`, `EXTRA_CHECK_ORIGINS`, `POOL_SIZE`,
`ERL_ZFLAGS`, `GRAPPA_CAPTCHA_PROVIDER`, `GRAPPA_CAPTCHA_SITE_KEY`,
`GRAPPA_CAPTCHA_SECRET`.

`GRAPPA_ENCRYPTION_KEY` encrypts the stored IRC credentials. Losing it makes
them unrecoverable, so tell your users to back it up.

grappa's `config/runtime.exs` reads more variables than the template lists.
Those are not part of this contract.

## Commands the install steps use

`/usr/bin/grappa` provides `migrate`, `seed-themes` and `gen-secrets` (root
only), among others; the README lists the rest. It must run
as root or as a member of the `grappa` group, because it reads
`/etc/grappa/grappa.env`. Run as root, it drops to the `grappa` user through
`runuser` (util-linux).

`apply-upgrade.sh` runs as root. Besides `/usr/bin/grappa` (`rpc` and
`eval`) it uses `systemctl`, `curl` and `timeout`, and it reaches the
service on `127.0.0.1` at the `PORT` set in `grappa.env`, bare or quoted
(4000 when unset). A `PORT` set in a unit drop-in is not read. Every wait on
the service is bounded, so a service that does not answer is restarted
rather than holding the package manager.

## Supported platforms

The bundled Erlang runtime, the NIFs and `shottino` link against the glibc
and OpenSSL of the host that builds them. That is why each binary format
names the platforms it runs on:

| Format | Architectures | Built on | Supported on |
| ------ | ------------- | -------- | ------------ |
| `.deb` | amd64, arm64 | the `ubuntu-24.04` and `ubuntu-24.04-arm` runners (pinned) | Ubuntu 24.04 and Debian 13 (trixie). Before uploading them, CI installs both packages on each and starts the bouncer (`infra/packaging/deb_floor_proof.sh` for Debian 13). Debian 12 and Ubuntu 22.04 are not supported. |
| `.rpm` | x86_64, aarch64 | a `fedora:43` container with Fedora's own Erlang and Elixir | the Fedora family. RHEL, Rocky and Alma are out of scope. |
| Arch | x86_64 | an `archlinux:latest` container | Arch Linux. Arch has no official ARM port, so there is no aarch64 package. |

Runtime libraries: OpenSSL 3, ncurses 6, libstdc++, libgcc and the CA
certificates, plus the `openssl` command (`gen-secrets.sh`), util-linux
(`runuser`) and `curl` (`apply-upgrade.sh`). The exact package names for
each format are in `infra/packaging/nfpm.yaml` and the `PKGBUILD`.

## Change policy

- A change to anything this file lists is a change to the contract, and it
  updates this file in the same change.
- **Every release's notes have a "Packaging" section**
  ([template](.github/release-notes-template.md)). It lists each contract
  change the release carries, or reads "No change to the packaging contract."
  when there is none. A missing section would be ambiguous: no change, or a
  forgotten section?
- **Each change is announced as compatible or incompatible.** Incompatible
  means a package built against the previous contract breaks, or silently
  changes behaviour, without being edited. Examples: an asset renamed or
  removed; a path, unit, user or directory moved or renamed; an env key
  renamed or removed, or a new one that must be set; an architecture or
  platform dropped; a new install step a repackager has to perform.
  Compatible examples: a new asset, a new optional env key, a new
  architecture, a wider platform range.
- **The version number does not tell the two apart.** Either kind can ship
  in a minor release, so read the Packaging section of every release, not
  only of a major one.

## Following releases

- On GitHub: on [vjt/grappa-irc](https://github.com/vjt/grappa-irc),
  **Watch → Custom → Releases**.
- As a feed: `https://github.com/vjt/grappa-irc/releases.atom`.

Both announce every release, so you do not depend on anyone telling you.
Read the Packaging section of each release's notes.

<!-- TODO(issue 2570): a contact for packagers. No maintainer address,
     list or channel is published for this yet; until one is, use the
     repository's issues. -->
