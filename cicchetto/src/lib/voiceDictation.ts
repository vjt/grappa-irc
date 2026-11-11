// issue 2611 — dictation in the compose box: the Web Speech API's
// recognition, ON DEVICE and nothing else, feeding the normal send path as
// plain text (issue 106's input method; #314 still forbids an audio payload,
// so nothing here records or uploads a sound).
//
// On-device is the whole condition, not a preference. `SpeechRecognition`
// without `processLocally` sends the audio to the vendor's servers — on
// Chrome, to Google — so a browser that cannot do it locally does not get a
// mic button at all (Firefox has no `SpeechRecognition`; Chrome may have the
// API but not the local model, in which case `available()` says
// `downloadable` and `install()` fetches it). There is no WASM fallback:
// vjt's ruling on the issue.
//
// The session is a small state machine over a recognition object and a
// clock, kept apart from the browser so it can be tested: text is sent every
// `SEGMENT_MS`, only finalized words go out, an empty segment sends nothing,
// and a session stops at `SESSION_MS` and sends what is left.

import { createSignal } from "solid-js";
import { resolveLocale } from "./dateFormat";

/** The prefix every dictated message carries (issue 2611). */
export const DICTATION_PREFIX = "🔊 ";
/** How long one dictated message may gather words before it goes out. */
export const SEGMENT_MS = 15_000;
/** The hard cap on one dictation session. */
export const SESSION_MS = 60_000;

/** What a dictation session is doing, as the compose box draws it. */
export type DictationState =
  | { phase: "idle" }
  | {
      phase: "listening";
      /** When the session began. */
      startedAt: number;
      /** When the words gathered so far go out. */
      nextSendAt: number;
      /** What is still being recognised, shown as it comes. */
      interim: string;
    };

const [dictation, setDictation] = createSignal<DictationState>({ phase: "idle" });
export const dictationState = dictation;

// Whether this browser can dictate at all: the constructor exists AND the
// engine can run locally for the UI's language. `null` until asked, and the
// check is only asked on the operator's press — `available()`/`install()` are
// native calls, and asking them when a compose box merely mounts was measured
// to take the renderer down (a channel window in CI: "Target crashed", 30s,
// then the whole shard). Nothing native runs until a human asks to dictate.
const [dictationReady, setDictationReady] = createSignal<boolean | null>(null);
export const dictationAvailable = dictationReady;

/** The constructor the browser exposes, if any (Chrome ships the prefixed one). */
type RecognitionCtor = new () => Recognition;
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};
type RecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};
type RecognitionStatic = {
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (options: { langs: string[] }) => Promise<boolean>;
};

function recognitionCtor(): (RecognitionCtor & RecognitionStatic) | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: RecognitionCtor & RecognitionStatic;
    webkitSpeechRecognition?: RecognitionCtor & RecognitionStatic;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * Whether the browser has the API at all — synchronous and free, so the
 * compose box can draw its microphone without touching the engine. It does
 * NOT promise on-device recognition: that answer is `checkDictation()`, and
 * it is asked on the press, never on mount.
 */
export function dictationSupported(): boolean {
  return recognitionCtor() !== null;
}

/**
 * Whether dictation may be offered, asking once per page. `true` only when
 * the engine runs locally for the UI's language: `available()` absent means
 * the browser is too old to promise it, and `downloadable` is installed
 * first (the model is the browser's, not ours). Called from the press, so
 * both the question and the download happen inside a user gesture.
 */
export async function checkDictation(): Promise<boolean> {
  const ready = dictationReady();
  if (ready !== null) return ready;
  const ctor = recognitionCtor();
  let can = false;
  if (ctor !== null) {
    const lang = resolveLocale();
    if (ctor.available === undefined) {
      can = false;
    } else {
      try {
        const answer = await ctor.available({ langs: [lang], processLocally: true });
        can =
          answer === "available" ||
          (answer === "downloadable" &&
            ctor.install !== undefined &&
            (await ctor.install({ langs: [lang] })));
      } catch {
        can = false;
      }
    }
  }
  setDictationReady(can);
  return can;
}

/**
 * Asks the engine ONCE per page, off the mount path.
 *
 * vjt's ruling on the issue (2026-11-11) rejects a microphone that appears on
 * the cheap `dictationSupported()` and vanishes on the first tap: the button
 * is offered only where on-device recognition is actually usable, which means
 * `available()` has to be asked before the button is drawn. Asking it from the
 * MOUNT was measured to take the renderer down in CI (a channel window:
 * "Target crashed", then the shard), so it is asked from a task of its own,
 * after the frame that drew the box has committed — no native call inside a
 * render or a mount effect. The answer lands in `dictationAvailable()`; until
 * it does, the compose box keeps its send button.
 */
let probeStarted = false;
export function probeDictation(): void {
  if (probeStarted) return;
  probeStarted = true;
  setTimeout(() => {
    void checkDictation();
  }, 0);
}

/** Test seam — forget what the check answered. */
export function __resetDictationForTests(): void {
  setDictationReady(null);
  probeStarted = false;
  stopDictation();
}

/**
 * What one session keeps, away from the browser: the words finalized since
 * the last send, and the two clocks. `tick` answers the text to send now, or
 * null.
 */
export class DictationSession {
  private pending = "";
  private readonly startedAt: number;
  private lastSendAt: number;

  constructor(
    private readonly now: () => number,
    private readonly send: (text: string) => void,
  ) {
    this.startedAt = now();
    this.lastSendAt = this.startedAt;
  }

