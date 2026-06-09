import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyServerSettings, setServerSettings } from "../lib/serverSettings";
import { DOCUMENT_MIMES_OFFICE, DOCUMENT_MIMES_PORTABLE, VIDEO_MIMES } from "../lib/uploadCategory";
import {
  __setUploadTokenReader,
  activeHost,
  availableHosts,
  embeddedHost,
  litterboxHost,
  type UploadHost,
  type UploadProgress,
  xhrUpload,
} from "../lib/uploadHost";

// Wire-shaped upload subtree builder — the server pushes the three
// per-category cap fields since uploads cluster Task 2 (385129f).
const wireUpload = (
  overrides: Partial<{
    active_host: string;
    image_per_file_cap_bytes: number;
    video_per_file_cap_bytes: number;
    document_per_file_cap_bytes: number;
    global_cap_bytes: number;
  }> = {},
) => ({
  active_host: "embedded",
  image_per_file_cap_bytes: 10 * 1024 * 1024,
  video_per_file_cap_bytes: 50 * 1024 * 1024,
  document_per_file_cap_bytes: 10 * 1024 * 1024,
  global_cap_bytes: 10 * 1024 * 1024 * 1024,
  ...overrides,
});

// --------------------------------------------------------------
// MockXMLHttpRequest — minimal stand-in for jsdom's XHR.
//
// Captures `.open` / `.send` arguments, exposes `triggerLoad` /
// `triggerError` / `triggerAbort` / `triggerUploadProgress` so each
// test can drive the lifecycle deterministically. Listeners installed
// via `addEventListener` AND legacy `.onfoo` / `.upload.onprogress`
// are both honoured (litterboxHost may use either shape; the test
// shouldn't depend on which).
// --------------------------------------------------------------
class MockUpload {
  listeners = new Map<string, Set<(ev: { loaded: number; total: number }) => void>>();
  onprogress: ((ev: { loaded: number; total: number }) => void) | null = null;
  addEventListener(type: string, fn: (ev: { loaded: number; total: number }) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  fire(type: string, ev: { loaded: number; total: number }): void {
    if (type === "progress" && this.onprogress) this.onprogress(ev);
    this.listeners.get(type)?.forEach((fn) => {
      fn(ev);
    });
  }
}

class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = [];

  method = "";
  url = "";
  body: unknown = null;
  status = 0;
  responseText = "";
  upload = new MockUpload();
  readyState = 0;
  aborted = false;
  headers: Record<string, string> = {};

