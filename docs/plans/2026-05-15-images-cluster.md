# Images cluster

**Status**: brainstorm v3 (vjt-blessed 2026-05-15, ready to start) —
implementation NOT started. I-CSP cleared to begin.

| Bucket | Status | Deploy | Notes |
|--------|--------|--------|-------|
| I-CSP — nginx CSP `connect-src` allowlist for litterbox | brainstorm | **COLD** (nginx reload) | Lands first |
| I-1 — pluggable image-host interface + litterbox impl | brainstorm | cic-bundle | `image-upload.ts` behind an interface; litterbox = first impl |
| I-2 — ComposeBox upload UI (picker + drag-drop) + privacy modal + 📸-prefix insertion | brainstorm | cic-bundle | The whole user-facing surface |
| I-3 — docs sweep (README + DESIGN_NOTES + project-story) | brainstorm | none | In-step per `feedback_readme_currency` |
| I-Z — cluster CLOSE | brainstorm | n/a | Mirror visitor-parity CLOSE shape |

**Branch**: `cluster/images` (worktree from local main).
**Position**: post-`visitor-parity-and-nickserv` (CP32). Spec seed:
`project_image_upload` memory, vjt-confirmed 2026-05-03 + refined
2026-05-15 (this doc v2).
**Origin evidence**: vjt verbal spec — "IRC REMAINS TEXT FUCKING
ONLY." Operator picks file in cic, file goes to litterbox.catbox.moe,
URL is auto-sent (or pre-filled — see Q-AUTOSEND) into PRIVMSG
prefixed with the photocamera emoji `📸`. NO clickable thumbnails,
NO scrollback rendering changes, NO lightbox. The browser's
native "click a link to a .png → open in new tab" IS the image
viewer; zero ceremony beyond what already ships.

## Goal

**Make uploading an image from cic feel native, while leaving IRC
itself text-only.** The ONLY new render surface is in the compose
box (file picker button + drag-drop landing). Once uploaded, the
PRIVMSG body is `📸 https://litter.catbox.moe/abc.png` — plain text,
indistinguishable from a hand-pasted URL. cic operators click the
link, the browser opens the image in a new tab. Other IRC clients
(irssi, weechat, the future Phase-6 listener facade) see the same
text and the same clickable URL. No special handling anywhere
downstream.

**What we are NOT building.**
- NO inline thumbnails in scrollback. NO lightbox component. NO
  changes to `cicchetto/src/ScrollbackPane.tsx`. NO changes to
  `cicchetto/src/lib/linkify.ts` (it already linkifies any URL
  including `.png` ones — that's the entire image-viewing surface
  we need).
- NO grappa-side proxying of images. The browser POSTs directly to
  litterbox; the browser fetches directly from
  `files.catbox.moe`/`litter.catbox.moe`. Grappa never touches image
  bytes.
- NO image-edit / annotate / crop / blur tools.
- NO catbox.moe permanent uploads (file sharing is out of scope per
  CLAUDE.md spirit; `project_image_upload` already pinned this).
- NO clipboard-paste handler in v1 (Q-PASTE — easy to add later if
  vjt wants it).

**Subject parity.** Visitors and registered users get the SAME
upload surface. The CP32 visitor-parity invariant covers this — no
`subject.kind === "user"` gate anywhere in the new code paths.

## Architecture decisions

### A1. Direct-to-host upload, no grappa proxying

Browser POSTs multipart directly to the image host. Grappa is
uninvolved end-to-end:

- Zero new server code.
- Zero `Plug.Parsers` config changes.
- Zero `lib/grappa_web/body_limit.ex` changes (HIGH-19's 4096-byte
  PRIVMSG body cap fits a `📸 https://litter.catbox.moe/abc.png`
  message ten times over).