  /**
   * Words the engine finalized.
   *
   * Whether a later final carries a leading space is the PLATFORM's business,
   * not a contract: concatenating them raw glued two sentences into one word
   * on an engine that does not (by reading, not measured). One space is
   * inserted when neither side already has whitespace there.
   */
  final(text: string): void {
    if (text === "") return;
    const needsSpace = this.pending !== "" && !/\s$/.test(this.pending) && !/^\s/.test(text);
    this.pending += needsSpace ? ` ${text}` : text;
  }

  /** The next automatic send's instant. */
  get nextSendAt(): number {
    return Math.min(this.lastSendAt + SEGMENT_MS, this.startedAt + SESSION_MS);
  }

  /** Whether the session has reached its cap. */
  get expired(): boolean {
    return this.now() - this.startedAt >= SESSION_MS;
  }

  /**
   * Sends what the window holds, if anything, and moves the window on. An
   * empty window sends nothing (silence is not a message) and still moves
   * it, so the cadence does not collapse into a burst the moment words come.
   */
  flush(): void {
    const text = this.pending.trim();
    this.pending = "";
    this.lastSendAt = this.now();
    if (text !== "") this.send(text);
  }

  /** The clock reached `nextSendAt`: send, and answer whether the session is over. */
  tick(): boolean {
    if (this.expired) {
      this.flush();
      return true;
    }
    if (this.now() >= this.nextSendAt) this.flush();
    return false;
  }

  /** Ends the session now, sending what is left. */
  end(): void {
    this.flush();
  }
}

let session: DictationSession | null = null;
let recognition: Recognition | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * One `result` event: finals join the session, interim words are shown as they
 * come. Shared by the running session and by the graceful stop, which keeps
 * listening for the utterance `stop()` finalises.
 */
function collect(event: RecognitionEvent): void {
  const current = session;
  if (current === null) return;
  let interim = "";
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    if (result === undefined) continue;
    const transcript = result[0].transcript;
    if (result.isFinal) current.final(transcript);
    else interim += transcript;
  }
  setDictation((state) => (state.phase === "listening" ? { ...state, interim } : state));
}

/**
 * Starts dictating: the recognized text goes to `send`, one message per
 * `SEGMENT_MS` at most, prefixed with `DICTATION_PREFIX`, through the normal
 * send path. Does nothing when the browser cannot dictate on device.
 */
export async function startDictation(send: (text: string) => void): Promise<void> {
  if (session !== null) return;
  if (!(await checkDictation())) return;
  const ctor = recognitionCtor();
  if (ctor === null) return;

  const engine = new ctor();
  engine.lang = resolveLocale();
  engine.continuous = true;
  engine.interimResults = true;
  engine.processLocally = true;

  const startedAt = Date.now();
  const current = new DictationSession(Date.now, (text) => send(DICTATION_PREFIX + text));
  session = current;
  recognition = engine;
  setDictation({
    phase: "listening",
    startedAt,
    nextSendAt: current.nextSendAt,
    interim: "",
  });

  engine.onresult = (event) => collect(event);
  engine.onerror = () => stopDictation();
  engine.onend = () => stopDictation();

  timer = setInterval(() => {
    if (session === null) return;
    const over = session.tick();
    setDictation((state) =>
      state.phase === "listening"
        ? { ...state, nextSendAt: session?.nextSendAt ?? state.nextSendAt }
        : state,
    );
    if (over) stopDictation();
  }, 1000);

  try {
    engine.start();
  } catch {
    stopDictation();
  }
}

/**
 * How long a stopping engine may take to deliver its last final before the
 * session ends without it. `stop()` is asynchronous: the engine finalises the
 * audio it already has and answers `onresult` then `onend`. Two seconds is a
 * safety net for an engine that never does, not a measured deadline.
 */
export const FINISH_GRACE_MS = 2_000;
let finishTimer: ReturnType<typeof setTimeout> | null = null;

/** Ends the session: what it still holds goes out, and the state goes idle. */
function finishDictation(): void {
  if (finishTimer !== null) {
    clearTimeout(finishTimer);
    finishTimer = null;
  }
  const running = session;
  session = null;
  recognition = null;
  running?.end();
  setDictation({ phase: "idle" });
}

/**
 * Ends the session now, sending whatever it still holds — including the
 * utterance in flight.
 *
 * 🔴 THE HANDLERS STAY ATTACHED UNTIL THE ENGINE SAYS IT IS DONE. `stop()` is
 * what makes the engine finalise the audio it already captured and deliver it
 * as a final result; the first cut nulled `onresult` and THEN called `stop()`,
 * so the ordinary gesture — say a sentence, tap stop — sent nothing of it
 * (measured, against a fake that does what the spec says `stop()` does). The
 * same happened at the one-minute cap.
 */
export function stopDictation(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  const engine = recognition;
  if (engine === null) {
    finishDictation();
    return;
  }
  const done = (): void => finishDictation();
  engine.onresult = (event) => collect(event);
  engine.onerror = done;
  engine.onend = done;
  try {
    engine.stop();
  } catch {
    // Already stopped: nothing left to finalise.
    done();
    return;
  }
  // An engine that never answers must not hold the session open. Only when it
  // has not already answered synchronously inside `stop()` (a fake in a test
  // does exactly that), or the timer would outlive the session it guards.
  if (session !== null) finishTimer = setTimeout(done, FINISH_GRACE_MS);
}
