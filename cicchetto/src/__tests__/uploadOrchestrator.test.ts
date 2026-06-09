import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks — vi.mock factories run before module imports.
vi.mock("../lib/scrollback", () => ({
  sendMessage: vi.fn(async () => {}),
}));

// UX-4 bucket M (2026-05-19) — server-pref upload-TTL replaces the
// localStorage-keyed one. Mock the REST wrapper so tests don't hit
// the network; the orchestrator's internal signal still updates
// through the cache-mirror hooks.
vi.mock("../lib/userSettings", async () => {
  const actual = await vi.importActual<typeof import("../lib/userSettings")>("../lib/userSettings");
  return {
    ...actual,
    getUploadTtlSeconds: vi.fn(async () => null),
    putUploadTtlSeconds: vi.fn(async (_token: string, seconds: number | null) => seconds),
  };
});

vi.mock("../lib/uploadHost", async () => {
  const actual = await vi.importActual<typeof import("../lib/uploadHost")>("../lib/uploadHost");
  return {
    ...actual,
    activeHost: vi.fn(() => actual.litterboxHost),
  };
});

// Task 6 (2026-06-09) — the video branch awaits transcodeVideo before
// the host POST. Mock at the module boundary: these tests pin the
// orchestrator's dispatch policy (phases, fallback eligibility, cancel
// propagation), videoTranscode.test.ts pins the transcode itself.
// Deferred-resolver shape mirrors `pendingResolvers` below.
//
// Task 6 quality-review follow-up (landed with Task 7, 2026-06-09):
// the policy surface (constants + probe) lives in
// videoPolicy.ts — importActual the constants so the suite can't drift
// from the real MAX_DURATION_SECONDS; only the probe is stubbed. The
// transcode itself is loaded by the orchestrator via dynamic import()
// (mediabunny stays off the main chunk), which vi.mock intercepts too.
const vt = vi.hoisted(() => ({
  transcodes: [] as Array<{
    file: File;
    capBytes: number;
    onProgress: (fraction: number) => void;
    signal: AbortSignal;
    resolve: (
      result:
        | { ok: File }
        | { error: { kind: "too_long"; durationSeconds: number } }
        | { error: { kind: "unsupported" } }
        | { error: { kind: "failed"; message: string } },
    ) => void;
  }>,
  probeDuration: vi.fn(async (_file: File): Promise<number | null> => null),
}));

vi.mock("../lib/videoPolicy", async () => {
  const actual = await vi.importActual<typeof import("../lib/videoPolicy")>("../lib/videoPolicy");
  return { ...actual, probeDuration: vt.probeDuration };
});

vi.mock("../lib/videoTranscode", () => ({
  transcodeVideo: vi.fn(
    (file: File, capBytes: number, onProgress: (fraction: number) => void, signal: AbortSignal) =>
      new Promise((resolve) => {
        vt.transcodes.push({ file, capBytes, onProgress, signal, resolve });
      }),
  ),
}));

import { channelKey } from "../lib/channelKey";
import { sendMessage } from "../lib/scrollback";
import { activeHost, type UploadHost } from "../lib/uploadHost";
import {
  acknowledgePrivacy,
  cancelUpload,
  dismissUpload,
  loadUploadTtlSeconds,
  privacyModalState,
  resetUploadTtlSecondsForTests,
  retryUpload,
  saveUploadTtlSeconds,
  triggerUpload,
  uploadState,
  uploadTtlSecondsValue,
} from "../lib/uploadOrchestrator";
import * as userSettings from "../lib/userSettings";

const slug = "freenode";
const channel = "#a";
const key = channelKey(slug, channel);

const sampleImage = (): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "screenshot.png", { type: "image/png" });

const sampleNonImage = (): File => new File(["hello"], "notes.txt", { type: "text/plain" });

