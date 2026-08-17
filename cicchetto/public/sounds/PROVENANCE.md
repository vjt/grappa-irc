# Notification sound assets — provenance

Preset samples for the selectable in-app notification sound (#1480). These are
*third-party* recordings, committed here on vjt's explicit instruction so the
service worker can precache them and a chosen preset still plays offline.
Everything about their origin that is known is recorded below; nothing is
inferred.

These files land *ahead of* the code that reads them: as of this commit
`cicchetto/src/lib/beep.ts` still plays one hard-coded 440 Hz sine and nothing
here is referenced yet. Per #1480 the default preset stays synthesised, so the
feature is designed to survive this directory being removed.

| File | Bytes | Duration | Origin |
|---|---|---|---|
| `icq-uh-oh.mp3` | 12537 | 0.50 s | ICQ message sound, supplied by vjt from <https://sindro.me/t/icq-uh-oh.mp3> |
| `xp-notify.mp3` | 11969 | 1.18 s | `Windows XP Notify` — the balloon-tip chime |
| `xp-ding.mp3` | 5447 | 0.44 s | `Windows XP Ding` |
| `xp-balloon.mp3` | 3335 | 0.21 s | `Windows XP Balloon` |
| `xp-exclamation.mp3` | 10636 | 1.02 s | `Windows XP Exclamation` |

The four `xp-*` files come from the Internet Archive item
[`windowsxpstartup_201910`](https://archive.org/details/windowsxpstartup_201910)
("ALL Windows XP Sounds"), renamed to lowercase-kebab and otherwise
byte-identical to the item's own files. All five are 22050 Hz stereo MP3 and
were verified with `ffprobe` before being committed.

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
