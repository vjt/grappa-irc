// oidc-op — stub OpenID Provider for the #1911 login e2e.
//
// The controller tests in test/grappa_web/controllers/oidc_controller_test.exs
// stub the OP with Bypass over cleartext http://localhost — which is exactly
// the half of the contract they CANNOT exercise: Discovery and IdToken refuse
// non-https endpoints, and Req/Finch verify_peer against the system CA store
// (:public_key.cacerts_get()). No CI lane ever spoke TLS to a provider. This
// sidecar is that lane: a real https OP at https://oidc-test:3443 whose CA
// the stack trusts (see ../oidc-certs/gen-certs.sh — the merged bundle is
// mounted over grappa-test's /etc/ssl/certs/ca-certificates.crt), so
// discovery + JWKS + the token exchange all cross a verified TLS connection
// before the browser ever sees a landing.
//
// Shape (mirrors push-catcher's posture): one node-stdlib file, zero deps,
// no production-code surface, reachable only intra-network. It implements
// the provider contract grappa actually enforces — authorization code +
// PKCE S256, HTTP Basic client auth at the token endpoint, ES256 id_token
// with a kid-only JOSE header and a P-256 JWKS — and is STRICT on the
// authorize params, because in this stack a malformed redirect request is
// a grappa regression this e2e exists to catch, not an input to tolerate.
//
// One node-specific trap, handled in derToRaw(): crypto.sign('SHA256')
// returns the ECDSA signature DER-encoded, while JOSE expects the raw
// fixed-width r||s concatenation (64 bytes for P-256). Signing with the
// DER form verbatim produces an id_token every compliant verifier —
// grappa's included — rejects as a bad signature. The Bypass tests sign
// with JOSE itself so this class of bug is invisible to them; here the
// stub OP is a second implementation, which is the point.
//
// Endpoints:
//   GET  /.well-known/openid-configuration — discovery doc.
//   GET  /authorize  — strict param check, then a consent page with one
//                      form-button per persona (linked user / stranger).
//   POST /approve    — form from the consent page; 302 to the redirect_uri
//                      with a one-time code + the echoed state.
//   POST /token      — Basic auth + code + redirect_uri + code_verifier →
//                      ES256 id_token (nonce echoed, aud = client_id).
//   GET  /jwks.json  — the P-256 public key (kid-tagged).
//   GET  /healthz    — liveness for the compose healthcheck.
//
// Personas (the only two the e2e needs):
//   oidc1911 — sub pre-linked to the seeded `oidc1911` grappa user by the
//              compose seeder (Grappa.Auth.Oidc.link_identity/4).
//   stranger — sub no account claims → grappa must answer not_linked.

import { createServer } from "node:https";
import { createHash, createSign, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

const PORT = Number(process.env.PORT ?? 3443);
const HOST = process.env.HOST ?? "0.0.0.0";

const ISSUER = "https://oidc-test:3443";
const CLIENT_ID = "grappa-e2e";
const CLIENT_SECRET = "grappa-e2e-secret";
const REDIRECT_URI = "https://nginx-test/auth/oidc/callback";
const KID = "oidc-op-e2e-1";
const ID_TOKEN_TTL_S = 300;
const CODE_TTL_MS = 60_000;
const REQUEST_TTL_MS = 300_000;

const PERSONAS = {
  oidc1911: { sub: "1911-linked-sub", name: "Oidc Eleven", preferred_username: "oidc1911" },
  stranger: { sub: "1919-stranger-sub", name: "Stranger", preferred_username: "stranger" },
};

// Ephemeral P-256 signing key, minted at boot. A restart mid-run rotates it;
// grappa fetches the JWKS after the (60s-cached) discovery, so a fresh boot
// is always observed before the next id_token is verified.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PUBLIC_JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "ES256", use: "sig" };

/** Pending /authorize requests, keyed by opaque id — the consent forms carry it back. */
const pending = new Map();
/** One-time authorization codes → everything /token needs to bind to. */
const codes = new Map();

function sweep(now) {
  for (const [k, r] of pending) if (r.expires_at < now) pending.delete(k);
  for (const [k, c] of codes) if (c.expires_at < now) codes.delete(k);
}

function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}