// The orchestrator pulls videoTranscode in via dynamic import() (lazy
// mediabunny chunk) — the transcode mock registers a microtask after
// triggerUpload, never synchronously.
const awaitTranscodeStart = async (n: number): Promise<void> => {
  await vi.waitFor(() => expect(vt.transcodes.length).toBe(n));
};

// Test-controlled host so we can drive resolve/reject deterministically.
// `file` is captured so category-dispatch + #49 tests can assert WHICH
// file actually went over the wire.
type Resolver = {
  file: File;
  resolve: (url: string) => void;
  reject: (err: unknown) => void;
  onProgress: (loaded: number, total: number) => void;
  signal: AbortSignal;
};

let pendingResolvers: Resolver[] = [];

const makeTestHost = (overrides: Partial<UploadHost> = {}): UploadHost => ({
  id: "test-host",
  displayName: "test.host.example",
  retentionStatement: "TEST host — files exist for the next 24 hours.",
  ttlOptions: [
    { value: "1h", label: "1 hour", seconds: 3600 },
    { value: "24h", label: "24 hours", seconds: 86_400 },
  ],
  defaultTtl: "24h",
  acceptedMimeTypes: { image: ["image/png", "image/jpeg"], video: [], document: [] },
  maxFileSizeBytes: () => 1024 * 1024,
  supportsProgress: true,
  upload: (file, _options, onProgress, signal) =>
    new Promise<string>((resolve, reject) => {
      pendingResolvers.push({
        file,
        resolve,
        reject,
        onProgress: (loaded, total) => onProgress({ loaded, total }),
        signal,
      });
    }),
  ...overrides,
});

// Host accepting all three categories with distinct per-category caps —
// category-dispatch tests (video+document uploads cluster Task 5,
// 2026-06-09).
const categoryHost = (): UploadHost =>
  makeTestHost({
    acceptedMimeTypes: {
      image: ["image/png", "image/jpeg"],
      video: ["video/mp4"],
      document: ["application/pdf", "text/plain"],
    },
    maxFileSizeBytes: (category) =>
      ({ image: 1024 * 1024, video: 5 * 1024 * 1024, document: 512 * 1024 })[category],
  });

beforeEach(() => {
  pendingResolvers = [];
  vt.transcodes = [];
  vt.probeDuration.mockResolvedValue(null);
  vi.mocked(sendMessage).mockClear();
  // Wipe localStorage between tests so privacy state doesn't leak.
  localStorage.clear();
  // Reset modal state explicitly — singleton survives across tests.
  dismissUpload(key);
  // Reset to default (litterbox).
  vi.mocked(activeHost).mockReturnValue(makeTestHost());
  // UX-4 bucket M — reset the server-pref cache so each test starts
  // from "no preference set" (host default).
  resetUploadTtlSecondsForTests();
  vi.mocked(userSettings.getUploadTtlSeconds).mockResolvedValue(null);
  vi.mocked(userSettings.putUploadTtlSeconds).mockImplementation(async (_, s) => s);
});

afterEach(() => {
  vi.clearAllMocks();
});

// --------------------------------------------------------------------
// Privacy modal gating
// --------------------------------------------------------------------

