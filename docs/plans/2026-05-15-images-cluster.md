# Images cluster

**Status**: brainstorm v2 (post-vjt-refinement 2026-05-15) —
implementation NOT started. Awaiting bless to start I-CSP.

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
to plug different image hosters tomorrow." The cic module is named
`image-upload.ts` (NOT `litterbox.ts`). It exposes a generic
contract; the litterbox-specific multipart shape lives behind it.

```ts
// cicchetto/src/lib/image-upload.ts
export type UploadProgress = { loaded: number; total: number };
export type UploadError =
  | { kind: "network" }
  | { kind: "http"; status: number }
  | { kind: "abort" }
  | { kind: "invalid_response"; body: string };

export interface ImageHost {
  readonly name: string;             // "litterbox", future "0x0.st", etc.
  readonly defaultTtlLabel: string;  // "24 hours"
  upload(
    file: File,
    onProgress: (p: UploadProgress) => void,
    signal: AbortSignal,
  ): Promise<string>;                // resolves with the public URL
}

export const litterboxHost: ImageHost = { /* impl */ };

// active host — module-level for now; future: settings-drawer toggle
export const activeHost = (): ImageHost => litterboxHost;
```

Switching to a new host tomorrow: write a second `ImageHost` impl,
swap `activeHost()`. Privacy-modal copy (which references the host
name) reads from `activeHost().name`. Default TTL label too.

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
default; vjt overrode to 24h.) Operator can override per upload via
a small dropdown next to the file picker (litterbox supports `1h`,
`12h`, `24h`, `72h`). Last-chosen TTL persists in `localStorage`.

### A5. Upload trigger surfaces — picker + drag-drop, NO paste in v1

Per vjt: "YES drag and drop on desktop YES browse library from
phone." Two trigger surfaces in v1:

1. **File picker button** in ComposeBox: `<input type="file"
   accept="image/*" hidden>` + a small button that fires
   `.click()`. Mobile-friendly (iOS Safari opens camera roll).
2. **Drag-drop** on the ComposeBox container: `ondragover` /
   `ondragleave` / `ondrop` handlers. Visual cue: dashed border on
   drag-over.

Clipboard paste deferred — easy to add later if vjt wants it
(see Q-PASTE).

Both triggers feed into the same `ImageHost.upload()` call.

### A6. First-upload privacy modal — operator-side, no server involvement

Per `feedback_no_localized_strings_server_side`: server stays out of
cic copy. First upload per browser per `localStorage` key
`image-upload-privacy-acknowledged`:

