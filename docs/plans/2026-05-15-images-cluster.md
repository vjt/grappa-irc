# Images cluster

**Status**: brainstorm — implementation NOT started. Awaiting vjt
bless / refine / veto on the Q-block (especially **Q-DIRECT vs
PROXIED**).

| Bucket | Status | Deploy | Notes |
|--------|--------|--------|-------|
| I-CSP — nginx CSP allowlist for litterbox + files.catbox.moe | brainstorm | **COLD** (nginx reload) | Lands first; pre-req for I-2/I-3/I-4 |
| I-1 — linkify image-URL detection | brainstorm | cic-bundle | Extends `cicchetto/src/lib/linkify.ts` |
| I-2 — inline thumbnail render in scrollback | brainstorm | cic-bundle | Builds on I-1 segment |
| I-3 — lightbox overlay component | brainstorm | cic-bundle | Click-through from I-2 |
| I-4 — upload UI + litterbox client in ComposeBox | brainstorm | cic-bundle | File picker + drag-drop + paste |
| I-5 — docs sweep (README + DESIGN_NOTES + project-story) | brainstorm | none | In-step per `feedback_readme_currency` |
| I-Z — cluster CLOSE (rebase + healthcheck + retrospective) | brainstorm | n/a | Mirror visitor-parity CLOSE shape |

**Branch**: `cluster/images` (worktree to be created from local main).
**Position**: post-`visitor-parity-and-nickserv` (CP32 cluster). Spec
seed: `project_image_upload` memory, vjt-confirmed 2026-05-03.
**Origin evidence**: vjt verbal spec — operator picks file in cic,
file goes to litterbox.catbox.moe, resulting URL pasted into compose,
scrollback picks up image URLs and renders thumbnails with lightbox
overlay. Default TTL 72h. Permanent catbox.moe deferred (file sharing
is out of cluster scope).

## Goal

**Make image sharing in IRC feel native.** Picking a screenshot from
your phone, dragging a PNG onto the desktop compose box, or pasting a
clipboard image should result in a clickable thumbnail in scrollback
within ~2 seconds — for both the sender AND any other cic operator on
the channel — with a one-click lightbox for full-size viewing. Non-cic
IRC clients see a plain URL in the message body and lose nothing.

**What we are NOT building.** No persistent image storage on the
bouncer. No proxying of image bytes through grappa (default; flagged
as alternative — see Q-DIRECT). No image-edit / annotate / crop /
blur tools. No GIF auto-play toggle (browser default). No SVG inline
rendering (security — see Q10). No catbox.moe permanent uploads in v1
(deferred per `project_image_upload`).

**Subject parity.** Visitors and registered users get the SAME upload
+ render surface. The visitor-parity cluster (CP32-V) made all
subject-scoped features uniform; this cluster inherits that — no
`subject.kind === "user"` gate anywhere in the new code paths.

## Architecture decisions

### A1. Direct-to-litterbox upload (proposed default; alt: proxied via grappa)

**Default: direct.** The cic browser POSTs multipart directly to
`https://litterbox.catbox.moe/resources/internals/api.php`. Grappa is
uninvolved — it sees only the resulting URL embedded in a PRIVMSG
`body` like any other text. This is the simplest possible shape:

- Zero new server code.
- Zero changes to `Plug.Parsers` config (today's JSON-only body
  parser stays).
- Zero changes to `lib/grappa_web/body_limit.ex` (HIGH-19 — its
  4096-byte cap applies to PRIVMSG `body` text, which a
  `https://files.catbox.moe/abc.png` URL fits within ten times over).
