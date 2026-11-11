// issue 2611 — dictation's rules, away from the browser: a segment goes out
// every 15 seconds, only finalized words are sent, silence sends nothing,
// and a session stops at a minute. The on-device check is here too: a
// browser that cannot promise local recognition gets no microphone.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetDictationForTests,
  checkDictation,
  DICTATION_PREFIX,
  DictationSession,
  dictationAvailable,
  dictationState,
  ensureDictationModel,
  FINISH_GRACE_MS,
  probeDictation,
  SEGMENT_MS,
  SESSION_MS,
  startDictation,
  stopDictation,
} from "../lib/voiceDictation";

const clock = () => {
  let at = 0;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
};

describe("DictationSession (issue 2611)", () => {
  it("sends what the window holds every 15 seconds, and only then", () => {
    const time = clock();
    const sent: string[] = [];
    const session = new DictationSession(time.now, (text) => sent.push(text));

    session.final("hello");
    time.advance(SEGMENT_MS - 1);
    expect(session.tick()).toBe(false);
    expect(sent).toEqual([]);

    time.advance(1);
    expect(session.tick()).toBe(false);
    expect(sent).toEqual(["hello"]);

    session.final(" again");
    time.advance(SEGMENT_MS);
    session.tick();
    expect(sent).toEqual(["hello", "again"]);
  });

  it("sends nothing for a silent window, and keeps the cadence", () => {
    const time = clock();
    const sent: string[] = [];
    const session = new DictationSession(time.now, (text) => sent.push(text));

    time.advance(SEGMENT_MS);
    session.tick();
    expect(sent).toEqual([]);

    // The window has moved on: words arriving now wait for the next one.
    session.final("late");
    session.tick();
    expect(sent).toEqual([]);
    time.advance(SEGMENT_MS);
    session.tick();
    expect(sent).toEqual(["late"]);
  });

  it("ends at a minute, sending what is left", () => {
    const time = clock();
    const sent: string[] = [];
    const session = new DictationSession(time.now, (text) => sent.push(text));

    session.final("first");
    time.advance(SEGMENT_MS);
    session.tick();
    session.final("last");
    time.advance(SESSION_MS);

    expect(session.tick()).toBe(true);
    expect(sent).toEqual(["first", "last"]);
  });

  it("answers the instant of the next send, never past the cap", () => {
    const time = clock();
    const session = new DictationSession(time.now, () => undefined);

    expect(session.nextSendAt).toBe(SEGMENT_MS);
    time.advance(SEGMENT_MS);
    session.flush();
    expect(session.nextSendAt).toBe(2 * SEGMENT_MS);

    // 🔴 THE CLAMP, and the only shape that pins it: a flush late enough that
    // a whole segment would run PAST the cap. At 50 s, `lastSendAt + 15 s` is
    // 65 s and the answer must still be 60 — a flush at 45 s leaves both arms
    // equal at 60 and a mutant that drops the `Math.min` survives.
    time.advance(2 * SEGMENT_MS + 5_000);
    session.flush();
    expect(session.nextSendAt).toBe(SESSION_MS);
  });

  // The platform's word, not ours: whether a final carries a leading space is
  // its business, so two finals must not glue into one word (by reading, not
  // measured) and must not double the space either.
  it("puts one space between two finals, and only where there is none", () => {
    const time = clock();
    const sent: string[] = [];
    const session = new DictationSession(time.now, (text) => sent.push(text));

    session.final("ciao");
    session.final("a tutti");
    time.advance(SEGMENT_MS);
    session.tick();
    expect(sent).toEqual(["ciao a tutti"]);

    session.final("ok");
    session.final(" bene");
    time.advance(SEGMENT_MS);
    session.tick();
    expect(sent).toEqual(["ciao a tutti", "ok bene"]);
  });
});

