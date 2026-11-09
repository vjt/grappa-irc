import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileInner } from "../lib/e2e/fileInner";

// issue 2517 — `sendEncryptedAttachment`, the encrypted door's order and its
// answers. Until this file it had no test of its own: the compose path was
// covered end to end and every refusal branch here was dark.
//
// Every boundary is mocked, so what these tests pin is THIS module's
// decisions: which cap applies to which category and at which moment, which
// type the inner names, and that no failure escapes as a throw.

const seal = vi.hoisted(() => ({
  fn: vi.fn(async (bytes: Uint8Array) => ({
    ciphertext: bytes,
    key: "k".repeat(43),
    iv: "i".repeat(16),
    sha256: "s".repeat(43),
  })),
}));

vi.mock("../lib/e2e/fileCrypto", () => ({ sealBytes: seal.fn }));

const sendFile = vi.hoisted(() => ({ fn: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock("../lib/encryptedChats", () => ({ sendEncryptedFile: sendFile.fn }));

const upload = vi.hoisted(() => ({
  fn: vi.fn(async () => ({
    url: "https://grappa.test/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaa",
    expiresAt: "2026-11-10T00:00:00Z",
  })),
}));

vi.mock("../lib/uploadHost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/uploadHost")>();
  return {
    ...actual,
    uploadEncryptedCiphertext: upload.fn,
    embeddedHost: {
      ...actual.embeddedHost,
      acceptedMimeTypes: {
        image: ["image/png", "image/jpeg"],
        video: ["video/mp4", "video/quicktime"],
        document: ["application/pdf"],
        audio: ["audio/mpeg"],
      },
      maxFileSizeBytes: (category: string) => (category === "video" ? 1_000 : 100),
    },
  };
});

// `unknown` returns on purpose: each test drives a different arm of the
// stripped/refused union, and an inferred narrow type would reject the other.
const strip = vi.hoisted(() => ({
  image: vi.fn((bytes: Uint8Array): unknown => ({ ok: bytes })),
  video: vi.fn((_original: File, result: unknown): unknown => result),
}));

vi.mock("../lib/metadataStrip", () => ({
  stripImageMetadata: strip.image,
  encryptedVideoOutcome: strip.video,
}));

// The module imports this lazily (`await import`) for videos only; a mock
// intercepts the dynamic import the same way.
const transcode = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../lib/videoTranscode", () => ({ transcodeVideo: transcode.fn }));

import { sendEncryptedAttachment } from "../lib/encryptedAttachments";

const fileOf = (name: string, type: string, bytes: number): File =>
  new File([new Uint8Array(bytes)], name, { type });

const request = (file: File) => ({
  networkSlug: "net",
  peer: "Guest",
  file,
  ttl: undefined,
  maxDurationSeconds: 300,
  signal: new AbortController().signal,
  onPhase: vi.fn(),
});

const sentInner = (): FileInner => sendFile.fn.mock.calls[0]?.[2] as FileInner;

describe("sendEncryptedAttachment (issue 2517)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    strip.image.mockImplementation((bytes: Uint8Array) => ({ ok: bytes }));
    strip.video.mockImplementation((_o: File, result: unknown) => result);
    upload.fn.mockResolvedValue({
      url: "https://grappa.test/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaa",
      expiresAt: "2026-11-10T00:00:00Z",
    });
    sendFile.fn.mockResolvedValue(undefined);
  });

  it("refuses a type the host does not accept, before any work", async () => {
    const outcome = await sendEncryptedAttachment(
      request(fileOf("a.exe", "application/x-msdownload", 1)),
    );

    expect(outcome).toEqual({
      ok: false,
      error: "Unsupported file type — application/x-msdownload.",
    });
    expect(upload.fn).not.toHaveBeenCalled();
  });

  it("refuses an image over the cap without stripping it", async () => {
    const outcome = await sendEncryptedAttachment(request(fileOf("a.png", "image/png", 101)));

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("too large") });
    expect(strip.image).not.toHaveBeenCalled();
  });

  // N1 — the plain path checks the cap AFTER the transform, because the
  // transcode changes the size. The encrypted door checked it on the original
  // and turned away videos the transcode would have brought under the limit.
  it("does NOT refuse a video on its original size — the transcode may shrink it", async () => {
    transcode.fn.mockResolvedValue({ ok: fileOf("a.mp4", "video/mp4", 500) });

    const outcome = await sendEncryptedAttachment(
      request(fileOf("a.mov", "video/quicktime", 5_000)),
    );

    expect(outcome).toEqual({ ok: true });
    expect(transcode.fn).toHaveBeenCalled();
  });

  it("still refuses a video whose transcoded output is over the cap", async () => {
    transcode.fn.mockResolvedValue({ ok: fileOf("a.mp4", "video/mp4", 1_001) });

    const outcome = await sendEncryptedAttachment(
      request(fileOf("a.mov", "video/quicktime", 5_000)),
    );

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("too large") });
    expect(upload.fn).not.toHaveBeenCalled();
  });

  // N2 — the inner named the ORIGINAL type, so a .mov transcoded to mp4 was
  // announced as quicktime: the peer's card named a container the bytes are
  // not, and `inlineKindOf` sent a playable mp4 down the save path.
  it("names the type of the file that goes, not of the one that came in", async () => {
    transcode.fn.mockResolvedValue({ ok: fileOf("a.mp4", "video/mp4", 500) });

    await sendEncryptedAttachment(request(fileOf("a.mov", "video/quicktime", 5_000)));

    expect(sentInner().mime).toBe("video/mp4");
    expect(sentInner().size).toBe(500);
  });

  it("carries the image's own type and the stripped bytes' size", async () => {
    strip.image.mockImplementation(() => ({ ok: new Uint8Array(40) }));

    await sendEncryptedAttachment(request(fileOf("a.png", "image/png", 50)));

    expect(sentInner()).toMatchObject({ mime: "image/png", size: 40, category: "image" });
  });

  it("refuses an image whose metadata cannot be stripped", async () => {
    strip.image.mockImplementation(() => ({ refused: { reason: "malformed" } }));

    const outcome = await sendEncryptedAttachment(request(fileOf("a.png", "image/png", 10)));

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("damaged") });
    expect(upload.fn).not.toHaveBeenCalled();
  });

  it("refuses a video the transcode could not strip", async () => {
    strip.video.mockImplementation(() => ({
      refused: { reason: "video_unprocessed", detail: "no H.264 encoder" },
    }));
    transcode.fn.mockResolvedValue({ error: { kind: "unsupported", detail: "no encoder" } });

    const outcome = await sendEncryptedAttachment(request(fileOf("a.mov", "video/quicktime", 10)));

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("metadata") });
    expect(upload.fn).not.toHaveBeenCalled();
  });

  it("answers an upload refusal as a sentence, never a throw", async () => {
    // `uploadEncryptedCiphertext` REJECTS with an `UploadError` (xhrUpload's
    // contract); it does not resolve one.
    upload.fn.mockRejectedValue({ kind: "http", status: 413, body: "" });

    const outcome = await sendEncryptedAttachment(request(fileOf("a.pdf", "application/pdf", 10)));

    expect(outcome).toEqual({ ok: false, error: "File is too large for the server." });
    expect(sendFile.fn).not.toHaveBeenCalled();
  });

  // N3 — the upload had already succeeded, so a throw here left the compose
  // box on "uploading" with the blob on the server and no message naming it.
  it("answers a throwing send instead of leaving the upload stuck", async () => {
    sendFile.fn.mockRejectedValue(new Error("boom"));

    const outcome = await sendEncryptedAttachment(request(fileOf("a.pdf", "application/pdf", 10)));

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("was not sent") });
  });

  it("sends a document as it is, with its own type", async () => {
    await sendEncryptedAttachment(request(fileOf("a.pdf", "application/pdf", 10)));

    expect(sentInner()).toMatchObject({
      name: "a.pdf",
      mime: "application/pdf",
      category: "document",
    });
    expect(sendFile.fn).toHaveBeenCalledWith("net", "Guest", sentInner());
  });
});
