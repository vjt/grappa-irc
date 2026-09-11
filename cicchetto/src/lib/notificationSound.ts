// #1480 — the notification-sound preset pack: the vocabulary and the recipes.
//
// ## Why this is not inside `beep.ts`
//
// `beep.ts` is MOCKED wholesale by `__tests__/subscribe.test.ts`
// (`vi.mock("../lib/beep", () => ({ playBeep: vi.fn() }))`), and a mock factory
// only exports what it lists. Anything else importing a VALUE from `beep.ts`
// would resolve to a missing export inside that suite — the exact failure its
// own comment warns about ("bleeds a missing-export into UX-6-L beep tests
// downstream"). `userSettings.ts` needs `DEFAULT_NOTIFICATION_SOUND` for the
// prefs default, the settings drawer needs the labels and the slash-command
// parser needs the name set, so the vocabulary lives here, on the far side of
// that mock, and `beep.ts` imports it like everyone else.
//
// Sibling shape: `timeFormat.ts` (#217) — one small module owning a closed-set
// key, its default and its guard.
//
// ## Two species, one table
//
// A preset is either an oscillator recipe we SYNTHESISE (no bytes, no fetch)
// or an mp3 we DECODE. The discriminated union is what makes adding one a
// table row: the switch in `beep.ts` is exhaustive, so a new `kind` is a
// compile error at every site that must learn about it, rather than a silent
// fall-through to silence.
//
// The samples are committed under `public/sounds/` on vjt's explicit ruling
// (2026-09-11) with the licence position stated in that directory's
// `PROVENANCE.md`. They are precached by the service worker
// (`vite.config.ts`'s `globPatterns` carries `mp3` for this reason), so a
// chosen preset still plays with the network down — the case that matters
// most for a PWA notification sound. If they ever have to come out, the synth
// presets are the fallback and the feature degrades rather than breaks.
//
// ## The default is SILENCE
//
// `none` ships selected for everybody, existing subjects included (vjt,
// 2026-09-11: «suono deve essere opt-in», «mi sta bene che sia disattivato per
// tutti»). It is also the only implementable answer to the report that opened
// the issue — a page cannot read macOS Focus/Do Not Disturb, so "respect DND"
// is not a gate anybody can build here; a preset the user picks is.
//
// The server holds the same closed set (`Grappa.UserSettings`'s
// `@notification_sounds`) and rejects anything outside it at the write
// boundary. Adding a preset therefore touches BOTH lists — this one for the
// recipe, that one for the vocabulary.

/** One oscillator burst. A preset is a list of these, scheduled together. */
export type SoundVoice = {
  readonly wave: OscillatorType;
  /** Start frequency in Hz. */
  readonly fromHz: number;
  /**
   * End frequency in Hz — always present, equal to `fromHz` for a flat note.
   * Stated rather than optional so the player has one code path (a ramp) and
   * no "did the author mean a glide?" branch.
   */
  readonly toHz: number;
  /** Offset from the start of the preset, in ms. */
  readonly atMs: number;
  readonly durationMs: number;
  /** Peak linear gain, before the shared envelope. */
  readonly gain: number;
};

export type SoundPreset =
  | { readonly kind: "silent"; readonly label: string }
  | { readonly kind: "synth"; readonly label: string; readonly voices: readonly SoundVoice[] }
  | {
      readonly kind: "sample";
      readonly label: string;
      readonly url: string;
      readonly gain: number;
    };

/**
 * Every preset name, in the order the settings drawer offers them: silence
 * first, then the synthesised ones (cheapest, always available), then the
 * samples.
 *
 * Wire values, so snake_case and never a hyphen — they cross the JSON boundary
 * into `notification_prefs.notification_sound` and are matched against the
 * server's own list byte for byte.
 */
export const NOTIFICATION_SOUNDS = [
  "none",
  "tone",
  "chime",
  "blip",
  "pop",
  "icq",
  "xp_notify",
  "xp_ding",
  "xp_balloon",
  "xp_exclamation",
] as const;

