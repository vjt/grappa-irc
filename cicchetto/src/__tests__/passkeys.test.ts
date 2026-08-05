import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPasskey, getPasskey, passkeysAvailable } from "../lib/passkeys";

// The server speaks snake_case and `navigator.credentials` speaks the
// camelCase WebAuthn shape; lib/passkeys.ts is the only place that
// translates. Nothing else in the app would notice a mistranslation, so
// these assert the exact object the browser API is handed.

const b64 = (bytes: number[]): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const bytesOf = (buffer: BufferSource | undefined): number[] =>
  Array.from(new Uint8Array(buffer as ArrayBuffer));

const definedOr = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
};

const optionsGivenTo = <T>(spy: ReturnType<typeof vi.fn>): T => {
  const call = definedOr(spy.mock.calls[0], "the browser credentials API to have been called");
  return (call[0] as { publicKey: T }).publicKey;
};

const credentialStub = {
  rawId: new Uint8Array([9, 9]).buffer,
  response: {
    attestationObject: new Uint8Array([1]).buffer,
    clientDataJSON: new Uint8Array([2]).buffer,
    authenticatorData: new Uint8Array([3]).buffer,
    signature: new Uint8Array([4]).buffer,
    userHandle: null,
    getTransports: () => ["usb"],
  },
};

let create: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;

beforeEach(() => {
  create = vi.fn().mockResolvedValue(credentialStub);
  get = vi.fn().mockResolvedValue(credentialStub);
  vi.stubGlobal("navigator", { credentials: { create, get } });
});

// #725 — `CredentialsContainer` is [SecureContext]-only, so on a plain-http
// deployment (grappa is self-hosted; an operator on `http://192.168.1.10` is
// a supported reality) `navigator.credentials` is `undefined` and both entry
// points threw `TypeError: undefined is not an object (evaluating
// 'navigator.credentials.get')` — a JavaScript internal printed verbatim on
// the login card and in the settings pane.
describe("an origin or browser without WebAuthn", () => {
  const refusalFrom = async (run: () => Promise<unknown>): Promise<unknown> =>
    run().then(
      () => {
        throw new Error("expected the ceremony to be refused");
      },
      (value: unknown) => value,
    );

  beforeEach(() => {
    // Exactly what a browser hands you over plain http: no `credentials`.
    vi.stubGlobal("navigator", {});
  });

  it("reports itself unavailable", () => {
    expect(passkeysAvailable()).toBe(false);
  });

  it("refuses registration by name rather than throwing a raw TypeError", async () => {
    const refusal = await refusalFrom(() =>
      createPasskey({ challenge_id: "cid", public_key: { challenge: b64([1]) } }),
    );

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toMatch(/secure \(HTTPS\) connection/);
  });

  it("refuses authentication by name rather than throwing a raw TypeError", async () => {
    const refusal = await refusalFrom(() =>
      getPasskey({
        challenge_id: "cid",
        public_key: { challenge: b64([1]), rp_id: "irc.example" },
      }),
    );

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toMatch(/secure \(HTTPS\) connection/);
  });
});

describe("createPasskey", () => {
  it("reports itself available when the browser implements the ceremony", () => {
    expect(passkeysAvailable()).toBe(true);
  });

  const options = {
    challenge_id: "cid",
    public_key: {
      challenge: b64([1, 2, 3]),
      rp: { id: "irc.example", name: "Grappa" },
      user: { id: b64([4, 5]), name: "vjt", display_name: "vjt" },
      pub_key_cred_params: [{ type: "public-key", alg: -7 }],
      timeout: 300000,
      attestation: "none",
      authenticator_selection: { resident_key: "preferred", user_verification: "required" },
    },
  };

  it("hands the browser the camelCase shape with decoded buffers", async () => {
    await createPasskey(options);

    const publicKey = optionsGivenTo<PublicKeyCredentialCreationOptions>(create);
    expect(bytesOf(publicKey.challenge)).toEqual([1, 2, 3]);
    expect(bytesOf(publicKey.user.id)).toEqual([4, 5]);
    expect(publicKey.user.displayName).toBe("vjt");
    expect(publicKey.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
    expect(publicKey.authenticatorSelection).toEqual({
      residentKey: "preferred",
      userVerification: "required",
    });
  });

  it("leaves no snake_case key behind for the browser to ignore", async () => {
    await createPasskey(options);

    const publicKey = optionsGivenTo<PublicKeyCredentialCreationOptions>(create);
    expect(Object.keys(publicKey).filter((key) => key.includes("_"))).toEqual([]);
  });
});

describe("getPasskey", () => {
  it("decodes allow_credentials so a non-discoverable key can be offered", async () => {
    await getPasskey({
      challenge_id: "cid",
      public_key: {
        challenge: b64([7]),
        rp_id: "irc.example",
        timeout: 300000,
        user_verification: "required",
        allow_credentials: [{ type: "public-key", id: b64([1, 2, 3]), transports: ["usb"] }],
      },
    });

    const publicKey = optionsGivenTo<PublicKeyCredentialRequestOptions>(get);
    expect(publicKey.rpId).toBe("irc.example");
    expect(publicKey.userVerification).toBe("required");

    const descriptor = definedOr(publicKey.allowCredentials?.[0], "one offered credential");
    expect(descriptor.type).toBe("public-key");
    expect(descriptor.transports).toEqual(["usb"]);
    expect(bytesOf(descriptor.id)).toEqual([1, 2, 3]);
  });

  it("omits transports when the server sent no hint", async () => {
    await getPasskey({
      challenge_id: "cid",
      public_key: {
        challenge: b64([7]),
        rp_id: "irc.example",
        allow_credentials: [{ type: "public-key", id: b64([1]) }],
      },
    });

    const publicKey = optionsGivenTo<PublicKeyCredentialRequestOptions>(get);
    const descriptor = definedOr(publicKey.allowCredentials?.[0], "one offered credential");
    expect("transports" in descriptor).toBe(false);
  });

  it("sends an empty allow list when the passwordless door offered none", async () => {
    await getPasskey({
      challenge_id: "cid",
      public_key: { challenge: b64([7]), rp_id: "irc.example", user_verification: "required" },
    });

    expect(optionsGivenTo<PublicKeyCredentialRequestOptions>(get).allowCredentials).toEqual([]);
  });
});
