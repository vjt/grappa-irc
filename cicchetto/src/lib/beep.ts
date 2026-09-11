// In-app beep for foreground alerts.
//
// UX-6-L (2026-05-20) — when a notification-worthy WS event arrives (channel
// mention or inbound DM) for a conversation the operator is NOT looking at,
// play a short sound instead of relying on the OS notification (which the SW
// suppresses for visible windows per `lib/pushDedup.ts`).
//
// 🔴 The gate is per-CONVERSATION focus, not page foreground, and this comment
// used to say the opposite. Measured at the call site (#1480,
// `lib/subscribe.ts` — `!effectivelyFocused(slug, displayName)`): the beep
// fires for a background TAB too, as long as the page is alive. That is not a
// detail — it is exactly the case the deadbeef_ report hit, cicchetto sitting
// behind a macOS Focus session, and a reader who trusted the old sentence
// would have looked for the bug in the wrong half of the system.
//
// ## Which sound (#1480)
//
// The preset is DATA — `lib/notificationSound.ts` owns the table — and it
// arrives as an ARGUMENT, from the caller that already holds the subject's
// prefs. This module reads no store: same input, same sound, and the settings
// drawer's preview button reaches the identical door as the live notify path
// (CLAUDE.md — one feature, one code path, every door).
//
// Two species, one exhaustive switch: an oscillator recipe we synthesise, or
// an mp3 we fetch once and decode into this same `AudioContext`. Decoded
// buffers are cached in-module, so a preset costs one round trip per session
// and the service worker serves it from precache offline.
//
// Everything is wrapped in a `try` that swallows: audio failure is non-fatal,
// the unread badge and the sidebar bump still surface the event. The
// AudioContext is lazy-initialised on the first call so SSR / older browsers
// without `AudioContext` don't fail at import time.
//
// Test seam: when `playBeep` schedules something it stamps
// `window.__lastBeepAt = Date.now()` so e2e + CDP smoke can assert on the
// last-beep timestamp without poking at the AudioContext itself (Playwright
// cannot observe sound). 🔴 `none` returns BEFORE the stamp, deliberately:
// silence is not an attempt to play, and a seam that ticked for the default
// preset would report "beeped" for every user who never opted in — which is
// everybody, which would make the seam useless exactly where the e2e needs
// it. Production callers don't read the property.

import {
  NOTIFICATION_SOUND_PRESETS,
  type NotificationSound,
  type SoundPreset,
  type SoundVoice,
} from "./notificationSound";

// Shared amplitude envelope, in seconds. A bare gain step clicks at both ends;
// a 5 ms attack and a decay to (near) zero is the cheapest fix that costs no
// extra node. `exponentialRampToValueAtTime` cannot reach 0, hence the epsilon.
const ATTACK_S = 0.005;
const SILENCE_GAIN = 0.0001;

let ctx: AudioContext | null = null;

// url → the decode, memoised. The PROMISE is cached rather than the buffer so
// two beeps in the same tick share one fetch; a rejection evicts its entry so
// a later attempt can retry rather than being poisoned for the session.
const sampleBuffers = new Map<string, Promise<AudioBuffer>>();

declare global {
  interface Window {
    __lastBeepAt?: number;
  }
}

function audioContext(): AudioContext | null {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (ctx === null) ctx = new Ctor();
  return ctx;
}

function playVoice(context: AudioContext, voice: SoundVoice, startAt: number): void {
  const osc = context.createOscillator();
  const gain = context.createGain();
  const at = startAt + voice.atMs / 1000;
  const end = at + voice.durationMs / 1000;

  osc.type = voice.wave;
  osc.frequency.setValueAtTime(voice.fromHz, at);
  // Flat when `fromHz === toHz`, which is the common case and costs the same.
  osc.frequency.linearRampToValueAtTime(voice.toHz, end);

  gain.gain.setValueAtTime(SILENCE_GAIN, at);
  gain.gain.linearRampToValueAtTime(voice.gain, at + ATTACK_S);
  gain.gain.exponentialRampToValueAtTime(SILENCE_GAIN, end);

  osc.connect(gain).connect(context.destination);
  osc.start(at);
  osc.stop(end);
}

function decodeSample(context: AudioContext, url: string): Promise<AudioBuffer> {
  const cached = sampleBuffers.get(url);
  if (cached !== undefined) return cached;

  const pending = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`sound fetch failed: ${res.status}`);
      return res.arrayBuffer();
    })
    .then((bytes) => context.decodeAudioData(bytes))
    .catch((err) => {
      sampleBuffers.delete(url);
      throw err;
    });

  sampleBuffers.set(url, pending);
  return pending;
}

function playSample(context: AudioContext, url: string, peakGain: number): void {
  // Fire-and-forget: the fetch/decode is async and nothing downstream waits on
  // the sound. A failure is swallowed for the same reason the synth path's is
  // — the badge already told the operator something arrived.
  void decodeSample(context, url)
    .then((buffer) => {
      const src = context.createBufferSource();
      const gain = context.createGain();
      src.buffer = buffer;
      gain.gain.value = peakGain;
      src.connect(gain).connect(context.destination);
      src.start();
    })
    .catch(() => {});
}

function playPreset(context: AudioContext, preset: SoundPreset): void {
  switch (preset.kind) {
    case "silent":
      return;
    case "synth": {
      const now = context.currentTime;
      for (const voice of preset.voices) playVoice(context, voice, now);
      return;
    }
    case "sample":
      playSample(context, preset.url, preset.gain);
      return;
  }
}

/**
 * Play `sound`. Silent presets, unsupported browsers and every audio failure
 * are no-ops — never a throw, since this runs inside the WS message handler.
 */
export function playBeep(sound: NotificationSound): void {
  if (typeof window === "undefined") return;

  const preset = NOTIFICATION_SOUND_PRESETS[sound];
  // Before the context is even built: the opted-out majority should not be
  // constructing an AudioContext on every mention, and the seam below must
  // stay honest about what was scheduled.
  if (preset.kind === "silent") return;

  try {
    const context = audioContext();
    if (context === null) return;

    // Some browsers suspend the context until the next user gesture. Resume is
    // a no-op if already running; ignore the promise — the sound simply
    // doesn't play if the resume hasn't completed in time, and the next one
    // tries again. The settings preview button exists to make that gesture
    // deliberately, on the surface where the choice is made.
    if (context.state === "suspended") void context.resume();

    // Stamp BEFORE scheduling so the seam advances even if a node constructor
    // throws (e.g. ctx in an invalid state). The contract is "playBeep
    // scheduled a non-silent preset", not "audio was audible" — the latter is
    // unobservable from Playwright.
    window.__lastBeepAt = Date.now();

    playPreset(context, preset);
  } catch {
    // Audio failure is non-fatal — the unread badge + sidebar bump still
    // surface the event. Suppress so a beep glitch never crashes the WS
    // handler.
  }
}
