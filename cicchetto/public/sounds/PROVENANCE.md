# Notification sound assets — provenance

Preset samples for the selectable in-app notification sound (#1480). These are
*third-party* recordings, committed here on vjt's explicit instruction so the
service worker can precache them and a chosen preset still plays offline.
Everything about their origin that is known is recorded below; nothing is
inferred.

All five are wired up as presets in `cicchetto/src/lib/notificationSound.ts`
and precached by the service worker (`vite.config.ts`'s `globPatterns` carries
`mp3` for exactly this reason), so a chosen preset still plays offline. Per
#1480 the DEFAULT preset is silence and the opt-in one is synthesised, so the
feature is designed to survive this directory being removed.

| File | Bytes | Duration | Format | Origin |
|---|---|---|---|---|
| `icq-uh-oh.mp3` | 12537 | 0.50 s | 44100 Hz mono | ICQ message sound, supplied by vjt from <https://sindro.me/t/icq-uh-oh.mp3> |
| `xp-notify.mp3` | 11969 | 1.18 s | 22050 Hz stereo | `Windows XP Notify` — the balloon-tip chime |
| `xp-ding.mp3` | 5447 | 0.44 s | 22050 Hz stereo | `Windows XP Ding` |
| `xp-balloon.mp3` | 3335 | 0.21 s | 22050 Hz stereo | `Windows XP Balloon` |
| `xp-exclamation.mp3` | 10636 | 1.02 s | 22050 Hz stereo | `Windows XP Exclamation` |

The four `xp-*` files come from the Internet Archive item
[`windowsxpstartup_201910`](https://archive.org/details/windowsxpstartup_201910)
("ALL Windows XP Sounds"), renamed to lowercase-kebab and otherwise
byte-identical to the item's own files.

The per-file `Format` column corrects this table's first version, which said
"all five are 22050 Hz stereo": the ICQ sound is **44100 Hz mono**, and it does
not come from the Archive item, so there was never a reason for it to match.
Re-measured independently on 2026-09-11 with `afinfo` (this host has no
`ffprobe`) after re-downloading all three reachable originals — the bytes came
back identical to what is committed here, so the correction is to the
description, not to the files. The oracle was calibrated in both directions
first: `afinfo` exits 1 on a text file and reports a duration for a known-good
system AIFF.

## Licence status

Stated plainly, because a future reader will need it: **the Windows XP sounds
are Microsoft's work and the Archive item declares no licence** (its
`licenseurl` metadata field is null). Hosting on the Internet Archive confers
no rights, and this repository is public, so these bytes are in its history
permanently. That trade was made deliberately and knowingly by the project
owner, and is not a conclusion anybody should re-derive from the files being
present.

The ICQ sound carries the same caveat; its provenance is vjt's to declare.

If either ever has to come out, the synthesised presets are the fallback, and
removing this directory degrades the feature rather than breaking it.