  listeners = new Map<string, Set<() => void>>();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  send(body: unknown): void {
    this.body = body;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  abort(): void {
    this.aborted = true;
    this.fire("abort");
  }

  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  fire(type: string): void {
    if (type === "load" && this.onload) this.onload();
    if (type === "error" && this.onerror) this.onerror();
    if (type === "abort" && this.onabort) this.onabort();
    this.listeners.get(type)?.forEach((fn) => {
      fn();
    });
  }

  triggerLoad(status: number, responseText: string): void {
    this.status = status;
    this.responseText = responseText;
    this.readyState = 4;
    this.fire("load");
  }

  triggerError(): void {
    this.fire("error");
  }

  triggerUploadProgress(loaded: number, total: number): void {
    this.upload.fire("progress", { loaded, total });
  }
}

beforeEach(() => {
  MockXMLHttpRequest.instances = [];
  vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sampleFile = (): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "screenshot.png", { type: "image/png" });

const formDataEntries = (body: unknown): Record<string, FormDataEntryValue> => {
  if (!(body instanceof FormData)) throw new Error("expected FormData body");
  const out: Record<string, FormDataEntryValue> = {};
  for (const [k, v] of body.entries()) out[k] = v;
  return out;
};

// ----- Litterbox impl ---------------------------------------------

describe("litterboxHost — metadata", () => {
  it("identifies as litterbox", () => {
    expect(litterboxHost.id).toBe("litterbox");
  });

  it("exposes the canonical display name", () => {
    expect(litterboxHost.displayName).toBe("litterbox.catbox.moe");
  });

  it("retentionStatement names the public temp host + 24-hour window", () => {
    expect(litterboxHost.retentionStatement).toMatch(/public/i);
    expect(litterboxHost.retentionStatement).toMatch(/24 hours?/i);
    expect(litterboxHost.retentionStatement).toMatch(/anyone with the URL/i);
  });

  it("ttlOptions cover 1h/12h/24h/72h", () => {
    const values = litterboxHost.ttlOptions.map((o) => o.value);
    expect(values).toEqual(["1h", "12h", "24h", "72h"]);
  });

  it("ttlOptions each carry a human label", () => {
    for (const opt of litterboxHost.ttlOptions) {
      expect(typeof opt.label).toBe("string");
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it("defaults TTL to 24h per vjt 2026-05-15", () => {
    expect(litterboxHost.defaultTtl).toBe("24h");
  });

  it("acceptedMimeTypes.image lists the image suffixes the brainstorm pinned", () => {
    expect(litterboxHost.acceptedMimeTypes.image).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/apng",
    ]);
  });

  it("acceptedMimeTypes.video lists the selectable video MIMEs", () => {
    expect(litterboxHost.acceptedMimeTypes.video).toEqual(VIDEO_MIMES);
  });

  it("acceptedMimeTypes.document excludes docx/xlsx (litterbox blocks .doc* host-side)", () => {
    expect(litterboxHost.acceptedMimeTypes.document).toEqual(DOCUMENT_MIMES_PORTABLE);
    for (const office of DOCUMENT_MIMES_OFFICE) {
      expect(litterboxHost.acceptedMimeTypes.document).not.toContain(office);
    }
  });

  it("declares per-category upper file sizes (100/50/10 MiB)", () => {
    expect(litterboxHost.maxFileSizeBytes("image")).toBe(100 * 1024 * 1024);
    expect(litterboxHost.maxFileSizeBytes("video")).toBe(50 * 1024 * 1024);
    expect(litterboxHost.maxFileSizeBytes("document")).toBe(10 * 1024 * 1024);
  });
});

describe("litterboxHost.upload — wire shape", () => {
  it("POSTs multipart to the litterbox API endpoint", async () => {
    const upload = litterboxHost.upload(
      sampleFile(),
      { ttl: "24h" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR instance");

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("https://litterbox.catbox.moe/resources/internals/api.php");

    xhr.triggerLoad(200, "https://litter.catbox.moe/abc.png");
    await upload;
  });

  it("includes reqtype=fileupload, time, and fileToUpload fields", async () => {
    const file = sampleFile();
    const upload = litterboxHost.upload(
      file,
      { ttl: "24h" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR instance");

    const fields = formDataEntries(xhr.body);
    expect(fields.reqtype).toBe("fileupload");
    expect(fields.time).toBe("24h");
    expect(fields.fileToUpload).toBeInstanceOf(File);
    expect((fields.fileToUpload as File).name).toBe("screenshot.png");

    xhr.triggerLoad(200, "https://litter.catbox.moe/abc.png");
    await upload;
  });

  it.each(["1h", "12h", "24h", "72h"])("wires TTL %s into the time= field", async (ttl) => {
    const upload = litterboxHost.upload(
      sampleFile(),
      { ttl },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR instance");

    expect(formDataEntries(xhr.body).time).toBe(ttl);

    xhr.triggerLoad(200, "https://litter.catbox.moe/x.png");
    await upload;
  });

  it("falls back to defaultTtl when no ttl supplied", async () => {
    const upload = litterboxHost.upload(sampleFile(), {}, () => {}, new AbortController().signal);
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR instance");

    expect(formDataEntries(xhr.body).time).toBe(litterboxHost.defaultTtl);

    xhr.triggerLoad(200, "https://litter.catbox.moe/x.png");
    await upload;
  });
});

describe("litterboxHost.upload — resolution + error mapping", () => {
  it("resolves with the trimmed response body URL", async () => {
    const upload = litterboxHost.upload(
      sampleFile(),
      { ttl: "24h" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(200, "https://litter.catbox.moe/abc.png\n");

    await expect(upload).resolves.toBe("https://litter.catbox.moe/abc.png");
  });

  it("rejects with {kind: network} on transport error", async () => {
    const upload = litterboxHost.upload(
      sampleFile(),
      { ttl: "24h" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerError();

    await expect(upload).rejects.toEqual({ kind: "network" });
  });

  it("rejects with {kind: http, status, body} on HTTP 4xx", async () => {
    const upload = litterboxHost.upload(
      sampleFile(),
      { ttl: "24h" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(413, "Payload Too Large");

    await expect(upload).rejects.toEqual({ kind: "http", status: 413, body: "Payload Too Large" });
  });

  it("rejects with {kind: http, status, body} on HTTP 5xx", async () => {
    const upload = litterboxHost.upload(
      sampleFile(),
      { ttl: "24h" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(503, "Service Unavailable");

    await expect(upload).rejects.toEqual({
      kind: "http",
      status: 503,
      body: "Service Unavailable",
    });
  });

  it("rejects with {kind: invalid_response, body} when the body is not a URL", async () => {
    const upload = litterboxHost.upload(
      sampleFile(),
      { ttl: "24h" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(200, "this is not a url");

    await expect(upload).rejects.toEqual({ kind: "invalid_response", body: "this is not a url" });
  });

  it('rejects with {kind: invalid_response, body: ""} on empty 200 body', async () => {
    const upload = litterboxHost.upload(
      sampleFile(),
      { ttl: "24h" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(200, "");

    await expect(upload).rejects.toEqual({ kind: "invalid_response", body: "" });
  });
});

describe("litterboxHost.upload — abort", () => {
  it("aborts the XHR when the AbortSignal fires + rejects with {kind: abort}", async () => {
    const ctrl = new AbortController();
    const upload = litterboxHost.upload(sampleFile(), { ttl: "24h" }, () => {}, ctrl.signal);
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");

    ctrl.abort();
    expect(xhr.aborted).toBe(true);

    await expect(upload).rejects.toEqual({ kind: "abort" });
  });

  it("rejects with {kind: abort} immediately if signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const upload = litterboxHost.upload(sampleFile(), { ttl: "24h" }, () => {}, ctrl.signal);

    await expect(upload).rejects.toEqual({ kind: "abort" });
  });
});

describe("litterboxHost.upload — progress callback", () => {
  it("does NOT attach an upload progress listener (litterbox lacks CORS preflight)", async () => {
    const events: UploadProgress[] = [];
    const upload = litterboxHost.upload(
      sampleFile(),
      { ttl: "24h" },
      (p) => events.push(p),
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");

    // Even if the browser were to fire a progress event, no listener
    // is attached so onProgress must remain unobserved. Drives
    // `<progress>` to its indeterminate visual state — see the host
    // moduledoc CORS-preflight gotcha note.
    xhr.triggerUploadProgress(512, 2048);
    xhr.triggerUploadProgress(2048, 2048);
    xhr.triggerLoad(200, "https://litter.catbox.moe/x.png");
    await upload;

    expect(events).toEqual([]);
    expect(xhr.upload.listeners.has("progress")).toBe(false);
  });

  it("declares supportsProgress=false (preflight gotcha pin)", () => {
    expect(litterboxHost.supportsProgress).toBe(false);
  });
});

// Synthetic CORS-friendly host exercises the supportsProgress=true
// branch in xhrUpload — pins behaviour for the next provider impl.
const corsFriendlyMockHost: UploadHost = {
  id: "cors-friendly-mock",
  displayName: "cors-friendly mock",
  retentionStatement: "Files are not actually stored anywhere.",
  ttlOptions: [],
  defaultTtl: null,
  acceptedMimeTypes: { image: ["image/png"], video: [], document: [] },
  maxFileSizeBytes: () => null,
  supportsProgress: true,
  upload: (file, _options, onProgress, signal) => {
    const body = new FormData();
    body.append("file", file);
    return xhrUpload({
      url: "https://example.invalid/upload",
      body,
      onProgress,
      signal,
      parseResponse: (status, text) =>
        status >= 200 && status < 300 ? text : { kind: "http", status, body: text },
      supportsProgress: true,
    });
  },
};

describe("supportsProgress=true (synthetic CORS-friendly host)", () => {
  it("attaches the progress listener and forwards loaded/total events", async () => {
    const events: UploadProgress[] = [];
    const upload = corsFriendlyMockHost.upload(
      sampleFile(),
      { ttl: "24h" },
      (p) => events.push(p),
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");

    xhr.triggerUploadProgress(256, 1024);
    xhr.triggerUploadProgress(1024, 1024);
    xhr.triggerLoad(200, "https://example.invalid/ok.png");
    await upload;

    expect(events).toEqual([
      { loaded: 256, total: 1024 },
      { loaded: 1024, total: 1024 },
    ]);
    expect(xhr.upload.listeners.has("progress")).toBe(true);
  });
});

// ----- Registry + active host ------------------------------------

describe("availableHosts + activeHost", () => {
  it("registers embeddedHost FIRST then litterboxHost (default = embedded)", () => {
    expect(availableHosts[0]).toBe(embeddedHost);
    expect(availableHosts[1]).toBe(litterboxHost);
  });

  it("returns embeddedHost from activeHost() when signal is null (pre-snapshot)", () => {
    setServerSettings(null);
    expect(activeHost()).toBe(embeddedHost);
  });

  it("returns litterboxHost from activeHost() when admin pinned litterbox", () => {
    applyServerSettings({ upload: wireUpload({ active_host: "litterbox" }) });
    expect(activeHost()).toBe(litterboxHost);
  });

  it("returns embeddedHost when admin flips back to embedded", () => {
    applyServerSettings({ upload: wireUpload({ active_host: "litterbox" }) });
    applyServerSettings({ upload: wireUpload({ active_host: "embedded" }) });
    expect(activeHost()).toBe(embeddedHost);
  });
});

// ----- Interface contract via in-memory mock ---------------------
//
// Documents how a second UploadHost would be authored. The interface
// is verified by the TypeScript compiler at this declaration site
// (the `: UploadHost` annotation forces the shape).

const mockHost: UploadHost = {
  id: "mock",
  displayName: "in-memory mock",
  retentionStatement: "Files are not actually stored anywhere.",
  ttlOptions: [],
  defaultTtl: null,
  acceptedMimeTypes: { image: ["image/png"], video: [], document: [] },
  maxFileSizeBytes: () => null,
  supportsProgress: false,
  upload: (_file, _options, _onProgress, _signal) =>
    Promise.resolve("https://example.invalid/mock.png"),
};

describe("UploadHost interface — second-impl exemplar", () => {
  it("a second impl satisfies the interface and resolves with a URL", async () => {
    const url = await mockHost.upload(sampleFile(), {}, () => {}, new AbortController().signal);
    expect(url).toBe("https://example.invalid/mock.png");
  });

  it("ttlOptions may be empty (host with no TTL choice)", () => {
    expect(mockHost.ttlOptions).toEqual([]);
    expect(mockHost.defaultTtl).toBeNull();
  });
});

// ----- embeddedHost (UX-6-B2 2026-05-21) ------------------------------

describe("embeddedHost — metadata", () => {
  it("identifies as embedded", () => {
    expect(embeddedHost.id).toBe("embedded");
  });

  it("exposes a friendly display name", () => {
    expect(typeof embeddedHost.displayName).toBe("string");
    expect(embeddedHost.displayName.length).toBeGreaterThan(0);
  });

  it("retentionStatement names the host + lifetime + public-URL audience", () => {
    expect(embeddedHost.retentionStatement).toMatch(/grappa/i);
    expect(embeddedHost.retentionStatement).toMatch(/public/i);
    expect(embeddedHost.retentionStatement).toMatch(/anyone with/i);
  });

  it("ttlOptions cover 1h/12h/24h/72h with integer-seconds values", () => {
    const values = embeddedHost.ttlOptions.map((o) => o.value);
    expect(values).toEqual(["3600", "43200", "86400", "259200"]);
    const secs = embeddedHost.ttlOptions.map((o) => o.seconds);
    expect(secs).toEqual([3600, 43_200, 86_400, 259_200]);
  });

  it("defaults TTL to 24h (86400s) per cluster spec", () => {
    expect(embeddedHost.defaultTtl).toBe("86400");
  });

  it("acceptedMimeTypes.image lists the 5 image suffixes", () => {
    expect(embeddedHost.acceptedMimeTypes.image).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/apng",
    ]);
  });

  it("acceptedMimeTypes.video lists the selectable video MIMEs", () => {
    expect(embeddedHost.acceptedMimeTypes.video).toEqual(VIDEO_MIMES);
  });

  it("acceptedMimeTypes.document includes the office formats litterbox blocks", () => {
    expect(embeddedHost.acceptedMimeTypes.document).toEqual([
      ...DOCUMENT_MIMES_PORTABLE,
      ...DOCUMENT_MIMES_OFFICE,
    ]);
  });

  it("declares supportsProgress=true (same-origin, no CORS preflight)", () => {
    expect(embeddedHost.supportsProgress).toBe(true);
  });
});

describe("embeddedHost.maxFileSizeBytes — reactive per-category cap", () => {
  it("falls back to the server-default literals (10/50/10 MiB) when signal is null", () => {
    setServerSettings(null);
    expect(embeddedHost.maxFileSizeBytes("image")).toBe(10 * 1024 * 1024);
    expect(embeddedHost.maxFileSizeBytes("video")).toBe(50 * 1024 * 1024);
    expect(embeddedHost.maxFileSizeBytes("document")).toBe(10 * 1024 * 1024);
  });

  it("reads the admin-tuned per-category caps from the serverSettings signal", () => {
    applyServerSettings({
      upload: wireUpload({
        image_per_file_cap_bytes: 1_111,
        video_per_file_cap_bytes: 2_222,
        document_per_file_cap_bytes: 3_333,
      }),
    });
    expect(embeddedHost.maxFileSizeBytes("image")).toBe(1_111);
    expect(embeddedHost.maxFileSizeBytes("video")).toBe(2_222);
    expect(embeddedHost.maxFileSizeBytes("document")).toBe(3_333);
  });
});

describe("embeddedHost.upload — wire shape", () => {
  beforeEach(() => {
    __setUploadTokenReader(() => "test-bearer");
  });

  afterEach(() => {
    __setUploadTokenReader(null);
  });

  it("POSTs multipart to /api/uploads (same-origin)", async () => {
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR instance");

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/uploads");

    xhr.triggerLoad(
      201,
      JSON.stringify({
        slug: "abc",
        url: "https://grappa.test/uploads/abc",
        expires_at: "2026-05-22T00:00:00Z",
      }),
    );
    await upload;
  });

  it("includes file + expire fields", async () => {
    const file = sampleFile();
    const upload = embeddedHost.upload(
      file,
      { ttl: "3600" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR instance");

    const fields = formDataEntries(xhr.body);
    expect(fields.file).toBeInstanceOf(File);
    expect((fields.file as File).name).toBe("screenshot.png");
    expect(fields.expire).toBe("3600");

    xhr.triggerLoad(
      201,
      JSON.stringify({
        slug: "x",
        url: "https://grappa.test/uploads/x",
        expires_at: "2026-05-22T00:00:00Z",
      }),
    );
    await upload;
  });

  it("attaches Authorization: Bearer header from the token reader", async () => {
    __setUploadTokenReader(() => "abc-token-123");
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");

    expect(xhr.headers.authorization).toBe("Bearer abc-token-123");

    xhr.triggerLoad(
      201,
      JSON.stringify({
        slug: "x",
        url: "https://grappa.test/uploads/x",
        expires_at: "2026-05-22T00:00:00Z",
      }),
    );
    await upload;
  });

  it("omits Authorization header when token is null", async () => {
    __setUploadTokenReader(() => null);
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");

    expect(xhr.headers.authorization).toBeUndefined();

    // Server would 401; verify by triggering a 401 and asserting rejection.
    xhr.triggerLoad(401, '{"error":"unauthorized"}');
    await expect(upload).rejects.toEqual({
      kind: "http",
      status: 401,
      body: '{"error":"unauthorized"}',
    });
  });

  it.each([
    "3600",
    "43200",
    "86400",
    "259200",
  ])("wires TTL %s into the expire= field", async (ttl) => {
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");

    expect(formDataEntries(xhr.body).expire).toBe(ttl);

    xhr.triggerLoad(
      201,
      JSON.stringify({
        slug: "x",
        url: "https://grappa.test/uploads/x",
        expires_at: "2026-05-22T00:00:00Z",
      }),
    );
    await upload;
  });

  it("falls back to defaultTtl when no ttl supplied", async () => {
    const upload = embeddedHost.upload(sampleFile(), {}, () => {}, new AbortController().signal);
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");

    expect(formDataEntries(xhr.body).expire).toBe(embeddedHost.defaultTtl);

    xhr.triggerLoad(
      201,
      JSON.stringify({
        slug: "x",
        url: "https://grappa.test/uploads/x",
        expires_at: "2026-05-22T00:00:00Z",
      }),
    );
    await upload;
  });
});

describe("embeddedHost.upload — resolution + error mapping", () => {
  beforeEach(() => {
    __setUploadTokenReader(() => "test-bearer");
  });

  afterEach(() => {
    __setUploadTokenReader(null);
  });

  it("resolves with the JSON response url field", async () => {
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(
      201,
      JSON.stringify({
        slug: "abc",
        url: "https://grappa.test/uploads/abc",
        expires_at: "2026-05-22T00:00:00Z",
      }),
    );

    await expect(upload).resolves.toBe("https://grappa.test/uploads/abc");
  });

  it("rejects with {kind: network} on transport error", async () => {
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerError();

    await expect(upload).rejects.toEqual({ kind: "network" });
  });

  it("rejects with {kind: http, status, body} on 413 file_too_large", async () => {
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(413, '{"error":"file_too_large","max_bytes":10485760}');

    await expect(upload).rejects.toEqual({
      kind: "http",
      status: 413,
      body: '{"error":"file_too_large","max_bytes":10485760}',
    });
  });

  it("rejects with {kind: http, status, body} on 507 insufficient_storage", async () => {
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(507, '{"error":"insufficient_storage"}');

    await expect(upload).rejects.toEqual({
      kind: "http",
      status: 507,
      body: '{"error":"insufficient_storage"}',
    });
  });

  it("rejects with {kind: invalid_response} when body is not JSON", async () => {
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(201, "not-json");

    await expect(upload).rejects.toEqual({ kind: "invalid_response", body: "not-json" });
  });

  it("rejects with {kind: invalid_response} when url field is missing", async () => {
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(201, '{"slug":"abc","expires_at":"2026-05-22T00:00:00Z"}');

    await expect(upload).rejects.toEqual({
      kind: "invalid_response",
      body: '{"slug":"abc","expires_at":"2026-05-22T00:00:00Z"}',
    });
  });

  it("rejects with {kind: invalid_response} when url is not a URL", async () => {
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      () => {},
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");
    xhr.triggerLoad(201, '{"slug":"x","url":"not a url","expires_at":"x"}');

    await expect(upload).rejects.toEqual({
      kind: "invalid_response",
      body: '{"slug":"x","url":"not a url","expires_at":"x"}',
    });
  });
});

describe("embeddedHost.upload — abort", () => {
  beforeEach(() => {
    __setUploadTokenReader(() => "test-bearer");
  });

  afterEach(() => {
    __setUploadTokenReader(null);
  });

  it("aborts the XHR when the AbortSignal fires + rejects with {kind: abort}", async () => {
    const ctrl = new AbortController();
    const upload = embeddedHost.upload(sampleFile(), { ttl: "86400" }, () => {}, ctrl.signal);
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");

    ctrl.abort();
    expect(xhr.aborted).toBe(true);

    await expect(upload).rejects.toEqual({ kind: "abort" });
  });
});

describe("embeddedHost.upload — progress callback", () => {
  beforeEach(() => {
    __setUploadTokenReader(() => "test-bearer");
  });

  afterEach(() => {
    __setUploadTokenReader(null);
  });

  it("DOES attach an upload progress listener (same-origin, no preflight)", async () => {
    const events: UploadProgress[] = [];
    const upload = embeddedHost.upload(
      sampleFile(),
      { ttl: "86400" },
      (p) => events.push(p),
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");

    xhr.triggerUploadProgress(512, 2048);
    xhr.triggerUploadProgress(2048, 2048);
    xhr.triggerLoad(
      201,
      JSON.stringify({
        slug: "x",
        url: "https://grappa.test/uploads/x",
        expires_at: "2026-05-22T00:00:00Z",
      }),
    );
    await upload;

    expect(events).toEqual([
      { loaded: 512, total: 2048 },
      { loaded: 2048, total: 2048 },
    ]);
    expect(xhr.upload.listeners.has("progress")).toBe(true);
  });
});
