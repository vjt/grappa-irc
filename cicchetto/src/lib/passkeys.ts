export type PasskeyOptions = {
  challenge_id: string;
  public_key: Record<string, unknown>;
};

type CreationJSON = Omit<
  PublicKeyCredentialCreationOptions,
  "challenge" | "user" | "excludeCredentials"
> & {
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
  excludeCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
};

type RequestJSON = Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> & {
  challenge: string;
  allowCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
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

export async function createPasskey(options: PasskeyOptions): Promise<Record<string, unknown>> {
  const json = options.public_key as CreationJSON;
  const publicKey = {
    ...json,
    challenge: decode(json.challenge),
    user: { ...json.user, id: decode(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((item) => ({
      ...item,
      id: decode(item.id),
    })),
  } as PublicKeyCredentialCreationOptions;
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
  const json = options.public_key as RequestJSON;
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...json,
    challenge: decode(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((item) => ({
      ...item,
      id: decode(item.id),
    })),
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
