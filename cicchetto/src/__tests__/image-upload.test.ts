import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeHost,
  availableHosts,
  type ImageHost,
  litterboxHost,
  type UploadProgress,
} from "../lib/image-upload";

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

  it("acceptedMimeTypes lists the image suffixes the brainstorm pinned", () => {
    expect(litterboxHost.acceptedMimeTypes).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/apng",
    ]);
  });

  it("declares an upper file size", () => {
    expect(typeof litterboxHost.maxFileSizeBytes).toBe("number");
    expect(litterboxHost.maxFileSizeBytes).not.toBeNull();
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
  it("invokes onProgress with {loaded, total} when XHR upload fires progress", async () => {
    const events: UploadProgress[] = [];
    const upload = litterboxHost.upload(
      sampleFile(),
      { ttl: "24h" },
      (p) => events.push(p),
      new AbortController().signal,
    );
    const xhr = MockXMLHttpRequest.instances[0];
    if (!xhr) throw new Error("expected XHR");

    xhr.triggerUploadProgress(512, 2048);
    xhr.triggerUploadProgress(2048, 2048);
    xhr.triggerLoad(200, "https://litter.catbox.moe/x.png");
    await upload;

    expect(events).toEqual([
      { loaded: 512, total: 2048 },
      { loaded: 2048, total: 2048 },
    ]);
  });
});

// ----- Registry + active host ------------------------------------

describe("availableHosts + activeHost", () => {
  it("registers litterboxHost as an available host", () => {
    expect(availableHosts).toContain(litterboxHost);
  });

  it("returns litterboxHost from activeHost() by default", () => {
    expect(activeHost()).toBe(litterboxHost);
  });
});

// ----- Interface contract via in-memory mock ---------------------
//
// Documents how a second ImageHost would be authored. The interface
// is verified by the TypeScript compiler at this declaration site
// (the `: ImageHost` annotation forces the shape).

const mockHost: ImageHost = {
  id: "mock",
  displayName: "in-memory mock",
  retentionStatement: "Files are not actually stored anywhere.",
  ttlOptions: [],
  defaultTtl: null,
  acceptedMimeTypes: ["image/png"],
  maxFileSizeBytes: null,
  upload: (_file, _options, _onProgress, _signal) =>
    Promise.resolve("https://example.invalid/mock.png"),
};

describe("ImageHost interface — second-impl exemplar", () => {
  it("a second impl satisfies the interface and resolves with a URL", async () => {
    const url = await mockHost.upload(sampleFile(), {}, () => {}, new AbortController().signal);
    expect(url).toBe("https://example.invalid/mock.png");
  });

  it("ttlOptions may be empty (host with no TTL choice)", () => {
    expect(mockHost.ttlOptions).toEqual([]);
    expect(mockHost.defaultTtl).toBeNull();
  });
});