describe("checkDictation (issue 2611)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetDictationForTests();
  });

  const withRecognition = (statics: Record<string, unknown>): void => {
    vi.stubGlobal("SpeechRecognition", Object.assign(class {}, statics));
  };

  // A recognition engine that behaves as the spec says: `stop()` finalises the
  // audio captured so far and answers `onresult`, then `onend`.
  const fakeEngine = (finalOnStop?: string) => {
    const engine = {
      lang: "",
      continuous: false,
      interimResults: false,
      processLocally: false,
      started: 0,
      onresult: null as null | ((event: unknown) => void),
      onerror: null as null | (() => void),
      onend: null as null | (() => void),
      say(transcript: string, isFinal: boolean) {
        engine.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] });
      },
      start() {
        engine.started += 1;
      },
      stop() {
        if (finalOnStop !== undefined) engine.say(finalOnStop, true);
        engine.onend?.();
      },
      abort() {},
    };
    return engine;
  };

  const withRecognitionFor = (engine: ReturnType<typeof fakeEngine>): void => {
    // `new Ctor()` needs a CONSTRUCTABLE function, and an arrow is not one:
    // `new (() => engine)()` throws "function is not a constructor". A plain
    // function is, and `new` keeps the object a constructor returns — which is
    // exactly the fake the module then talks to.
    // biome-ignore lint/complexity/useArrowFunction: `new` needs a constructable function, an arrow is not one
    const Ctor = function () {
      return engine;
    } as unknown as new () => unknown;
    vi.stubGlobal("SpeechRecognition", Object.assign(Ctor, { available: async () => "available" }));
  };

  it("offers no microphone where there is no SpeechRecognition at all", async () => {
    expect(await checkDictation()).toBe(false);
  });

  it("offers none when the engine cannot promise local recognition", async () => {
    withRecognition({ available: async () => "unavailable" });
    expect(await checkDictation()).toBe(false);
  });

  it("offers none when the browser cannot say whether it is local", async () => {
    withRecognition({});
    expect(await checkDictation()).toBe(false);
  });

  it("offers one when the model is there, or when it can be installed", async () => {
    withRecognition({ available: async () => "available" });
    expect(await checkDictation()).toBe(true);

    __resetDictationForTests();
    const install = vi.fn(async () => true);
    withRecognition({ available: async () => "downloadable", install });
    expect(await checkDictation()).toBe(true);
    // The offer does NOT pay for the model: `available()` is the cheap
    // question, and the download waits for the press (see
    // `ensureDictationModel`). A download on the page's first unrelated tap
    // was the defect the probe exists to avoid, one call later.
    expect(install).toHaveBeenCalledTimes(0);

    __resetDictationForTests();
    withRecognition({ available: async () => "downloadable", install: async () => false });
    expect(await checkDictation()).toBe(true);
  });

  it("downloads the model on the press, and takes the button away if it fails", async () => {
    const install = vi.fn(async () => true);
    withRecognition({ available: async () => "downloadable", install });
    expect(await checkDictation()).toBe(true);
    expect(await ensureDictationModel()).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
    // Once is enough: a second press does not download again.
    expect(await ensureDictationModel()).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);

    __resetDictationForTests();
    withRecognition({ available: async () => "downloadable", install: async () => false });
    expect(await checkDictation()).toBe(true);
    expect(await ensureDictationModel()).toBe(false);
    // A control that answers nothing is worse than no control.
    expect(dictationAvailable()).toBe(false);
  });

  it("has nothing to download when the model is already there", async () => {
    const install = vi.fn(async () => true);
    withRecognition({ available: async () => "available", install });
    expect(await checkDictation()).toBe(true);
    expect(await ensureDictationModel()).toBe(true);
    expect(install).toHaveBeenCalledTimes(0);
  });

  // The review's MAJOR: `stopDictation` nulled `onresult` BEFORE `engine.stop()`,
  // and `stop()` is what makes the engine finalise the utterance in flight. Say
  // a sentence and tap stop — the ordinary gesture — and none of it went out.
  // The fake does what the Web Speech spec says `stop()` does: it delivers a
  // final result for the audio captured so far, then `onend`.
  it("sends the utterance in flight when the operator stops", async () => {
    const engine = fakeEngine("ciao a tutti");
    withRecognitionFor(engine);
    const sent: string[] = [];

    await startDictation((text) => sent.push(text));
    expect(engine.started).toBe(1);
    expect(sent).toEqual([]);

    stopDictation();

    expect(sent).toEqual([`${DICTATION_PREFIX}ciao a tutti`]);
  });

  // Control for the case above: the same fake, words finalised BEFORE the tap.
  it("still sends the words that were already final when the operator stops", async () => {
    const engine = fakeEngine();
    withRecognitionFor(engine);
    const sent: string[] = [];

    await startDictation((text) => sent.push(text));
    engine.say("prima", true);
    stopDictation();

    expect(sent).toEqual([`${DICTATION_PREFIX}prima`]);
  });

  it("carries the marker every dictated message is sent with", () => {
    expect(DICTATION_PREFIX).toBe("🔊 ");
  });

  // The delta-2 review's MAJOR A: a second stop during the 2 s grace
  // overwrote `finishTimer` without clearing the first, and the leaked timer
  // later ended whatever session was running then — an engine still listening
  // with no UI and no reference left to stop it. A second stop is one tap away
  // (during the grace the control still reads "stop dictating and send").
  it("a second stop during the grace does not end the session that comes after it", async () => {
    vi.useFakeTimers();
    try {
      // `stop()` answers nothing: the grace is what ends the first session,
      // and the test decides when the engine finalises.
      const engine = {
        lang: "",
        continuous: false,
        interimResults: false,
        processLocally: false,
        starts: 0,
        stops: 0,
        onresult: null as null | ((event: unknown) => void),
        onerror: null as null | (() => void),
        onend: null as null | (() => void),
        start() {
          engine.starts += 1;
        },
        stop() {
          engine.stops += 1;
        },
        abort() {},
      };
      // biome-ignore lint/complexity/useArrowFunction: `new` needs a constructable function, an arrow is not one
      const Ctor = function () {
        return engine;
      } as unknown as new () => unknown;
      vi.stubGlobal(
        "SpeechRecognition",
        Object.assign(Ctor, { available: async () => "available" }),
      );
      const sent: string[] = [];
      const send = (text: string): void => {
        sent.push(text);
      };

      await startDictation(send);
      stopDictation();
      expect(engine.stops).toBe(1);

      vi.advanceTimersByTime(500);
      stopDictation();
      // The second stop does not reach the engine again: the first owns it.
      expect(engine.stops).toBe(1);

      engine.onend?.();
      expect(dictationState().phase).toBe("idle");

      await startDictation(send);
      expect(dictationState().phase).toBe("listening");

      // The first stop's timer, had it leaked, would end this session here.
      vi.advanceTimersByTime(FINISH_GRACE_MS + 1_000);
      expect(dictationState().phase).toBe("listening");
      expect(engine.stops).toBe(1);
    } finally {
      // End the session under the fake clock, so no real grace timer outlives
      // this case and no `finishTimer` survives into the next one.
      __resetDictationForTests();
      vi.advanceTimersByTime(FINISH_GRACE_MS + 1);
      vi.useRealTimers();
    }
  });
});

// The delta-2 review's BLOCKER: asking the engine when a compose box merely
// mounted took the renderer down in CI. The question is armed by the mount and
// asked by the operator's first gesture, once per page.
describe("probeDictation (issue 2611)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetDictationForTests();
  });

  const withEngine = () => {
    const available = vi.fn(async () => "available");
    vi.stubGlobal("SpeechRecognition", Object.assign(class {}, { available }));
    return available;
  };

  it("asks the engine nothing until the first gesture, then once", async () => {
    const available = withEngine();
    probeDictation();
    await Promise.resolve();
    expect(available).not.toHaveBeenCalled();

    document.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => expect(available).toHaveBeenCalledTimes(1));

    document.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(available).toHaveBeenCalledTimes(1);
  });

  it("is armed once per page, whatever asks it again", async () => {
    const available = withEngine();
    probeDictation();
    probeDictation();
    document.dispatchEvent(new Event("keydown"));
    await vi.waitFor(() => expect(available).toHaveBeenCalledTimes(1));
  });
});