describe("privacy modal gating", () => {
  it("first upload (no localStorage flag) opens the privacy modal + does NOT trigger XHR", () => {
    triggerUpload(key, slug, channel, sampleImage());

    const modal = privacyModalState();
    expect(modal.open).toBe(true);
    expect(modal.host?.id).toBe("test-host");
    expect(pendingResolvers.length).toBe(0); // host.upload not called yet
  });

  it("acknowledgePrivacy(true) writes the per-host localStorage flag + triggers the upload", () => {
    triggerUpload(key, slug, channel, sampleImage());
    acknowledgePrivacy(true);

    expect(localStorage.getItem("image-upload-privacy-acknowledged:test-host")).toBe("1");
    expect(privacyModalState().open).toBe(false);
    expect(pendingResolvers.length).toBe(1);
  });

  it("acknowledgePrivacy(false) triggers the upload but does NOT persist", () => {
    triggerUpload(key, slug, channel, sampleImage());
    acknowledgePrivacy(false);

    expect(localStorage.getItem("image-upload-privacy-acknowledged:test-host")).toBeNull();
    expect(pendingResolvers.length).toBe(1);
  });

  it("subsequent upload with flag set bypasses the modal", () => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");

    triggerUpload(key, slug, channel, sampleImage());

    expect(privacyModalState().open).toBe(false);
    expect(pendingResolvers.length).toBe(1);
  });

  it("flag is namespaced per host id — switching hosts re-prompts", () => {
    // Ack on host A.
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    // Now switch to a different host id.
    vi.mocked(activeHost).mockReturnValue(makeTestHost({ id: "other-host" }));

    triggerUpload(key, slug, channel, sampleImage());

    expect(privacyModalState().open).toBe(true);
  });

  it("cancel from privacy modal closes modal and does NOT trigger upload", () => {
    triggerUpload(key, slug, channel, sampleImage());
    dismissUpload(key);

    expect(privacyModalState().open).toBe(false);
    expect(pendingResolvers.length).toBe(0);
  });
});

// --------------------------------------------------------------------
// MIME + size gating
// --------------------------------------------------------------------

describe("MIME + size pre-checks", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  });

  it("MIME outside the host's accepted lists → error listing supported extensions, no upload", () => {
    // text/plain is a document-category MIME, but the default test host
    // accepts no documents — generalized unsupported-type message lists
    // the extensions the host DOES take.
    triggerUpload(key, slug, channel, sampleNonImage());

    const st = uploadState(key);
    expect(st?.error).toBeTruthy();
    expect(st?.error).toMatch(/png/);
    expect(st?.error).toMatch(/jpg/);
    expect(pendingResolvers.length).toBe(0);
  });

  it("oversize file → state has error, no upload", () => {
    const big = new File([new Uint8Array(2 * 1024 * 1024)], "big.png", { type: "image/png" });
    triggerUpload(key, slug, channel, big);

    const st = uploadState(key);
    expect(st?.error).toBeTruthy();
    expect(st?.error).toMatch(/size|large/i);
    expect(pendingResolvers.length).toBe(0);
  });
});

// --------------------------------------------------------------------
// Upload lifecycle
// --------------------------------------------------------------------

describe("upload lifecycle", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  });

  it("triggers host.upload with the file + chosen TTL", () => {
    triggerUpload(key, slug, channel, sampleImage());

    expect(pendingResolvers.length).toBe(1);
    expect(uploadState(key)?.filename).toBe("screenshot.png");
    expect(uploadState(key)?.error).toBeUndefined();
    // Task 5 (2026-06-09): every entry carries a phase; "transcoding"
    // is wired by the Task 6 video transcode.
    expect(uploadState(key)?.phase).toBe("uploading");
  });

  it("progress events update uploadState's loaded/total", () => {
    triggerUpload(key, slug, channel, sampleImage());

    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");
    r.onProgress(512, 2048);

    expect(uploadState(key)?.loaded).toBe(512);
    expect(uploadState(key)?.total).toBe(2048);
  });

  it("on resolve, sends PRIVMSG with photocamera-prefixed URL body + clears state", async () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.resolve("https://litter.catbox.moe/abc.png");
    // Allow microtask queue to flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(slug, channel, "📸 https://litter.catbox.moe/abc.png");
    expect(uploadState(key)).toBeNull();
  });

  it("on reject (network), state has error string + does NOT auto-send", async () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toBeTruthy();
    expect(uploadState(key)?.error).toMatch(/network/i);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("on reject (http 413), error message is friendly + mentions size or rejection", async () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "http", status: 413, body: "Payload Too Large" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toMatch(/reject|too large|file/i);
  });

  it("on reject (http 5xx), error message mentions service / unavailable", async () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "http", status: 503, body: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toMatch(/service|unavailable|server/i);
  });

  it("on reject (abort), state is cleared silently — no error UI", async () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    r.reject({ kind: "abort" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)).toBeNull();
  });
});

