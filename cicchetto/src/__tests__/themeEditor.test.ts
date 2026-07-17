import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenColors, TokenPayload } from "../lib/themesApi";
import type { ThemesWireT } from "../lib/wireTypes";

// #75 producer path — the theme editor's testable seams:
//   * newThemeSeedPayload — seed a brand-new theme from the built-in the
//     gallery already fetched (irssi-dark), NEVER a hand-copied cic
//     palette constant (two copies of the 27-key palette WOULD drift —
//     orchestrator directive 2026-07-17).
//   * persistThemeDraft — the save orchestration: create (new) or update
//     (edit own), then activate so the saved theme becomes the live +
//     server-persisted active theme.
//   * open/close overlay signal.
//
// The overlay DOM + live-preview re-paint + snapshot/restore-on-cancel
// are exercised by the Playwright e2e (jsdom is blind to the CSS-var
// re-paint); this file pins the pure orchestration.

const mocks = vi.hoisted(() => ({
  createTheme: vi.fn(),
  updateTheme: vi.fn(),
  activateTheme: vi.fn(),
}));

vi.mock("../lib/themesApi", () => ({
  createTheme: mocks.createTheme,
  updateTheme: mocks.updateTheme,
}));

vi.mock("../lib/customTheme", () => ({
  activateTheme: mocks.activateTheme,
}));

import {
  closeThemeEditor,
  newThemeSeedPayload,
  openThemeEditor,
  persistThemeDraft,
  themeEditorState,
} from "../lib/themeEditor";

function fullColors(): TokenColors {
  const base = [
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
  ];
  const colors: Record<string, string> = {};
  for (const k of base) colors[k] = "#101010";
  for (let i = 0; i < 16; i++) colors[`nick_${i}`] = "#20a0c0";
  return colors as TokenColors;
}

function payload(over: Partial<TokenPayload> = {}): TokenPayload {
  return {
    colors: fullColors(),
    font_family: "mono-default",
    background: { image_id: null, opacity: 0.3 },
    ...over,
  };
}

function theme(over: Partial<ThemesWireT> = {}): ThemesWireT {
  return {
    id: 1,
    name: "t",
    author: "system",
    built_in: false,
    published: false,
    apply_count: 0,
    mine: true,
    payload: payload() as unknown as Record<string, unknown>,
    inserted_at: "2026-07-17T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  mocks.createTheme.mockReset();
  mocks.updateTheme.mockReset();
  mocks.activateTheme.mockReset();
  closeThemeEditor();
});

describe("newThemeSeedPayload", () => {
  it("prefers the irssi-dark built-in and returns a deep clone", () => {
    const irssi = payload({ colors: { ...fullColors(), bg: "#0a0a0a" } });
    const irssiCard = theme({ id: 6, name: "irssi-dark", built_in: true, payload: irssi as never });
    const themes = [
      theme({ id: 5, name: "dracula", built_in: true, payload: payload() as never }),
      irssiCard,
    ];
    const seed = newThemeSeedPayload(themes);
    expect(seed).toEqual(irssi);
    // Deep clone — editing the seed must not mutate the source card.
    expect(seed).not.toBe(irssiCard.payload);
    expect(seed?.colors).not.toBe(irssi.colors);
  });

  it("falls back to the first built-in when irssi-dark is absent", () => {
    const first = payload({ colors: { ...fullColors(), fg: "#abcdef" } });
    const themes = [
      theme({ id: 7, name: "nord", built_in: true, payload: first as never }),
      theme({ id: 8, name: "gruvbox-dark", built_in: true, payload: payload() as never }),
    ];
    expect(newThemeSeedPayload(themes)).toEqual(first);
  });

  it("returns null when the gallery carries no built-in (entry point disables itself)", () => {
    const themes = [theme({ id: 9, name: "mine", built_in: false })];
    expect(newThemeSeedPayload(themes)).toBeNull();
  });
});

describe("persistThemeDraft", () => {
  it("creates then activates a NEW theme, returning the server copy", async () => {
    const draft = payload({ colors: { ...fullColors(), accent: "#ff00ff" } });
    const saved = theme({ id: 42, name: "MyTheme", mine: true, payload: draft as never });
    mocks.createTheme.mockResolvedValue(saved);
    mocks.activateTheme.mockResolvedValue(undefined);

    const result = await persistThemeDraft(
      "tok",
      { mode: "new", basePayload: payload() },
      "MyTheme",
      draft,
    );

    expect(mocks.createTheme).toHaveBeenCalledWith("tok", { name: "MyTheme", payload: draft });
    expect(mocks.updateTheme).not.toHaveBeenCalled();
    expect(mocks.activateTheme).toHaveBeenCalledWith("tok", saved);
    expect(result).toBe(saved);
  });

  it("updates then activates an EDITED own theme", async () => {
    const existing = theme({ id: 7, name: "old", mine: true });
    const draft = payload({ colors: { ...fullColors(), bg: "#123456" } });
    const saved = theme({ id: 7, name: "Renamed", mine: true, payload: draft as never });
    mocks.updateTheme.mockResolvedValue(saved);
    mocks.activateTheme.mockResolvedValue(undefined);

    const result = await persistThemeDraft(
      "tok",
      { mode: "edit", theme: existing },
      "Renamed",
      draft,
    );

    expect(mocks.updateTheme).toHaveBeenCalledWith("tok", 7, { name: "Renamed", payload: draft });
    expect(mocks.createTheme).not.toHaveBeenCalled();
    expect(mocks.activateTheme).toHaveBeenCalledWith("tok", saved);
    expect(result).toBe(saved);
  });
});

describe("theme editor open/close signal", () => {
  it("starts closed", () => {
    expect(themeEditorState()).toBeNull();
  });

  it("openThemeEditor sets the seed; closeThemeEditor clears it", () => {
    const seed = { mode: "new", basePayload: payload() } as const;
    openThemeEditor(seed);
    expect(themeEditorState()).toEqual(seed);
    closeThemeEditor();
    expect(themeEditorState()).toBeNull();
  });
});
