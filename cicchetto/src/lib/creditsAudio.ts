// #1773 — the credit roll's soundtrack: a synthesised chiptune, with ZERO
// audio assets in the tree.
//
// WHY SYNTHESISED, and why this is not a preference. The issue asked for
// "something epic", and the obvious candidates (Star Wars, Super Mario) are
// under copyright. grappa ships a PUBLIC PWA and a `.deb`, so shipping either
// would put a licence violation in a distro package. The alternatives were an
// original chiptune, a CC0 track with its licence recorded in-tree, or this:
// a few seconds of WebAudio with no asset at all. It is also by far the
// smallest payload, and the modal is already a synthetic-graphics affair, so
// nothing about it is out of place.
//
// Autoplay is legal here because the modal opens on a click — the user
// gesture requirement is satisfied by the thing that mounted this. A
// suspended context is still resumed explicitly: Safari hands one back
// suspended more often than Chromium does.
//
// The AudioContext is handed IN rather than constructed here, and `stop()`
// CLOSES it. Two reasons: jsdom has no AudioContext, so the caller has to do
// the feature test anyway and a constructor inside would make this module
// untestable; and an easter egg that leaves a live audio graph behind a
// closed modal is the battery bug this file's sibling rAF loop was careful
// not to be.
//
// #1916 — the arrangement, and why it is DATA. What shipped in #1773 was one
// 1.92 s bar (eight triangle notes over a static A2 sine) re-armed verbatim
// for as long as the modal stayed open, which reads as a ringtone rather than
// a soundtrack. Four things changed, all inside the same contract above:
//
//  - The phrase is a `BARS` ARRAY walked in order (Am → F → C → G), so the
//    loop point is PHRASE_S out rather than one bar. Lengthening it is adding
//    entries to that array — no code moves. Four bars is an assumption, not a
//    ruling; see the PR and DESIGN_NOTES.
//  - The lead is a `square` and the triangle is demoted to a bass line that
//    MOVES with the chord, replacing the drone. That swap is most of what
//    makes a chiptune sound like a chiptune.
//  - One noise channel for percussion, and only one: a snare REPLACES the hat
//    on the backbeat instead of sounding over it, which is both how a
//    two-pulse-plus-noise chip actually behaves and what keeps the mix peak
//    inside the pre-#1916 budget (see PEAK_GAIN).
//  - Bars are placed on a LOOKAHEAD cursor (`nextBarAt`) rather than re-based
//    on `ctx.currentTime` at every re-arm, so timer jitter no longer smears
//    the phrase. See `pump` for the one hazard that introduces.

/** A running soundtrack. Both verbs are idempotent. */
export type CreditsArpeggio = {
  /** Fade to silence (or back), without tearing down the graph. */
  readonly setMuted: (muted: boolean) => void;
  /** Silence it, drop every node, and CLOSE the context handed to `start`. */
  readonly stop: () => void;
};

// ---------------------------------------------------------------------------
// Pitch — note names rather than a wall of Hz, so the score below reads as a
// score. `Note` is a template-literal type, so a typo is a compile error and
// not a semitone nobody notices.
// ---------------------------------------------------------------------------

const SEMITONE = {
  C: 0,
  "C#": 1,
  D: 2,
  "D#": 3,
  E: 4,
  F: 5,
  "F#": 6,
  G: 7,
  "G#": 8,
  A: 9,
  "A#": 10,
  B: 11,
} as const;

type PitchClass = keyof typeof SEMITONE;
type Octave = "1" | "2" | "3" | "4" | "5" | "6";
/** Scientific pitch notation — `A2`, `C#5`. */
type Note = `${PitchClass}${Octave}`;

