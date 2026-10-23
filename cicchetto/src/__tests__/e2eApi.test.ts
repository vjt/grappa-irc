import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { WireShapeError } from "../lib/wireNarrow";

// issue 2430 — grappa protocol 49's per-device E2E doors. fetch is stubbed;
// each case pins the method, path and body the server's router + controller
// accept (`GrappaWeb.E2eController`), and the token an error carries.

afterEach(() => vi.unstubAllGlobals());

const K43 = "A".repeat(43);
const S86 = "B".repeat(86);
// Both base64url specials: a did is used raw in the path.
const DID = "_Uw_z3-OAsk";
const device = { did: DID, ed25519: K43, curve25519: K43, sig: S86 };
const list = { master: K43, ver: 3, devices: [K43], sig: S86 };

function stub(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const f = vi.fn().mockResolvedValue(
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
  );
  vi.stubGlobal("fetch", f);
  return f;
}

function sent(f: ReturnType<typeof vi.fn>): { url: string; method: string; body: unknown } {
  const [url, init] = f.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: init.method ?? "GET",
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
  };
}

describe("device doors", () => {
  it("registerE2eDevice POSTs the id block and returns the device with its did", async () => {
    const f = stub(200, device);
    const out = await api.registerE2eDevice("tok", "azzurra", {
      ed25519: K43,
      curve25519: K43,
      sig: S86,
    });
    expect(out).toEqual(device);
    expect(sent(f)).toEqual({
      url: "/networks/azzurra/e2e/devices",
      method: "POST",
      body: { ed25519: K43, curve25519: K43, sig: S86 },
    });
  });

  it("registerE2eDevice surfaces 409 too_many_devices as an ApiError token", async () => {
    stub(409, { error: "too_many_devices" });
    await expect(
      api.registerE2eDevice("tok", "azzurra", { ed25519: K43, curve25519: K43, sig: S86 }),
    ).rejects.toMatchObject({ status: 409, code: "too_many_devices" });
  });

  it("listE2eDevices GETs and unwraps the devices array", async () => {
    const f = stub(200, { devices: [device] });
    expect(await api.listE2eDevices("tok", "azzurra")).toEqual([device]);
    expect(sent(f)).toMatchObject({ url: "/networks/azzurra/e2e/devices", method: "GET" });
  });

  it("listE2eDevices rejects a device with no did", async () => {
    stub(200, { devices: [{ ed25519: K43, curve25519: K43, sig: S86 }] });
    await expect(api.listE2eDevices("tok", "azzurra")).rejects.toBeInstanceOf(WireShapeError);
  });

  it("removeE2eDevice DELETEs with the did raw in the path", async () => {
    const f = stub(204, null);
    await api.removeE2eDevice("tok", "azzurra", DID);
    expect(sent(f)).toMatchObject({
      url: `/networks/azzurra/e2e/devices/${DID}`,
      method: "DELETE",
    });
  });

  it("removeE2eDevice surfaces 409 listed_device", async () => {
    stub(409, { error: "listed_device" });
    await expect(api.removeE2eDevice("tok", "azzurra", DID)).rejects.toMatchObject({
      status: 409,
      code: "listed_device",
    });
  });
});

