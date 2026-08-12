import { beforeEach, describe, expect, it, vi } from "vitest";

// pasteRoute is the shared clipboard-paste router (extracted from ComposeBox,
// #352). ComposeBox.test.tsx already exercises the focused path end-to-end via
// the component; these tests pin the module's contract directly — in particular
// the `nativeInsertAvailable` flag that splits the focused textarea (browser
// inserts natively) from the #352 global path (paste fired unfocused → NO
// native insert → we insert explicitly).

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

vi.mock("../lib/compose", () => ({
  getDraft: vi.fn(() => ""),
  setDraft: vi.fn(),
  // #737 — the router drops a text paste aimed at a window a paced drain is
  // still rewriting. Default false: every pre-existing case is idle.
  isDraining: vi.fn(() => false),
}));

vi.mock("../lib/confirmDialog", () => ({
  requestConfirm: vi.fn(),
}));

vi.mock("../lib/dropUpload", () => ({
  dropUpload: vi.fn(),
}));

import { setDraft } from "../lib/compose";
import { requestConfirm } from "../lib/confirmDialog";
import { dropUpload } from "../lib/dropUpload";
import {
  PASTE_UPLOAD_FILENAME,
  routeClipboardPaste,
  routePastedInput,
  uploadPastedText,
} from "../lib/pasteRoute";

type ClipItem = { kind: string; type: string; getAsFile: () => File | null };

// Synthesise a paste ClipboardEvent — jsdom ships no constructible
// ClipboardEvent that takes a clipboardData option (see ComposeBox.test.tsx),
// so build a plain Event + a structural DataTransfer with getData + items.
function pasteEvent(opts: { text?: string; file?: File | null }): {
  e: ClipboardEvent;
  preventDefault: ReturnType<typeof vi.spyOn>;
} {
  const items: ClipItem[] = [];
  if (opts.file) {
    items.push({ kind: "file", type: opts.file.type, getAsFile: () => opts.file ?? null });
  }
  const dt = {
    items,
    getData: (t: string) => (t === "text" || t === "text/plain" ? (opts.text ?? "") : ""),
  };
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: dt, configurable: true });
  const preventDefault = vi.spyOn(e, "preventDefault");
  return { e: e as unknown as ClipboardEvent, preventDefault };
}

function textarea(): HTMLTextAreaElement {
  return document.createElement("textarea");
}

// #1250 — synthesise the `beforeinput` an IME insertion fires. `dataTransfer`
// is not settable through the constructor, so it is defined on the instance
// the same way `clipboardData` is above; `data` rides the constructor, which
// is how the engines report a plain-string commit.
function inputEvent(opts: { inputType: string; dataTransferText?: string; data?: string }): {
  e: InputEvent;
  preventDefault: ReturnType<typeof vi.spyOn>;
} {
  const e = new InputEvent("beforeinput", {
    inputType: opts.inputType,
    data: opts.data ?? null,
    bubbles: true,
    cancelable: true,
  });
  if (opts.dataTransferText !== undefined) {
    Object.defineProperty(e, "dataTransfer", {
      value: { getData: (t: string) => (t === "text" ? opts.dataTransferText : "") },
      configurable: true,
    });
  }
  const preventDefault = vi.spyOn(e, "preventDefault");
  return { e, preventDefault };
}

const pngFile = (): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });

