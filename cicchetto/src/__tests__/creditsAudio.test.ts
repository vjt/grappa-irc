import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BAR_COUNT,
  BAR_S,
  type CreditsEvent,
  creditsBar,
  PEAK_GAIN,
  PHRASE_S,
  startCreditsArpeggio,
} from "../lib/creditsAudio";

// #1773 — the credit roll's synthesised soundtrack.
//
// Two things are worth proving here and neither is the music. The first is
// that it can be SILENCED, because the modal autoplays: it opens on a click,
// so the browser lets it, which means the mute control is the only thing
// standing between an easter egg and someone's open-plan office. The second
// is that it LEAVES NOTHING BEHIND — a scheduler still arming oscillators
// behind a dismissed dialog is the same battery bug as an orphaned rAF loop,
// and it is completely inaudible, so nothing but a test would ever catch it.
//
// jsdom has no WebAudio at all. The AudioContext is handed in rather than
// constructed by the module precisely so this file can supply one; the
// component does the feature test.
//
// #1916 — a third thing joins them: the arrangement is now several bars long,
// and "several bars" is the kind of claim that rots into "one bar" the moment
// someone tidies the scheduler. So the progression is proven at both ends —
// as data (`creditsBar`) and as what the scheduler actually arms over time.
// The melody itself is still NOT pinned: no test below names a frequency or a
// step length, so the tune can be rewritten without touching this file. What
// is pinned is the shape (bars differ, the phrase is the loop point), the
// timbre swap that #1916 exists for, and the LOUDNESS.
//
// The stub context's clock is a real clock. It has to be: the scheduler places
// bars against `ctx.currentTime` with a lookahead window, so a `currentTime`
// frozen at 0 would make it correctly decide there is nothing to arm yet, and
// every progression assertion below would be measuring the stub instead of the
// module. `vi.useFakeTimers()` fakes `Date` along with the timers, so the two
// advance together under `vi.advanceTimersByTime`.

type StubParam = {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
};

type StubOscillator = {
  type: string;
  frequency: StubParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};

type StubBufferSource = {
  buffer: unknown;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};

function stubParam(): StubParam {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
  };
}