- Zero `infra/nginx.conf` `client_max_body_size` changes (default
  1MB stays; the upload doesn't touch nginx).

vjt's framing: "we do not ease spamming litterbox at all." The end
user IS litterbox's user — abuse-control is litterbox's surface, not
ours. ZERO server ceremony.

### A2. Pluggable host interface (`image-upload.ts`), litterbox = first impl

Per vjt: "we DONT KNOW if we stay on litterbox thus BUILD INTERFACE
to plug different image hosters tomorrow ... litterbox has a fucking
api and other providers have different apis so ensure the fucking
pluggable interface provides enough flexibility to swap image
providers." The interface must accommodate REAL provider diversity:

| Provider | Endpoint | Auth | Request shape | Response shape | TTL semantics |
|----------|----------|------|---------------|----------------|---------------|
| litterbox.catbox.moe | `/resources/internals/api.php` | none | multipart `reqtype=fileupload` + `time=1h\|12h\|24h\|72h` + `fileToUpload` | text body = URL | server-side TTL, host picks expiry |
| catbox.moe (permanent) | `/user/api.php` | optional userhash | multipart `reqtype=fileupload` + `userhash=<token>` + `fileToUpload` | text body = URL | none (permanent) |
| 0x0.st | `/` | none | multipart `file=<binary>` + optional `expires=<hours>` | text body = URL | client-requested TTL header |
| imgur | `/3/upload` | bearer (`Authorization: Client-ID <id>`) | multipart or base64 JSON | JSON `{data:{link, deletehash, ...}}` | none |
| custom self-hosted | varies | varies | varies | varies | varies |

Generalizations the interface must encode:

- **Endpoint URL** + **HTTP method** (always POST in practice).
- **Headers** the host requires (`Authorization`, custom client-id,
  etc.) — provider-supplied.
- **Request body builder** — takes `(file, options)`, returns a
  `FormData` (or `Blob` for hosts that want raw bytes). Provider
  decides field names + extras.
- **Response parser** — takes raw response text + status, returns
  `{url} | {error}`. Litterbox returns text; imgur returns JSON.
  Provider decides shape.
- **TTL options** — provider-supplied list of `{value, label}` pairs
  to populate the cic dropdown (litterbox: `1h/12h/24h/72h`;
  imgur: `[]` — no TTL choice; 0x0.st: `1h..720h`).
- **Default TTL** — provider-supplied; cic respects user override
  via the dropdown if provider exposes choices; hides dropdown
  entirely if `ttlOptions` is empty.
- **Capabilities flags** — `supportsTtl`, `supportsDelete`,
  `requiresAuth`, etc. — for cic UI gating (e.g. hide TTL dropdown
  when `!supportsTtl`).
- **Privacy posture** — host name + retention statement string for
  the privacy modal (`name: "litterbox"`, `retentionStatement:
  "Files are public for the next 24 hours."`; `name: "imgur"`,
  `retentionStatement: "Files are public until you delete them."`).
- **Progress** + **abort** mechanics — uniform via XHR + AbortSignal
  (host doesn't customize this; cic owns the XHR loop).

```ts
// cicchetto/src/lib/image-upload.ts

export type UploadProgress = { loaded: number; total: number };

export type UploadError =
  | { kind: "network" }
  | { kind: "http"; status: number; body: string }
  | { kind: "abort" }
  | { kind: "invalid_response"; body: string }
  | { kind: "provider"; message: string }; // host-decoded error string

export type TtlOption = { value: string; label: string };

export type UploadOptions = {
  ttl?: string;             // value from provider's ttlOptions
  // future: signal preferred filename, content-type override, etc.
};

export interface ImageHost {
  readonly id: string;                       // "litterbox", "imgur", "0x0"
  readonly displayName: string;              // "litterbox.catbox.moe"
  readonly retentionStatement: string;       // privacy-modal copy fragment
  readonly ttlOptions: ReadonlyArray<TtlOption>; // [] if no TTL choice
  readonly defaultTtl: string | null;        // matches a ttlOptions value, or null
  readonly maxFileSizeBytes: number | null;  // for client-side pre-check; null = unknown
  readonly acceptedMimeTypes: ReadonlyArray<string>; // for <input accept="..."> + drop gate

  /** Provider-specific request builder + dispatcher.
   * Implementations should:
   *   - build the request body (FormData) per provider contract
   *   - set provider-required headers (auth, client-id, etc.)
   *   - POST via XMLHttpRequest (cic pattern — needed for progress)
   *   - parse response per provider contract
   *   - resolve with the public URL string
   *   - reject with UploadError
   */
  upload(
    file: File,
    options: UploadOptions,
    onProgress: (p: UploadProgress) => void,
    signal: AbortSignal,
  ): Promise<string>;
}

export const litterboxHost: ImageHost = { /* impl */ };

// Active host — module-level for now. Future: settings-drawer
// dropdown lets operator pick; persists per-browser in localStorage.
export const activeHost = (): ImageHost => litterboxHost;

// Registry — for the future drawer toggle to enumerate.
export const availableHosts: ReadonlyArray<ImageHost> = [litterboxHost];
```

Call site (in `ComposeBox.tsx` / orchestrator) is provider-agnostic:

```ts
const host = activeHost();
const ttl = chosenTtl() ?? host.defaultTtl;  // dropdown value, falling back to default
const url = await host.upload(file, { ttl }, onProgress, ctrl.signal);
sendPrivmsg(`📸 ${url}`);
```

The cic dropdown reads `host.ttlOptions` — empty array → dropdown
hidden entirely (imgur shape). MIME accept attr reads
`host.acceptedMimeTypes.join(",")`. Drop gate compares
`file.type` against `host.acceptedMimeTypes`. Privacy modal
interpolates `host.displayName` + `host.retentionStatement`.

Switching to a new host tomorrow: write a second `ImageHost` impl
(its own request builder + response parser), add to `availableHosts`,
swap `activeHost()`. Zero changes elsewhere — that's the test of
whether the interface is right.

I-1 ships this interface PLUS the litterbox impl PLUS a simple
in-memory mock impl for tests. A second real impl is NOT in cluster
scope, but the interface is designed so adding one is mechanical.

### A3. PRIVMSG body shape: `📸 <url>`

After successful upload, the PRIVMSG body is `📸 ` + URL. Single
photocamera emoji prefix + space + URL. That's it. Per vjt:
"plain irc message with just a photocamera emoji 📸 and the
fucking link. that's it."

- Non-cic clients see `📸 https://litter.catbox.moe/abc.png` —
  plain text + clickable URL. Modern IRC clients render the emoji;
  ASCII-only clients see the codepoint glyph or `?` placeholder.
  Either way the URL is right there to click.
- cic users: `linkify.ts` already wraps the URL in `<a target="_blank">`
  (`ScrollbackPane.tsx:217-220`). Click → browser opens image in
  new tab. ZERO new render code.
- Phase-6 IRCv3 listener facade: sees the same text. No special
  handling needed.

### A4. Default TTL = 24h

Per vjt. (`project_image_upload` memory had 72h as my original
default; vjt overrode to 24h.) Litterbox's default TTL surfaces via
the `ImageHost` interface as `litterboxHost.defaultTtl = "24h"`;
operator can override per upload via the dropdown that lists
`litterboxHost.ttlOptions = [{1h}, {12h}, {24h}, {72h}]`.
Last-chosen TTL persists in `localStorage` keyed per host
(`image-upload-ttl:litterbox`) so swapping providers later doesn't
silently inherit the wrong default.

### A5. Upload trigger surfaces — picker + drag-drop + paste + mobile camera

vjt 2026-05-15: "YES drag and drop on desktop YES browse library
from phone ... clipboard paste sure why not ... we should allow to
upload from camera on mobile as well." Four trigger surfaces in v1:

1. **File picker button** in ComposeBox: `<input type="file"
   accept={host.acceptedMimeTypes.join(",")} hidden>` + a small
   camera-icon button that fires `.click()`. On desktop opens the
   OS file picker; on mobile (iOS/Android) opens the photo library.
2. **Mobile camera capture** — separate trigger or HTML attribute?
   Two viable shapes:
   - **Shape A (recommended):** add a SECOND button next to the
     gallery-picker, visible only on touch/mobile (CSS
     `@media (pointer: coarse)`), that uses `<input type="file"
     accept="image/*" capture="environment" hidden>`. The
     `capture="environment"` attribute tells iOS Safari + Android
     Chrome to open the rear-camera capture UI directly (skipping
     the gallery). Two distinct buttons = two distinct intents
     ("pick from library" vs "take photo now") — clearer UX than
     one button that does both depending on user choice in a
     system sheet.
   - **Shape B (alt):** single picker button without `capture`;
     mobile OSes show a sheet with "Photo Library" + "Take Photo"
     options natively. Simpler markup; relies on OS sheet quality
     (iOS does this well, Android varies).
   - **Default:** Shape A. Two buttons, two clear intents. Defer
     to Q-CAMERA-UI if vjt prefers Shape B.
3. **Drag-drop** on the ComposeBox container (desktop only —
   irrelevant on touch): `ondragover` / `ondragleave` / `ondrop`
   handlers. Visual cue: dashed border on drag-over.
4. **Clipboard paste** on the textarea: `onpaste` intercepts
   `e.clipboardData.items` looking for `kind === "file"` with type
   in `host.acceptedMimeTypes`. Cmd-Shift-Ctrl-4 → paste workflow
   on macOS, Win+Shift+S → paste on Windows, screenshot apps on
   Linux. If a non-image paste happens (text), passes through
   normally.

All four triggers feed into the same `host.upload()` call. ONE
upload code path; FOUR trigger surfaces.

### A6. First-upload privacy modal — operator-side, no server involvement

Per `feedback_no_localized_strings_server_side`: server stays out of
cic copy. First upload per browser per `localStorage` key
`image-upload-privacy-acknowledged`:

> Files you upload here go to {host.displayName} —
> {host.retentionStatement} Don't upload anything you wouldn't want
> a stranger to see. [Cancel] [Continue] [☐ Don't show this again]

For litterbox: `displayName: "litterbox.catbox.moe"`,
`retentionStatement: "a public temporary host. Anyone with the URL
can view files there for the next 24 hours."` Modal copy is
parameterized so swapping host tomorrow doesn't require copy edits;
each `ImageHost` impl supplies its own retention statement.

Privacy ack is **per host** (key: `image-upload-privacy-acknowledged:litterbox`),
not global — switching to a host with different privacy semantics
re-prompts the user. No "Continue" without explicit click.

### A7. Inline progress UI in compose (not toast)

While upload is in flight: a small row beneath the textarea shows
filename + progress bar + cancel button. Multi-MB iPhone screenshots
on cellular take 10-30s — non-optional UX. On completion: progress
row dismissed, `📸 <url>` body **auto-sent immediately** as a normal
PRIVMSG via the existing `compose.ts` `submit()` flow (vjt 2026-05-15:
"after upload autosend yes"). On error: progress row turns red with
retry + dismiss buttons. Compose stays editable throughout — operator
can keep typing a separate message while upload runs.

If operator wants to add caption alongside the image: send a
follow-up text message. The 📸-prefix message is intentionally
single-purpose; trying to bundle caption + image in one PRIVMSG
adds UX state (queue the upload then send on Enter? cancel both on
Esc?) that is not worth the complexity in v1.

### A8. CSP change is COLD — only `connect-src`, NOT `img-src`

Per `feedback_hot_deploy_preflight` HIGH-29: hot path doesn't reload
nginx. Per vjt: "NO PROBLEM WITH COLD DEPLOY."

**Only `connect-src` needs `https://litterbox.catbox.moe`** — for
the multipart POST from cic. **`img-src` does NOT need an entry**
because cic NEVER renders images; the user clicks a link, the
browser opens the image URL in a new tab, which is its own document
load completely outside our CSP.

I-CSP is its own COLD bucket, deployed standalone (`scripts/deploy.sh
--force-cold`), BEFORE I-1 / I-2 ship to cic. Otherwise operator's
first upload hits a silent CSP wall on the XHR.

### A9. `accept="image/*"` + MIME gate on drag-drop + paste

Per `project_image_upload` cluster scope = images. Each trigger
respects the host's `acceptedMimeTypes`:
- File picker `<input>` uses `accept={host.acceptedMimeTypes.join(",")}`.
- Drag-drop `ondrop` checks `file.type` against
  `host.acceptedMimeTypes`; non-match → inline error.
- Camera `<input capture>` uses `accept="image/*"` (always — the
  camera always produces an image).
- Clipboard paste checks `e.clipboardData.items[i].type` against
  `host.acceptedMimeTypes`; non-image paste passes through to
  textarea normally.

For litterbox: `acceptedMimeTypes: ["image/png", "image/jpeg",
"image/gif", "image/webp", "image/apng"]`. Litterbox itself accepts
arbitrary file types, but the cluster scope is "image upload" per
`project_image_upload` — generic file uploads is a separate ask
with different ergonomics (no obvious shape for the PRIVMSG body —
the photocamera emoji wouldn't fit). Defer.

### A10. Codify "IRC stays text-only" in CLAUDE.md

Per vjt 2026-05-15: "yes porco dio codify that in claude.md, as
that is already in readme.md." I-3 adds a CLAUDE.md rule under
Engineering Standards — Code-shape rules:

> **IRC stays text only.** No inline rendering of media types in
> scrollback (images, videos, audio, link-unfurl previews). Media
> URLs in PRIVMSG bodies are clickable links via the existing
> `linkify` path; clicking opens the resource in a browser tab.
> Do not propose in-scrollback thumbnails / autoplay / preview
> cards / lightbox-on-arrival without an explicit cluster spec
> lifting this rule. The image-upload cluster (2026-05-15) ships
> a 📸-prefixed URL pattern that is text on the wire and a
> clickable link in cic — that is the model.

Lands in I-3 docs sweep alongside the README + DESIGN_NOTES update.

## CSP change — exact diff (I-CSP)

`infra/snippets/security-headers.conf` line 61 — single `add_header
Content-Security-Policy` line. ONE directive gains ONE entry:

```
- connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com;
+ connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com https://litterbox.catbox.moe;
```

`img-src` stays `'self' data:` — unchanged (we don't render image
hosts). Update the moduledoc comment block at the top of
`security-headers.conf` to document the new entry + cluster name +
WHY (mirror existing hcaptcha rationale shape).

## Buckets

### Bucket I-CSP — nginx CSP `connect-src` allowlist update

**Failing test first:** N/A in code (CSP lives in nginx config).
Empirical verification step from operator workstation:

```sh
curl -F "reqtype=fileupload" -F "time=24h" \
     -F "fileToUpload=@/tmp/test.png" \
     https://litterbox.catbox.moe/resources/internals/api.php
```

Note the response URL host. Pin in `image-upload.ts` impl (informs
which host to NOT include in `img-src` — should be no-op since we
don't render images; informs the privacy-modal "you can view the
URL at <host>" copy though).

Manual smoke after deploy: cic loads cleanly, DevTools console
shows zero new CSP violations (no regression).

**Production change:**

1. `infra/snippets/security-headers.conf` line 61 — add
   `https://litterbox.catbox.moe` to `connect-src`.
2. Update the module-comment block at the top to document the new
   entry + cluster name + why (mirror hcaptcha rationale shape).

**Exit criteria:** CSP diff applied; nginx reloaded; existing cic
functionality regression-tested (login, scrollback, captcha if
configured); DevTools console shows zero new CSP violations on a
fresh cic load; `scripts/healthcheck.sh` returns ok.

**Deploy:** **COLD** — `scripts/deploy.sh --force-cold` (per
HIGH-29). Standalone bucket; lands BEFORE I-1/I-2 so the first
upload doesn't hit a silent CSP wall.

### Bucket I-1 — pluggable image-host interface + litterbox impl

**Failing test first:** `cicchetto/src/__tests__/image-upload.test.ts`:

Interface contract (host-agnostic — uses an in-memory mock impl that
simulates progress/error/abort deterministically):
- `mockHost.upload(file, opts, onProgress, signal)` invokes
  `onProgress` at least once with `{loaded, total}` shape.
- `signal.abort()` mid-upload → rejects with `{kind: "abort"}`.
- Network error → rejects with `{kind: "network"}`.
- HTTP 4xx → rejects with `{kind: "http", status, body}`.
- HTTP 5xx → rejects with `{kind: "http", status, body}`.
- Empty / non-URL response → rejects with `{kind:
  "invalid_response", body}`.
- Provider-decoded error string (e.g. imgur `{success: false,
  data: {error: "..."}}`) → rejects with `{kind: "provider",
  message}`.

Litterbox-specific (mocks `XMLHttpRequest`, asserts wire shape):
- `litterboxHost.upload(file, {ttl: "24h"}, ...)` POSTs to
  `https://litterbox.catbox.moe/resources/internals/api.php` with
  multipart fields `reqtype=fileupload`, `time=24h`,
  `fileToUpload=<binary>`.
- Each TTL value `1h`/`12h`/`24h`/`72h` produces matching `time=`
  field.
- Resolves with response body trimmed (the URL).
- `litterboxHost.id === "litterbox"`.
- `litterboxHost.displayName === "litterbox.catbox.moe"`.
- `litterboxHost.retentionStatement` mentions "24 hours" and
  "public" and "anyone with the URL" (assert substrings — exact
  copy not pinned).
- `litterboxHost.ttlOptions` has 4 entries with `value` ∈
  `{1h,12h,24h,72h}`.
- `litterboxHost.defaultTtl === "24h"`.
- `litterboxHost.acceptedMimeTypes` is a non-empty array of
  `image/*` types.
- `availableHosts` includes `litterboxHost`.
- `activeHost()` returns `litterboxHost` by default.

**Production change:**

1. New `cicchetto/src/lib/image-upload.ts` — `ImageHost` interface,
   types (`UploadProgress`, `UploadError`, `TtlOption`,
   `UploadOptions`), `litterboxHost` impl, `availableHosts` array,
   `activeHost()` selector. Uses `XMLHttpRequest` (not `fetch`) —
   needed for upload progress events across all browser targets.
2. NO consumer changes in this bucket — interface only. I-2 wires
   it up.

**Exit criteria:** vitest green; `scripts/bun.sh run check` green
(typecheck + lint); module is consumer-free until I-2 wires it up;
litterbox + interface contract both covered; mock host impl shows
how to write a second provider.

**Deploy:** cic-bundle (`scripts/deploy-cic.sh`).

### Bucket I-2 — ComposeBox upload UI + privacy modal + 📸-prefix auto-send

**Failing test first:** `cicchetto/src/__tests__/ComposeBox.test.tsx`:

- Click camera-icon button → file picker opens (mock
  `<input>.click()`).
- Select image file via mocked input change → `activeHost().upload()`
  called with file + chosen TTL.
- Click camera-capture button (mobile) → opens picker with
  `capture="environment"` attribute set.
- Drag image file onto compose container → same upload path.
- Drag NON-image file (e.g. `.txt`) → rejected with inline error;
  no upload triggered.
- Paste image from clipboard (mocked `ClipboardEvent` with
  `items[0].kind === "file"` + `image/*` MIME) → same upload path;
  textarea content NOT modified.
- Paste text from clipboard → passes through to textarea normally;
  no upload triggered.
- During upload: progress row visible with filename + cancel
  button; compose stays editable.
- On upload success: PRIVMSG body `📸 <url>` is **auto-sent**
  immediately via `compose.ts` `submit()` (per A7); progress row
  dismissed.
- Auto-send happens even if textarea has draft text (the draft
  stays in the textarea unchanged; the image message is its own
  separate PRIVMSG).
- On upload error: progress row turns red with retry + dismiss;
  compose still editable.
- First-upload (localStorage flag absent for current host id):
  privacy modal shown; modal blocks upload until "Continue"
  clicked.
- "Don't show again" + Continue → localStorage flag set
  (`image-upload-privacy-acknowledged:litterbox`); subsequent
  uploads to same host bypass modal.
- Subsequent uploads (flag present): modal NOT shown.
- Per-host privacy ack: switching to a different `activeHost()`
  re-shows modal (different localStorage key per host id).
- Privacy-modal copy includes `activeHost().displayName` and
  `activeHost().retentionStatement` (parameterized).
- TTL dropdown defaults to `activeHost().defaultTtl`; selecting
  another value persists in `localStorage` keyed per host id
  (`image-upload-ttl:litterbox`); affects next upload.
- TTL dropdown HIDDEN entirely when `host.ttlOptions.length === 0`
  (test with mock host with no TTL options).
- Camera-capture button hidden via CSS `@media (pointer: coarse)`
  on desktop — assert button present in DOM but with
  display-context test (or accept this is CSS-only and skip the
  unit test, defer to Playwright).
- Cancel mid-upload aborts XHR + dismisses progress row.
- Playwright e2e (per `feedback_ux_e2e_mandatory`): scripted
  operator drags fixture image onto compose → privacy modal →
  Continue → upload → PRIVMSG sent with `📸 <url>` → assert
  message visible in scrollback with clickable link via existing
  linkify rendering. Assert link click opens new tab (Playwright
  page.expect_event for popup or just assert href + target=_blank).

**Production change:**

1. `cicchetto/src/ComposeBox.tsx` extensions:
   - Camera-icon picker button + hidden `<input type="file">` with
     `accept` from `host.acceptedMimeTypes.join(",")`.
   - Mobile camera-capture button + hidden `<input type="file"
     accept="image/*" capture="environment">`. CSS-hidden on
     desktop via `@media (pointer: coarse)`.
   - Drag-drop handlers on form container (desktop only, but
     handlers don't need to be conditionally bound — touch
     devices won't fire dragenter).
   - Textarea `onpaste` handler for clipboard image paste.
   - Inline progress row beneath textarea (new `<Show>` reading
     from upload-state signal).
   - TTL dropdown next to picker — `<Show when={host.ttlOptions.length > 0}>`.
   - On upload success: build body `📸 ${url}`, call existing
     `compose.ts` `submit()` directly (bypassing the textarea —
     auto-send path is independent of operator's draft text).
2. Tiny privacy-modal component (single-purpose, dismissable, no
   external lib). Reads/writes localStorage keyed per host id.
   Copy interpolates `host.displayName` + `host.retentionStatement`.
3. Camera-icon SVG (inline or asset — implementation taste).
4. CSS for new bits — picker buttons, drag-over highlight (dashed
   border), progress row, modal, mobile-button media query.

**Exit criteria:** vitest green; Playwright e2e green; manual smoke
on three browsers (desktop Chrome, desktop Safari, iOS Safari) AND
one Android device with all four trigger surfaces (picker, camera,
drop, paste); 8MB file uploads cleanly with visible progress;
cancel works mid-upload; first-upload modal appears + dismisses
correctly; PRIVMSG body in scrollback renders the link as clickable
(existing linkify path, regression-checked); auto-send fires on
upload success.

**Deploy:** cic-bundle.

### Bucket I-3 — README + DESIGN_NOTES + project-story + CLAUDE.md sweep

**Failing test first:** N/A (docs).

**Production change:**

1. `README.md` — add a one-paragraph "Image upload" subsection in
   the cic feature list. Mention: pluggable host (litterbox first
   impl), 24h default TTL, four trigger surfaces (picker / camera /
   drag-drop / paste), 📸-prefix wire shape, IRC-text-only render
   contract.
2. `docs/DESIGN_NOTES.md` — chronological entry: cluster name,
   date, A1-A10 summary, retro reference.
3. `docs/project-story.md` — episode (per CLAUDE.md "Project story
   lives on" rule).
4. `CLAUDE.md` — add the "IRC stays text only" rule under
   Engineering Standards / Code-shape rules per A10. vjt
   2026-05-15: "yes porco dio codify that in claude.md, as that
   is already in readme.md."

**Exit criteria:** README diff reads cleanly; DESIGN_NOTES entry
chronological + complete; project-story episode named + dated;
CLAUDE.md "IRC stays text only" rule landed.

**Deploy:** none.

### Bucket I-Z — cluster CLOSE

After I-CSP + I-1 + I-2 + I-3 green:

1. `cd /Users/mbarnaba/code/grappa/.worktrees/images && git fetch
   origin main && git rebase origin/main`
2. Re-run gates: `scripts/check.sh` + `scripts/bun.sh run check` +
   `scripts/bun.sh run test` + `scripts/integration.sh`.
3. Standalone Dialyzer per `feedback_dialyzer_plt_staleness`:
   `scripts/dialyzer.sh`.
4. Brief vjt with cluster summary (commit shas, what shipped per
   bucket, deviations).
5. Merge: `cd /Users/mbarnaba/code/grappa && git checkout main &&
   git merge --ff-only cluster/images`.
6. Per-bucket deploy reminder: I-CSP shipped standalone earlier
   (COLD); I-1/I-2 ship as cic bundles via `scripts/deploy-cic.sh`.
   Per `feedback_deploy_preflight_empty_diff_after_merge`: post-
   local-merge the deploy preflight diff is empty → manually verify
   nothing snuck in (`mix.lock`, long_lived_modules, migrations,
   nginx.conf) before a final `--force-cold` if needed.
7. Healthcheck: `scripts/healthcheck.sh`.
8. Browser smoke from anon visitor + identified visitor + registered-
   user session: each tier picks an image AND drags an image (8MB+
   file); upload succeeds; `📸 <url>` lands in PRIVMSG; clicking
   the URL opens image in new tab; cancel works mid-upload;
   first-upload modal appears once.
9. CSP regression check: DevTools console shows zero new CSP
   violations on a normal cic session.
10. Push origin/main per `feedback_push_autonomy`.
11. Update `project_post_p4_1_arc` — mark cluster CLOSED, point at
    next.
12. Write CP3X at `docs/checkpoints/2026-05-XX-cp3X.md`.
13. DESIGN_NOTES entry — chronological log, A1-A10 summary +
    lessons learned.
14. README updated (lands in I-3, verify final).
15. Story episode at `docs/project-story.md` (lands in I-3, verify
    final).
16. CLAUDE.md update — only if new recurring rule surfaced (likely
    the no-inline-thumbnails contract).
17. Save memory: `project_image_cluster_closed`.
18. Worktree cleanup: `git worktree remove .worktrees/images`.

## Open questions for vjt — RESOLVED

All resolved 2026-05-15:

- **Q-AUTOSEND** ✅ — auto-send `📸 <url>` immediately on upload
  success. No pre-fill, no draft-text interaction.
- **Q-PASTE** ✅ — clipboard paste is in v1 (4th trigger surface).
- **Q-CAMERA-UI** ✅ NEW — mobile camera capture as a separate
  button next to the gallery picker (Shape A from A5), uses
  `<input capture="environment">`. Folded into A5 + I-2.
- **Q-CLAUDE-MD** ✅ — codify "IRC stays text only" rule per A10;
  lands in I-3 docs sweep.
- **Q-ICON** ✅ — camera icon for the picker button.

## Memories that ARE relevant

- [[project-image-upload]] — cluster seed (vjt-confirmed 2026-05-03)
- [[project-post-p4-1-arc]] — current arc state; cluster goes here
- [[feedback-readme-currency]] — README updates land in-step
- [[feedback-cicchetto-browser-smoke]] + [[feedback-ux-e2e-mandatory]]
  — Playwright e2e mandatory for cic-touching buckets
- [[feedback-no-localized-strings-server-side]] — server stays out of
  cic copy; privacy modal + error messages cic-owned (A6, I-2)
- [[feedback-hot-deploy-preflight]] — nginx + CSP = COLD; I-CSP
  standalone bucket per HIGH-29 (A8)
- [[feedback-deploy-preflight-empty-diff-after-merge]] — V9 lesson;
  manual cold-check post-local-merge for I-CSP + at I-Z
- [[feedback-per-bucket-deploy]] — browser smoke at each bucket close
- [[feedback-landed-claim-evidence]] — `check.sh` exit-0 tail in
  commit body
- [[feedback-push-autonomy]] — push autonomy granted at cluster CLOSE
- [[project-visitor-parity-cluster-closed]] — predecessor; subject
  parity invariant covers visitor + user uploads identically

## Authoritative refs

- `CLAUDE.md` — engineering standards; "Ask before building"; "10x
  simpler approach"; "Reuse the verbs, not the nouns"
- `cicchetto/src/lib/linkify.ts` — already linkifies any URL, no
  changes needed
- `cicchetto/src/ScrollbackPane.tsx:217` — current url-segment
  render path; also unchanged
- `cicchetto/src/ComposeBox.tsx` — extension point for I-2 (picker
  button + drag-drop + progress + privacy modal)
- `infra/snippets/security-headers.conf` line 61 — CSP allowlist;
  I-CSP edits the single `add_header` line (`connect-src` only)
- `infra/nginx.conf` — body-size context; unchanged (direct upload)
- `lib/grappa_web/body_limit.ex` — HIGH-19 unchanged; PRIVMSG body
  `📸 <url>` fits in 4096 bytes ten times over
- `scripts/deploy.sh` + `scripts/deploy-cic.sh` — deploy paths;
  I-CSP uses former with `--force-cold`, all other buckets use
  latter
- `docs/plans/2026-05-14-visitor-parity-and-nickserv.md` —
  predecessor brainstorm shape
- `docs/DESIGN_NOTES.md` — chronological decision log

## v2 → v3 diff (post-vjt-bless 2026-05-15)

vjt blessed v2 with refinements that strengthen the pluggable
interface and expand trigger surfaces. Changes:

- **A2 strengthened**: `ImageHost` interface now encodes per-host
  endpoint URL, headers, request-builder, response-parser,
  `ttlOptions` array (empty → dropdown hidden), `defaultTtl`,
  `acceptedMimeTypes`, `displayName`, `retentionStatement`,
  `maxFileSizeBytes`. Real provider diversity (litterbox vs imgur
  JSON vs 0x0.st header-based TTL vs imgur bearer auth) all fits.
  vjt: "litterbox has a fucking api and other providers have
  different apis so ensure the fucking pluggable interface
  provides enough flexibility to swap image providers."
- **A5 expanded**: 4 trigger surfaces (was 2). Added clipboard
  paste + mobile camera capture (`<input capture="environment">`
  as a separate button next to the gallery picker, visible only
  via `@media (pointer: coarse)`). vjt: "we should allow to
  upload from camera on mobile as well ... clipboard paste sure
  why not."
- **A7 pinned**: auto-send `📸 <url>` immediately on upload
  success (was Q-AUTOSEND, vjt: "after upload autosend yes").
- **A10 added**: codify "IRC stays text only" in CLAUDE.md per
  vjt: "yes porco dio codify that in claude.md, as that is
  already in readme.md."
- **A6 refined**: privacy ack is per-host (different localStorage
  key per `host.id`); switching to a host with different privacy
  semantics re-prompts. Copy fully parameterized via
  `host.displayName` + `host.retentionStatement`.
- **TTL persistence keyed per host**: `image-upload-ttl:litterbox`
  not just `image-upload-ttl` — swapping hosts later doesn't
  silently inherit the wrong default.
- **I-1 test surface expanded**: interface contract tested via
  in-memory mock impl; litterbox impl tested separately. The mock
  doubles as a "how to write a second provider" example.
- **I-2 test surface expanded**: paste handler, camera button,
  TTL-dropdown-hidden-when-empty, per-host privacy ack, auto-send.
- **Camera icon** for the picker button (was Q-ICON, vjt:
  "camera icon porco dio").

Bucket count unchanged (5). Code surface modestly larger (4
trigger surfaces, richer interface). Cluster spirit unchanged:
"image upload feels native, IRC stays text-only."

## v1 → v2 diff (post-vjt-refinement 2026-05-15)

vjt scoped the cluster significantly tighter than v1 proposed.
Removals:

- **Cut I-1 (linkify image-URL detection)** — IRC stays text-only;
  no `image-url` segment arm; `linkify.ts` unchanged.
- **Cut I-2 (inline thumbnail render)** — no `<img>` tags in
  scrollback; `ScrollbackPane.tsx` unchanged.
- **Cut I-3 (lightbox overlay component)** — browser's "open link
  in new tab" IS the image viewer.
- **Cut img-src CSP entry** — we don't render images, so the host
  doesn't need `img-src` allowlist.
- **Default TTL 72h → 24h** per vjt.
- **Module name `litterbox.ts` → `image-upload.ts`** per vjt
  ("BUILD INTERFACE to plug different image hosters tomorrow") —
  pluggable `ImageHost` interface, litterbox = first impl.

Additions:

- **`📸 <url>` PRIVMSG body shape** per vjt explicit spec.
- **A2 pluggable host interface** (didn't exist in v1).

Bucket count: 7 → 5. Code surface roughly halved. Cluster spirit:
same — "image upload feels native, IRC stays text-only."