describe("pasteRoute — routeClipboardPaste", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("file paste → dropUpload + preventDefault, no text insert", () => {
    const file = pngFile();
    const { e, preventDefault } = pasteEvent({ file });
    routeClipboardPaste(e, textarea(), "freenode", "#a", true);
    expect(dropUpload).toHaveBeenCalledWith([file], "freenode", "#a");
    expect(preventDefault).toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("small text, native insert AVAILABLE → left to the browser (no insert, no preventDefault)", () => {
    const { e, preventDefault } = pasteEvent({ text: "one line" });
    routeClipboardPaste(e, textarea(), "freenode", "#a", true);
    expect(setDraft).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it("small text, native insert UNAVAILABLE (global path) → explicit insert + preventDefault", () => {
    const { e, preventDefault } = pasteEvent({ text: "one line" });
    routeClipboardPaste(e, textarea(), "freenode", "#a", false);
    expect(setDraft).toHaveBeenCalledWith("freenode #a", "one line");
    expect(preventDefault).toHaveBeenCalled();
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  // #737 — a paced drain owns the target window's draft, so the text path has
  // nowhere to put a paste. Drop it here instead of asking "Paste N lines?"
  // and then discarding the answer when the store refuses the write.
  it("#737 — text paste into a DRAINING window is dropped: no confirm, no insert", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.isDraining).mockReturnValue(true);
    try {
      for (const text of ["one line", "a\nb\nc\nd"]) {
        const { e, preventDefault } = pasteEvent({ text });
        routeClipboardPaste(e, textarea(), "freenode", "#a", false);
        expect(requestConfirm).not.toHaveBeenCalled();
        expect(setDraft).not.toHaveBeenCalled();
        expect(preventDefault).toHaveBeenCalled();
      }
    } finally {
      vi.mocked(compose.isDraining).mockReturnValue(false);
    }
  });

  // …but an UPLOAD is a separate pipeline that never touches the draft, so a
  // drain must not block it.
  it("#737 — a FILE paste still uploads while the window is draining", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.isDraining).mockReturnValue(true);
    try {
      const file = pngFile();
      const { e } = pasteEvent({ file });
      routeClipboardPaste(e, textarea(), "freenode", "#a", true);
      expect(dropUpload).toHaveBeenCalledWith([file], "freenode", "#a");
    } finally {
      vi.mocked(compose.isDraining).mockReturnValue(false);
    }
  });

  it("empty text, native insert UNAVAILABLE → focus-only no-op (no insert, no preventDefault)", () => {
    const { e, preventDefault } = pasteEvent({ text: "" });
    routeClipboardPaste(e, textarea(), "freenode", "#a", false);
    expect(setDraft).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("big text (> flood threshold) → confirm dialog, no immediate insert (both modes)", () => {
    const block = "a\nb\nc\nd";
    for (const native of [true, false]) {
      vi.clearAllMocks();
      const { e, preventDefault } = pasteEvent({ text: block });
      routeClipboardPaste(e, textarea(), "freenode", "#a", native);
      expect(requestConfirm).toHaveBeenCalledTimes(1);
      expect(preventDefault).toHaveBeenCalled();
      expect(setDraft).not.toHaveBeenCalled();
    }
  });

  it("big text confirm → onConfirm inserts the block at the caret", () => {
    const block = "a\nb\nc\nd";
    const { e } = pasteEvent({ text: block });
    routeClipboardPaste(e, textarea(), "freenode", "#a", false);
    const req = vi.mocked(requestConfirm).mock.calls[0]?.[0];
    expect(req).toBeDefined();
    req?.onConfirm();
    expect(setDraft).toHaveBeenCalledWith("freenode #a", block);
  });
});

// #1250 — the IME door. GBoard's clipboard chip fires NO `paste` event: it
// commits through the input method, which surfaces only as `beforeinput` with
// an `insertFromPaste` inputType. Before this the flood cap was not weak on
// that path, it was absent — `classifyPaste` never ran, so an operator could
// paste an arbitrary burst by choosing the chip over the long-press menu.
describe("pasteRoute — routePastedInput (IME insertFromPaste, #1250)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const BLOCK_OVER_LIMIT = "a\nb\nc\nd\ne\nf\ng";
  const BLOCK_CONFIRM = "a\nb\nc\nd";

  it("over-limit IME paste → hard close: the upload dialog, and the text never lands", () => {
    const { e, preventDefault } = inputEvent({
      inputType: "insertFromPaste",
      dataTransferText: BLOCK_OVER_LIMIT,
    });
    routePastedInput(e, textarea(), "freenode", "#a");

    expect(preventDefault).toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
    const req = vi.mocked(requestConfirm).mock.calls[0]?.[0];
    // The over-limit arm is the one with no paste door: upload IS the
    // affirmative and there is no alternative offered.
    expect(req?.confirmLabel).toBe("Upload as .txt");
    expect(req?.alternative).toBeNull();
  });

  it("mid-size IME paste → the same confirm dialog the clipboard door raises", () => {
    const { e, preventDefault } = inputEvent({
      inputType: "insertFromPaste",
      dataTransferText: BLOCK_CONFIRM,
    });
    routePastedInput(e, textarea(), "freenode", "#a");

    expect(preventDefault).toHaveBeenCalled();
    expect(vi.mocked(requestConfirm).mock.calls[0]?.[0]?.title).toBe("Paste as 4 messages?");
  });

  it("insertFromPasteAsQuotation is the same gesture and is guarded too", () => {
    const { e, preventDefault } = inputEvent({
      inputType: "insertFromPasteAsQuotation",
      dataTransferText: BLOCK_OVER_LIMIT,
    });
    routePastedInput(e, textarea(), "freenode", "#a");

    expect(requestConfirm).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("falls back to event.data when the insertion carries no dataTransfer", () => {
    const { e, preventDefault } = inputEvent({ inputType: "insertFromPaste", data: BLOCK_CONFIRM });
    routePastedInput(e, textarea(), "freenode", "#a");

    expect(requestConfirm).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("a one-message IME paste is left to the browser — no dialog, no preventDefault", () => {
    const { e, preventDefault } = inputEvent({
      inputType: "insertFromPaste",
      dataTransferText: "one line",
    });
    routePastedInput(e, textarea(), "freenode", "#a");

    expect(requestConfirm).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("ordinary typing is not a paste — a big insertText is untouched", () => {
    const { e, preventDefault } = inputEvent({ inputType: "insertText", data: BLOCK_OVER_LIMIT });
    routePastedInput(e, textarea(), "freenode", "#a");

    expect(requestConfirm).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

// #1250 — one gesture, at most one dialog, with no cross-event bookkeeping.
// A native paste IS reported twice, but the second report is the first one's
// default action: the UA fires `paste`, and only an uncancelled `paste`
// produces the insertion that fires `beforeinput[insertFromPaste]`. These pin
// the two halves of that argument at the unit level — that a guarded arm
// cancels (so the second report never exists) and that the pass-through arm is
// idempotent if both do fire. The ORDERING itself is a browser contract, so it
// is measured in a real browser by `paste-ime-flood-guard.spec.ts`, not
// asserted here from a synthetic event.
describe("pasteRoute — one gesture cannot ask twice (#1250)", () => {
  const BLOCK = "a\nb\nc\nd";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a guarded paste CANCELS, which is what suppresses the beforeinput that would ask again", () => {
    const { e, preventDefault } = pasteEvent({ text: BLOCK });
    routeClipboardPaste(e, textarea(), "freenode", "#a", true);

    expect(requestConfirm).toHaveBeenCalledTimes(1);
    // The whole no-double-dialog argument rests on this call: no insertion,
    // therefore no insertFromPaste, therefore no second decision.
    expect(preventDefault).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("the guarded IME arm cancels its own insertion the same way", () => {
    const { e, preventDefault } = inputEvent({
      inputType: "insertFromPaste",
      dataTransferText: BLOCK,
    });
    routePastedInput(e, textarea(), "freenode", "#a");

    expect(requestConfirm).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  // The one case where both reports DO reach the router: a below-threshold
  // paste, which cancels nothing. Running the decision twice must stay a
  // no-op — no dialog, no draft write, nothing inserted twice.
  it("a below-threshold paste reported twice inserts once and asks nothing", () => {
    const { e: pasted, preventDefault: pastePrevented } = pasteEvent({ text: "one line" });
    routeClipboardPaste(pasted, textarea(), "freenode", "#a", true);
    const { e: inserted, preventDefault: inputPrevented } = inputEvent({
      inputType: "insertFromPaste",
      dataTransferText: "one line",
    });
    routePastedInput(inserted, textarea(), "freenode", "#a");

    expect(requestConfirm).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
    expect(pastePrevented).not.toHaveBeenCalled();
    expect(inputPrevented).not.toHaveBeenCalled();
  });
});

// #1256 — the paste-as-.txt File must DECLARE utf-8. The bytes are ours
// (File encodes a USVString part as UTF-8 by spec), and a server that
// stores no charset serves no charset, which a Western-locale browser
// then decodes as windows-1252 — every accent becomes mojibake.
describe("uploadPastedText — the File declares its encoding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands dropUpload a text/plain File labelled utf-8", async () => {
    uploadPastedText("perché è così", "freenode", "#a");

    expect(dropUpload).toHaveBeenCalledTimes(1);
    const [files, slug, channel] = vi.mocked(dropUpload).mock.calls[0] ?? [];
    expect(slug).toBe("freenode");
    expect(channel).toBe("#a");
    const file = files?.[0] as File;
    expect(file.name).toBe(PASTE_UPLOAD_FILENAME);
    expect(file.type).toBe("text/plain; charset=utf-8");
    // And the label is true: the bytes really are UTF-8.
    expect(await file.text()).toBe("perché è così");
  });
});