describe("list doors", () => {
  it("getE2eList returns the held list", async () => {
    const f = stub(200, list);
    expect(await api.getE2eList("tok", "azzurra")).toEqual(list);
    expect(sent(f)).toMatchObject({ url: "/networks/azzurra/e2e/list", method: "GET" });
  });

  it("getE2eList answers null on 404: ResolveNetwork and E2eKeys.list share the {error: not_found} body, so no-list-yet and unresolvable-network are indistinguishable", async () => {
    stub(404, { error: "not_found" });
    expect(await api.getE2eList("tok", "azzurra")).toBeNull();
  });

  it("registerE2eDevice on a 404 rejects with ApiError not_found, never resolves", async () => {
    stub(404, { error: "not_found" });
    const p = api.registerE2eDevice("tok", "not-mine", {
      ed25519: K43,
      curve25519: K43,
      sig: S86,
    });
    await expect(p).rejects.toBeInstanceOf(api.ApiError);
    await expect(p).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("getE2eList still throws on a non-404 failure", async () => {
    stub(500, { error: "internal" });
    await expect(api.getE2eList("tok", "azzurra")).rejects.toMatchObject({ status: 500 });
  });

  it("putE2eList PUTs the signed list and returns the one grappa holds", async () => {
    const f = stub(200, list);
    expect(await api.putE2eList("tok", "azzurra", list)).toEqual(list);
    expect(sent(f)).toEqual({ url: "/networks/azzurra/e2e/list", method: "PUT", body: list });
  });

  it.each(["master_mismatch", "stale_list"])("putE2eList surfaces 409 %s", async (token) => {
    stub(409, { error: token });
    await expect(api.putE2eList("tok", "azzurra", list)).rejects.toMatchObject({
      status: 409,
      code: token,
    });
  });

  it("putE2eList surfaces 422 unknown_device", async () => {
    stub(422, { error: "unknown_device" });
    await expect(api.putE2eList("tok", "azzurra", list)).rejects.toMatchObject({
      status: 422,
      code: "unknown_device",
    });
  });
});

describe("per-device key doors", () => {
  it("getE2eDeviceKeys GETs the device's status", async () => {
    const f = stub(200, { one_time_keys: 12, fallback: true });
    expect(await api.getE2eDeviceKeys("tok", "azzurra", DID)).toEqual({
      one_time_keys: 12,
      fallback: true,
    });
    expect(sent(f)).toMatchObject({
      url: `/networks/azzurra/e2e/devices/${DID}/keys`,
      method: "GET",
    });
  });

  it("uploadE2eDeviceKeys POSTs signed keys and a fallback, null fallback included", async () => {
    const f = stub(200, { one_time_keys: 1, fallback: false });
    const upload = { one_time_keys: [{ key: K43, sig: S86 }], fallback: null };
    expect(await api.uploadE2eDeviceKeys("tok", "azzurra", DID, upload)).toEqual({
      one_time_keys: 1,
      fallback: false,
    });
    expect(sent(f)).toEqual({
      url: `/networks/azzurra/e2e/devices/${DID}/keys`,
      method: "POST",
      body: upload,
    });
  });

  it("uploadE2eDeviceKeys surfaces 404 for a did that is not this subject's", async () => {
    stub(404, { error: "not_found" });
    await expect(
      api.uploadE2eDeviceKeys("tok", "azzurra", DID, { one_time_keys: [], fallback: null }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("per-device inbox doors", () => {
  const msg = {
    kind: "e2e_message",
    id: 7,
    network: "azzurra",
    from: "peer",
    from_did: "If4x36FUomE",
    to_did: DID,
    verb: "msg",
    msgid: "m1",
    payload: '{"v":2}',
    own: false,
  };

  it("listE2eDeviceInbox GETs ?after= and returns the messages with from_did/to_did", async () => {
    const f = stub(200, { messages: [msg] });
    const out = await api.listE2eDeviceInbox("tok", "azzurra", DID, 5);
    expect(out.messages[0]).toMatchObject({ from_did: "If4x36FUomE", to_did: DID });
    expect(sent(f)).toMatchObject({
      url: `/networks/azzurra/e2e/devices/${DID}/inbox?after=5`,
      method: "GET",
    });
  });

  it("listE2eDeviceInbox rejects a message with no to_did", async () => {
    const { to_did: _drop, ...v1 } = msg;
    stub(200, { messages: [v1] });
    await expect(api.listE2eDeviceInbox("tok", "azzurra", DID, 0)).rejects.toBeInstanceOf(
      WireShapeError,
    );
  });

  it("ackE2eDeviceInbox POSTs the ids to that device's ack door", async () => {
    const f = stub(204, null);
    await api.ackE2eDeviceInbox("tok", "azzurra", DID, [7, 8]);
    expect(sent(f)).toEqual({
      url: `/networks/azzurra/e2e/devices/${DID}/inbox/ack`,
      method: "POST",
      body: { ids: [7, 8] },
    });
  });
});

describe("sendE2e", () => {
  const base = {
    target: "peer",
    verb: "msg",
    from: "If4x36FUomE",
    to: "*",
    payload: '{"v":2}',
    priority: "text",
  } as const;

  it("sends from, to and priority, and omits expires_at when expiresAt is null", async () => {
    const f = stub(202, { msgid: "m9" });
    expect(await api.sendE2e("tok", "azzurra", { ...base, expiresAt: null })).toEqual({
      msgid: "m9",
    });
    const s = sent(f);
    expect(s).toMatchObject({ url: "/networks/azzurra/e2e/messages", method: "POST" });
    expect(s.body).toEqual(base);
    expect(Object.keys(s.body as object)).not.toContain("expires_at");
  });

  it("puts expires_at on the wire when expiresAt is a number", async () => {
    const f = stub(202, { msgid: "m9" });
    await api.sendE2e("tok", "azzurra", { ...base, priority: "control", expiresAt: 1_900_000_000 });
    expect(sent(f).body).toEqual({ ...base, priority: "control", expires_at: 1_900_000_000 });
  });

  it("surfaces 422 unknown_device and 429 rate_limited as tokens", async () => {
    stub(422, { error: "unknown_device" });
    await expect(api.sendE2e("tok", "azzurra", { ...base, expiresAt: null })).rejects.toMatchObject(
      { status: 422, code: "unknown_device" },
    );
    stub(429, { error: "rate_limited" });
    await expect(api.sendE2e("tok", "azzurra", { ...base, expiresAt: null })).rejects.toMatchObject(
      { status: 429, code: "rate_limited" },
    );
  });
});

describe("clearE2eKeys", () => {
  it("DELETEs /e2e/keys", async () => {
    const f = stub(204, null);
    await api.clearE2eKeys("tok", "azzurra");
    expect(sent(f)).toMatchObject({ url: "/networks/azzurra/e2e/keys", method: "DELETE" });
  });
});
