// issue 2517 — an encrypted attachment's crypto, its inner, and the click
// that opens one: the ciphertext is exactly the plaintext plus the GCM tag,
// a wrong key or a changed byte opens nothing, the digest is over the
// ciphertext, and nothing a peer says makes this client fetch another host
// or render a document in its own origin.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBytes, sealBytes, sha256Base64 } from "../lib/e2e/fileCrypto";
import {
  type FileInner,
  onGrappaOrigin,
  parseFileInner,
  sanitizeFileName,
} from "../lib/e2e/fileInner";
import { base64Unpadded } from "../lib/e2e/wire";
import { inlineKindOf, openEncryptedFile } from "../lib/encryptedFileOpen";

const bytes = (n: number, fill = 7): Uint8Array<ArrayBuffer> => new Uint8Array(n).fill(fill);
const b64 = (n: number): string => base64Unpadded(bytes(n));
const SLUG = "abcdefghijklmnopqrstuvwxyz";

const fileInner = (over: Partial<FileInner> = {}): FileInner => ({
  t: "file",
  url: `${location.origin}/uploads/${SLUG}`,
  key: b64(32),
  iv: b64(12),
  sha256: b64(32),
  name: "holiday.jpg",
  mime: "image/jpeg",
  size: 123,
  category: "image",
  expires_at: "2099-01-01T00:00:00Z",
  ...over,
});

describe("sealBytes / openBytes (issue 2517)", () => {
  it("round-trips, and the ciphertext is the plaintext plus the 16-byte tag", async () => {
    const plaintext = bytes(1000);
    const sealed = await sealBytes(plaintext);

    expect(sealed.ciphertext.length).toBe(1000 + 16);
    expect(sealed.sha256).toBe(await sha256Base64(sealed.ciphertext));
    expect(await openBytes(sealed.ciphertext, sealed.key, sealed.iv)).toEqual(plaintext);
  });

  it("gives every file its own key and IV", async () => {
    const one = await sealBytes(bytes(8));
    const two = await sealBytes(bytes(8));

    expect(one.key).not.toBe(two.key);
    expect(one.iv).not.toBe(two.iv);
    expect(one.ciphertext).not.toEqual(two.ciphertext);
  });

  it("opens nothing with the wrong key, a changed byte, or a changed IV", async () => {
    const sealed = await sealBytes(bytes(64));
    const other = await sealBytes(bytes(64));
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] = (tampered[0] as number) ^ 0xff;

    expect(await openBytes(sealed.ciphertext, other.key, sealed.iv)).toBeNull();
    expect(await openBytes(tampered, sealed.key, sealed.iv)).toBeNull();
    expect(await openBytes(sealed.ciphertext, sealed.key, other.iv)).toBeNull();
  });
});

describe("parseFileInner (issue 2517)", () => {
  it("takes a well-formed attachment", () => {
    expect(parseFileInner(fileInner())).toEqual(fileInner());
  });

  it("refuses every field that is not what the wire says it is", () => {
    const cases: Array<[Partial<FileInner>, string]> = [
      [{ key: b64(31) }, "bad-key"],
      [{ key: b64(33) }, "bad-key"],
      [{ key: "not base64!" }, "bad-key"],
      [{ iv: b64(16) }, "bad-iv"],
      [{ sha256: b64(20) }, "bad-sha256"],
      [{ name: "" }, "bad-name"],
      [{ mime: "" }, "bad-mime"],
      [{ size: -1 }, "bad-size"],
      [{ size: 1.5 }, "bad-size"],
      [{ category: "executable" as FileInner["category"] }, "bad-category"],
      [{ expires_at: "not a date" }, "bad-expiry"],
      [{ url: 42 as unknown as string }, "bad-url"],
    ];
    for (const [over, reason] of cases) {
      expect(parseFileInner(fileInner(over))).toBe(reason);
    }
  });
});

