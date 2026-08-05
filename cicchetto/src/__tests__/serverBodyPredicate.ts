// #863 — the server's notion of "an empty message body", modelled here so
// the client-side suites can be held against it.
//
// THIS IS THE HALF THAT MUST BE UPDATED IF THE SERVER CHANGES. The
// disagreement #863 reports is silent precisely because the two predicates
// live in two languages with nothing tying them together: the client's is
// `splitMessageLines`' `!== ""` filter (`src/lib/messageLines.ts`), the
// server's is an emergent property of Ecto rather than a written rule.
// Whichever way the fix goes, both halves move together — and the suites
// that import this file fail until they do.
//
// Where the server's behaviour comes from (read on origin/main, measured on
// prod by the #863 reporter — NOT executed from this suite):
//
//   * `GrappaWeb.MessagesController.create/2` guards on `body != ""`, so a
//     whitespace-only body passes the controller.
//   * `Grappa.Session.send_privmsg/4` only rejects CRLF/NUL, so it passes
//     there too.
//   * `Grappa.Session.Server.persist_and_send_fragments/5` persists BEFORE
//     it relays, and `Grappa.Scrollback.Message.changeset/2` runs
//     `validate_required([:body])`. Ecto's `cast/4` trims string params
//     before its empty-value test (`Ecto.Type.trim/2` against
//     `@empty_values [""]`), so `" "` is treated as an ABSENT param: the
//     change is never applied, `:body` stays nil, and validate_required
//     adds "can't be blank".
//
// So the server accepts a body iff it is non-empty AFTER trimming — an
// accident of `cast/4`, not a decision anyone wrote down. That is the point.
//
// LIMIT, stated rather than papered over: this uses JavaScript's `trim()`,
// which is not byte-identical to Elixir's `String.trim/1` on exotic
// whitespace (U+FEFF is stripped by JS and not by Elixir). Callers must
// keep their samples to ASCII spaces and tabs, where the two agree. This
// model is a stand-in for the real server, and only inside that range.
export const serverAcceptsBody = (body: string): boolean => body.trim() !== "";

// The 422 the server returns when `serverAcceptsBody` is false, in the exact
// shape `readError` builds — `friendlyApiError` renders this as
// `Please fix: body: can't be blank.`, the string the user reported.
export const BLANK_BODY_ERROR = {
  status: 422,
  code: "validation_failed",
  info: { field_errors: { body: ["can't be blank"] } },
} as const;