> Files you upload here go to litterbox.catbox.moe — a public
> temporary host. Anyone with the URL can view them for the next
> 24 hours. Don't upload anything you wouldn't want a stranger to
> see. [Cancel] [Continue] [☐ Don't show this again]

Host name + TTL label come from `activeHost()` so the modal stays
correct if vjt swaps the host later. No "Continue" without explicit
click. "Don't show again" sets the localStorage key.

### A7. Inline progress UI in compose (not toast)

While upload is in flight: a small row beneath the textarea shows
filename + progress bar + cancel button. Multi-MB iPhone screenshots
on cellular take 10-30s — non-optional UX. On completion: progress
row dismissed, body inserted (or auto-sent — see Q-AUTOSEND).
On error: progress row turns red with retry + dismiss buttons.
Compose stays editable throughout.

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

### A9. `accept="image/*"` + MIME gate on drag-drop

Per `project_image_upload` cluster scope = images. File picker uses
`accept="image/*"`; drag-drop also gates on
`file.type.startsWith("image/")` and rejects (with inline error)
non-image drops. Litterbox itself accepts arbitrary file types but
generic file uploads is a separate ask with different ergonomics
(no obvious shape for the PRIVMSG body — the photocamera emoji
wouldn't fit). Defer.

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

- `litterboxHost.upload(file, onProgress, signal)` POSTs multipart
  with correct fields (`reqtype=fileupload`, `time=<ttl>`,
  `fileToUpload=<binary>`) — assert via `XMLHttpRequest` mock.
- Resolves with response body trimmed (the URL).
- `onProgress` invoked at least once during upload (mock progress
  event) with non-null `loaded` + `total`.
- `signal.abort()` mid-upload → rejects with `{kind: "abort"}`.
- Network error → rejects with `{kind: "network"}`.
- HTTP 4xx → rejects with `{kind: "http", status: <n>}`.
- HTTP 5xx → rejects with `{kind: "http", status: <n>}`.
- Empty / non-URL response body → rejects with `{kind:
  "invalid_response", body}`.
- TTL parameter wired correctly: each of `1h`, `12h`, `24h`, `72h`
  produces the right multipart `time=` field.
- `activeHost()` returns `litterboxHost` (default).
- `activeHost().name` is `"litterbox"`, `defaultTtlLabel` is
  `"24 hours"`.

**Production change:**

1. New `cicchetto/src/lib/image-upload.ts` — `ImageHost` interface,
   `UploadProgress` + `UploadError` types, `litterboxHost` impl,
   `activeHost()` selector. Uses `XMLHttpRequest` (not `fetch` —
   XHR has progress events, fetch doesn't natively across all our
   browser targets).
2. NO consumer changes in this bucket — interface only.

**Exit criteria:** vitest green; `scripts/bun.sh run check` green
(typecheck + lint); module is consumer-free until I-2 wires it up.

**Deploy:** cic-bundle (`scripts/deploy-cic.sh`).

### Bucket I-2 — ComposeBox upload UI + privacy modal + 📸-prefix

**Failing test first:** `cicchetto/src/__tests__/ComposeBox.test.tsx`:

- Click image-picker button → file picker opens (mock
  `<input>.click()`).
- Select image file via mocked input change → `image-upload`
  `activeHost().upload()` called with file + chosen TTL.
- Drag image file onto compose container → same upload path.
- Drag NON-image file (e.g. `.txt`) → rejected with inline error;
  no upload triggered.
- During upload: progress row visible with filename + cancel
  button; compose stays editable.
- On upload success: PRIVMSG body becomes `📸 <url>` and is sent
  (or pre-filled — see Q-AUTOSEND; pin behavior to chosen default).
- On upload error: progress row turns red with retry + dismiss;
  compose still editable.
- First-upload (localStorage flag absent): privacy modal shown;
  modal blocks upload until "Continue" clicked.
- "Don't show again" + Continue → localStorage flag set; subsequent
  uploads bypass modal.
- Subsequent uploads (flag present): modal NOT shown.
- TTL dropdown defaults to 24h; selecting another TTL persists in
  localStorage and affects next upload.
- Cancel mid-upload aborts XHR + dismisses progress row.
- Privacy-modal copy includes `activeHost().name` and
  `activeHost().defaultTtlLabel` (parameterized — host swap
  won't require copy edits).
- Playwright e2e (per `feedback_ux_e2e_mandatory`): scripted
  operator drags fixture image onto compose → privacy modal →
  Continue → upload → PRIVMSG sent with `📸 <url>` → assert
  message visible in scrollback with clickable link via existing
  linkify rendering.

**Production change:**

1. `cicchetto/src/ComposeBox.tsx` extensions:
   - Image-picker button + hidden `<input type="file" accept="image/*">`.
   - Drag-drop handlers on form container.
   - Inline progress row beneath textarea (new `<Show>`).
   - TTL dropdown next to picker button.
   - On upload success: build body `📸 ${url}` and submit via
     existing `compose.ts` `submit()` flow — single code path with
     normal text messages.
2. New tiny privacy-modal component (single-purpose, dismissable,
   no external lib). Reads/writes localStorage
   `image-upload-privacy-acknowledged`. Copy parameterized on
   `activeHost()`.
3. CSS for new bits — picker button, drag-over highlight (dashed
   border), progress row, modal.

**Exit criteria:** vitest green; Playwright e2e green; manual smoke
on three browsers (desktop Chrome, desktop Safari, iOS Safari) with
both trigger surfaces (picker + drop); 8MB file uploads cleanly with
visible progress; cancel works mid-upload; first-upload modal
appears + dismisses correctly; PRIVMSG body in scrollback renders
the link as clickable (existing linkify path, regression-checked).

**Deploy:** cic-bundle.

### Bucket I-3 — README + DESIGN_NOTES + project-story sweep

**Failing test first:** N/A (docs).

**Production change:**

1. `README.md` — add a one-paragraph "Image upload" subsection in
   the cic feature list. Mention: pluggable host (litterbox first
   impl), 24h default TTL, 📸-prefix wire shape, IRC-text-only
   render contract.
2. `docs/DESIGN_NOTES.md` — chronological entry: cluster name,
   date, A1-A9 summary, retro reference.
3. `docs/project-story.md` — episode (per CLAUDE.md "Project story
   lives on" rule).
4. `CLAUDE.md` — audit: any RECURRING rule surfaced? Probable
   answer: maybe ONE — "client-side only image rendering; never
   inline thumbnails in scrollback unless explicitly opted in via
   future cluster" — could pin this to prevent future-Claude from
   re-litigating. Decide at write time.

**Exit criteria:** README diff reads cleanly; DESIGN_NOTES entry
chronological + complete; project-story episode named + dated.

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
13. DESIGN_NOTES entry — chronological log, A1-A9 summary +
    lessons learned.
14. README updated (lands in I-3, verify final).
15. Story episode at `docs/project-story.md` (lands in I-3, verify
    final).
16. CLAUDE.md update — only if new recurring rule surfaced (likely
    the no-inline-thumbnails contract).
17. Save memory: `project_image_cluster_closed`.
18. Worktree cleanup: `git worktree remove .worktrees/images`.

## Open questions for vjt

### Q-AUTOSEND — auto-send `📸 <url>` or pre-fill compose?

After upload completes, two options:
- **Auto-send (recommended default):** message goes out immediately.
  Matches vjt's "that's it" tone — minimal ceremony. Operator can
  add commentary in a follow-up message if they want.
- **Pre-fill compose:** body inserted at cursor (`📸 ${url} `
  trailing space), operator hits Enter to send. Lets operator add
  caption inline before sending.

If vjt picks pre-fill, also need: what to do if textarea already
has draft text? Append? Replace? Insert at cursor (probably
"insert at cursor" is least surprising).

### Q-PASTE — clipboard-paste handler now or later?

vjt explicitly mentioned picker + drag-drop, did NOT mention paste.
Easy to add: textarea `onpaste` handler intercepts
`e.clipboardData.items[0].kind === "file"` with `image/*` MIME →
upload via same path. macOS screenshot ergonomics
(Cmd-Shift-Ctrl-4 → paste) are real but optional. Default: defer
to v2; pin as "easy add."

### Q-CLAUDE-MD — codify the no-inline-thumbnails contract?

Should I-3 add a CLAUDE.md "Render contract" rule like:

> **IRC remains text only.** No inline rendering of media types in
> scrollback (images, videos, audio). Media URLs in PRIVMSG bodies
> are clickable links via the existing `linkify` path; clicking
> opens the resource in a browser tab. Do not propose
> in-scrollback thumbnails / autoplay / preview cards without an
> explicit cluster spec lifting this rule.

Pro: pins the rule so future-Claude doesn't re-derive. Con:
CLAUDE.md is for recurring rules — this might be a one-off.
vjt's call.

### Q-ICON — picker-button icon?

A small camera / paperclip / plus icon? Use existing emoji `📷`
for parity with the wire-shape `📸`? Plain text "Image"? Defer to
implementation taste; not load-bearing.

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
- **Cut clipboard-paste handler from v1 default** — vjt mentioned
  picker + drag-drop only; pin paste as Q-PASTE deferred.
- **Default TTL 72h → 24h** per vjt.
- **Module name `litterbox.ts` → `image-upload.ts`** per vjt
  ("BUILD INTERFACE to plug different image hosters tomorrow") —
  pluggable `ImageHost` interface, litterbox = first impl.

Additions:

- **`📸 <url>` PRIVMSG body shape** per vjt explicit spec.
- **A2 pluggable host interface** (didn't exist in v1).

Bucket count: 7 → 5. Code surface roughly halved. Cluster spirit:
same — "image upload feels native, IRC stays text-only."