export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];

export const DEFAULT_NOTIFICATION_SOUND: NotificationSound = "none";

/**
 * The name `/beep on` selects — "the sound we shipped before this issue", not
 * a synonym for "the default". The two are deliberately different values now:
 * the default is silence, and `on` is what a user types to opt in.
 */
export const OPT_IN_NOTIFICATION_SOUND: NotificationSound = "tone";

/**
 * Narrow an untrusted string (a stored pref, a `/beep` argument) to a preset
 * name. Everything unrecognised is the caller's problem to report — this does
 * not silently substitute the default, because a mistyped `/beep` deserves an
 * error and a stale stored value deserves the default, and only the caller
 * knows which it is holding.
 */
export function isNotificationSound(value: unknown): value is NotificationSound {
  return typeof value === "string" && (NOTIFICATION_SOUNDS as readonly string[]).includes(value);
}

// One gain for every sample. The mp3s are third-party recordings at their own
// mastering levels and this host has no way to measure loudness, so the number
// is a judgement (roughly the headroom the synth presets sit at), NOT a
// measurement — it is one constant precisely so a future ear can move it once.
const SAMPLE_GAIN = 0.6;

export const NOTIFICATION_SOUND_PRESETS: Readonly<Record<NotificationSound, SoundPreset>> = {
  none: { kind: "silent", label: "silent (default)" },

  // The pre-#1480 sound, unchanged to the Hz: a bare 440 Hz sine for 80 ms at
  // gain 0.1. Kept exactly because it is what `/beep on` promises and what an
  // existing user who opts back in expects to hear.
  tone: {
    kind: "synth",
    label: "tone (440 Hz)",
    voices: [{ wave: "sine", fromHz: 440, toHz: 440, atMs: 0, durationMs: 80, gain: 0.1 }],
  },

  // A falling two-note interval — the shape everyone reads as "message", and
  // the direct answer to the complaint that opened the issue (alk: the 440 Hz
  // tone is indistinguishable from the Windows Sticky Keys chime). Triangle
  // rather than sine so it carries over a noisy room without being harsh.
  chime: {
    kind: "synth",
    label: "chime",
    voices: [
      { wave: "triangle", fromHz: 988, toHz: 988, atMs: 0, durationMs: 110, gain: 0.09 },
      { wave: "triangle", fromHz: 659, toHz: 659, atMs: 100, durationMs: 220, gain: 0.09 },
    ],
  },

  // A short rising sweep. Square is the loudest wave per unit gain, hence the
  // markedly lower number — same perceived level, not a quieter preset.
  blip: {
    kind: "synth",
    label: "blip",
    voices: [{ wave: "square", fromHz: 660, toHz: 1320, atMs: 0, durationMs: 60, gain: 0.05 }],
  },

  // A fast downward sweep: the bubble-pop shape, and the least intrusive of
  // the four for someone who wants to know without being addressed.
  pop: {
    kind: "synth",
    label: "pop",
    voices: [{ wave: "sine", fromHz: 1200, toHz: 300, atMs: 0, durationMs: 70, gain: 0.12 }],
  },

  icq: { kind: "sample", label: 'ICQ "uh-oh"', url: "/sounds/icq-uh-oh.mp3", gain: SAMPLE_GAIN },

  xp_notify: {
    kind: "sample",
    label: "Windows XP notify",
    url: "/sounds/xp-notify.mp3",
    gain: SAMPLE_GAIN,
  },
  xp_ding: {
    kind: "sample",
    label: "Windows XP ding",
    url: "/sounds/xp-ding.mp3",
    gain: SAMPLE_GAIN,
  },
  xp_balloon: {
    kind: "sample",
    label: "Windows XP balloon",
    url: "/sounds/xp-balloon.mp3",
    gain: SAMPLE_GAIN,
  },
  xp_exclamation: {
    kind: "sample",
    label: "Windows XP exclamation",
    url: "/sounds/xp-exclamation.mp3",
    gain: SAMPLE_GAIN,
  },
};
