// #739 — IMPORTED, not re-declared. This is a wire shape, so api.ts owns it.
// A second identical declaration here typechecked only by structural
// coincidence, and would have gone stale silently the day the server renamed
// a field: `tsc` stays green while the unchanged subset still matches, and
// the mismatch surfaces as a WebAuthn failure on device.
import type { PasskeyOptions } from "./api";

// The wire is snake_case without exception, but `navigator.credentials`
// wants the camelCase WebAuthn shape. Both ceremonies already have to
// rebuild the options object to turn base64url strings into ArrayBuffers,
// so that rebuild is the one place the two spellings meet.

type DescriptorJSON = { type: "public-key"; id: string; transports?: AuthenticatorTransport[] };

type CreationJSON = {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name: string; display_name: string };
  pub_key_cred_params: PublicKeyCredentialParameters[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticator_selection?: {
    resident_key?: ResidentKeyRequirement;
    user_verification?: UserVerificationRequirement;
  };
  exclude_credentials?: DescriptorJSON[];
};

type RequestJSON = {
  challenge: string;
  rp_id: string;
  timeout?: number;
  user_verification?: UserVerificationRequirement;
  allow_credentials?: DescriptorJSON[];
};

const decode = (value: string): ArrayBuffer => {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0)).buffer;
};

const encode = (value: ArrayBuffer): string => {
  const raw = String.fromCharCode(...new Uint8Array(value));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// #725 — `CredentialsContainer` is `[SecureContext]`-only. grappa is
// self-hosted and an operator serving it over `http://` on a LAN is a
// supported deployment, so `navigator.credentials` being `undefined` is not a
// hypothetical: both ceremonies used to run into it and throw
// `TypeError: undefined is not an object (evaluating
// 'navigator.credentials.get')`, which the login card and the settings pane
// then printed verbatim at the user.
//
// The predicate tests the two functions this module actually CALLS rather
// than `isSecureContext`. Same answer — the browser withholds the whole
// container off a secure context, which is the cause — but it is the honest
// question ("can the ceremony run?") and it also covers a browser that simply
// has no WebAuthn. `PublicKeyCredential` is deliberately NOT in the test: it
// appears in this file only in type positions, so requiring it at runtime
// would assert something we never touch.
export const PASSKEYS_UNAVAILABLE =
  "Passkeys need a secure (HTTPS) connection and a browser that supports them.";

export function passkeysAvailable(): boolean {
  const credentials = navigator.credentials as CredentialsContainer | undefined;
  return typeof credentials?.create === "function" && typeof credentials.get === "function";
}

const requireWebAuthn = (): void => {
  if (!passkeysAvailable()) throw new Error(PASSKEYS_UNAVAILABLE);
};

const toDescriptor = (item: DescriptorJSON): PublicKeyCredentialDescriptor => ({
  type: item.type,
  id: decode(item.id),
  ...(item.transports === undefined ? {} : { transports: item.transports }),
});

export async function createPasskey(options: PasskeyOptions): Promise<Record<string, unknown>> {
  requireWebAuthn();
  const json = options.public_key as CreationJSON;
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: decode(json.challenge),
    rp: json.rp,
    user: { id: decode(json.user.id), name: json.user.name, displayName: json.user.display_name },
    pubKeyCredParams: json.pub_key_cred_params,
    timeout: json.timeout,
    attestation: json.attestation,
    authenticatorSelection: {
      residentKey: json.authenticator_selection?.resident_key,
      userVerification: json.authenticator_selection?.user_verification,
    },
    excludeCredentials: (json.exclude_credentials ?? []).map(toDescriptor),
  };
  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (credential === null) throw new Error("Passkey creation cancelled");
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    challenge_id: options.challenge_id,
    raw_id: encode(credential.rawId),
    attestation_object: encode(response.attestationObject),
    client_data_json: encode(response.clientDataJSON),
    transports: response.getTransports?.() ?? [],
  };
}

export async function getPasskey(options: PasskeyOptions): Promise<Record<string, unknown>> {
  requireWebAuthn();
  const json = options.public_key as RequestJSON;
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: decode(json.challenge),
    rpId: json.rp_id,
    timeout: json.timeout,
    userVerification: json.user_verification,
    allowCredentials: (json.allow_credentials ?? []).map(toDescriptor),
  };
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (credential === null) throw new Error("Passkey authentication cancelled");
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    challenge_id: options.challenge_id,
    raw_id: encode(credential.rawId),
    authenticator_data: encode(response.authenticatorData),
    client_data_json: encode(response.clientDataJSON),
    signature: encode(response.signature),
    user_handle: response.userHandle === null ? null : encode(response.userHandle),
  };
}
