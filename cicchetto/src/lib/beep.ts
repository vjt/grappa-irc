// In-app beep for foreground alerts.
//
// UX-6-L (2026-05-20) — when the cic page is foreground and a
// notification-worthy WS event arrives (channel mention or inbound
// DM), play a short sine-wave tone instead of relying on the OS
// notification (which the SW suppresses for visible windows per
// `lib/pushDedup.ts`).
//
// Web Audio API only — no asset bytes, no autoplay-policy
// negotiation beyond the first user gesture that any cic session
// already produces (login click, channel switch, etc.). The
// AudioContext is lazy-initialised on the first call so SSR /
// older browsers without `AudioContext` don't fail at import time.
//
// Test seam: when `playBeep` fires it stamps
// `window.__lastBeepAt = Date.now()` so e2e + CDP smoke can assert
// on the last-beep timestamp without poking at the AudioContext
// itself (Playwright cannot observe sound). Production callers
// don't read the property.

const BEEP_FREQ_HZ = 440;
const BEEP_DURATION_MS = 80;
const BEEP_GAIN = 0.1;

let ctx: AudioContext | null = null;

declare global {
  interface Window {
    __lastBeepAt?: number;
  }
}

export function playBeep(): void {
  if (typeof window === "undefined") return;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;

  try {
    if (ctx === null) ctx = new Ctor();
    // Some browsers suspend the context until the next user gesture.
    // Resume is a no-op if already running; ignore the promise — the
    // beep simply doesn't play if the resume hasn't completed by the
    // time the oscillator starts, and the next beep tries again.
    if (ctx.state === "suspended") void ctx.resume();

    // Stamp BEFORE the oscillator so the e2e test seam advances even
    // if `osc.start()` throws (e.g. ctx in an invalid state). The
    // contract surface this property exposes is "playBeep was
    // called", not "audio actually played" — the latter is
    // unobservable from Playwright. Keep stamp tied to the
    // attempt-to-play, not the success-of-play.
    window.__lastBeepAt = Date.now();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = BEEP_FREQ_HZ;
    gain.gain.value = BEEP_GAIN;
    osc.connect(gain).connect(ctx.destination);

    const now = ctx.currentTime;
    osc.start(now);
    osc.stop(now + BEEP_DURATION_MS / 1000);
  } catch {
    // Audio failure is non-fatal — the unread badge + sidebar bump
    // still surface the event. Suppress so a beep glitch never
    // crashes the WS handler.
  }
}
