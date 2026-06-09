import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/compose", () => ({
  getDraft: vi.fn(() => ""),
  setDraft: vi.fn(),
  submit: vi.fn(),
  recallPrev: vi.fn(),
  recallNext: vi.fn(),
  tabComplete: vi.fn(),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

let mockUploadStateValue: {
  filename: string;
  loaded: number;
  total: number;
  phase?: "transcoding" | "uploading";
  error?: string;
} | null = null;

vi.mock("../lib/uploadOrchestrator", () => {
  const actual = {
    triggerUpload: vi.fn(),
    cancelUpload: vi.fn(),
    dismissUpload: vi.fn(),
    retryUpload: vi.fn(),
    uploadState: vi.fn(() => mockUploadStateValue),
  };
  return actual;
});

vi.mock("../lib/uploadHost", async () => {
  const actual = await vi.importActual<typeof import("../lib/uploadHost")>("../lib/uploadHost");
  return actual;
});

let mockWindowState: Record<string, string> = {};
let mockNetworkConnectionState: Record<string, string | undefined> = {};

vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => mockWindowState,
}));

vi.mock("../lib/networks", () => ({
  // Bucket F H4: ComposeBox narrows on `kind === "user"` before
  // reading connection_state. Tests exercise the user branch (the
  // greyed cascade only applies to user subjects' credential rows;
  // visitors don't have one). Default to "connected" when the
  // per-test override is absent so the not-greyed branch is the
  // baseline.
  networkBySlug: (slug: string) => ({
    kind: "user",
    id: 1,
    slug,
    nick: "vjt",
    inserted_at: "",
    updated_at: "",
    connection_state: mockNetworkConnectionState[slug] ?? "connected",
    connection_state_reason: null,
    connection_state_changed_at: null,
  }),
}));

import ComposeBox from "../ComposeBox";

beforeEach(() => {
  vi.clearAllMocks();
  mockWindowState = {};
  mockNetworkConnectionState = {};
  mockUploadStateValue = null;
});