/** Equal temperament off A4 = 440 Hz (MIDI 69). `A2` → 110, `C4` → 261.63. */
function hzOf(note: Note): number {
  const octave = Number(note.slice(-1));
  const pitchClass = note.slice(0, -1) as PitchClass;
  return 440 * 2 ** (((octave + 1) * 12 + SEMITONE[pitchClass] - 69) / 12);
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

type Eight<T> = readonly [T, T, T, T, T, T, T, T];
type Four<T> = readonly [T, T, T, T];

/** One bar: eight eighth-notes of lead over four quarter-notes of bass. */
type Bar = {
  readonly lead: Eight<Note>;
  readonly bass: Four<Note>;
};

// Am → F → C → G, the i–VI–III–VII everyone already knows, which is the point:
// the roll is a joke and the tune should land as one. Each lead bar walks the
// chord up, back down, and exits on a step towards the next chord's root. The
// bass is root · root · fifth · root, staying inside 87–165 Hz so it sits
// under the lead instead of fighting it.
//
// Adding bars five to eight is adding entries HERE. Nothing below counts to
// four.
const BARS: readonly [Bar, ...Bar[]] = [
  { lead: ["A4", "C5", "E5", "A5", "E5", "C5", "A4", "B4"], bass: ["A2", "A2", "E3", "A2"] },
  { lead: ["F4", "A4", "C5", "F5", "C5", "A4", "F4", "G4"], bass: ["F2", "F2", "C3", "F2"] },
  { lead: ["E4", "G4", "C5", "E5", "C5", "G4", "E4", "F4"], bass: ["C3", "C3", "G2", "C3"] },
  { lead: ["D4", "G4", "B4", "D5", "B4", "G4", "D4", "E4"], bass: ["G2", "G2", "D3", "G2"] },
];

type Drum = "hat" | "snare";

// ONE noise channel, so the backbeat snare takes the hat's slot rather than
// stacking on it — see the header. Indices 2 and 6 are beats 2 and 4.
const DRUMS: Eight<Drum | null> = ["hat", "hat", "snare", "hat", "hat", "hat", "snare", "hat"];

/** One eighth note. 0.24 s ⇒ 125 BPM, unchanged from #1773. */
const STEP_S = 0.24;
/** Bar length, in seconds. */
export const BAR_S = 8 * STEP_S;
/** How many bars before the phrase repeats. */
export const BAR_COUNT = BARS.length;
/** How long the whole phrase runs before it loops. THE number #1916 asked for. */
export const PHRASE_S = BAR_COUNT * BAR_S;

const BASS_S = 2 * STEP_S;
const HAT_S = 0.03;
const SNARE_S = 0.12;

// ---------------------------------------------------------------------------
// Gain budget
//
// Quiet on purpose: this opens without being asked for, on a surface someone
// may be showing a colleague. Loud enough to be a joke, not loud enough to be
// an incident.
//
// `PEAK_GAIN` is the master and is UNCHANGED from #1773. Every voice below
// declares its envelope peak RELATIVE to it, so the worst instant this mix can
// produce is `PEAK_GAIN × (sum of the peaks of whatever overlaps)`. #1773's
// worst instant was a lead note (1) over the drone (0.025 / 0.06 = 0.4167) —
// 1.4167, i.e. 0.085 absolute. The numbers below are chosen so the new worst
// instant (lead + bass + snare = 1.41) stays under that, and
// `creditsAudio.test.ts` measures it from this data rather than trusting the
// arithmetic in this comment.
// ---------------------------------------------------------------------------

/** Master gain. Deliberate, and not to be raised — see above. */
export const PEAK_GAIN = 0.06;
const LEAD_PEAK = 1;
const BASS_PEAK = 0.28;
const HAT_PEAK = 0.05;
const SNARE_PEAK = 0.13;

/** Ramp constant for the mute toggle. An instant gain jump clicks. */
const MUTE_RAMP_S = 0.02;
/** Exponential ramps cannot reach zero; this is the working silence. */
const GAIN_FLOOR = 0.0001;
/** Fraction of a note spent decaying — the rest is the gap that articulates it. */
const DECAY_FRACTION = 0.9;
const ATTACK_S = 0.006;

// ---------------------------------------------------------------------------
// The score, expanded to events
// ---------------------------------------------------------------------------

export type CreditsVoice = "lead" | "bass" | "hat" | "snare";

/** One scheduled sound. Times are relative to the START OF ITS BAR. */
export type CreditsEvent = {
  readonly voice: CreditsVoice;
  /** Oscillator pitch, or `null` for the noise voices. */
  readonly hz: number | null;
  readonly at: number;
  /** How long the source runs before it is stopped. */
  readonly durS: number;
  /**
   * How long the envelope takes to reach silence — always shorter than
   * `durS`, and the gap between the two is what articulates one note from the
   * next. It is a FIELD rather than a fraction applied at render time because
   * it is the note's audible span, and that is what a loudness measurement has
   * to sum over: measuring against `durS` instead makes two adjacent notes
   * "overlap" by one float ULP and doubles the answer.
   */
  readonly decayS: number;
  /** Envelope peak RELATIVE to the master gain: 1 means `PEAK_GAIN`. */
  readonly peak: number;
};

/**
 * The events of bar `index`, which wraps — `creditsBar(BAR_COUNT)` is bar 0
 * again. Pure: the scheduler renders these, and the test measures them.
 */
export function creditsBar(index: number): readonly CreditsEvent[] {
  // `?? BARS[0]` is unreachable after the modulo; it is how a non-empty tuple
  // is spelled under `noUncheckedIndexedAccess` without a throw.
  const bar = BARS[((index % BAR_COUNT) + BAR_COUNT) % BAR_COUNT] ?? BARS[0];
  const events: CreditsEvent[] = [];

  bar.lead.forEach((note, i) => {
    events.push({
      voice: "lead",
      hz: hzOf(note),
      at: i * STEP_S,
      durS: STEP_S,
      decayS: STEP_S * DECAY_FRACTION,
      peak: LEAD_PEAK,
    });
  });

  bar.bass.forEach((note, i) => {
    events.push({
      voice: "bass",
      hz: hzOf(note),
      at: i * BASS_S,
      durS: BASS_S,
      decayS: BASS_S * DECAY_FRACTION,
      peak: BASS_PEAK,
    });
  });

  DRUMS.forEach((drum, i) => {
    if (drum === null) return;
    const durS = drum === "hat" ? HAT_S : SNARE_S;
    events.push({
      voice: drum,
      hz: null,
      at: i * STEP_S,
      durS,
      decayS: durS * DECAY_FRACTION,
      peak: drum === "hat" ? HAT_PEAK : SNARE_PEAK,
    });
  });

  return events;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Seconds of noise held in the shared buffer bursts are cut out of. */
const NOISE_S = 1;
/** How far ahead of the audio clock a bar is armed. */
const LOOKAHEAD_S = 0.35;
/** How often the main thread checks whether the next bar is due. */
const PUMP_MS = 100;

function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * NOISE_S));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Start the soundtrack on `ctx`, which this function then OWNS — `stop()`
 * closes it. Never throws: a browser that refuses a node leaves the modal
 * silent rather than broken.
 */
