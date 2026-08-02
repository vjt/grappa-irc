import { encode } from "uqr";

// #392 — QR code SVG generator for the session-share modal.
//
// Wraps `uqr` (zero-dependency, ESM/TS-native QR encoder) into a
// self-contained SVG string. Chosen over hand-rolling the QR algorithm:
// an encoder bug produces an unscannable code that CI cannot catch
// (Playwright can't operate a camera), so a published, tested encoder is
// correct-by-construction; chosen over heavier `qrcode`/canvas libs for
// bundle size + crisp vector output. See DESIGN_NOTES 2026-07-25.
//
// The symbol is rendered BLACK modules on a WHITE background with a
// quiet-zone margin, INDEPENDENT of the cic theme: a QR that inherited a
// dark theme's colours would render light-on-dark and be rejected by many
// camera scanners. The modal frames it in its own light card.

// Quiet-zone margin in modules on every side. The spec asks for 4; 2 is
// the pragmatic on-screen minimum that still scans reliably.
const QUIET = 2;

/**
 * Build a theme-independent, viewBox-scaled SVG QR code for `text`.
 * Returns the SVG markup string; the caller injects it (e.g. via
 * `innerHTML`) into a sized container — no fixed px width/height, so CSS
 * controls the rendered size while modules stay crisp at any scale.
 */
export function qrSvg(text: string): string {
  return qrSvgWithLabel(text, "session QR code");
}

/** Same QR renderer with a caller-owned accessible label. */
export function qrSvgWithLabel(text: string, ariaLabel: string): string {
  const { data, size } = encode(text, { ecc: "M" });
  const dim = size + QUIET * 2;

  // One <rect> per dark module. A merged path would be denser output but
  // per-module rects keep the wrapper trivially testable (rect count ≈
  // dark modules) and shape-rendering=crispEdges keeps them sharp.
  let rects = "";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y]?.[x]) {
        rects += `<rect x="${x + QUIET}" y="${y + QUIET}" width="1" height="1"/>`;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${escapeAttribute(ariaLabel)}">` +
    `<rect width="${dim}" height="${dim}" fill="#fff"/>` +
    `<g fill="#000">${rects}</g></svg>`
  );
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
