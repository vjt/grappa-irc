// Source-text fetch for the media viewer's `.txt` / `.md` arm (#1764).
//
// Pure module (no SolidJS, no DOM) — same separation as `mediaLink.ts`:
// `MediaViewerModal.tsx` owns the pane, this owns "how many bytes reach the
// DOM, and what a line is".
//
// ## Why this is not `res.text()`
//
// Every other viewer kind hands a URL to an element and lets the browser
// stream it; this one reads the bytes itself, so it is the one place where a
// large file becomes a large DOM. The ceiling above it is real: an upload is
// capped per category by `ServerSettings.get_upload_per_file_cap_bytes/1`
// (`:document` defaults to 10 MiB and an operator can raise it as far as
// `ServerSettings.max_upload_per_file_cap_bytes/0`, 512 MiB, which the upload
// doors' multipart ceiling in `GrappaWeb.MultipartLimits` clears). A naive
// viewer would pull all of it in.
//
// So the cap is enforced HERE, by reading the response through a reader and
// hanging up, rather than by trusting the `Range` header to be honoured. The
// header is still sent — it is a courtesy that stops the server pushing bytes
// we would discard — but a proxy that strips it, or any future admitted host
// that ignores it, changes nothing about how much lands in the page. Enforcing
// on our side is also what makes `truncated` a FACT rather than an inference
// from a `content-range` we may not have been given.
//
// ## The number
//
// NOT a rendering measurement: a browser cannot be driven from this dev host,
// so nothing here was timed on a device. It is anchored on the two numbers
// that were measured, and chosen on the safe side of them because the
// degradation is visible and reversible — the pane says it was cut, and "open
// in browser" still serves the whole file. At ~80 columns 512 KiB is ~6,500
// lines, well past any log or config anyone pastes into IRC, and 20× under the
// default document upload cap, so the cap bites long before an operator-raised
// setting could matter. The DOM cost does not scale with it either: the pane
// renders TWO text nodes (gutter + source), not one node per line, so what
// grows is text layout, not node count.
export const TEXT_VIEW_MAX_BYTES = 512 * 1024;

export type TextResource = {
  // One entry per rendered row. The gutter numbers THIS array and the source
  // pane joins THIS array, so the two cannot disagree about what a line is.
  lines: readonly string[];
  // True only when bytes were left on the server — see `readCapped`.
  truncated: boolean;
};

/**
 * Split source text into the rows the viewer renders. Handles CRLF, and drops
 * the phantom row a trailing newline would otherwise produce (every editor
 * agrees a file ending in `\n` has as many lines as it has newlines; rendering
 * the phantom would put a gutter number beside nothing). Empty input is ONE
 * empty line, not zero — an empty file still has a first line.
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Fetch a source file and return it as rows plus an honest truncation flag.
 *
 * Rejects on a non-2xx response, a bodyless response, or an aborted/failed
 * network read — the caller renders the viewer's shared failure state. Reads
 * at most `TEXT_VIEW_MAX_BYTES` into the page whatever the server does.
 *
 * @param href the viewer-safe href from `classifyMediaLink` — ALWAYS an
 *   admitted host, re-rooted on the page origin. A cross-host href would be
 *   blocked by `connect-src` and never reaches here; see `mediaLink.ts`.
 * @param signal aborts the read when the viewer closes mid-flight.
 */
export async function fetchTextResource(href: string, signal: AbortSignal): Promise<TextResource> {
  const res = await fetch(href, {
    signal,
    // One byte PAST the cap, so "is there more?" is answerable from the bytes
    // we already have instead of costing a second request.
    headers: { range: `bytes=0-${TEXT_VIEW_MAX_BYTES}` },
  });
  if (!res.ok) throw new Error(`text source fetch failed: ${res.status}`);
  if (res.body === null) throw new Error("text source response had no body");

  const { text, truncated } = await readCapped(res.body, TEXT_VIEW_MAX_BYTES);
  return { lines: splitLines(text), truncated };
}

// Read until the stream ends or one byte PAST `max` has arrived, then decode
// the first `max`. The extra byte is what separates "the file ended exactly
// here" from "we stopped here" — reading exactly `max` and stopping cannot
// tell those apart, and would report a file of precisely the cap size as
// truncated forever.
//
// A codepoint straddling the cut decodes to U+FFFD. That is unavoidable when
// capping by BYTES (the server's own `Range` slice would do the same) and is
// honest: the bytes really were cut there.
async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= max) {
    const { done, value } = await reader.read();
    if (done === true) break;
    if (value === undefined || value.byteLength === 0) continue;
    chunks.push(value);
    total += value.byteLength;
  }
  // Hang up rather than drain a body we are not going to read.
  if (total > max) await reader.cancel();

  const kept = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const chunk of chunks) {
    if (at >= kept.length) break;
    const take = Math.min(chunk.byteLength, kept.length - at);
    kept.set(chunk.subarray(0, take), at);
    at += take;
  }
  return { text: new TextDecoder().decode(kept), truncated: total > max };
}
