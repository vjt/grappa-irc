// UX-4 bucket L (2026-05-19) — minimal UA-string parser.
//
// SettingsDrawer's device list rendered the raw `user_agent` string
// from the server (e.g. "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
// AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
// — visually noisy, blew the drawer width on long modern strings (iOS
// Safari + UA-CH brand strings can hit 200+ chars). Bucket L replaces
// the raw string with a device-class icon + short parsed name like
// "💻 Chrome on macOS" or "📱 Safari on iOS".
//
// KISS: regex-based parser, no external dep (ua-parser-js is ~100KB
// minified — overkill for a 9-field device list). Covers the common
// browsers + platforms; falls back to "Unknown browser" / "Unknown OS"
// on misses. Misclassification of a niche UA is benign (the icon +
// name are informational; the unique device id is the row's
// load-bearing identity).
//
// Pattern order matters: Edge UA contains "Chrome" + "Safari" + "Edg"
// — we check Edg first. iOS Chrome contains "CriOS" not "Chrome" —
// check CriOS first. Match the most specific brand wins.

export type DeviceClass = "desktop" | "mobile" | "tablet" | "unknown";

export type ParsedUserAgent = {
  browser: string;
  os: string;
  deviceClass: DeviceClass;
};

const UNKNOWN: ParsedUserAgent = {
  browser: "Unknown browser",
  os: "Unknown OS",
  deviceClass: "unknown",
};

// Device-class icon — single character so it fits in tight lists.
// Tablet falls back to mobile glyph (no distinct mid-size emoji that
// renders consistently across browsers).
export const deviceClassIcon = (cls: DeviceClass): string => {
  switch (cls) {
    case "desktop":
      return "\u{1F4BB}"; // 💻
    case "mobile":
      return "\u{1F4F1}"; // 📱
    case "tablet":
      return "\u{1F4F1}"; // 📱 (same glyph as mobile)
    case "unknown":
      return "❔"; // ❔
  }
};

const detectBrowser = (ua: string): string => {
  // Order: most specific first. Edg / OPR / CriOS / FxiOS all
  // embed substrings from upstream Chrome/Safari.
  if (/\bEdg\/[\d.]+/.test(ua)) return "Edge";
  if (/\bOPR\/[\d.]+/.test(ua)) return "Opera";
  if (/\bCriOS\/[\d.]+/.test(ua)) return "Chrome";
  if (/\bFxiOS\/[\d.]+/.test(ua)) return "Firefox";
  if (/\bFirefox\/[\d.]+/.test(ua)) return "Firefox";
  if (/\bChrome\/[\d.]+/.test(ua)) return "Chrome";
  if (/\bSafari\/[\d.]+/.test(ua) && /Version\/[\d.]+/.test(ua)) return "Safari";
  return "Unknown browser";
};

const detectOs = (ua: string): string => {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/X11.*Linux|Linux x86_64|Linux i686/.test(ua)) return "Linux";
  if (/CrOS/.test(ua)) return "ChromeOS";
  return "Unknown OS";
};

const detectDeviceClass = (ua: string): DeviceClass => {
  if (/iPad/.test(ua)) return "tablet";
  if (/Tablet/i.test(ua)) return "tablet";
  if (/iPhone|iPod|Android.*Mobile|Mobile.*Android/.test(ua)) return "mobile";
  // Android-without-Mobile suggests a tablet UA in some Android versions
  if (/Android/.test(ua)) return "tablet";
  if (/Mac OS X|Macintosh|Windows NT|Linux|CrOS/.test(ua)) return "desktop";
  return "unknown";
};

/**
 * Parses a UA string into `{browser, os, deviceClass}`. Returns
 * UNKNOWN-shaped placeholder for null/empty inputs.
 *
 * Format choice: `${browser} on ${os}` (e.g. "Chrome on macOS").
 * Consumers pair the parsed name with `deviceClassIcon(p.deviceClass)`
 * to render a chip like "💻 Chrome on macOS".
 */
export const parseUserAgent = (ua: string | null | undefined): ParsedUserAgent => {
  if (ua === null || ua === undefined || ua === "") return UNKNOWN;
  return {
    browser: detectBrowser(ua),
    os: detectOs(ua),
    deviceClass: detectDeviceClass(ua),
  };
};
