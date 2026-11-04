// The CTCP ACTION envelope, and the one place that knows its shape.
//
// The server stores the wire-form body verbatim per the CLAUDE.md CTCP
// "preserved as-is" rule (round-trip fidelity for ACTION and other verbs), so
// every consumer that wants the text a human actually saw has to unwrap it.
//
// #1126 — this used to be a module-local `const` inside `ScrollbackPane.tsx`,
// which meant the RENDER layer unwrapped the envelope and the REPLY layer did
// not: replying to an `/me` quoted `<nick> \x01ACTION text\x01<< ` and shipped
// both delimiters back onto the wire inside an ordinary PRIVMSG. One parser,
// one shape, both doors.

export const CTCP_DELIMITER = "\x01";
const CTCP_ACTION_PREFIX = `${CTCP_DELIMITER}ACTION `;

// #591 — the single CTCP frame builder: `\x01VERB\x01` (no args) or
// `\x01VERB args\x01`. This is the ONE place that wraps a body in CTCP `\x01`
// framing — shared by /me (verb ACTION, one frame per line), /ctcp (arbitrary
// verb, single frame) and the #1192 nick-menu CTCP submenu. Empty args yield NO
// trailing space, so a bare `/ctcp bob version` frames as `\x01VERSION\x01`,
// not `\x01VERSION \x01`.
//
// #1192 moved it here from `compose.ts`. It always belonged next to the
// envelope it builds — the note below already had to point across a module
// boundary to name it — and the move is what lets `ctcpQuery.ts` frame a menu
// dispatch without importing `compose`, which imports `ctcpQuery` back.
export const ctcpFrame = (verb: string, args: string): string =>
  args === ""
    ? `${CTCP_DELIMITER}${verb}${CTCP_DELIMITER}`
    : `${CTCP_DELIMITER}${verb} ${args}${CTCP_DELIMITER}`;

// Whether `body` is an action: the envelope `stripCtcpAction` unwraps.
export const isCtcpAction = (body: string): boolean => body.startsWith(CTCP_ACTION_PREFIX);

// The inner text of an action body, or the body unchanged when the envelope
// isn't there. Defensive on purpose: a future server-side pre-strip, or a row
// persisted before the wire form was stored, must still render.
export const stripCtcpAction = (body: string | null): string => {
  if (!body) return "";
  if (!body.startsWith(CTCP_ACTION_PREFIX)) return body;
  const inner = body.slice(CTCP_ACTION_PREFIX.length);
  return inner.endsWith(CTCP_DELIMITER) ? inner.slice(0, -1) : inner;
};

// Scrub every CTCP delimiter out of operator-typed free text.
//
// `\x01` is framing, and cic has exactly ONE sanctioned producer of it
// (`ctcpFrame`, above). A delimiter arriving in free text is either a
// paste or a bug upstream; either way it is not framing the operator chose, so
// it must not survive to the wire. Scrub rather than reject — the byte is
// invisible, so refusing the whole message would be an unexplainable failure,
// and the tree's posture for a stray \x01 is already "scrub it" (#641).
export const scrubCtcpDelimiters = (text: string): string => text.replaceAll(CTCP_DELIMITER, "");