function makeCtx() {
  const oscillators: StubOscillator[] = [];
  const bufferSources: StubBufferSource[] = [];
  const gains: { gain: StubParam; connect: ReturnType<typeof vi.fn> }[] = [];
  const close = vi.fn();
  const resume = vi.fn();
  const startedAt = Date.now();

  const ctx = {
    // Seconds since this context was made, off the faked `Date` — see the
    // header. A real AudioContext's clock runs; a stub whose clock does not is
    // a different module under test.
    get currentTime(): number {
      return (Date.now() - startedAt) / 1000;
    },
    state: "running" as AudioContextState,
    sampleRate: 48_000,
    destination: {} as AudioDestinationNode,
    close,
    resume,
    createGain: () => {
      const node = { gain: stubParam(), connect: vi.fn(), disconnect: vi.fn() };
      gains.push(node);
      return node;
    },
    createOscillator: () => {
      const node: StubOscillator = {
        type: "",
        frequency: stubParam(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      oscillators.push(node);
      return node;
    },
    createBuffer: (_channels: number, frames: number, _rate: number) => ({
      getChannelData: () => new Float32Array(frames),
    }),
    createBufferSource: () => {
      const node: StubBufferSource = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      bufferSources.push(node);
      return node;
    },
  };

  return { ctx: ctx as unknown as AudioContext, oscillators, bufferSources, gains, close, resume };
}

/** How many lead notes one bar carries — read off the score, never hardcoded. */
const LEAD_STEPS = creditsBar(0).filter((event) => event.voice === "lead").length;

/** The lead line the scheduler has actually armed so far, chopped into bars. */
function leadBars(oscillators: readonly StubOscillator[]): number[][] {
  const pitches = oscillators
    .filter((osc) => osc.type === "square")
    .map((osc) => osc.frequency.value);
  const bars: number[][] = [];
  for (let i = 0; i + LEAD_STEPS <= pitches.length; i += LEAD_STEPS) {
    bars.push(pitches.slice(i, i + LEAD_STEPS));
  }
  return bars;
}

describe("startCreditsArpeggio (#1773)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("opens silent when the reader has already muted it", () => {
    // Not "mutes shortly after starting": the modal remembers the mute across
    // a close and reopen within a session, and a ramp-down from full volume
    // would play the first note anyway — which is the whole thing the reader
    // asked not to happen.
    const { ctx, gains } = makeCtx();

    startCreditsArpeggio(ctx, true);

    expect(gains[0]?.gain.value).toBe(0);
  });

  it("opens audible when it has not been muted", () => {
    // The positive control for the case above: without it, a master gain
    // hard-wired to zero would pass that one and ship a silent easter egg.
    const { ctx, gains } = makeCtx();

    startCreditsArpeggio(ctx, false);

    expect(gains[0]?.gain.value).toBeGreaterThan(0);
  });

  it("ramps to silence and back on the mute toggle", () => {
    const { ctx, gains } = makeCtx();
    const arpeggio = startCreditsArpeggio(ctx, false);
    const master = gains[0];

    arpeggio.setMuted(true);
    expect(master?.gain.setTargetAtTime).toHaveBeenCalledWith(0, 0, expect.any(Number));

    arpeggio.setMuted(false);
    // A RAMP back to an AUDIBLE target, not to whatever happened to be
    // there: asserting only that setTargetAtTime was called again would pass
    // on an unmute that ramps to zero.
    const calls = master?.gain.setTargetAtTime.mock.calls ?? [];
    expect(calls[calls.length - 1]?.[0]).toBeGreaterThan(0);
  });

  it("arms the next bar while it is running", () => {
    // The positive control for the teardown case below. Without it, a
    // scheduler that never re-armed at all would pass "no new voices after
    // stop" while being broken in the opposite direction.
    const { ctx, oscillators } = makeCtx();
    startCreditsArpeggio(ctx, false);
    const firstBar = oscillators.length;

    vi.advanceTimersByTime(5_000);

    expect(oscillators.length).toBeGreaterThan(firstBar);
  });

  it("stops scheduling, silences every voice and closes the context", () => {
    const { ctx, oscillators, close } = makeCtx();
    const arpeggio = startCreditsArpeggio(ctx, false);
    const armed = oscillators.length;
    expect(armed).toBeGreaterThan(0);

    arpeggio.stop();

    // Every voice already scheduled — including a note whose start time is
    // still in the future, which `onended` can never reach because a note
    // that has not begun never ends.
    for (const osc of oscillators) {
      expect(osc.stop).toHaveBeenCalled();
      expect(osc.disconnect).toHaveBeenCalled();
    }
    expect(close).toHaveBeenCalled();

    // And nothing re-arms. This is the leak: inaudible, because the context
    // is closed, and permanent, because the timer would keep re-arming for
    // as long as the tab lives.
    vi.advanceTimersByTime(30_000);
    expect(oscillators.length).toBe(armed);
  });

  it("survives a second stop and a mute after teardown", () => {
    // The component calls stop() from an effect AND from onCleanup, so the
    // double call is the normal path, not a defensive hypothetical.
    const { ctx, close } = makeCtx();
    const arpeggio = startCreditsArpeggio(ctx, false);

    arpeggio.stop();
    arpeggio.stop();
    arpeggio.setMuted(true);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("resumes a context the browser handed back suspended", () => {
    // Safari does this more often than Chromium, and a suspended context
    // schedules everything correctly while making no sound at all.
    const { ctx, resume } = makeCtx();
    (ctx as unknown as { state: AudioContextState }).state = "suspended";

    startCreditsArpeggio(ctx, false);

    expect(resume).toHaveBeenCalled();
  });
});

describe("the credits phrase (#1916)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("is several distinct bars long, and the PHRASE is the loop point", () => {
    // The complaint #1916 records is "it repeats too soon", so the thing to
    // prove is that the repeat is a phrase away and that the bars in between
    // are not each other. Proven on the score rather than on a frequency
    // list, so rewriting the tune costs nothing here.
    expect(BAR_COUNT).toBeGreaterThan(1);

    const shapes = new Set(
      Array.from({ length: BAR_COUNT }, (_unused, i) =>
        JSON.stringify(creditsBar(i).map((event) => [event.voice, event.hz, event.at])),
      ),
    );
    expect(shapes.size).toBe(BAR_COUNT);

    // ...and bar BAR_COUNT is bar 0 again: the wrap, which is what makes it a
    // phrase rather than a one-shot that runs out.
    expect(creditsBar(BAR_COUNT)).toEqual(creditsBar(0));
  });

  it("loops seconds out rather than the ~2 s that got it filed", () => {
    // A floor, not a pin: #1916 asked for "longer", the orchestrator's call
    // was ~8 s, and any future shortening back towards the 1.92 s bar this
    // replaced should have to argue with a red test first.
    expect(PHRASE_S).toBeCloseTo(BAR_COUNT * BAR_S);
    expect(PHRASE_S).toBeGreaterThan(7);
  });

  it("arms the bars in order instead of re-arming the first one", () => {
    // The scheduler half. `creditsBar` could walk a perfect progression while
    // the pump asked it for bar 0 every time, and every assertion above would
    // still be green.
    const { ctx, oscillators } = makeCtx();
    startCreditsArpeggio(ctx, false);

    vi.advanceTimersByTime((PHRASE_S + BAR_S) * 1000);

    const bars = leadBars(oscillators);
    expect(bars.length).toBeGreaterThan(BAR_COUNT);
    expect(bars[1]).not.toEqual(bars[0]);
    expect(bars[BAR_COUNT]).toEqual(bars[0]);
  });

  it("carries the lead on a pulse and the bass on the triangle", () => {
    // THE swap #1916 is about, and nothing else in the suite would notice a
    // revert to the #1773 triangle-over-sine-drone voicing.
    const { ctx, oscillators } = makeCtx();
    startCreditsArpeggio(ctx, false);

    const types = new Set(oscillators.map((osc) => osc.type));
    expect(types).toEqual(new Set(["square", "triangle"]));

    // And the pulse is the one ON TOP: a swap that put the square underneath
    // would satisfy the set above while sounding like a fog horn.
    const lead = oscillators.filter((o) => o.type === "square").map((o) => o.frequency.value);
    const bass = oscillators.filter((o) => o.type === "triangle").map((o) => o.frequency.value);
    expect(Math.min(...lead)).toBeGreaterThan(Math.max(...bass));
  });

  it("gives the percussion its own noise source, and stop() drops those too", () => {
    // A `createBufferSource` is not an `OscillatorNode`, so the teardown case
    // in the suite above walks straight past it: an untorn-down noise channel
    // would be exactly the leak that test exists to catch, and invisible to it.
    const { ctx, bufferSources } = makeCtx();
    const arpeggio = startCreditsArpeggio(ctx, false);
    expect(bufferSources.length).toBeGreaterThan(0);

    arpeggio.stop();

    for (const burst of bufferSources) {
      expect(burst.stop).toHaveBeenCalled();
      expect(burst.disconnect).toHaveBeenCalled();
    }
  });

  it("cannot get louder than the bar it replaced", () => {
    // MEASURED off the shipped score, not read off the comment in the module.
    //
    // Method: expand two whole phrases to events (two, so the loop seam is
    // inside the window), lay them on one timeline, and take the worst
    // instant — the sum of the envelope PEAKS of everything AUDIBLE there.
    // That is an UPPER BOUND on the rendered waveform rather than the waveform
    // itself, because |sine|, |square| and |triangle| are all ≤ 1; nothing
    // here renders audio, and neither jsdom nor node has an
    // OfflineAudioContext to render it with. It is computed the same way for
    // both sides of the comparison, so the bound is what is being compared.
    //
    // `decayS`, not `durS`: a note's source outlives its envelope, and summing
    // over the source's life makes every note overlap its successor by one
    // float ULP. Measured before that was fixed — the bound read 2.61 instead
    // of 1.41, i.e. it counted two leads and two basses that were, in reality,
    // 10⁻¹⁵ s apart.
    const timeline: CreditsEvent[] = [];
    for (let bar = 0; bar < BAR_COUNT * 2; bar += 1) {
      for (const event of creditsBar(bar)) {
        timeline.push({ ...event, at: bar * BAR_S + event.at });
      }
    }

    const worstInstant = Math.max(
      ...timeline.map((anchor) =>
        timeline
          .filter((event) => event.at <= anchor.at && anchor.at < event.at + event.decayS)
          .reduce((sum, event) => sum + event.peak, 0),
      ),
    );

    // The positive control. A single voice, or an arrangement whose voices
    // never overlap, would clear the ceiling below while proving nothing.
    expect(worstInstant).toBeGreaterThan(1);

    // #1773's worst instant, from the constants it shipped with: a lead note
    // at full envelope (peak 1) over the continuous A2 drone
    // (DRONE_GAIN / PEAK_GAIN = 0.025 / 0.06), times the master.
    const pre1916MixPeak = 0.06 * (1 + 0.025 / 0.06);
    expect(PEAK_GAIN * worstInstant).toBeLessThanOrEqual(pre1916MixPeak);
  });

  it("does not dump the missed bars at once when the tab was asleep", () => {
    // A backgrounded tab freezes `setTimeout` while the audio clock keeps
    // running. Without the resync in `pump`, the catch-up loop arms every bar
    // it missed, all with start times in the PAST, which WebAudio renders
    // immediately — fifteen bars at once, and the gain budget measured above
    // says nothing at all about that instant.
    const { ctx, oscillators } = makeCtx();
    startCreditsArpeggio(ctx, false);
    const oneBar = oscillators.length;
    expect(oneBar).toBeGreaterThan(0);

    // `setSystemTime` moves the clock WITHOUT running the timers — which is
    // precisely what a sleeping tab does to them.
    vi.setSystemTime(Date.now() + 30_000);
    vi.advanceTimersByTime(250);

    expect(oscillators.length).toBeLessThanOrEqual(oneBar * 2);
  });
});
