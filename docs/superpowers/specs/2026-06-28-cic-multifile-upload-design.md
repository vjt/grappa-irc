# Multi-file paste / drag-drop upload (sequential queue) — Design

**Date:** 2026-06-28
**Status:** approved by vjt (brainstorm 2026-06-28), pending spec review
**Issue:** GH #118 ("cicchetto: paste & drag-and-drop image upload in compose")
**Cluster:** extends images I-2 (2026-05-15) + uploads-2 (2026-06-09)

## Context — what already exists (this is NOT a from-scratch feature)

Paste + drag-and-drop upload **already shipped** in `ComposeBox.tsx` on `main`
via commit `8f1a76b` (2026-05-15, the image-upload I-2 surface) — six weeks
*before* #118 was filed. Today, on `main`:

- `onPaste` (textarea), `onDrop`/`onDragOver` (form) and the paperclip picker
  all funnel into `triggerUpload(key, net, chan, file)` →
  `uploadOrchestrator.dispatchUpload`.
- The orchestrator is **category-aware** (image/video/document/audio with
  per-category caps), shows an in-flight `<progress>` affordance with a cancel
  button, surfaces failures inline (`role="alert"` + retry/dismiss), ignores
  non-uploadable payloads (`categoryOf(mime) === null`), and on success
  **auto-sends** an emoji-prefixed URL PRIVMSG (`📸/🎬/📄/🎵 <url>` —
  `uploadOrchestrator.ts:347`). Auto-send is the documented model (CLAUDE.md
  "image-upload pattern ships a 📸-prefixed URL… that is the model").

So most of #118's literal text is already satisfied. #118's "splice the URL
into the draft at the cursor" **contradicts** the shipped auto-send invariant;
vjt confirmed **auto-send stays** (do NOT splice into the draft).

The one **genuine gap** vs #118 + vjt's confirmed defaults: every entry point
uploads the **first file only**.

- `onDrop` reads `e.dataTransfer.files[0]`.
- `onPaste` `return`s after the first file item.
- `onPickerChange` reads `input.files[0]`; the `<input>` has no `multiple`.

The orchestrator is **single-slot per channel**: `inflight: Map<ChannelKey,
ActiveUpload>` holds one active upload, and a re-trigger **aborts** the prior
one (`dispatchUpload` line 278). So multi-file is not "loop the handler" — N
concurrent triggers would abort each other.

## Goal