// --------------------------------------------------------------------
// Cancel + dismiss + retry
// --------------------------------------------------------------------

describe("cancel + dismiss + retry", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  });

  it("cancelUpload aborts the host's signal + clears state", () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");

    cancelUpload(key);

    expect(r.signal.aborted).toBe(true);
    expect(uploadState(key)).toBeNull();
  });

  it("dismissUpload clears an error state without triggering anything", async () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");
    r.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)?.error).toBeTruthy();

    dismissUpload(key);
    expect(uploadState(key)).toBeNull();
  });

  it("retryUpload re-triggers with the original file after an error", async () => {
    triggerUpload(key, slug, channel, sampleImage());
    const r = pendingResolvers[0];
    if (!r) throw new Error("expected resolver");
    r.reject({ kind: "network" });
    await Promise.resolve();
    await Promise.resolve();

    retryUpload(key);

    expect(pendingResolvers.length).toBe(2);
    expect(uploadState(key)?.error).toBeUndefined();
  });
});

// --------------------------------------------------------------------
// Category dispatch — video+document uploads cluster Task 5 (2026-06-09)
//
// Single pipeline: categoryOf → host accept gate → transform hook
// (identity until the Task 6 video transcode) → per-category cap →
// upload → emoji-prefixed PRIVMSG (📸/🎬/📄).
// --------------------------------------------------------------------

describe("category dispatch", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    vi.mocked(activeHost).mockReturnValue(categoryHost());
  });

  it("document upload → host.upload called + 📄-prefixed PRIVMSG", async () => {
    const pdf = new File(["%PDF-1.4"], "notes.pdf", { type: "application/pdf" });
    triggerUpload(key, slug, channel, pdf);

    expect(pendingResolvers.length).toBe(1);
    pendingResolvers[0]?.resolve("https://litter.catbox.moe/abc.pdf");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(slug, channel, "📄 https://litter.catbox.moe/abc.pdf");
    expect(uploadState(key)).toBeNull();
  });

  it("image upload → 📸-prefixed PRIVMSG (via the emoji map)", async () => {
    triggerUpload(key, slug, channel, sampleImage());

    expect(pendingResolvers.length).toBe(1);
    pendingResolvers[0]?.resolve("https://litter.catbox.moe/abc.png");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(slug, channel, "📸 https://litter.catbox.moe/abc.png");
  });

  it("video upload → routed through the transcode → 🎬-prefixed PRIVMSG", async () => {
    const clip = new File([new Uint8Array(16)], "clip.mp4", { type: "video/mp4" });
    triggerUpload(key, slug, channel, clip);

    // Task 6: the transform hook is the transcode now — the host POST
    // only fires once the transcode resolves.
    await awaitTranscodeStart(1);
    expect(pendingResolvers.length).toBe(0);
    const out = new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" });
    vt.transcodes[0]?.resolve({ ok: out });
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(1));

    pendingResolvers[0]?.resolve("https://litter.catbox.moe/abc.mp4");
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        slug,
        channel,
        "🎬 https://litter.catbox.moe/abc.mp4",
      ),
    );
  });

  it("unknown MIME → error listing supported types, host.upload NOT called", () => {
    const exe = new File([new Uint8Array(4)], "setup.exe", {
      type: "application/x-msdownload",
    });
    triggerUpload(key, slug, channel, exe);

    const st = uploadState(key);
    expect(st?.error).toMatch(/png/);
    expect(st?.error).toMatch(/mp4/);
    expect(st?.error).toMatch(/pdf/);
    expect(pendingResolvers.length).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("document over the document cap → cap error message, no upload", () => {
    // 1MB pdf vs the categoryHost's 512KB document cap (image cap is
    // 1MB — a flat cap would let this through).
    const big = new File([new Uint8Array(1024 * 1024)], "big.pdf", { type: "application/pdf" });
    triggerUpload(key, slug, channel, big);

    const st = uploadState(key);
    expect(st?.error).toMatch(/too large/i);
    expect(pendingResolvers.length).toBe(0);
  });
});

