#!/bin/sh
# Regenerates the fixtures of cic's metadata strip (#2517b). Needs exiftool +
# ffmpeg, both in the grappa container image; from the repo root:
#
#   docker run --rm --entrypoint sh -v "$PWD:/repo" \
#     -w /repo/cicchetto/src/__tests__/fixtures/metadataStrip grappa:latest ./generate.sh
#
# POSIX sh, not bash: the image is alpine and ships no bash.
#
# Fixtures are committed — rerun only if the strip test assertions change.
# The tests assert on marker STRINGS, never on coordinates.
set -eu
cd "$(dirname "$0")"

# The four images the SERVER strip is tested on, copied byte for byte so both
# strips are pinned on the same leak shapes: `scripts/bun.sh` mounts only
# cicchetto/, so vitest cannot read them where they live.
server=../../../../../test/support/fixtures/uploads
cp "$server/gps.jpg" "$server/gps.png" "$server/oriented.jpg" "$server/p3.jpg" .

# apng: three frames, the EXIF leak in eXIf (GPS + device + Orientation=6),
# XMP in iTXt, a comment in tEXt. Pins the animation chunks surviving and
# Orientation coming back in a minimal eXIf.
ffmpeg -y -loglevel error -f lavfi -i "testsrc=s=32x32:r=4:d=0.75" -plays 0 -f apng tagged.apng
exiftool -q -overwrite_original \
  -GPSLatitude=41.9028 -GPSLatitudeRef=N \
  -GPSLongitude=12.4964 -GPSLongitudeRef=E \
  -Make=Apple -Model="iPhone 15 Pro" -Orientation#=6 \
  -XMP-dc:Creator="Secret Author" -PNG:Comment="secret comment" tagged.apng

# animated webp: the same EXIF leak and XMP, plus the Display-P3 profile, so
# one file pins ANIM/ANMF, ICCP, the VP8X flag rewrite and Orientation.
ffmpeg -y -loglevel error -f lavfi -i "testsrc=s=32x32:r=4:d=0.75" \
  -c:v libwebp_anim -loop 0 tagged.webp
exiftool -q -overwrite_original \
  -GPSLatitude=41.9028 -GPSLatitudeRef=N \
  -GPSLongitude=12.4964 -GPSLongitudeRef=E \
  -Make=Apple -Model="iPhone 15 Pro" -Orientation#=6 \
  -XMP-dc:Creator="Secret Author" "-icc_profile<=$server/display-p3.icc" tagged.webp

# animated gif: a Comment extension, an XMP application extension and an ICC
# application extension beside the NETSCAPE2.0 loop. GIF has no EXIF, so
# no GPS here: the leak shape is the comment and the XMP packet.
ffmpeg -y -loglevel error -f lavfi -i "testsrc=s=32x32:r=4:d=0.75" -loop 0 -f gif tagged.gif
exiftool -q -overwrite_original \
  -Comment="secret comment" -XMP-dc:Creator="Secret Author" \
  "-icc_profile<=$server/display-p3.icc" tagged.gif

# The SERVER strip's output for each fixture, made with the exact image argv of
# Grappa.Uploads.MetadataStrip (`-all= -tagsfromfile @ -Orientation
# -ICC_Profile`). The cic test compares its own output with these twins, so
# the two strips are pinned against each other on every run, not once on a
# bench.
for f in gps.jpg oriented.jpg p3.jpg gps.png tagged.apng tagged.webp tagged.gif; do
  out="${f%.*}.exiftool.${f##*.}"
  rm -f "$out"
  exiftool -q -all= -tagsfromfile @ -Orientation -ICC_Profile -o "$out" "$f"
done
