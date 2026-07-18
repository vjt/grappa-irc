import { describe, expect, test } from "vitest";
import { canManageTheme, dedupeThemesById, SWATCH_KEYS, swatchColors } from "../themeGallery";
import type { TokenPayload } from "../themesApi";
import type { ThemesWireT } from "../wireTypes";

// themeGallery — pure helpers for the gallery consumer view: the derived
// swatch (palette chips, NO stored screenshot) + the owner|admin
// management gate. Tests assert outcomes.

function payload(): TokenPayload {
  const colors: Record<string, string> = {};
  for (const k of [
    "bg",
    "bg_alt",
    "fg",
    "accent",
    "muted",
    "border",
    "mention",
    "mode_op",
    "mode_halfop",
    "mode_voiced",
    "mode_plain",
  ]) {
    colors[k] = `#${k.length}${k.length}${k.length}${k.length}${k.length}${k.length}`.slice(0, 7);
  }
  for (let i = 0; i < 16; i++) colors[`nick_${i}`] = "#0a0b0c";
  return {
    colors: colors as TokenPayload["colors"],
    font_family: "mono-default",
    background: { image_id: null, builtin: null, size: "cover", opacity: 0.3 },
  };
}

function theme(overrides: Partial<ThemesWireT> = {}): ThemesWireT {
  return {
    id: 1,
    name: "T",
    author: "system",
    built_in: true,
    published: true,
    apply_count: 0,
    in_use: 0,
    mine: false,
    payload: payload() as unknown as Record<string, unknown>,
    inserted_at: "2026-07-17T00:00:00Z",
    ...overrides,
  };
}

describe("swatchColors", () => {
  test("returns one hex per swatch key, in order, drawn from the payload", () => {
    const colors = swatchColors(payload());
    expect(colors).toHaveLength(SWATCH_KEYS.length);
    // Every returned value is a hex string from the payload's colors.
    for (const c of colors) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    // bg is the first swatch key → its payload value leads.
    expect(colors[0]).toBe(payload().colors.bg);
  });
});

describe("canManageTheme", () => {
  test("owner can manage their own theme", () => {
    expect(canManageTheme(theme({ mine: true, built_in: false }), false)).toBe(true);
  });

  test("non-owner non-admin cannot manage a built-in", () => {
    expect(canManageTheme(theme({ mine: false, built_in: true }), false)).toBe(false);
  });

  test("admin can manage any theme (moderation)", () => {
    expect(canManageTheme(theme({ mine: false, built_in: true }), true)).toBe(true);
  });
});

describe("dedupeThemesById", () => {
  test("keeps the first occurrence of each id, preserving order", () => {
    // #299 — the gallery view concatenates the published gallery + the
    // caller's owned library (their own published themes appear in BOTH).
    // Dedup by id, first occurrence wins, so the gallery copy's order +
    // viewer-relative flags lead and the owned-only (unpublished) rows append.
    const galleryA = theme({ id: 1, name: "gallery-1" });
    const galleryB = theme({ id: 2, name: "gallery-2" });
    const ownedDupe = theme({ id: 1, name: "owned-1-dupe", mine: true });
    const ownedUnpublished = theme({ id: 3, name: "owned-3", mine: true, published: false });

    const merged = dedupeThemesById([galleryA, galleryB, ownedDupe, ownedUnpublished]);

    expect(merged.map((t) => t.id)).toEqual([1, 2, 3]);
    // First occurrence (the gallery copy of id 1) wins over the owned dupe.
    expect(merged[0]?.name).toBe("gallery-1");
    // The owned unpublished theme (never in the published gallery) is surfaced.
    expect(merged.some((t) => t.id === 3)).toBe(true);
  });

  test("returns an empty array when given no themes", () => {
    expect(dedupeThemesById([])).toEqual([]);
  });
});