- Zero changes to `infra/nginx.conf` `client_max_body_size` (default
  1MB stays; the upload doesn't touch nginx).
- Operator's browser handles upload progress + cancel + retry via
  standard `XMLHttpRequest` events.

**Tradeoff:** no abuse control. Anyone with a bearer can spam
litterbox with arbitrary files (rate-limit/abuse is the upstream
service's problem, not grappa's). No ability to refuse uploads of
certain content types or sizes server-side. No audit trail —
`Session.Server` never knows an upload happened until the URL appears
in PRIVMSG (at which point it's indistinguishable from a pasted URL).

**Alternative: proxied.** Browser POSTs multipart to a new grappa
route (e.g. `POST /me/uploads`); grappa multipart-parses, optionally
rate-limits / auth-gates / refuses oversize, then re-POSTs to
litterbox upstream and returns the resulting URL. Adds:

- A new HOT-friendly `Plug.Parsers` config (today's chain only
  handles JSON; multipart with a 16MB cap is a new parser entry).
- `client_max_body_size 16m` on nginx for the new `/me/uploads` route
  ONLY (loosening it globally is a footgun — keep the existing 1MB
  default for everything else).
- A new route-specific `BodyLimit`-style cap (HIGH-19's 4096-byte
  field cap is for IRC PRIVMSG bodies; uploads need their own
  constant `:upload_max_bytes` set somewhere around 16MB).
- An HTTP client to litterbox. Verify `mix.exs` — `Req` is preferred
  if present; otherwise `Finch`/`Mint`. Don't add a new HTTP-client
  dep just for this.
- Potentially a per-subject upload throttle (ETS counter, mirror
  `Grappa.Session.Backoff`).
- A new HOT-vs-COLD classifier triggers (Plug.Parsers config change
  + nginx change BOTH require COLD per `feedback_hot_deploy_preflight`
  HIGH-29).

**Recommendation: ship direct first.** Per CLAUDE.md "Ask before
building" — the abuse-control surface is YAGNI until abuse becomes
real. `project_image_upload` memory's "litterbox covers chat lifetime"
framing aligns: 72h TTL ON THE UPSTREAM SIDE is a natural rate-limit
(an attacker spamming litterbox creates evidence on litterbox's logs,
not ours). Defer proxied to a future hardening pass with a real abuse
trigger.

If vjt picks proxied: I-4 forks into I-4-S (server bucket — Plug.Parsers
+ new controller + HTTP client + nginx + body-cap constant) PLUS I-4-C
(client bucket — XHR target swap from litterbox to `/me/uploads`).
All other buckets unchanged. The COLD classification flips for I-4
from cic-bundle to full server cold deploy.

### A2. Bare URL in PRIVMSG body — no `image:` prefix

The uploaded URL travels as plain text inside a normal PRIVMSG. No
magic prefix, no IRC tag, no out-of-band signaling. Rationale:

- Non-cic IRC clients (irssi, weechat, mIRC, the Phase 6 IRCv3
  listener facade) see a plain link they can click. Identical to
  today's "user pasted an image URL by hand" experience — zero
  special casing.
- cic's image-detection regex (I-1) treats the URL identically
  whether it came from upload or paste. ONE code path. Reuse the
  verbs.
- The `image:` prefix would force every other client to display
  literal `image:https://...` text — visible noise + breaks
  click-to-open.
- Discoverability: if a non-cic operator wants to know "did you mean
  to attach an image?" they see the URL and click it. Same affordance
  as a Slack inline attachment.

If vjt wants per-message metadata (attachment-type, original-filename,
dimensions) later, that's a Phase-6 IRCv3 message-tag layer
(`+grappa.attachment=image`) — additive, not breaking.

### A3. Inline thumbnail in scrollback row + lightbox on click

Per `feedback_card_vs_scrollback_ux`:
- **Scrollback rows ARE scrollback rows** — an inline thumbnail is
  row enrichment, fine. Pin: `max-width: 240px; max-height: 120px;
  object-fit: contain;` so a wall of images doesn't blow scrollback
  layout. Native `loading="lazy"` so off-screen thumbnails don't
  fetch until scrolled into view.
- **Cards = single-entity structured overlays** (whois, whowas,
  lusers). The lightbox is one-click ephemera — card-like overlay,
  fine. Esc-close + click-outside + focus-trap, NO heavy modal lib.
- The line between "cards" and "lightbox" is intent: cards are
  dispatched events from server, lightbox is direct cic UI state
  from a click. Different lifecycle, different code paths, no
  shared infrastructure.

### A4. Image-suffix detection lives in linkify

`cicchetto/src/lib/linkify.ts` already returns `LinkifySegment[]` with
two arms: `text` and `url`. Add a third arm: `image-url`. Detection
rule: any URL whose path component (post-strip of `?…` and `#…`) ends
in a case-insensitive image suffix (allowlist below).

```ts
export type LinkifySegment =
  | { type: "text"; value: string }
  | { type: "url"; value: string; href: string }
  | { type: "image-url"; value: string; href: string };
```

`ScrollbackPane.tsx:217` `<For>` body grows a third arm — `image-url`
renders `<img src={seg.href} loading="lazy" class="scrollback-image"
onClick={openLightbox}/>` (or similar). The plain-`url` path is
unchanged.

**Suffix allowlist (case-insensitive):** `.png .jpg .jpeg .gif .webp
.apng`. Explicitly excluded:

- `.svg` — SVG can carry inline `<script>` tags; even with `img-src`
  CSP, browsers historically have had bypasses. Render as a plain
  link, not a thumbnail. (Pin in linkify test:
  `https://example.com/foo.svg` → `url` segment, NOT `image-url`.)
- `.bmp .tiff .ico .heic` — uncommon in IRC + variable browser
  support. Add later if requested.
- Bare hosts (no path) like `https://files.catbox.moe/` — must end
  in suffix.

Path-extraction rule: strip query string + fragment first, THEN test
suffix.
- `https://files.catbox.moe/abc.png` → image
- `https://files.catbox.moe/abc.png?v=2` → image (suffix found in
  path before `?`)
- `https://files.catbox.moe/abc.png#anchor` → image
- `https://example.com/foo?ext=.png` → NOT image (no `.png` in path)

### A5. Litterbox host = the actual host the URL response uses

vjt-confirmed: upload POSTs to
`https://litterbox.catbox.moe/resources/internals/api.php`. Response
is plain-text URL. The orchestrator note suggests the response URL is
`https://litter.catbox.moe/<random>.<ext>` per docs, but I have NOT
verified empirically. **First task in I-CSP is to actually POST a
test file** (curl from operator workstation, not from the cluster)
and inspect the response URL to pin the exact host before writing the
CSP allowlist. Possible candidates:
- `files.catbox.moe`
- `litter.catbox.moe`
- Both — depending on TTL.

The CSP `img-src` entry MUST match what's actually returned, or all
uploaded thumbnails 404 under CSP and the cluster ships broken. Pin
the host empirically.

### A6. First-upload privacy modal — operator-side, no server involvement

Per `feedback_no_localized_strings_server_side`: the server stays out
of cic copy. Cic owns the privacy warning entirely. First time the
operator triggers an upload (per browser per `localStorage` key
`image-upload-privacy-acknowledged`), show:

> Files you upload here go to litterbox.catbox.moe — a public
> temporary host. Anyone with the URL can view them for the next 72
> hours. Don't upload anything you wouldn't want a stranger to see.
> [Cancel] [Continue] [☐ Don't show this again]

No "Continue" without explicit click. "Don't show again" sets the
localStorage key. No telemetry.

### A7. Default TTL = 72h, operator can override per upload

`project_image_upload` lists litterbox TTLs `{1h, 12h, 24h, 72h}`.
Default = 72h (longest convenience; covers chat lifetime per memory).
Surfacing the picker in the upload UI is a small dropdown next to the
file picker — defaults to the operator's last-chosen value (persist in
`localStorage`). v1 ships with the picker visible; if vjt thinks it's
clutter, fold to "always 72h" + advanced setting in SettingsDrawer.

### A8. Upload UI — file picker + drag-drop + paste, all three

Each is a small separable code path; collectively they cover desktop
screenshot ergonomics + mobile camera roll + drag-from-Finder
workflows. v1 ships all three:

1. **File picker button** in ComposeBox: `<input type="file"
   accept="image/png,image/jpeg,image/gif,image/webp,image/apng"
   hidden>` + a paperclip icon button that triggers `.click()`.
   Mobile-friendly (iOS Safari opens camera roll).
2. **Drag-drop** on the ComposeBox container: standard `ondragover` /
   `ondrop` handlers. Visual feedback: dashed border on drag-over.
3. **Paste from clipboard**: `ComposeBox` textarea `onpaste`
   handler — if `e.clipboardData.items[0].kind === "file"` and type
   starts with `image/`, intercept + upload (don't insert anything
   into the textarea). Screenshot ergonomics on macOS
   Cmd-Shift-Ctrl-4 → paste.

All three feed into ONE `cicchetto/src/lib/litterbox.ts`
`uploadFile(file: File, ttl: TTL): Promise<string>` function. ONE
upload code path; three trigger surfaces.

### A9. Inline progress UI in compose, NOT toast

While upload is in flight: a row beneath the textarea shows filename
+ progress bar + cancel button + filesize. Multi-MB iPhone screenshots
(3-8MB) on flaky cellular take 10-30s — non-optional UX. On
completion: progress row disappears, URL is inserted at the textarea
cursor (operator can edit / add caption / send). On error: progress
row turns red with retry + dismiss buttons. Compose stays editable
throughout — operator can keep typing. NO toast, NO modal-block — the
progress UI is contextual to the compose surface that triggered it.

### A10. CSP changes are COLD — own bucket lands first

Per `feedback_hot_deploy_preflight` HIGH-29: hot path doesn't reload
nginx. CSP allowlist drift = "new captcha provider won't take effect,
cic widgets 404." The image cluster's analog: CSP allowlist for
litterbox + files-host MUST land + reload nginx BEFORE the cic upload
feature ships, or operator's first upload silently fails (CSP blocks
the connect-src POST and the operator sees a generic "upload failed"
with no obvious cause).

I-CSP is its own COLD bucket, deployed standalone (`scripts/deploy.sh
--force-cold`), BEFORE I-1/I-2/I-3/I-4 ship to cic. After I-CSP lands,
all subsequent buckets are cic-bundle-only deploys via
`scripts/deploy-cic.sh` — no further server touches.

## CSP changes — exact diff (I-CSP)

`infra/snippets/security-headers.conf` line 61 — the single
`add_header Content-Security-Policy` line. Two directives gain entries
(assuming empirical verification of the response host pins it to
`files.catbox.moe`; if it's `litter.catbox.moe`, swap accordingly):

- `connect-src` gains `https://litterbox.catbox.moe` — for the
  multipart POST.
- `img-src` gains `https://files.catbox.moe` (and `data:` stays for
  the existing inline-SVG path).

Diff shape (illustrative, exact verification pending I-CSP empirical
step):

```
- connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com;
+ connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com https://litterbox.catbox.moe;
- img-src 'self' data:;
+ img-src 'self' data: https://files.catbox.moe;
```

Update the moduledoc comment block at the top of
`security-headers.conf` to explain WHY the new entries (mirror the
existing hcaptcha rationale shape — name the cluster + the verb that
needs the entry).

If both `files.catbox.moe` AND `litter.catbox.moe` show up in
responses across TTL bands: list both. Don't wildcard `*.catbox.moe`
— a separate `catbox.moe` permanent-uploads service is OUT of scope
per cluster definition and would auto-allowlist itself if we
wildcarded.

## Buckets

### Bucket I-CSP — nginx CSP allowlist update

**Failing test first:** there isn't one in the conventional sense —
CSP is in the nginx config, not in code. The "test" is the empirical
verification step:

1. From operator workstation: `curl -F "reqtype=fileupload" -F
   "time=72h" -F "fileToUpload=@/tmp/test.png"
   https://litterbox.catbox.moe/resources/internals/api.php` — note
   the response URL host.
2. Pin that host in the CSP allowlist diff.
3. Manual smoke after deploy: operator's browser DevTools console
   shows zero CSP violations when (a) cic loads (no regression) and
   (b) cic POSTs a multipart to litterbox via fetch (after I-4 lands;
   for I-CSP standalone, just verify no regressions).

**Production change:**

1. Update `infra/snippets/security-headers.conf` line 61 — add
   `https://litterbox.catbox.moe` to `connect-src`, add
   `https://files.catbox.moe` (or empirically-verified host) to
   `img-src`.
2. Update the module-comment block at the top to document the new
   entries + the cluster name + WHY.

**Exit criteria:** CSP diff applied; nginx reloaded; existing cic
functionality regression-tested (login, scrollback, captcha if
configured); DevTools console shows zero new CSP violations on a
fresh cic load.

**Deploy:** **COLD** — `scripts/deploy.sh --force-cold` (per HIGH-29,
hot path doesn't reload nginx). Standalone cluster of one bucket;
lands BEFORE the cic-feature buckets so the CSP is in place when
operators hit the upload button.

### Bucket I-1 — linkify image-URL detection

**Failing test first:** `cicchetto/src/__tests__/linkify.test.ts`
adds:

- `linkify("see https://files.catbox.moe/abc.png here")` returns
  three segments: text `"see "`, **image-url**
  `https://files.catbox.moe/abc.png`, text `" here"`.
- Suffix allowlist coverage: `.png .jpg .jpeg .gif .webp .apng` all
  match (each as its own assertion).
- `.svg` does NOT match — returns `url`, not `image-url`.
- Query-string handling: `https://files.catbox.moe/abc.png?v=2`
  returns `image-url` with `value` and `href` including the query
  string.
- Fragment handling: `https://files.catbox.moe/abc.png#section` same.
- Negative — bare host: `https://files.catbox.moe/` returns `url`,
  not `image-url`.
- Negative — query-string-as-extension:
  `https://example.com/foo?ext=.png` returns `url`, not `image-url`.
- Sentence-boundary trailing-punct interaction: `look at
  https://files.catbox.moe/abc.png.` — image-url is `…abc.png`,
  trailing `.` is its own text segment (mirror existing trailing-punct
  test pattern).
- Coalesce: pre/post-image-url text segments still merge correctly
  per existing logic.

**Production change:**

1. `cicchetto/src/lib/linkify.ts` — extend `LinkifySegment`
   discriminated union with `image-url`. Add helper
   `isImageUrl(href: string): boolean` that strips `?…#…` and tests
   against the suffix allowlist case-insensitively.
2. In the `linkify()` loop where a `url` segment is currently pushed,
   branch: if `isImageUrl(href)`, push `image-url` instead. Keep
   `value` and `href` semantics identical so non-rendering consumers
   don't care which arm fired.

**Exit criteria:** vitest green;
`feedback_wire_edge_runtime_allowlist_exhaustiveness` honored if any
new switch/match on segment.type exists in the codebase (grep for
`seg.type ===` and audit each call site to see if it now needs to
handle `image-url`). All existing linkify tests still pass.

**Deploy:** cic-bundle (`scripts/deploy-cic.sh`) — no server change.

### Bucket I-2 — inline thumbnail render in scrollback

**Failing test first:** `cicchetto/src/__tests__/ScrollbackPane.test.tsx`
adds:

- A message body containing a single
  `https://files.catbox.moe/abc.png` renders an `<img>` tag with that
  URL as `src` AND `loading="lazy"` AND a `scrollback-image` class.
- A click on the `<img>` invokes the lightbox-open dispatcher (mock
  the dispatcher; assert called with the image URL).
- A message with mixed text + image-URL renders text spans + img
  inline.
- Existing URL rendering unchanged for non-image URLs.
- Playwright e2e (per `feedback_ux_e2e_mandatory`): scripted operator
  sends a PRIVMSG with a litterbox URL pointing at a fixture image
  file served from the playwright test runner; assert thumbnail
  visible in scrollback within 2s.

**Production change:**

1. `cicchetto/src/ScrollbackPane.tsx:215-226` — extend the `<For>`
   body's segment-type switch to handle `image-url`. Render `<img
   src={seg.href} loading="lazy" class="scrollback-image"
   alt={seg.href} onClick={() => openLightbox(seg.href)}/>`.
2. CSS: `.scrollback-image { max-width: 240px; max-height: 120px;
   object-fit: contain; cursor: pointer; }` — pin somewhere
   theme-agnostic (probably `cicchetto/src/themes/base.css` or
   wherever scrollback-link styles live).
3. Lightbox-open dispatcher: a tiny `cicchetto/src/lib/lightbox.ts`
   exposing `openLightbox(href: string)` + a Solid signal
   `lightboxImage()` that I-3 reads.

**Exit criteria:** vitest green; Playwright e2e green; manual smoke:
open a channel with several known image URLs in scrollback, verify
thumbnails render, click → lightbox opens (after I-3 ships). Pre-I-3,
the click is a no-op + console log placeholder.

**Deploy:** cic-bundle.

### Bucket I-3 — lightbox overlay component

**Failing test first:** `cicchetto/src/__tests__/ImageOverlay.test.tsx`:

- Render with `lightboxImage = "https://files.catbox.moe/abc.png"`,
  assert overlay visible + img rendered with that src.
- Render with `lightboxImage = null`, assert overlay NOT visible.
- Click outside the img (on the backdrop) → `lightboxImage` set to
  null, overlay closes.
- Esc keypress → overlay closes.
- Focus trap: when overlay open, Tab cycles focus inside overlay only
  (assert via querying `document.activeElement` after Tab events).
- Touch swipe close (defer to v2 if vitest can't simulate cleanly;
  pin in spec rather than ship half-tested).
- Playwright e2e: full click-thumbnail-then-Esc round-trip.

**Production change:**

1. New component `cicchetto/src/ImageOverlay.tsx` (or wherever
   components live — sibling to `WhoisCard.tsx`/`LusersCard.tsx`).
2. Wire into `Shell.tsx` so the overlay renders at the root level
   (above all other UI).
3. Esc handler via global `document.addEventListener("keydown", …)`
   scoped to overlay-mounted-only via `onCleanup`.
4. Click-outside via overlay backdrop `onClick`; img element has
   `onClick={(e) => e.stopPropagation()}` so clicking the img doesn't
   close.
5. Focus trap via `tabindex` + first/last sentinel pattern (or trap on
   overlay container + redirect Tab manually). NO heavy a11y lib.
6. CSS: full-viewport fixed overlay with semi-transparent backdrop;
   img centered with `max-width: 95vw; max-height: 95vh; object-fit:
   contain;`.

**Exit criteria:** vitest green; Playwright e2e green (click thumbnail
in scrollback → overlay opens → Esc → overlay closes); manual smoke
on iPhone Safari (touch-outside close works; rotation handled).

**Deploy:** cic-bundle.

### Bucket I-4 — upload UI in ComposeBox + litterbox client

**Failing test first:** `cicchetto/src/__tests__/ComposeBox.test.tsx`
extends with:

- Click paperclip button → file picker opens (mock `<input>.click()`).
- Select file via mocked input change event →
  `litterbox.uploadFile()` called with file + chosen TTL.
- Drag-drop image file onto compose container → same upload path.
- Paste image from clipboard (mocked `ClipboardEvent` with
  `items[0].kind === "file"`) → same upload path.
- During upload: progress row visible with filename + cancel button.
- On upload success: URL inserted at textarea cursor; progress row
  dismissed.
- On upload error: progress row turns red + shows retry; compose
  still editable.
- First-upload: privacy modal shown; localStorage flag absent → modal
  blocks upload until "Continue" clicked.
- Subsequent uploads: privacy modal NOT shown (localStorage flag
  present).
- vitest for `cicchetto/src/lib/litterbox.ts`: mock
  `XMLHttpRequest`, assert correct multipart shape, correct URL,
  correct response parsing (plain-text URL), error handling (non-2xx,
  network-error, abort).
- Playwright e2e: full picker → upload → URL-in-compose → send →
  thumbnail-in-scrollback round-trip with a real fixture file POSTed
  to a Playwright-controlled mock litterbox endpoint (NOT real
  litterbox in CI — flake risk).

**Production change:**

1. New `cicchetto/src/lib/litterbox.ts`:
   - `export async function uploadFile(file: File, ttl: "1h" | "12h"
     | "24h" | "72h", onProgress: (loaded: number, total: number) =>
     void, signal: AbortSignal): Promise<string>`.
   - Uses `XMLHttpRequest` (not `fetch`) — XHR has progress events,
     fetch doesn't natively (yet, in browsers we target).
   - POSTs `multipart/form-data` to
     `https://litterbox.catbox.moe/resources/internals/api.php` with
     `reqtype=fileupload`, `time=<ttl>`, `fileToUpload=<binary>`.
   - Resolves with the response body trimmed (the URL).
   - Rejects with typed error: `{kind: "network"} | {kind: "http",
     status: number} | {kind: "abort"} | {kind: "invalid_response",
     body: string}`.
2. New `cicchetto/src/lib/imageUpload.ts` (orchestration above the
   bare HTTP client):
   - Tracks active upload per channel (Solid signal map).
   - Privacy-modal gate (reads/writes localStorage
     `image-upload-privacy-acknowledged`).
   - On success: calls into `compose.ts` to insert text at cursor.
3. `cicchetto/src/ComposeBox.tsx` extensions:
   - Paperclip button + hidden `<input type="file">`.
   - `ondragover` / `ondragleave` / `ondrop` handlers on the form
     container.
   - `onpaste` on the textarea.
   - Inline progress row beneath textarea (new `<Show>` block reading
     from `imageUpload.ts` signal).
   - TTL dropdown (defaults to 72h, persisted in localStorage).
4. New component or inline JSX for the privacy modal —
   single-purpose, dismissable, no external lib.
5. CSS for the new bits — paperclip button, drag-over highlight,
   progress row, modal.

**Exit criteria:** vitest green; Playwright e2e green; manual smoke
on three browsers (desktop Chrome, desktop Safari, iOS Safari) with
all three trigger surfaces (picker, drag, paste); 8MB file uploads
cleanly with visible progress; cancel works mid-upload; first-upload
modal appears and dismisses correctly.

**Deploy:** cic-bundle.

### Bucket I-5 — README + DESIGN_NOTES + project-story sweep

**Failing test first:** N/A (docs).

**Production change:**

1. `README.md` — add a one-paragraph "Image sharing" subsection under
   the cic feature list. Mention litterbox dependency + 72h default
   TTL + direct-upload architecture (no server proxy).
2. `docs/DESIGN_NOTES.md` — chronological entry: cluster name, date,
   key decisions A1-A10, cluster CLOSE retro reference.
3. `docs/project-story.md` — episode (per CLAUDE.md "Project story
   lives on" rule). Tone matches existing episodes.
4. `CLAUDE.md` — audit: does this cluster surface any RECURRING rule?
   Probable answer: no (the rules it leverages — CSP-is-COLD, parity,
   three-trigger-surfaces, etc. — already exist). If a new rule
   emerges (e.g. "third-party-asset CSP entries get their own COLD
   bucket") then add it; otherwise leave CLAUDE.md alone.

**Exit criteria:** README diff reads cleanly; DESIGN_NOTES entry is
chronological + complete; project-story episode is named + dated.

**Deploy:** none (docs).

### Bucket I-Z — cluster CLOSE

After I-CSP + I-1 + I-2 + I-3 + I-4 + I-5 green:

1. `cd /Users/mbarnaba/code/grappa/.worktrees/images && git fetch
   origin main && git rebase origin/main`
2. Re-run gates: `scripts/check.sh` + `scripts/bun.sh run check` +
   `scripts/bun.sh run test` + `scripts/integration.sh`.
3. Standalone Dialyzer per `feedback_dialyzer_plt_staleness`:
   `scripts/dialyzer.sh`.
4. Brief vjt with cluster summary (commit shas, what shipped per
   bucket, deviations).
5. Merge: `cd /Users/mbarnaba/code/grappa && git checkout main && git
   merge --ff-only cluster/images`.
6. Per-bucket deploy reminder: I-CSP shipped standalone earlier
   (COLD); I-1/I-2/I-3/I-4 ship as cic bundles via
   `scripts/deploy-cic.sh`. No additional server deploy needed.
7. Healthcheck: `scripts/healthcheck.sh` (no server change post-I-CSP,
   but verify nothing crept in).
8. Browser smoke from anon visitor + identified visitor +
   registered-user session: each tier picks an image, drags an image,
   pastes an image; uploads succeed; thumbnails render in scrollback;
   lightbox opens; Esc closes.
9. CSP regression check: DevTools console shows zero CSP violations
   on a normal cic session.
10. Push origin/main per `feedback_push_autonomy`.
11. Update `project_post_p4_1_arc` — mark cluster CLOSED, point at
    next.
12. Write CP3X at `docs/checkpoints/2026-05-XX-cp3X.md`.
13. DESIGN_NOTES entry — chronological log, A1-A10 summary + lessons
    learned.
14. README updated (lands in I-5, but verify final).
15. Story episode at `docs/project-story.md` (lands in I-5, but
    verify final).
16. CLAUDE.md update — only if new recurring rule surfaced.
17. Save memory: `project_image_cluster_closed`.
18. Worktree cleanup: `git worktree remove .worktrees/images`.

## Open questions for vjt

### Q-DIRECT vs PROXIED upload (highest priority)

**Default proposed: direct-to-litterbox.** Browser POSTs multipart
directly; grappa never sees the bytes. Simplest possible shape; zero
server work; aligns with `project_image_upload` "litterbox covers
chat lifetime" framing.

**Alternative: proxied via grappa.** Requires Plug.Parsers config
(multipart, 16MB), nginx `client_max_body_size 16m` on a new route,
route-specific `BodyLimit`-style cap (HIGH-19 stays 4096 for IRC
bodies; uploads need own constant), HTTP client to litterbox, optional
rate-limit ETS table. Adds abuse-control surface + audit trail +
ability to refuse content; costs a server bucket + COLD deploy.

**Recommendation:** ship direct first. Per CLAUDE.md "Ask before
building" + "10x simpler approach": abuse-control is YAGNI until
abuse is real. If vjt picks proxied, I-4 forks into I-4-S (server) +
I-4-C (client); other buckets unchanged.

### Q1 — Upload provider scope

**Default proposed:** litterbox-only (temporary, 72h max). Permanent
catbox.moe is "file sharing" — out of cluster scope per CLAUDE.md
spirit ("'add X' means add X, not X + Y + Z"). Veto if you want
catbox permanent in v1; otherwise we deliver the smaller surface and
add catbox later if real demand surfaces.

### Q2 — Upload UI shape

**Default proposed:** all three (file picker + drag-drop + paste).
Each is a small separable code path; collectively they cover desktop
screenshot ergonomics (paste), mobile camera roll (picker), and
drag-from-Finder (drop). If any feels overkill, name it; vitest +
Playwright cost is roughly linear so removal saves real test time.

### Q3 — Progress UI

**Default proposed:** inline-in-compose progress bar + cancel/retry
button mandatory; no toast. Multi-MB iPhone screenshots on cellular
make this non-optional. Compose stays editable throughout — operator
can keep typing while upload runs.

### Q4 — URL form in PRIVMSG

**Default proposed:** bare URL — no `image:` prefix, no IRC tag.
Non-cic clients see a plain link they can click; cic detects via
suffix in linkify. ONE code path. (See A2 rationale.)

### Q5 — Overlay UX

**Default proposed:** click-thumbnail-to-expand into lightbox. Esc +
click-outside close. Focus trap. Per `feedback_card_vs_scrollback_ux`:
thumbnails are scrollback-row enrichment (fine); lightbox is
one-click ephemera (card-like, fine — different from server-dispatched
cards). Pin: `max-width: 240px; max-height: 120px` thumbnails so a
wall of images doesn't blow scrollback layout.

### Q6 — Non-cic clients

**Default proposed:** URL travels as text; Phase 6 IRCv3 listener
facade sees it identically; no special handling needed. Pin in spec
for future-Claude.

### Q7 — HIGH-19 / nginx body-size wire-up

**REFRAME:** the orchestrator's framing conflates HIGH-19 (per-field
4096-byte cap on IRC bodies, COMPILE-time, in
`lib/grappa_web/body_limit.ex`) with nginx's `client_max_body_size`
(per-request HTTP body cap). They're different layers.

- **If direct-to-litterbox (default):** neither needs to change. The
  PRIVMSG body containing a `https://files.catbox.moe/abc.png` URL
  fits within 4096 bytes ten times over; the litterbox upload doesn't
  touch grappa or nginx.
- **If proxied:** need a route-specific `client_max_body_size 16m`
  AND a route-specific upload byte cap (HIGH-19's 4096 is wrong for
  uploads — needs a new `:upload_max_bytes` constant, scoped to the
  upload controller, NOT a global loosening).

### Q8 — Litterbox failure UX

**Default proposed:** inline error badge on the in-compose progress
row + retry button + dismiss button. Compose stays editable. Error
categories surfaced:
- Network error: "Upload failed — network error. Retry?"
- HTTP 4xx (bad file type, oversize): "Upload rejected — try a
  different file."
- HTTP 5xx (litterbox down): "Upload service unavailable. Retry?"
- Abort: progress row dismissed silently (operator-initiated).

No toast, no modal-block. Per CLAUDE.md "thin contexts" spirit, the
error envelope is plain English in cic — no localized strings, no
server involvement (server doesn't see the upload).

### Q9 — Privacy / security

**Default proposed:** first-upload modal per A6. Default TTL 72h per
A7 (operator override visible in upload UI, persisted per-browser in
localStorage). No server involvement. No per-network policy
enforcement (visitor and registered-user uploads identical — parity
invariant). If vjt wants admin-side "no uploads on this network"
toggle, that's a Phase-6 concern (operator CLI flag), not v1.

### Q10 — URL-pattern detection edge cases

**Default proposed:** suffix allowlist `.png .jpg .jpeg .gif .webp
.apng` (case-insensitive); strip `?…#…` before suffix test; SVG
explicitly excluded (renders as plain link, not thumbnail) per
script-injection risk; bare hosts (no path) don't match. (See A4
detail.) Veto if the SVG exclusion feels excessive — the alternative
is rendering SVG inline and trusting `img-src` CSP to neutralize
embedded scripts (browser track record on this is mixed; recommend
stay conservative).

### Q-NEW — Image cache + memory pressure

**Default proposed:** native `<img loading="lazy">` is enough at v1.
Long-lived bouncer scrollback with hundreds of thumbnails — browsers
GC off-screen images via standard heuristics. If scrollback feels
sluggish in real use, revisit with intersection-observer-driven
cleanup or virtualization (separate cluster). Pin a "if this gets
sluggish, the lever to pull is X" line in DESIGN_NOTES so
future-Claude doesn't re-derive.

### Q-NEW — Cic offline + upload retry

**Default proposed:** out of cluster scope. If cic loses connectivity
mid-upload, the XHR aborts; operator sees the error and retries when
back online. No queue, no background-sync. (Service Worker
background-sync for uploads is a real feature but adds complexity
disproportionate to the v1 surface — defer to a future hardening
pass.)

### Q-NEW — Animated GIF auto-play

**Default proposed:** browser-default behavior (auto-play). No toggle
in v1. If vjt wants a "click to play" gate (some operators find
auto-play disruptive), that's a separate cic UX bucket — could fold
into SettingsDrawer as an "image rendering" subsection later.

### Q-NEW — Upload from non-image files

**Default proposed:** v1 rejects non-image MIME types at the
file-picker level (`accept="image/*"`). Drag-drop and paste also gate
on `file.type.startsWith("image/")`. Litterbox itself supports any
file type, but the cluster scope is "image sharing" per
`project_image_upload` — generic file uploads is a separate ask (and
would need different scrollback-row UX — a "file" affordance, not a
thumbnail).

### Q-NEW — CSP host: `files.catbox.moe` vs `litter.catbox.moe`

**Pending empirical verification.** Orchestrator note suggests
`litter.catbox.moe` per docs but I have NOT POSTed a test file to
verify. First task in I-CSP is `curl -F …` from operator workstation
to inspect the response URL host. Pin the exact host before writing
the CSP allowlist diff. If both hosts show up across TTL bands, list
both. Don't wildcard `*.catbox.moe` — would auto-allowlist the
out-of-scope catbox-permanent surface.

## Memories that ARE relevant

- [[project-image-upload]] — cluster seed (vjt-confirmed 2026-05-03)
- [[project-post-p4-1-arc]] — current arc state; cluster goes here
- [[feedback-readme-currency]] — README updates land in-step
- [[feedback-cicchetto-browser-smoke]] + [[feedback-ux-e2e-mandatory]]
  — Playwright e2e mandatory for every cic-touching bucket
- [[feedback-card-vs-scrollback-ux]] — thumbnail-in-row vs
  lightbox-overlay distinction (A3)
- [[feedback-no-localized-strings-server-side]] — server stays out of
  cic copy; privacy modal + error messages are cic-owned (A6, Q8)
- [[feedback-hot-deploy-preflight]] — nginx + CSP changes are COLD;
  I-CSP standalone bucket per HIGH-29 (A10)
- [[feedback-deploy-preflight-empty-diff-after-merge]] — V9 lesson;
  manual cold-check post-local-merge for I-CSP
- [[feedback-per-bucket-deploy]] — browser smoke at each bucket close
- [[feedback-landed-claim-evidence]] — `check.sh` exit-0 tail in
  commit body
- [[feedback-wire-edge-runtime-allowlist-exhaustiveness]] — auditing
  existing `seg.type ===` switches when adding `image-url` arm (I-1)
- [[feedback-push-autonomy]] — push autonomy granted at cluster CLOSE
- [[project-visitor-parity-cluster-closed]] — predecessor cluster;
  subject parity invariant covers visitor + user uploads identically

## Authoritative refs

- `CLAUDE.md` — engineering standards; "Ask before building"; "10x
  simpler approach"; "Reuse the verbs, not the nouns"
- `cicchetto/src/lib/linkify.ts` — extension point for I-1 (add
  `image-url` segment arm)
- `cicchetto/src/ScrollbackPane.tsx:215-226` — current linkify call
  site; I-2 extends segment-type switch
- `cicchetto/src/ComposeBox.tsx` — current compose surface; I-4 adds
  picker/drop/paste handlers + progress row
- `infra/snippets/security-headers.conf` — CSP allowlist; I-CSP edits
  the single `add_header` line at line 61
- `infra/nginx.conf` — body-size context; unchanged in default
  direct-upload path
- `lib/grappa_web/body_limit.ex` — HIGH-19 reality: per-field
  4096-byte cap on IRC PRIVMSG body fields, COMPILE-time. Unchanged
  for direct-upload; would need route-specific override for proxied
  alternative
- `scripts/deploy.sh` + `scripts/deploy-cic.sh` — deploy paths; I-CSP
  uses former with `--force-cold`, all other buckets use latter
- `docs/plans/2026-05-14-visitor-parity-and-nickserv.md` —
  predecessor brainstorm shape (mirror this structure)
- `docs/DESIGN_NOTES.md` — chronological decision log; cluster lands
  an entry at CLOSE