// --------------------------------------------------------------------
// Video transcode branch — Task 6 (2026-06-09)
//
// Policy split lives here: too_long is POLICY (hard reject, no
// fallback); unsupported/failed are CAPABILITY (fall back to the
// original under the same duration + cap gates, console.warn the
// reason — no silent swallow). Cancel during a transcode aborts the
// transcode signal and clears state without falling back.
// --------------------------------------------------------------------

describe("video transcode branch", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const videoClip = (bytes = 16): File =>
    new File([new Uint8Array(bytes)], "clip.mp4", { type: "video/mp4" });

  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    vi.mocked(activeHost).mockReturnValue(categoryHost());
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("happy path: transcoding phase first, host receives the TRANSCODED file, 🎬 PRIVMSG", async () => {
    const clip = videoClip();
    triggerUpload(key, slug, channel, clip);

    // Transcoding entry is visible before any upload starts.
    expect(uploadState(key)?.phase).toBe("transcoding");
    expect(uploadState(key)?.filename).toBe("clip.mp4");
    expect(pendingResolvers.length).toBe(0);
    await awaitTranscodeStart(1);
    expect(vt.transcodes[0]?.file).toBe(clip);
    // The video cap (categoryHost: 5MB) drives the bitrate budget.
    expect(vt.transcodes[0]?.capBytes).toBe(5 * 1024 * 1024);

    // Transcode progress lands in the entry as a 0..1 fraction.
    vt.transcodes[0]?.onProgress(0.5);
    expect(uploadState(key)?.loaded).toBe(0.5);
    expect(uploadState(key)?.total).toBe(1);

    const out = new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" });
    vt.transcodes[0]?.resolve({ ok: out });
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(1));

    // Referential check — the host uploads the transcode OUTPUT.
    expect(pendingResolvers[0]?.file).toBe(out);
    expect(uploadState(key)?.phase).toBe("uploading");

    pendingResolvers[0]?.resolve("https://litter.catbox.moe/abc.mp4");
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        slug,
        channel,
        "🎬 https://litter.catbox.moe/abc.mp4",
      ),
    );
    expect(uploadState(key)).toBeNull();
  });

  it("too_long is POLICY: hard reject, no fallback, host.upload never called", async () => {
    triggerUpload(key, slug, channel, videoClip());

    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({ error: { kind: "too_long", durationSeconds: 300 } });
    await vi.waitFor(() => expect(uploadState(key)?.error).toBe("Video too long (max 2 minutes)."));

    expect(pendingResolvers.length).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("unsupported + small original → ORIGINAL uploads, reason console.warn'd", async () => {
    const clip = videoClip();
    triggerUpload(key, slug, channel, clip);

    vt.probeDuration.mockResolvedValue(30);
    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({ error: { kind: "unsupported" } });
    await vi.waitFor(() => expect(pendingResolvers.length).toBe(1));

    expect(pendingResolvers[0]?.file).toBe(clip);
    expect(warnSpy).toHaveBeenCalledWith("video transcode unavailable, uploading original:", {
      kind: "unsupported",
    });
  });

  it("unsupported + oversize original → cap error, no upload", async () => {
    // 6MB original vs the categoryHost 5MB video cap.
    triggerUpload(key, slug, channel, videoClip(6 * 1024 * 1024));

    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({ error: { kind: "unsupported" } });
    await vi.waitFor(() => expect(uploadState(key)?.error).toMatch(/too large/i));

    expect(pendingResolvers.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("failed + original over the 2-minute ceiling → too-long error, no fallback upload", async () => {
    triggerUpload(key, slug, channel, videoClip());

    vt.probeDuration.mockResolvedValue(200);
    await awaitTranscodeStart(1);
    vt.transcodes[0]?.resolve({ error: { kind: "failed", message: "encoder blew up" } });
    await vi.waitFor(() => expect(uploadState(key)?.error).toBe("Video too long (max 2 minutes)."));

    expect(pendingResolvers.length).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("cancel during transcode → state cleared, transcode signal aborted, no fallback", async () => {
    triggerUpload(key, slug, channel, videoClip());
    expect(uploadState(key)?.phase).toBe("transcoding");
    await awaitTranscodeStart(1);

    cancelUpload(key);

    expect(vt.transcodes[0]?.signal.aborted).toBe(true);
    expect(uploadState(key)).toBeNull();

    // The aborted conversion eventually settles as failed — the stale-
    // controller guard must NOT resurrect state or fall back.
    vt.transcodes[0]?.resolve({ error: { kind: "failed", message: "conversion canceled" } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(uploadState(key)).toBeNull();
    expect(pendingResolvers.length).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("re-trigger during an in-flight transcode aborts the previous controller (no orphaned encode)", async () => {
    triggerUpload(key, slug, channel, videoClip());
    await awaitTranscodeStart(1);
    expect(vt.transcodes[0]?.signal.aborted).toBe(false);

    // Second selection on the same channel while the first transcode
    // is still burning CPU — the orchestrator must kill the first.
    triggerUpload(key, slug, channel, videoClip());
    await awaitTranscodeStart(2);
    expect(vt.transcodes[0]?.signal.aborted).toBe(true);
    expect(vt.transcodes[1]?.signal.aborted).toBe(false);

    // The aborted first transcode settling late must not clobber the
    // second upload's state (stale-controller guard).
    vt.transcodes[0]?.resolve({ error: { kind: "failed", message: "conversion canceled" } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(uploadState(key)?.phase).toBe("transcoding");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------
// #49 — stale retry buffer
//
// lastAttempt must record the user's LATEST selection BEFORE any gate
// can reject. Pre-fix it was written only after the pre-check passed,
// so the error box's retry button re-dispatched the PREVIOUS file.
// --------------------------------------------------------------------

describe("#49 — stale retry buffer", () => {
  beforeEach(() => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
  });

  it("retry after a pre-check rejection retries the REJECTED file, not a prior one", async () => {
    // 1) Successful small upload — pre-fix this poisons lastAttempt.
    const small = new File([new Uint8Array(4)], "small.png", { type: "image/png" });
    triggerUpload(key, slug, channel, small);
    expect(pendingResolvers.length).toBe(1);
    pendingResolvers[0]?.resolve("https://litter.catbox.moe/small.png");
    await Promise.resolve();
    await Promise.resolve();

    // 2) Oversized file → pre-check rejection (host cap is 1MB).
    const big = new File([new Uint8Array(2 * 1024 * 1024)], "big.png", { type: "image/png" });
    triggerUpload(key, slug, channel, big);
    expect(uploadState(key)?.error).toMatch(/too large/i);

    // 3) Retry must re-attempt big.png — which fails the pre-check
    // AGAIN, with big.png's name in the error box…
    retryUpload(key);
    expect(uploadState(key)?.filename).toBe("big.png");
    expect(uploadState(key)?.error).toMatch(/too large/i);
    // …and must NOT re-dispatch small.png to the host.
    expect(pendingResolvers.length).toBe(1);
  });

  it("a new selection after a failed POST replaces the retry payload", async () => {
    const a = new File([new Uint8Array(4)], "a.png", { type: "image/png" });
    triggerUpload(key, slug, channel, a);
    expect(pendingResolvers.length).toBe(1);
    pendingResolvers[0]?.reject({ kind: "http", status: 413, body: "Payload Too Large" });
    await Promise.resolve();
    await Promise.resolve();
    expect(uploadState(key)?.error).toBeTruthy();

    const b = new File([new Uint8Array(4)], "b.png", { type: "image/png" });
    triggerUpload(key, slug, channel, b);
    expect(pendingResolvers.length).toBe(2);
    expect(pendingResolvers[1]?.file.name).toBe("b.png");
    pendingResolvers[1]?.resolve("https://litter.catbox.moe/b.png");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(slug, channel, "📸 https://litter.catbox.moe/b.png");
    expect(uploadState(key)).toBeNull();
  });
});

// --------------------------------------------------------------------
// TTL persistence — UX-4 bucket M (2026-05-19)
//
// Server is the authoritative source. The orchestrator caches the
// preference in a cic-side signal that SettingsDrawer reads/writes
// via loadUploadTtlSeconds/saveUploadTtlSeconds. Dispatching an
// upload translates the cached integer seconds into the active host's
// ttlOption.value token; falls back to host.defaultTtl when no
// preference (or no matching ladder entry).
// --------------------------------------------------------------------

describe("TTL persistence", () => {
  it("uploadTtlSecondsValue starts null when never loaded", () => {
    expect(uploadTtlSecondsValue()).toBeNull();
  });

  it("loadUploadTtlSeconds populates the cache from the server", async () => {
    vi.mocked(userSettings.getUploadTtlSeconds).mockResolvedValueOnce(3600);
    await loadUploadTtlSeconds("tok");
    expect(uploadTtlSecondsValue()).toBe(3600);
  });

  it("saveUploadTtlSeconds round-trips via the REST wrapper + mirrors the cache", async () => {
    await saveUploadTtlSeconds("tok", 43_200);
    expect(userSettings.putUploadTtlSeconds).toHaveBeenCalledWith("tok", 43_200);
    expect(uploadTtlSecondsValue()).toBe(43_200);
  });

  it("triggerUpload uses cached pref when matched to host ladder", async () => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    // 3600 seconds matches the test host's "1h" token.
    await saveUploadTtlSeconds("tok", 3600);

    let capturedTtl: string | undefined;
    vi.mocked(activeHost).mockReturnValue(
      makeTestHost({
        upload: (_file, options, _onProgress, _signal) => {
          capturedTtl = options.ttl;
          return new Promise<string>(() => {});
        },
      }),
    );

    triggerUpload(key, slug, channel, sampleImage());
    expect(capturedTtl).toBe("1h");
  });

  it("triggerUpload falls back to host.defaultTtl when no pref cached", () => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");

    let capturedTtl: string | undefined;
    vi.mocked(activeHost).mockReturnValue(
      makeTestHost({
        defaultTtl: "24h",
        upload: (_file, options, _onProgress, _signal) => {
          capturedTtl = options.ttl;
          return new Promise<string>(() => {});
        },
      }),
    );

    triggerUpload(key, slug, channel, sampleImage());
    expect(capturedTtl).toBe("24h");
  });

  it("triggerUpload falls back to host.defaultTtl when cached pref doesn't match the host ladder", async () => {
    localStorage.setItem("image-upload-privacy-acknowledged:test-host", "1");
    // 9999s isn't in the ladder.
    await saveUploadTtlSeconds("tok", 9999);

    let capturedTtl: string | undefined;
    vi.mocked(activeHost).mockReturnValue(
      makeTestHost({
        defaultTtl: "24h",
        upload: (_file, options, _onProgress, _signal) => {
          capturedTtl = options.ttl;
          return new Promise<string>(() => {});
        },
      }),
    );

    triggerUpload(key, slug, channel, sampleImage());
    expect(capturedTtl).toBe("24h");
  });

  it("loadUploadTtlSeconds swallows REST errors silently (cache stays null)", async () => {
    vi.mocked(userSettings.getUploadTtlSeconds).mockRejectedValueOnce(new Error("network"));
    await loadUploadTtlSeconds("tok");
    expect(uploadTtlSecondsValue()).toBeNull();
  });
});
