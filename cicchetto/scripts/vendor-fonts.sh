#!/usr/bin/env bash
# Vendor the curated self-hosted monospace fonts (#75 producer path) from
# npm devDependencies into public/fonts/ as committed static assets, served
# same-origin at /fonts/<family>/.
#
# WHY committed (not built on deploy): a RUNTIME external font fetch is
# banned by #75's security model — a CDN/Google-Fonts <link> is a
# per-render beacon + IP leak, the same class as a remote url(). The
# canonical model stores only a font-id from the closed allow-list; the
# renderer's @font-face (themes/default.css) points at these local copies.
#
# Re-runnable: bump the source dep, then re-run to refresh the woff2.
# Latin subset, weights 400 + 700 (regular + bold; synthesised bold on a
# mono face is ugly).
#
# Coverage vs the frozen font vocabulary (Grappa.Themes.TokenModel):
#   * jetbrains-mono, fira-code, source-code-pro, ibm-plex-mono,
#     cascadia-code — @fontsource (Google-Fonts mirror, OFL).
#   * hack — the official source-foundry `hack-font` npm package (NOT on
#     @fontsource; not a Google Font). Uses the "-subset" (latin) woff2.
#   * iosevka — INTENTIONALLY skipped (vjt 2026-07-17): its latin subset
#     is ~1.9MB, too heavy to vendor. It stays in the picker but has no
#     @font-face, so it renders via the fallback mono stack (graceful).
set -euo pipefail
cd "$(dirname "$0")/.."

# @fontsource families: <family>-latin-<weight>-normal.woff2
FAMILIES=(jetbrains-mono fira-code source-code-pro ibm-plex-mono cascadia-code)
WEIGHTS=(400 700)

for fam in "${FAMILIES[@]}"; do
  dest="public/fonts/$fam"
  mkdir -p "$dest"
  for w in "${WEIGHTS[@]}"; do
    src="node_modules/@fontsource/$fam/files/$fam-latin-$w-normal.woff2"
    if [ ! -f "$src" ]; then
      echo "MISSING: $src — run scripts/bun.sh install first" >&2
      exit 1
    fi
    cp "$src" "$dest/$fam-$w.woff2"
  done
done

# hack — different package layout (build/web/fonts, regular/bold subset).
mkdir -p public/fonts/hack
hack_src="node_modules/hack-font/build/web/fonts"
for pair in "regular:400" "bold:700"; do
  variant="${pair%%:*}"
  weight="${pair##*:}"
  src="$hack_src/hack-$variant-subset.woff2"
  if [ ! -f "$src" ]; then
    echo "MISSING: $src — run scripts/bun.sh install first" >&2
    exit 1
  fi
  cp "$src" "public/fonts/hack/hack-$weight.woff2"
done

echo "vendored ${#FAMILIES[@]} @fontsource families + hack x ${#WEIGHTS[@]} weights -> public/fonts/"