Upload **all** pasted/dropped/picked files, keeping the auto-send model, via a
**sequential per-channel queue**: process one file at a time through the
existing single-slot pipeline; each completion auto-sends its own emoji-URL
PRIVMSG; the next file then starts. N files → N messages (consistent with
today's one-file-one-message model).

vjt rejected the parallel multi-slot alternative (heavier: per-channel list +
multi-row progress UI + per-row cancel/retry addressing) — "lightweight over
heavyweight".

## Non-goals / out of scope

- **No parallel uploads.** Strictly sequential.
- **No draft splicing.** Auto-send stays; the compose draft is never touched by
  uploads (the I-2 invariant — keeps us clear of the in-flight
  `fix/compose-draft-recall-stash` branch, which only edits `compose.ts`).
- **No new server endpoint.** Same upload POST.
- **No change to category gating, caps, video transcode, privacy modal copy,
  TTL handling.**

## Repo note (brief correction)

`cicchetto/` is a **subdirectory of the grappa-irc repo**, not a separate repo.
The "cicchetto-wt-draft-recall" worktree is a normal grappa-irc worktree on
branch `fix/compose-draft-recall-stash`. #118 is built on a fresh grappa-irc
worktree off local `main`; it edits `cicchetto/src/lib/uploadOrchestrator.ts`
and `cicchetto/src/ComposeBox.tsx` (+ tests) — zero overlap with the
draft-recall branch's `compose.ts`/`compose.test.ts`.

## Design — `uploadOrchestrator.ts`

### New state

```ts
// Pending files waiting behind the active one, per channel. Plain Map —
// not reactive; the queue itself drives no UI.
const queue = new Map<ChannelKey, QueuedUpload[]>();
type QueuedUpload = { file: File; networkSlug: string; channelName: string };

// Reactive (index, total) for the "(i/N)" batch counter. Only this slice
// is reactive — ComposeBox reads uploadBatch(key) for the label.
const [batchByChannel, setBatchByChannel] =
  createSignal<Record<ChannelKey, { index: number; total: number }>>({});
export function uploadBatch(key: ChannelKey): { index: number; total: number } | null;
```

`index` = the 1-based position of the file currently active; `total` = files in
the current batch. Computed at dispatch time as `index = total - queue.length`
(after the dequeue). Cleared (`setBatchByChannel` drops the key) when the queue
drains, on cancel, and on modal-decline.

### Entry points

```ts
// New plural entry. Normalizes (iOS .m4r → audio/mp4) + enqueues all, updates
// batch total, then pumps if nothing is active for this channel.
export function triggerUploads(key, net, chan, rawFiles: File[]): void;

// Back-compat single alias — retains the existing public signature so the 45
// existing orchestrator tests + retryUpload keep working unchanged.
export function triggerUpload(key, net, chan, rawFile): void {
  triggerUploads(key, net, chan, [rawFile]);
}
```

`isActive(key)` = `inflight.has(key)` OR (privacy modal open for `key`) OR
(`uploadState(key)?.error` set). If active, `triggerUploads` only enqueues +
bumps total; the in-flight settle / dismiss / ack drains it. Otherwise it
pumps.

### The pump

```ts
function pumpQueue(key): void {
  const q = queue.get(key);
  if (!q || q.length === 0) { queue.delete(key); setBatchByChannel(drop key); return; }
  const next = q.shift()!;
  queue.set(key, q);
  setBatchByChannel(key → { index: total - q.length, total });
  startUpload(key, next);   // privacy gate + dispatchUpload, per file
}
```

`startUpload` is the existing single-file gate path (privacy modal check →
stage in `pendingPrivacyGated` + open modal, OR `dispatchUpload`). **Per-file
privacy gating is preserved**: a user who chose NOT to "remember" is asked per
file — that honors their explicit "ask every time" choice; the common case
(ack persisted in localStorage, or remembered) never re-prompts.

### Settle wiring

- `dispatchUpload` success (`.then`): `setEntry(key, null)` + auto-send (both
  unchanged) **+ `pumpQueue(key)`** → next file starts.
- `dispatchUpload` failure (`.catch`): set error entry (unchanged). **Pause** —
  no pump; the queue waits for the user.
- `acknowledgePrivacy`: dispatch the staged file (unchanged); its `.then`
  pumps the rest. (Single ack drains the batch when "remember" was checked.)
- `dismissUpload`:
  - **from the privacy modal** (modal open for `key`): user declined →
    **cancel the batch**: clear modal + `pendingPrivacyGated` + `queue.delete`
    + drop batch info + clear entry. (No pump — declining privacy must not
    silently re-dispatch the queued files.)
  - **from an error** (no modal): clear entry **+ `pumpQueue(key)`** → skip the
    failed file, continue with the rest.
- `cancelUpload` (progress "cancel" button): abort inflight + `queue.delete` +
  drop batch info + clear entry → **stop the whole batch**.
- `retryUpload`: `unshift` the failed `lastAttempt` file to the queue front +
  `pumpQueue` → re-run it first, then continue the remaining queue.

## Design — `ComposeBox.tsx`

- `onPickerChange`: `Array.from(input.files)` → `triggerUploads`; add
  `multiple` to the hidden `<input type="file">`.
- `onDrop`: `Array.from(e.dataTransfer.files).filter(f => categoryOf(f.type) !==
  null)` → `triggerUploads` (ignore if none).
- `onPaste`: collect **all** file items with `categoryOf !== null`; if any,
  `preventDefault()` + `triggerUploads` (was: first-only `return`).
- `handleFile(file)` → `handleFiles(files: File[])` calling `triggerUploads`.
- Progress + error UI: append a `(i/N)` counter (new
  `.compose-box-upload-batch` span) when `uploadBatch(key)?.total > 1`. Single
  uploads (total ≤ 1) render no counter — existing single-file UI + e2e text
  unchanged.

## Testing

- **vitest `uploadOrchestrator.test.ts`** (new describe "sequential multi-file
  queue"): enqueue N image files → uploads dispatch one at a time (assert only
  one `inflight`/host.upload active at a time); each success auto-sends its own
  emoji-URL (N `sendMessage` calls, in order); a mid-queue failure pauses the
  batch (no further dispatch) and `dismissUpload` resumes the remainder;
  `cancelUpload` clears the queue (no further dispatch); `uploadBatch` reports
  `(i/N)` and clears when drained. Existing 45 cases stay green via the
  back-compat `triggerUpload` alias.
- **vitest `ComposeBox.test.tsx`**: update the picker/drop/paste cases to assert
  `triggerUploads(..., [file])`; add multi-file drop + multi-file paste cases
  asserting all files are forwarded; assert the picker `<input>` carries
  `multiple`; assert the `(i/N)` counter renders when batch total > 1.
- **e2e**: add a multi-file drop (and/or paste) spec asserting N emoji-URL
  messages land, if Playwright can stage a multi-file `dataTransfer`/clipboard;
  otherwise document the limitation and rely on vitest. Grep `e2e/tests` for any
  upload-progress text only if the rendered single-file affordance changes (it
  does not).

## Risks

- The settle-path `pumpQueue` hooks add re-entrancy: a synchronous test host
  could pump before the current `.then` returns. Mitigation: pump runs after
  `setEntry(null)`/`inflight.delete`, so `isActive` reads false; the existing
  stale-controller guards remain. Covered by the sequential-dispatch test.
- Batch counter drift if a settle path forgets to clear `batchByChannel`.
  Mitigation: clearing is centralized in `pumpQueue` (empty → drop) + the two
  cancel paths; the counter test asserts it clears on drain + cancel.
