// #80/#816 — paste flood guard. A multi-line paste into the compose box
// becomes one PRIVMSG per line on submit (compose.ts → messageLines.ts), so a
// pasted block can flood a channel. The guard trips a confirm dialog BEFORE
// the text lands in the textarea. This module is the pure counting +
// threshold half — no DOM, no store — so the boundary is proven in isolation;
// `pasteRoute` owns the dialog call and ComposeBox the event wiring.
//
// #816 moved both halves off LINES and onto MESSAGES.
//
// The threshold: any paste that becomes more than ONE message confirms. #80
// carved out 1–3 lines as frictionless on the reasoning that short pastes are
// the common case; the ruling withdrew that carve-out, because every
// multi-message paste is a burst the operator did not compose by hand and the
// dialog is where they find out. A single line — with or without the trailing
// newline every copy leaves behind — still goes straight in.
//
// The unit: `splitMessageLines`, the SAME function the send path uses. #80
// deliberately used a different counter (lines as SEEN in the box, blank
// interior lines included), which was defensible while the dialog only asked
// "how big is this paste". It stopped being defensible once the dialog has to
// declare how many MESSAGES the paste becomes: that number is a promise about
// what send will do, so the code that does it must be the code that counts.
// `pasteFlood.test.ts` pins the two together.

import { splitMessageLines } from "./messageLines";

// How many PRIVMSGs this pasted block would become. Blank and whitespace-only
// lines yield none (#863 — the server refuses a body that is empty after
// trimming), and neither does a trailing newline.
export const pastedMessageCount = (text: string): number => splitMessageLines(text).length;

// True when a paste is large enough to guard (confirm before it lands).
export const shouldGuardPaste = (text: string): boolean => pastedMessageCount(text) > 1;
