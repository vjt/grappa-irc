// issue 2611 — the live waveform above the compose box while dictating.
//
// The Web Speech API reports words, not sound, so the level comes from the
// microphone itself: one `getUserMedia` stream, one `AnalyserNode`, and a
// frame loop that publishes the RMS as a 0..1 signal. The stream is opened
// when dictation starts and closed when it ends — a dictation session is the
// only thing that wants the microphone, and holding it open would leave the
// recording indicator lit for nothing.
//
// Everything is best-effort: a browser that refuses the stream (permission
// denied, no `mediaDevices`) leaves the level at zero and dictation still
// works, because recognition has its own microphone.

import { createSignal } from "solid-js";

const [level, setLevel] = createSignal(0);
/** The microphone's loudness, 0..1, while a meter runs; 0 otherwise. */
export const micLevel = level;

let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let frame: number | null = null;
// 🔴 A STOP THAT LANDS WHILE `getUserMedia` IS STILL PENDING. The stream does
// not exist yet, so `stopMicMeter` finds nothing to release; the awaited
// stream then lands and the meter runs with the microphone open — tracks
// never stopped, recording indicator lit until the page reloads. The window is
// the permission prompt, which the FIRST dictation always shows, and it is
// reached by a tap on stop, by a recognition error, and by an unmount.
//
// Every start and every stop bumps the generation; a stream that arrives under
// a stale one is released on the spot and never adopted.
let generation = 0;
let starting = false;

/** Starts the meter; resolves once it is running, or at once when it cannot. */
export async function startMicMeter(): Promise<void> {
  if (stream !== null || starting) return;
  const media = navigator.mediaDevices;
  if (media === undefined || media.getUserMedia === undefined) return;
  const mine = ++generation;
  starting = true;
  let opened: MediaStream;
  try {
    opened = await media.getUserMedia({ audio: true });
  } catch {
    starting = false;
    return;
  }
  starting = false;
  if (mine !== generation) {
    // Stopped while the prompt was up: this stream is nobody's.
    for (const track of opened.getTracks()) track.stop();
    return;
  }
  stream = opened;
  const Ctor = globalThis.AudioContext;
  if (Ctor === undefined) {
    stopMicMeter();
    return;
  }
  context = new Ctor();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const loop = (): void => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    // The RMS of speech sits around 0.02–0.2: scale it so an ordinary voice
    // fills most of the bar, and clamp the rest.
    setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 6));
    frame = requestAnimationFrame(loop);
  };
  loop();
}

/** Stops the meter and releases the microphone. */
export function stopMicMeter(): void {
  // Invalidates a start still waiting on the permission prompt (see above).
  generation += 1;
  starting = false;
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  void context?.close();
  context = null;
  setLevel(0);
}