describe("ComposeBox", () => {
  it("renders a textarea + send button with channel placeholder", () => {
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    expect(screen.getByPlaceholderText(/message #a/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  // UX-6 bucket F (2026-05-21) — send button reshaped: aria-label +
  // SVG paper-plane glyph (vjt iPhone-dogfood Bug 7). SVG (not a
  // Unicode codepoint) so the glyph survives Linux/Windows monospace
  // font-stack fallback — `.compose-box button` inherits `--font-mono`
  // whose Consolas/Liberation/DejaVu members lack Dingbats glyphs.
  it("UX-6-F — send button uses SVG glyph + aria-label, NOT literal 'send' text", () => {
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const btn = screen.getByRole("button", { name: /send message/i });
    expect(btn.getAttribute("aria-label")).toMatch(/send message/i);
    // Visible label is the SVG glyph, not text. Pre-bucket textContent
    // was "send"; post-bucket it's empty (SVG children carry no text).
    expect(btn.textContent?.trim()).toBe("");
    expect(btn.querySelector("[data-testid='compose-send-glyph']")).not.toBeNull();
  });

  it("typing fires compose.setDraft", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    fireEvent.input(screen.getByPlaceholderText(/message #a/i), {
      target: { value: "hi" },
    });
    expect(compose.setDraft).toHaveBeenCalled();
  });

  it("Enter (no shift) submits", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ ok: true });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(compose.submit).toHaveBeenCalledWith(expect.anything(), "freenode", "#a");
  });

  it("Shift+Enter inserts a newline (does NOT submit)", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(compose.submit).not.toHaveBeenCalled();
  });

  it("Up arrow on first-line cursor calls recallPrev", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(compose.recallPrev).toHaveBeenCalled();
  });

  it("Down arrow on last-line cursor calls recallNext", async () => {
    const compose = await import("../lib/compose");
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(compose.recallNext).toHaveBeenCalled();
  });

  it("error from submit renders an alert banner", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ error: "unknown command: /whois" });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter" });
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(/unknown command/i);
  });

  it("'empty' error from submit does NOT render the alert banner", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ error: "empty" });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i);
    fireEvent.keyDown(ta, { key: "Enter" });
    // Wait a tick for the async submit to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("textarea retains focus after a successful submit", async () => {
    const compose = await import("../lib/compose");
    vi.mocked(compose.submit).mockResolvedValue({ ok: true });
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;
    ta.focus();
    expect(document.activeElement).toBe(ta);
    fireEvent.keyDown(ta, { key: "Enter" });
    // Wait for the async submit to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(ta);
  });

  it("textarea has no `disabled` attribute (regression guard for focus loss)", () => {
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;
    expect(ta.hasAttribute("disabled")).toBe(false);
  });

  // CP15 B5: greyed-state visual when window state is failed/kicked/parked.
  // The form root gets `.compose-box-greyed`; an inline "(not joined)"
  // label sits beneath the textarea. Compose stays functional — the
  // operator can still type `/join` / `/part`. The visual cue tells
  // them their typing won't reach the channel without a re-join.
  it("renders .compose-box-greyed when state=failed", () => {
    mockWindowState = { "freenode #a": "failed" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(true);
  });

  it("renders .compose-box-greyed when state=kicked", () => {
    mockWindowState = { "freenode #a": "kicked" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(true);
  });

  it("renders .compose-box-greyed when state=parked", () => {
    mockWindowState = { "freenode #a": "parked" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(true);
  });

  it("renders the '(not joined)' label when state=failed", () => {
    mockWindowState = { "freenode #a": "failed" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    expect(screen.getByText(/\(not joined\)/i)).toBeInTheDocument();
  });

  it("does NOT render .compose-box-greyed when state=joined", () => {
    mockWindowState = { "freenode #a": "joined" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(false);
    expect(screen.queryByText(/\(not joined\)/i)).toBeNull();
  });

  it("does NOT render .compose-box-greyed when state=pending", () => {
    // Pending = JOIN in flight. Compose stays normal; the operator
    // typed JOIN and is awaiting the upstream echo.
    mockWindowState = { "freenode #a": "pending" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(false);
    expect(screen.queryByText(/\(not joined\)/i)).toBeNull();
  });

  it("does NOT render .compose-box-greyed for query windows (no state entry)", () => {
    // Query windows (DMs) have no window-state entry — they're always
    // "live" (no JOIN gate). Absence of the entry must not grey the
    // compose box, otherwise every DM looks broken.
    mockWindowState = {};
    render(() => <ComposeBox networkSlug="freenode" channelName="vjt" />);
    const form = document.querySelector(".compose-box");
    expect(form?.classList.contains("compose-box-greyed")).toBe(false);
    expect(screen.queryByText(/\(not joined\)/i)).toBeNull();
  });

  it("compose textarea remains functional when greyed (operator can still type /join)", () => {
    mockWindowState = { "freenode #a": "failed" };
    render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
    const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;
    expect(ta.hasAttribute("disabled")).toBe(false);
  });

  // CP19 T32 parked-window — per-network derivation overlay. Mirrors
  // the Sidebar derivation: when the network's credential
  // `connection_state ∈ {parked, failed}`, the compose box is greyed
  // regardless of the per-window state. Stops a parked network's
  // selected channel from looking ready-to-send.
  describe("CP19 T32 — per-network parked/failed derivation overlay", () => {
    it("renders .compose-box-greyed when network is parked, even if window state is joined", () => {
      mockNetworkConnectionState = { freenode: "parked" };
      mockWindowState = { "freenode #a": "joined" };
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const form = document.querySelector(".compose-box");
      expect(form?.classList.contains("compose-box-greyed")).toBe(true);
      expect(screen.queryByText(/\(not joined\)/i)).not.toBeNull();
    });

    it("renders .compose-box-greyed when network is failed, even with no window state entry", () => {
      mockNetworkConnectionState = { freenode: "failed" };
      mockWindowState = {};
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const form = document.querySelector(".compose-box");
      expect(form?.classList.contains("compose-box-greyed")).toBe(true);
    });

    it("does NOT render .compose-box-greyed when network is connected and window is joined", () => {
      mockNetworkConnectionState = { freenode: "connected" };
      mockWindowState = { "freenode #a": "joined" };
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const form = document.querySelector(".compose-box");
      expect(form?.classList.contains("compose-box-greyed")).toBe(false);
    });

    it("greyed when network is connected but per-window state is failed (existing rule preserved)", () => {
      mockNetworkConnectionState = { freenode: "connected" };
      mockWindowState = { "freenode #a": "failed" };
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const form = document.querySelector(".compose-box");
      expect(form?.classList.contains("compose-box-greyed")).toBe(true);
    });

    it("greyed query window when network is parked (DMs cascade too)", () => {
      mockNetworkConnectionState = { freenode: "parked" };
      mockWindowState = {};
      render(() => <ComposeBox networkSlug="freenode" channelName="vjt" />);
      const form = document.querySelector(".compose-box");
      expect(form?.classList.contains("compose-box-greyed")).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Images cluster I-2 — file picker + camera capture + drag-drop +
  // clipboard paste + inline progress + TTL dropdown.
  //
  // The privacy-modal flow + auto-send + per-host localStorage live in
  // uploadOrchestrator (mocked at module level above). ComposeBox
  // is the trigger surface — its job is to hand File objects to
  // `triggerUpload(...)` and render whatever `uploadState(key)` returns.
  // ----------------------------------------------------------------
  describe("image upload — trigger surfaces + progress UI", () => {
    const sampleImage = (): File =>
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "screenshot.png", {
        type: "image/png",
      });

    // Uploads cluster Task 7 — drop/paste accept ANY categorized MIME
    // (image/video/document); only category-less MIMEs are filtered.
    const sampleVideo = (): File =>
      new File([new Uint8Array(16)], "clip.mp4", { type: "video/mp4" });

    const sampleDocument = (): File =>
      new File(["%PDF-1.4"], "notes.pdf", { type: "application/pdf" });

    const sampleUnknownType = (): File =>
      new File([new Uint8Array(4)], "setup.exe", { type: "application/x-msdownload" });

    // jsdom 29 ships neither DataTransfer nor a constructible
    // ClipboardEvent that accepts a clipboardData option. Synthesise
    // both by hand: a minimal DataTransferLike object + a plain
    // Event with `clipboardData` slapped on (the real cic handlers
    // reach for `e.dataTransfer.files[0]` and
    // `e.clipboardData.items`, so a structural fake is enough).
    type DataTransferLike = {
      files: File[];
      items: Array<{ kind: string; type: string; getAsFile: () => File | null }>;
      types: string[];
    };

    const makeDataTransfer = (file: File | null = null, textData = ""): DataTransferLike => {
      const items: DataTransferLike["items"] = [];
      const types: string[] = [];
      if (file !== null) {
        items.push({ kind: "file", type: file.type, getAsFile: () => file });
      }
      if (textData !== "") {
        items.push({ kind: "string", type: "text/plain", getAsFile: () => null });
        types.push("text/plain");
      }
      return { files: file !== null ? [file] : [], items, types };
    };

    it("renders an image-picker button (camera icon)", () => {
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const btn = screen.getByRole("button", { name: /upload image/i });
      expect(btn).toBeInTheDocument();
    });

    it("renders a hidden file input that accepts ALL the host's MIME categories", () => {
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const input = document.querySelector(
        "input[type='file'][data-image-picker]",
      ) as HTMLInputElement | null;
      expect(input).not.toBeNull();
      // Task 7: accept spans every category the active host takes —
      // image + video + document, not image-only.
      const accept = input?.getAttribute("accept") ?? "";
      expect(accept).toMatch(/image\/png/);
      expect(accept).toMatch(/video\/mp4/);
      expect(accept).toMatch(/application\/pdf/);
    });

    it("clicking the image-picker button triggers the hidden input", () => {
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const input = document.querySelector(
        "input[type='file'][data-image-picker]",
      ) as HTMLInputElement;
      const clickSpy = vi.spyOn(input, "click");
      const btn = screen.getByRole("button", { name: /upload image/i });
      fireEvent.click(btn);
      expect(clickSpy).toHaveBeenCalled();
    });

    it("does not render a separate mobile-camera input — iOS Safari's picker exposes 'Take Photo' on the single image button", () => {
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const input = document.querySelector(
        "input[type='file'][data-camera-picker]",
      ) as HTMLInputElement | null;
      expect(input).toBeNull();
    });

    it("selecting a file via the picker calls triggerUpload with file + slug + channel", async () => {
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const input = document.querySelector(
        "input[type='file'][data-image-picker]",
      ) as HTMLInputElement;
      const file = sampleImage();
      Object.defineProperty(input, "files", {
        value: [file],
        configurable: true,
      });
      fireEvent.change(input);

      expect(orch.triggerUpload).toHaveBeenCalledWith(expect.any(String), "freenode", "#a", file);
    });

    it("dropping an image file onto the form calls triggerUpload", async () => {
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const form = document.querySelector(".compose-box") as HTMLFormElement;

      const file = sampleImage();
      fireEvent.drop(form, { dataTransfer: makeDataTransfer(file) });

      expect(orch.triggerUpload).toHaveBeenCalledWith(expect.any(String), "freenode", "#a", file);
    });

    it("dropping a video file calls triggerUpload (Task 7 — drop accepts all categories)", async () => {
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const form = document.querySelector(".compose-box") as HTMLFormElement;

      const file = sampleVideo();
      fireEvent.drop(form, { dataTransfer: makeDataTransfer(file) });

      expect(orch.triggerUpload).toHaveBeenCalledWith(expect.any(String), "freenode", "#a", file);
    });

    it("dropping a document file calls triggerUpload (Task 7 — drop accepts all categories)", async () => {
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const form = document.querySelector(".compose-box") as HTMLFormElement;

      const file = sampleDocument();
      fireEvent.drop(form, { dataTransfer: makeDataTransfer(file) });

      expect(orch.triggerUpload).toHaveBeenCalledWith(expect.any(String), "freenode", "#a", file);
    });

    it("dropping a category-less MIME is ignored — triggerUpload NOT called", async () => {
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const form = document.querySelector(".compose-box") as HTMLFormElement;

      fireEvent.drop(form, { dataTransfer: makeDataTransfer(sampleUnknownType()) });

      expect(orch.triggerUpload).not.toHaveBeenCalled();
    });

    it("ondragover prevents default to allow drop", () => {
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const form = document.querySelector(".compose-box") as HTMLFormElement;
      const event = new Event("dragover", { bubbles: true, cancelable: true });
      form.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it("pasting an image file calls triggerUpload + does NOT modify textarea", async () => {
      const orch = await import("../lib/uploadOrchestrator");
      const compose = await import("../lib/compose");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;

      const file = sampleImage();
      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: makeDataTransfer(file),
        configurable: true,
      });
      ta.dispatchEvent(pasteEvent);

      expect(orch.triggerUpload).toHaveBeenCalledWith(expect.any(String), "freenode", "#a", file);
      // Textarea content stays untouched (paste event was prevented).
      expect(compose.setDraft).not.toHaveBeenCalled();
    });

    it("pasting plain text does NOT trigger upload + leaves textarea paste behavior alone", async () => {
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;

      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: makeDataTransfer(null, "hello pasted text"),
        configurable: true,
      });
      ta.dispatchEvent(pasteEvent);

      expect(orch.triggerUpload).not.toHaveBeenCalled();
    });

    it("pasting a video file calls triggerUpload (Task 7 — paste accepts all categories)", async () => {
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;

      const file = sampleVideo();
      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: makeDataTransfer(file),
        configurable: true,
      });
      ta.dispatchEvent(pasteEvent);

      expect(orch.triggerUpload).toHaveBeenCalledWith(expect.any(String), "freenode", "#a", file);
    });

    it("pasting a document file calls triggerUpload (Task 7 — paste accepts all categories)", async () => {
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;

      const file = sampleDocument();
      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: makeDataTransfer(file),
        configurable: true,
      });
      ta.dispatchEvent(pasteEvent);

      expect(orch.triggerUpload).toHaveBeenCalledWith(expect.any(String), "freenode", "#a", file);
    });

    it("pasting a category-less MIME file is ignored — triggerUpload NOT called", async () => {
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;

      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: makeDataTransfer(sampleUnknownType()),
        configurable: true,
      });
      ta.dispatchEvent(pasteEvent);

      expect(orch.triggerUpload).not.toHaveBeenCalled();
    });

    it("renders the inline progress row when uploadState is non-null", () => {
      mockUploadStateValue = { filename: "screenshot.png", loaded: 512, total: 2048 };
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      expect(screen.getByText(/screenshot\.png/i)).toBeInTheDocument();
      // Progress bar present (a meter, progress, or annotated div).
      const progress =
        document.querySelector("[role='progressbar']") ??
        document.querySelector(".compose-box-upload-progress");
      expect(progress).not.toBeNull();
    });

    it("transcoding phase renders the 'processing video…' label (Task 7)", () => {
      mockUploadStateValue = {
        filename: "clip.mp4",
        loaded: 0.4,
        total: 1,
        phase: "transcoding",
      };
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const label = document.querySelector(".compose-box-upload-phase");
      expect(label).not.toBeNull();
      expect(label?.textContent).toMatch(/processing video/i);
    });

    it("uploading phase does NOT render the transcoding label", () => {
      mockUploadStateValue = {
        filename: "clip.mp4",
        loaded: 512,
        total: 2048,
        phase: "uploading",
      };
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      expect(document.querySelector(".compose-box-upload-phase")).toBeNull();
    });

    it("clicking cancel on a progress row calls cancelUpload", async () => {
      mockUploadStateValue = { filename: "screenshot.png", loaded: 512, total: 2048 };
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const cancelBtn = screen.getByRole("button", { name: /cancel/i });
      fireEvent.click(cancelBtn);
      expect(orch.cancelUpload).toHaveBeenCalledWith(expect.any(String));
    });

    it("renders error UI + retry/dismiss when uploadState has an error", async () => {
      mockUploadStateValue = {
        filename: "screenshot.png",
        loaded: 0,
        total: 0,
        error: "Upload failed — network error.",
      };
      const orch = await import("../lib/uploadOrchestrator");
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      expect(screen.getByText(/network error/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /retry/i }));
      expect(orch.retryUpload).toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
      expect(orch.dismissUpload).toHaveBeenCalled();
    });

    it("compose textarea remains editable while upload is in flight", () => {
      mockUploadStateValue = { filename: "screenshot.png", loaded: 100, total: 500 };
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const ta = screen.getByPlaceholderText(/message #a/i) as HTMLTextAreaElement;
      expect(ta.hasAttribute("disabled")).toBe(false);
    });

    // UX-4 bucket M (2026-05-19) — TTL select moved to SettingsDrawer.
    // ComposeBox no longer renders ANY select inside the form; this
    // regression-guard ensures it stays out so a future re-add (under
    // any data-attr / class name) would fail loudly.
    it("does NOT render any <select> inside the compose form (TTL moved to SettingsDrawer in bucket M)", () => {
      render(() => <ComposeBox networkSlug="freenode" channelName="#a" />);
      const select = document.querySelector(".compose-box select");
      expect(select).toBeNull();
    });
  });
});
