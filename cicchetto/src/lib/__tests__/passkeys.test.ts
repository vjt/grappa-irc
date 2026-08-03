import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPasskey, getPasskey } from "../passkeys";

// #736 — `lib/passkeys.ts` shipped with no coverage. It is the ONE place
// the snake_case wire meets the camelCase WebAuthn API, and the ONE place
// base64url ⇄ ArrayBuffer conversion happens. Both are silent-corruption
// candidates: a wrong alphabet swap or a dropped `=` pad yields a
// well-formed buffer of the WRONG bytes, so the ceremony fails at the
// authenticator (or, worse, verifies against a different challenge) with
// nothing in the UI naming the cause.
//
// jsdom ships no `navigator.credentials`, so the ceremony is faked at that
// exact boundary — everything above it (both conversions, both option
// rebuilds, both cancel guards) is the real module.

const credentials = { create: vi.fn(), get: vi.fn() };

const creationOptionsFrom = (options: unknown): PublicKeyCredentialCreationOptions => {
  const publicKey = (options as { publicKey?: PublicKeyCredentialCreationOptions }).publicKey;
  if (publicKey === undefined) throw new Error("credentials.create called without publicKey");
  return publicKey;
};

const requestOptionsFrom = (options: unknown): PublicKeyCredentialRequestOptions => {
  const publicKey = (options as { publicKey?: PublicKeyCredentialRequestOptions }).publicKey;
  if (publicKey === undefined) throw new Error("credentials.get called without publicKey");
  return publicKey;
};

const bytesOf = (buffer: ArrayBuffer | ArrayBufferView): number[] =>
  Array.from(
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  );

const requestOptions = (overrides: Record<string, unknown>) => ({
  challenge_id: "challenge-1",
  public_key: { challenge: "AQIDBA", rp_id: "grappa.example", ...overrides },
});

const creationOptions = (overrides: Record<string, unknown>) => ({
  challenge_id: "challenge-1",
  public_key: {
    challenge: "AQIDBA",
    rp: { id: "grappa.example", name: "Grappa" },
    user: { id: "dXNlcg", name: "alice", display_name: "Alice L" },
    pub_key_cred_params: [{ type: "public-key", alg: -7 }],
    ...overrides,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "credentials", { value: credentials, configurable: true });
});

afterEach(() => {
  // Delete rather than set-undefined: jsdom's baseline is an ABSENT
  // property, and #725's feature detection probes for exactly that.
  Reflect.deleteProperty(navigator, "credentials");
});

describe("passkeys — base64url ⇄ ArrayBuffer", () => {
  // Every sample exercises a different pad length (0/1/2 `=`) AND both
  // URL-alphabet substitutions, so a lost pad or a `-`/`+` mix-up moves
  // at least one of them.
  const SAMPLES = ["-_-_", "abc", "-A", "AQIDBAUGBwgJCg"];

  it.each(SAMPLES)("round-trips %s unchanged through decode → encode", async (sample) => {
    // The challenge goes IN as base64url, is decoded to an ArrayBuffer for
    // the authenticator, and comes back OUT re-encoded as `raw_id`. Echoing
    // the decoded buffer back as the credential makes the pair an identity
    // check using only production code — no local re-implementation of
    // either half to drift against.
    credentials.get.mockImplementation(async (options: unknown) => {
      const challenge = requestOptionsFrom(options).challenge as ArrayBuffer;
      return {
        rawId: challenge,
        response: {
          authenticatorData: challenge,
          clientDataJSON: challenge,
          signature: challenge,
          userHandle: null,
        },
      };
    });

    const result = await getPasskey(requestOptions({ challenge: sample }));

    expect(result.raw_id).toBe(sample);
  });

  it("decodes the URL alphabet as `-`→`+` and `_`→`/`, not the reverse", async () => {
    // "-_-_" is "+/+/" in standard base64 → 0xFB 0xFF 0xBF. Swapping the
    // two substitutions yields a different byte triple, and dropping them
    // makes `atob` throw — either way this pin moves.
    credentials.get.mockResolvedValue({
      rawId: new Uint8Array([1]).buffer,
      response: {
        authenticatorData: new Uint8Array([2]).buffer,
        clientDataJSON: new Uint8Array([3]).buffer,
        signature: new Uint8Array([4]).buffer,
        userHandle: null,
      },
    });

    await getPasskey(requestOptions({ challenge: "-_-_" }));

    const publicKey = requestOptionsFrom(credentials.get.mock.calls[0]?.[0]);
    expect(bytesOf(publicKey.challenge)).toEqual([0xfb, 0xff, 0xbf]);
  });

  it("strips the `=` padding off the encoded output", async () => {
    // A 1-byte buffer is 4 base64 chars, 2 of them padding. `=` is not
    // URL-safe and the server decodes strict base64url, so the pad MUST
    // be gone on the way out.
    credentials.get.mockResolvedValue({
      rawId: new Uint8Array([0xf8]).buffer,
      response: {
        authenticatorData: new Uint8Array([0xf8]).buffer,
        clientDataJSON: new Uint8Array([0xf8]).buffer,
        signature: new Uint8Array([0xf8]).buffer,
        userHandle: null,
      },
    });

    const result = await getPasskey(requestOptions({}));

    expect(result.raw_id).toBe("-A");
  });
});

