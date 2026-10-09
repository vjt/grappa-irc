// issue 2359 — the auto-away ladder and its words, shared by the two
// controls that offer it: the user's own pick (`SettingsDrawer`) and the
// admin's site default (`AdminSettingsTab`).
//
// #348 chose the rungs. Deliberately coarse: they answer "how long before
// my friends see me as away", and anything between them is what the
// drawer's custom entry is for. The server holds the same ladder (plus
// `0` = off) as the closed set its admin door accepts —
// `Grappa.ServerSettings` `@auto_away_default_seconds_ladder` — so a rung
// added here and not there is refused with a 422, loudly.
export const AUTO_AWAY_PRESETS: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 60, label: "1 minute" },
  { seconds: 300, label: "5 minutes" },
  { seconds: 600, label: "10 minutes" },
  { seconds: 1800, label: "30 minutes" },
  { seconds: 3600, label: "1 hour" },
];

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

// Words for an auto-away window in the wire's encoding: seconds, `0` = off.
// A ladder rung reads as its preset label; anything else — the boot
// fallback is operator config and need not sit on the ladder (the
// integration env runs 2s) — reads in the largest unit that divides it
// exactly, so no value is ever rounded into a different one.
export function formatAutoAwaySeconds(seconds: number): string {
  if (seconds === 0) return "off";
  const preset = AUTO_AWAY_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

// The drawer's "no preference" entry. `null` = the server did not say (a
// server before protocol 39, or no snapshot yet): the bare label, never a
// guessed number — a copy of the server's default here would go stale the
// day it moves, which is why #348 shipped the label bare in the first place.
export function siteDefaultLabel(seconds: number | null): string {
  return seconds === null
    ? "use site default"
    : `use site default (${formatAutoAwaySeconds(seconds)})`;
}
