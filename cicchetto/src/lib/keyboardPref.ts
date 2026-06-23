// Per-device opt-in for the IRC custom keyboard. Mirrors theme.ts:
// localStorage-backed boolean + a reactive signal so consumers re-render
// on toggle. NOT server-backed — this is a per-device display choice.

import { createRoot, createSignal } from "solid-js";

const STORAGE_KEY = "grappa-irc-keyboard";

export function getKeyboardPref(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}

const root = createRoot(() => {
  const [enabled, setEnabled] = createSignal(
    typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1",
  );
  return { enabled, setEnabled };
});

export const ircKeyboardEnabled = root.enabled;

export function setKeyboardPref(on: boolean): void {
  if (on) localStorage.setItem(STORAGE_KEY, "1");
  else localStorage.removeItem(STORAGE_KEY);
  root.setEnabled(on);
}
