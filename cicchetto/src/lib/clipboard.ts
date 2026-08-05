// #726 — one clipboard write for the surfaces that show a secret exactly
// once (TOTP recovery codes, passwordless recovery codes).
//
// `navigator.clipboard` is `[SecureContext]`-only, so on a plain-http
// deployment — an operator serving grappa over `http://` on a LAN, which is
// supported — the property is `undefined` and a bare `.writeText` throws a
// raw `TypeError: undefined is not an object`. The write can also reject on a
// denied permission or a non-user-gesture call.
//
// Neither failure may be silent HERE, whatever a caller elsewhere chooses:
// recovery codes are displayed once and are unrecoverable afterwards, so a
// user who believes the copy worked loses them. Throw with copy that names
// the reason AND the way out (copy by hand), and let the caller render it.
//
// `ShareSessionModal` deliberately keeps its own silent catch and is NOT
// routed through here: the artifact it copies is a URL still sitting in a
// visible, selectable input, so the failure is self-correcting. Same call,
// different stakes.
export async function copyText(text: string): Promise<void> {
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) {
    throw new Error(
      "This browser only allows copying over a secure (HTTPS) connection. Select the text and copy it by hand.",
    );
  }
  await clipboard.writeText(text);
}