describe("passkeys — getPasskey (assertion ceremony)", () => {
  const assertion = {
    rawId: new Uint8Array([0x01]).buffer,
    response: {
      authenticatorData: new Uint8Array([0x02]).buffer,
      clientDataJSON: new Uint8Array([0x03]).buffer,
      signature: new Uint8Array([0x04]).buffer,
      userHandle: new Uint8Array([0x05]).buffer,
    },
  };

  it("rebuilds the wire options into the camelCase WebAuthn shape", async () => {
    credentials.get.mockResolvedValue(assertion);

    await getPasskey(
      requestOptions({
        timeout: 60_000,
        user_verification: "required",
        allow_credentials: [
          { type: "public-key", id: "AQID", transports: ["internal"] },
          { type: "public-key", id: "BAUG" },
        ],
      }),
    );

    const publicKey = requestOptionsFrom(credentials.get.mock.calls[0]?.[0]);
    expect(publicKey.rpId).toBe("grappa.example");
    expect(publicKey.timeout).toBe(60_000);
    expect(publicKey.userVerification).toBe("required");
    const allowed = publicKey.allowCredentials ?? [];
    expect(allowed.map((item) => bytesOf(item.id))).toEqual([
      [0x01, 0x02, 0x03],
      [0x04, 0x05, 0x06],
    ]);
    // `transports` is OMITTED (not `undefined`) when the wire omits it —
    // Safari rejects a descriptor carrying an explicit undefined.
    expect(allowed[0]?.transports).toEqual(["internal"]);
    expect(allowed[1] === undefined ? true : "transports" in allowed[1]).toBe(false);
  });

  it("sends an empty allowCredentials when the wire omits it", async () => {
    credentials.get.mockResolvedValue(assertion);

    await getPasskey(requestOptions({}));

    expect(requestOptionsFrom(credentials.get.mock.calls[0]?.[0]).allowCredentials).toEqual([]);
  });

  it("returns the assertion with the challenge_id it was handed", async () => {
    credentials.get.mockResolvedValue(assertion);

    const result = await getPasskey(requestOptions({}));

    expect(result).toEqual({
      challenge_id: "challenge-1",
      raw_id: "AQ",
      authenticator_data: "Ag",
      client_data_json: "Aw",
      signature: "BA",
      user_handle: "BQ",
    });
  });

  it("keeps a null user_handle null instead of encoding it", async () => {
    // A second-factor assertion carries no user handle. `encode(null)`
    // would throw inside `String.fromCharCode`, so the null MUST survive
    // as null all the way to the wire.
    credentials.get.mockResolvedValue({
      ...assertion,
      response: { ...assertion.response, userHandle: null },
    });

    const result = await getPasskey(requestOptions({}));

    expect(result.user_handle).toBeNull();
  });

  it("rejects with a cancelled message when the user dismisses the prompt", async () => {
    // Chrome resolves `get()` with null on some dismiss paths instead of
    // rejecting; without the guard the next line reads `.rawId` off null
    // and the user sees a TypeError.
    credentials.get.mockResolvedValue(null);

    await expect(getPasskey(requestOptions({}))).rejects.toThrow(
      "Passkey authentication cancelled",
    );
  });
});

describe("passkeys — createPasskey (registration ceremony)", () => {
  const attestation = {
    rawId: new Uint8Array([0x01]).buffer,
    response: {
      attestationObject: new Uint8Array([0x02]).buffer,
      clientDataJSON: new Uint8Array([0x03]).buffer,
      getTransports: () => ["usb", "nfc"],
    },
  };

  it("rebuilds the wire options into the camelCase WebAuthn shape", async () => {
    credentials.create.mockResolvedValue(attestation);

    await createPasskey(
      creationOptions({
        attestation: "none",
        authenticator_selection: { resident_key: "required", user_verification: "preferred" },
        exclude_credentials: [{ type: "public-key", id: "AQID" }],
      }),
    );

    const publicKey = creationOptionsFrom(credentials.create.mock.calls[0]?.[0]);
    // `display_name` → `displayName` is the whole reason this rebuild
    // exists; a passthrough would hand the authenticator an undefined.
    expect(publicKey.user.displayName).toBe("Alice L");
    expect(publicKey.user.name).toBe("alice");
    expect(bytesOf(publicKey.user.id)).toEqual([0x75, 0x73, 0x65, 0x72]);
    expect(publicKey.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
    expect(publicKey.attestation).toBe("none");
    expect(publicKey.authenticatorSelection).toEqual({
      residentKey: "required",
      userVerification: "preferred",
    });
    expect((publicKey.excludeCredentials ?? []).map((item) => bytesOf(item.id))).toEqual([
      [0x01, 0x02, 0x03],
    ]);
  });

  it("returns the attestation with the transports the authenticator reported", async () => {
    credentials.create.mockResolvedValue(attestation);

    const result = await createPasskey(creationOptions({}));

    expect(result).toEqual({
      challenge_id: "challenge-1",
      raw_id: "AQ",
      attestation_object: "Ag",
      client_data_json: "Aw",
      transports: ["usb", "nfc"],
    });
  });

  it("sends an empty transports list when the authenticator has no getTransports", async () => {
    // `getTransports` is not universal (older Safari/Firefox). The optional
    // call MUST degrade to [] rather than blow up the registration.
    credentials.create.mockResolvedValue({
      ...attestation,
      response: { ...attestation.response, getTransports: undefined },
    });

    const result = await createPasskey(creationOptions({}));

    expect(result.transports).toEqual([]);
  });

  it("rejects with a cancelled message when the user dismisses the prompt", async () => {
    credentials.create.mockResolvedValue(null);

    await expect(createPasskey(creationOptions({}))).rejects.toThrow("Passkey creation cancelled");
  });
});