// DER ECDSA-Sig-Value {r INTEGER, s INTEGER} → JOSE raw r||s, each left-
// padded to the P-256 field width (32 bytes).
function derToRaw(der) {
  if (der[0] !== 0x30) throw new Error("not a DER sequence");
  let i = 2; // skip SEQUENCE header (length ≤ 128 for P-256, short form)
  const integer = () => {
    if (der[i] !== 0x02) throw new Error("not a DER integer");
    const len = der[i + 1];
    i += 2;
    let v = der.subarray(i, i + len);
    i += len;
    if (v[0] === 0) v = v.subarray(1); // strip the sign-padding byte
    if (v.length > 32) throw new Error("integer wider than P-256");
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  const r = integer();
  const s = integer();
  return Buffer.concat([r, s]);
}

function mintIdToken(persona, nonce) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: KID };
  const claims = {
    iss: ISSUER,
    sub: persona.sub,
    aud: CLIENT_ID,
    exp: now + ID_TOKEN_TTL_S,
    iat: now,
    nonce,
    name: persona.name,
    preferred_username: persona.preferred_username,
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = createSign("SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${b64u(derToRaw(sig))}`;
}

function send(res, status, body, headers = {}) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain" : "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
  return status;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readForm(req) {
  const body = await readBody(req);
  const params = new URLSearchParams(body.toString("utf8"));
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

// Expected Authorization: Basic grappa-e2e:grappa-e2e-secret — what Req's
// `auth: {:basic, ...}` sends. A mismatch is invalid_client (401), the
// shape grappa maps to its invalid_code arm.
function basicAuthOk(req) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const expect = Buffer.from(`Basic ${b64u(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
  const got = Buffer.from(header);
  return expect.length === got.length && timingSafeEqual(expect, got);
}

function consentPage(requestId) {
  const form = (persona, label) =>
    `<form method="post" action="/approve"><input type="hidden" name="req" value="${requestId}">` +
    `<input type="hidden" name="persona" value="${persona}">` +
    `<button type="submit" data-testid="op-consent-${persona}">${label}</button></form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>stub OP — consent</title></head>
<body><h1>Sign in — grappa e2e stub OP</h1>
${form("oidc1911", "Continue as oidc1911")}
${form("stranger", "Continue as stranger")}
</body></html>`;
}

const server = createServer(
  { key: readFileSync("/certs/oidc.key"), cert: readFileSync("/certs/oidc.crt") },
  async (req, res) => {
    const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "oidc-test"}`);
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        // Silent on purpose: the compose healthcheck polls every 5s and the
        // container log doubles as the flow trace — boot + exchanges only.
        send(res, 200, "ok");
        return;
      }

      if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        send(res, 200, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks.json`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/jwks.json") {
        send(res, 200, { keys: [PUBLIC_JWK] });
        return;
      }

      if (req.method === "GET" && url.pathname === "/authorize") {
        const q = url.searchParams;
        // STRICT on purpose: grappa's authorize redirect is the thing under
        // test. A missing or malformed param here is a grappa regression —
        // the spec's click never finds a consent button and fails loudly.
        const bad = (why) => send(res, 400, `bad authorize request: ${why}`);
        if (q.get("response_type") !== "code") return bad("response_type must be code");
        if (q.get("client_id") !== CLIENT_ID) return bad("unknown client_id");
        if (q.get("redirect_uri") !== REDIRECT_URI) return bad("redirect_uri mismatch");
        if (!(q.get("scope") ?? "").split(/\s+/).includes("openid")) return bad("scope must include openid");
        if (q.get("code_challenge_method") !== "S256") return bad("code_challenge_method must be S256");
        const challenge = q.get("code_challenge") ?? "";
        if (challenge.length < 43 || challenge.length > 128) return bad("code_challenge must be 43-128 chars");
        for (const key of ["state", "nonce"]) {
          if ((q.get(key) ?? "") === "") return bad(`${key} is required`);
        }

        const requestId = b64u(randomBytes(16));
        pending.set(requestId, {
          state: q.get("state"),
          nonce: q.get("nonce"),
          challenge,
          redirect_uri: q.get("redirect_uri"),
          expires_at: Date.now() + REQUEST_TTL_MS,
        });
        console.log(`authorize: req=${requestId.slice(0, 8)} challenge=${challenge.slice(0, 8)}…`);
        send(res, 200, consentPage(requestId), { "content-type": "text/html; charset=utf-8" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/approve") {
        const form = await readForm(req);
        const record = pending.get(form.req);
        pending.delete(form.req);
        const persona = PERSONAS[form.persona];
        if (record === undefined || persona === undefined) {
          send(res, 400, "unknown consent request");
          return;
        }
        const code = b64u(randomBytes(24));
        codes.set(code, {
          persona,
          nonce: record.nonce,
          challenge: record.challenge,
          redirect_uri: record.redirect_uri,
          expires_at: Date.now() + CODE_TTL_MS,
        });
        console.log(`approve: persona=${form.persona} sub=${persona.sub}`);
        const target = new URL(record.redirect_uri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", record.state);
        send(res, 302, "", { location: target.toString() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/token") {
        if (!basicAuthOk(req)) {
          console.log("token: refused — bad client credentials");
          send(res, 401, { error: "invalid_client" });
          return;
        }
        const form = await readForm(req);
        const record = codes.get(form.code);
        codes.delete(form.code); // one-time, consumed whether it verifies or not
        const refuse = (error, why) => {
          console.log(`token: ${error} — ${why}`);
          return send(res, 400, { error });
        };
        if (form.grant_type !== "authorization_code") return refuse("unsupported_grant_type", "wrong grant_type");
        if (record === undefined) return refuse("invalid_grant", "unknown or reused code");
        if (form.redirect_uri !== record.redirect_uri) return refuse("invalid_grant", "redirect_uri mismatch");
        const verifier = form.code_verifier;
        if ((verifier ?? "") === "") return refuse("invalid_request", "code_verifier is required");
        if (b64u(createHash("sha256").update(verifier).digest()) !== record.challenge) {
          return refuse("invalid_grant", "PKCE verification failed");
        }

        const id_token = mintIdToken(record.persona, record.nonce);
        console.log(`token: issued id_token sub=${record.persona.sub}`);
        send(res, 200, {
          access_token: `stub-${b64u(randomBytes(12))}`,
          token_type: "Bearer",
          expires_in: ID_TOKEN_TTL_S,
          id_token,
        });
        return;
      }

      send(res, 404, { error: "not_found", method: req.method, path: url.pathname });
    } catch (err) {
      console.error(`error on ${req.method} ${url.pathname}:`, err);
      if (!res.headersSent) send(res, 500, "internal error");
      else res.end();
    }
  },
);

setInterval(() => sweep(Date.now()), 30_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`oidc-op listening on https://${HOST}:${PORT} (issuer ${ISSUER}, client ${CLIENT_ID})`);
});