describe("onGrappaOrigin (issue 2517)", () => {
  it("takes this grappa's own upload path and nothing else", () => {
    const origin = location.origin;
    expect(onGrappaOrigin(`${origin}/uploads/${SLUG}`, origin)).toBe(true);
    expect(onGrappaOrigin(`https://evil.example/uploads/${SLUG}`, origin)).toBe(false);
    expect(onGrappaOrigin(`${origin}/uploads/${SLUG}?x=1`, origin)).toBe(false);
    expect(onGrappaOrigin(`${origin}/uploads/${SLUG}#f`, origin)).toBe(false);
    expect(onGrappaOrigin(`${origin}/api/uploads/${SLUG}`, origin)).toBe(false);
    expect(onGrappaOrigin(`${origin}/uploads/../secret`, origin)).toBe(false);
    expect(onGrappaOrigin(`${origin}/uploads/${SLUG}.jpg`, origin)).toBe(false);
  });
});

describe("sanitizeFileName (issue 2517)", () => {
  it("takes out separators, control characters and bidi overrides", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitizeFileName("a\u0000b\nc")).toBe("abc");
    expect(sanitizeFileName("invoice‮gpj.exe")).toBe("invoicegpj.exe");
    expect(sanitizeFileName("  holiday   photo.jpg  ")).toBe("holiday photo.jpg");
  });

  it("caps the length, and answers empty when nothing printable is left", () => {
    expect(sanitizeFileName("x".repeat(500))).toHaveLength(120);
    expect(sanitizeFileName("‮⁦\u0007")).toBe("");
  });
});

describe("inlineKindOf (issue 2517)", () => {
  it("is an allowlist: SVG and HTML are saved, never rendered", () => {
    expect(inlineKindOf("image/jpeg")).toBe("image");
    expect(inlineKindOf("image/webp")).toBe("image");
    expect(inlineKindOf("video/mp4")).toBe("video");
    expect(inlineKindOf("audio/ogg")).toBe("audio");
    expect(inlineKindOf("image/svg+xml")).toBeNull();
    expect(inlineKindOf("text/html")).toBeNull();
    expect(inlineKindOf("application/pdf")).toBeNull();
  });
});

describe("openEncryptedFile (issue 2517)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const served = (ciphertext: Uint8Array<ArrayBuffer>, status = 200): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(status === 200 ? ciphertext : "nope", { status })),
    );
  };

  it("checks the digest before it decrypts, and renders nothing on a mismatch", async () => {
    const sealed = await sealBytes(bytes(32));
    served(sealed.ciphertext);
    const digest = vi.spyOn(crypto.subtle, "digest");

    const outcome = await openEncryptedFile(
      fileInner({ key: sealed.key, iv: sealed.iv, sha256: b64(32), size: 32 }),
    );

    expect(outcome).toEqual({
      ok: false,
      error: "the file does not match the digest in the message",
    });
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it("refuses a file its key does not open", async () => {
    const sealed = await sealBytes(bytes(32));
    const other = await sealBytes(bytes(32));
    served(sealed.ciphertext);

    expect(
      await openEncryptedFile(
        fileInner({ key: other.key, iv: other.iv, sha256: sealed.sha256, size: 32 }),
      ),
    ).toEqual({ ok: false, error: "the file could not be decrypted" });
  });

  it("says expired when the server no longer holds it", async () => {
    served(bytes(0), 404);
    expect(await openEncryptedFile(fileInner({ expires_at: "2000-01-01T00:00:00Z" }))).toEqual({
      ok: false,
      error: "expired",
    });
  });

  it("opens an allowlisted image as a blob, and saves anything else", async () => {
    const sealed = await sealBytes(bytes(16));
    served(sealed.ciphertext);
    const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:one");

    const image = await openEncryptedFile(
      fileInner({ key: sealed.key, iv: sealed.iv, sha256: sealed.sha256, size: 16 }),
    );
    expect(image).toEqual({ ok: true, kind: "inline", url: "blob:one", media: "image" });

    const html = await openEncryptedFile(
      fileInner({
        key: sealed.key,
        iv: sealed.iv,
        sha256: sealed.sha256,
        size: 16,
        mime: "text/html",
      }),
    );
    expect(html).toEqual({ ok: true, kind: "download" });
    expect(created).toHaveBeenCalledTimes(2);
  });
});
