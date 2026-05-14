// push-catcher — minimal HTTP sink for the e2e Push.Sender path.
//
// Push notifications cluster B5 (2026-05-14). The integration stack
// has no real Web Push vendor reachable (FCM / Mozilla autopush
// require external network + valid VAPID-public-key registration).
// This sidecar plays the role of the vendor: cic registers a fake
// PushSubscription whose `endpoint` points at this server, the
// stored row drives `Grappa.Push.Sender.send_to_subscription/2`,
// and the upstream `:web_push_elixir` lib POSTs the encrypted body
// here. The spec then polls `GET /received/<subscription-id>` to
// confirm fan-out actually fired.
//
// Why not assert via server-side telemetry instead:
//   - telemetry handler attached from the runner would require a
//     remote BEAM connection (epmd + cookies + erlang distribution),
//     a much heavier seam than a single docker-network HTTP server.
//   - the goal of the trigger specs is to assert end-to-end fan-out:
//     server-side fired, *and* an HTTP request reached a vendor-
//     shaped endpoint. Telemetry stops at the Sender boundary;
//     push-catcher proves the bytes left the BEAM.
//   - push-catcher is one node-stdlib file with zero deps, no PROD
//     code touch. Trade-off accepted: e2e harness gains a sidecar,
//     production code stays untouched.
//
// Path scheme:
//   POST /p/<id>     — vendor delivery; body buffered, recorded under <id>.
//   GET  /received/<id> — JSON array of received bodies for <id>.
//   POST /reset       — wipe all recorded state (per-spec teardown).
//   GET  /healthz    — liveness for compose healthcheck.

import { createServer } from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

/** @type {Map<string, Array<{headers: Record<string,string>, body_b64: string, received_at: number}>>} */
const received = new Map();

function send(res, status, body) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain" : "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "push-catcher"}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    send(res, 200, "ok");
    return;
  }

  if (req.method === "POST" && url.pathname === "/reset") {
    received.clear();
    send(res, 204, "");
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/p/")) {
    const id = decodeURIComponent(url.pathname.slice(3));
    if (id === "") {
      send(res, 400, { error: "missing_id" });
      return;
    }
    const body = await readBody(req);
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(",");
    }
    const list = received.get(id) ?? [];
    list.push({
      headers,
      body_b64: body.toString("base64"),
      received_at: Date.now(),
    });
    received.set(id, list);
    // 201 Created mirrors a real push vendor's accept-and-deliver
    // shape — the upstream lib's success arm is `{:ok, _}` for 2xx.
    send(res, 201, "");
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/received/")) {
    const id = decodeURIComponent(url.pathname.slice("/received/".length));
    if (id === "") {
      send(res, 400, { error: "missing_id" });
      return;
    }
    send(res, 200, { id, deliveries: received.get(id) ?? [] });
    return;
  }

  send(res, 404, { error: "not_found", method: req.method, path: url.pathname });
});

server.listen(PORT, HOST, () => {
  console.log(`push-catcher listening on http://${HOST}:${PORT}`);
});
