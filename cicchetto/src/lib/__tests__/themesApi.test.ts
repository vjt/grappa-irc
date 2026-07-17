import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../api";
import {
  copyTheme,
  createTheme,
  deleteTheme,
  getActiveTheme,
  getTheme,
  listGallery,
  listMine,
  publishTheme,
  setActiveTheme,
  type TokenPayload,
  unpublishTheme,
  updateTheme,
  uploadBackground,
} from "../themesApi";

// themesApi — typed REST client for the #75 themes surface. Mirrors the
// api.ts buildHeaders/readError pattern and reuses api.ts's `readError`
// so the wire error token (rate_limited / forbidden / not_found / …)
// collapses to `ApiError.code`, and the shared 401 dead-token handler
// fires. Tests assert outcomes: the request the verb issued (method +
// URL) and the error-token mapping — not call order.

const TOKEN = "test-bearer";

type StubResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  headers: { get: (k: string) => string | null };
  statusText: string;
};

function ok(body: unknown, status = 200): StubResponse {
  return {
    ok: true,
    status,
    json: async () => body,
    headers: { get: () => null },
    statusText: "",
  };
}

function err(status: number, token: string): StubResponse {
  return {
    ok: false,
    status,
    json: async () => ({ error: token }),
    headers: { get: () => null },
    statusText: "",
  };
}

const fetchSpy = vi.fn<(...args: unknown[]) => Promise<StubResponse>>();

function samplePayload(): TokenPayload {
  const colors: Record<string, string> = {};
  for (const k of [
    "bg",
    "bg_alt",
    "fg",
    "accent",
    "muted",
    "border",
    "mention",
    "mode_op",
    "mode_halfop",
    "mode_voiced",
    "mode_plain",
  ]) {
    colors[k] = "#123456";
  }
  for (let i = 0; i < 16; i++) colors[`nick_${i}`] = "#abcdef";
  return {
    colors: colors as TokenPayload["colors"],
    font_family: "jetbrains-mono",
    background: { image_id: null, opacity: 0.3 },
  };
}

function sampleTheme(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: "Night",
    author: "vjt",
    built_in: false,
    published: false,
    apply_count: 0,
    mine: true,
    payload: samplePayload() as unknown as Record<string, unknown>,
    inserted_at: "2026-07-17T10:00:00Z",
    ...overrides,
  };
}

describe("themesApi", () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  test("listGallery GETs /themes and unwraps the themes envelope", async () => {
    fetchSpy.mockResolvedValue(ok({ themes: [sampleTheme()] }));
    const themes = await listGallery(TOKEN);
    expect(themes).toHaveLength(1);
    expect(themes[0]?.name).toBe("Night");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/themes");
    expect(init.method ?? "GET").toBe("GET");
  });

  test("listMine GETs /me/themes and unwraps the envelope", async () => {
    fetchSpy.mockResolvedValue(ok({ themes: [] }));
    const themes = await listMine(TOKEN);
    expect(themes).toEqual([]);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/me/themes");
  });

  test("getTheme GETs /themes/:id", async () => {
    fetchSpy.mockResolvedValue(ok(sampleTheme({ id: 42 })));
    const theme = await getTheme(TOKEN, 42);
    expect(theme.id).toBe(42);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/themes/42");
  });

  test("createTheme POSTs /themes with name + payload", async () => {
    fetchSpy.mockResolvedValue(ok(sampleTheme(), 201));
    const payload = samplePayload();
    await createTheme(TOKEN, { name: "Night", payload });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/themes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Night", payload });
  });

  test("updateTheme PATCHes /themes/:id", async () => {
    fetchSpy.mockResolvedValue(ok(sampleTheme({ name: "Day" })));
    await updateTheme(TOKEN, 7, { name: "Day" });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/themes/7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Day" });
  });

  test("deleteTheme DELETEs /themes/:id and returns void", async () => {
    fetchSpy.mockResolvedValue(ok({}, 204));
    await expect(deleteTheme(TOKEN, 7)).resolves.toBeUndefined();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/themes/7");
    expect(init.method).toBe("DELETE");
  });

  test("publishTheme POSTs /themes/:id/publish", async () => {
    fetchSpy.mockResolvedValue(ok(sampleTheme({ published: true })));
    const t = await publishTheme(TOKEN, 7);
    expect(t.published).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/themes/7/publish");
    expect(init.method).toBe("POST");
  });

  test("unpublishTheme POSTs /themes/:id/unpublish", async () => {
    fetchSpy.mockResolvedValue(ok(sampleTheme({ published: false })));
    await unpublishTheme(TOKEN, 7);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/themes/7/unpublish");
  });

  test("copyTheme POSTs /themes/:id/copy", async () => {
    fetchSpy.mockResolvedValue(ok(sampleTheme({ id: 99, mine: true }), 201));
    const copy = await copyTheme(TOKEN, 7);
    expect(copy.id).toBe(99);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/themes/7/copy");
  });

  test("getActiveTheme GETs /me/theme and passes through null", async () => {
    fetchSpy.mockResolvedValue(ok(null));
    const active = await getActiveTheme(TOKEN);
    expect(active).toBeNull();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/me/theme");
  });

  test("getActiveTheme returns the resolved theme when set", async () => {
    fetchSpy.mockResolvedValue(ok(sampleTheme({ id: 3 })));
    const active = await getActiveTheme(TOKEN);
    expect(active?.id).toBe(3);
  });

  test("setActiveTheme PUTs /me/theme with the id", async () => {
    fetchSpy.mockResolvedValue(ok(sampleTheme({ id: 3 })));
    await setActiveTheme(TOKEN, 3);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/theme");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ id: 3 });
  });

  test("uploadBackground by URL POSTs JSON body {url}", async () => {
    fetchSpy.mockResolvedValue(ok({ image_id: "slug123" }));
    const res = await uploadBackground(TOKEN, { url: "https://x/y.png" });
    expect(res.image_id).toBe("slug123");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/themes/background");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://x/y.png" });
  });

  test("uploadBackground by file POSTs multipart FormData with no JSON content-type", async () => {
    fetchSpy.mockResolvedValue(ok({ image_id: "slugfile" }));
    const file = new File([new Uint8Array([1, 2, 3])], "bg.png", { type: "image/png" });
    const res = await uploadBackground(TOKEN, { file });
    expect(res.image_id).toBe("slugfile");
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const headers = init.headers as Record<string, string>;
    // The browser sets the multipart boundary content-type itself; forcing
    // application/json here would break the upload.
    expect(headers["content-type"]).toBeUndefined();
  });

  test.each([
    [429, "rate_limited"],
    [403, "forbidden"],
    [404, "not_found"],
    [422, "validation_failed"],
  ])("verb surfaces the wire error token %s → %s as ApiError.code", async (status, token) => {
    fetchSpy.mockResolvedValue(err(status, token));
    const thrown = await createTheme(TOKEN, { name: "x", payload: samplePayload() }).catch(
      (e) => e,
    );
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(status);
    expect((thrown as ApiError).code).toBe(token);
  });
});