export function startCreditsArpeggio(ctx: AudioContext, muted: boolean): CreditsArpeggio {
  const master = ctx.createGain();
  master.gain.value = muted ? 0 : PEAK_GAIN;
  master.connect(ctx.destination);

  // Every source is kept so `stop()` can silence one scheduled a beat into the
  // future — `onended` cannot be relied on for that, because a note that has
  // not started yet never ends.
  const voices: AudioScheduledSourceNode[] = [];
  let noise: AudioBuffer | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let barIndex = 0;
  let nextBarAt = 0;

  // Called once the source has been STARTED: `stop()` on a source that never
  // started is an InvalidStateError, and the two sources start differently
  // (an oscillator takes a time, a burst takes a time and an offset).
  const keep = (source: AudioScheduledSourceNode, env: GainNode, stopAt: number): void => {
    source.stop(stopAt);
    voices.push(source);
    source.onended = (): void => {
      const i = voices.indexOf(source);
      if (i !== -1) voices.splice(i, 1);
      source.disconnect();
      env.disconnect();
    };
  };

  const scheduleEvent = (event: CreditsEvent, base: number): void => {
    const at = base + event.at;
    // A browser that refused the buffer gets no percussion; the tuned voices
    // still play. Checked BEFORE the gain node so the refusal costs no node.
    if (event.hz === null && noise === null) return;

    const env = ctx.createGain();
    // Pluck: near-instant attack, exponential decay over the note. Exponential
    // because a linear fade on a plucked tone reads as a cut.
    env.gain.setValueAtTime(GAIN_FLOOR, at);
    env.gain.exponentialRampToValueAtTime(event.peak, at + Math.min(ATTACK_S, event.durS * 0.2));
    env.gain.exponentialRampToValueAtTime(GAIN_FLOOR, at + event.decayS);
    env.connect(master);

    if (event.hz === null && noise !== null) {
      const burst = ctx.createBufferSource();
      burst.buffer = noise;
      burst.connect(env);
      // Cut each burst from a different place in the buffer, or every hat is
      // byte-identical and the row reads as a machine gun rather than a hat.
      burst.start(at, Math.random() * Math.max(0, NOISE_S - event.durS));
      keep(burst, env, at + event.durS);
      return;
    }

    const osc = ctx.createOscillator();
    // THE chiptune swap (#1916): pulse lead, triangle bass.
    osc.type = event.voice === "lead" ? "square" : "triangle";
    osc.frequency.value = event.hz ?? 0;
    osc.connect(env);
    osc.start(at);
    keep(osc, env, at + event.durS);
  };

  // Bars are placed against `ctx.currentTime` and never against a timer: a
  // per-note timer would put the rhythm on the main thread's mercy. The timer
  // only asks "is the next bar within the lookahead window yet".
  const pump = (): void => {
    if (stopped) return;
    // A backgrounded tab freezes setTimeout while the audio clock keeps
    // running. Without this resync the catch-up below would arm every missed
    // bar at once with start times in the PAST — which WebAudio renders
    // immediately, i.e. all together. That is the one way this can get loud,
    // and it is exactly the case the gain budget above cannot defend against.
    if (nextBarAt < ctx.currentTime) nextBarAt = ctx.currentTime;
    while (nextBarAt < ctx.currentTime + LOOKAHEAD_S) {
      for (const event of creditsBar(barIndex)) scheduleEvent(event, nextBarAt);
      barIndex += 1;
      nextBarAt += BAR_S;
    }
    timer = setTimeout(pump, PUMP_MS);
  };

  try {
    if (ctx.state === "suspended") void ctx.resume();
    noise = makeNoiseBuffer(ctx);
    nextBarAt = ctx.currentTime;
    pump();
  } catch {
    // A browser that refuses to start the graph gets a silent modal, not a
    // broken one. Nothing below depends on the loop having armed.
  }

  return {
    setMuted: (next: boolean): void => {
      if (stopped) return;
      master.gain.setTargetAtTime(next ? 0 : PEAK_GAIN, ctx.currentTime, MUTE_RAMP_S);
    },
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const voice of voices) {
        try {
          voice.stop();
        } catch {
          // Already stopped, or never started. Either way it is silent.
        }
        voice.disconnect();
      }
      voices.length = 0;
      master.disconnect();
      void ctx.close();
    },
  };
}
