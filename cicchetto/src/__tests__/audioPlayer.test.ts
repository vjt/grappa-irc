import { afterEach, describe, expect, it } from "vitest";
import { setToken } from "../lib/auth";
import { activeAudio, closeAudio, playAudio } from "../lib/audioPlayer";

// Docked audio mini-player store (GH #115). Module-singleton signal —
// same identity-scoped pattern as mediaViewer.ts. One player instance:
// playAudio swaps the href, closeAudio clears, token rotation resets.

afterEach(() => {
  closeAudio();
  setToken(null);
});

describe("audioPlayer store", () => {
  it("starts with no active audio", () => {
    expect(activeAudio()).toBeNull();
  });

  it("playAudio sets the active href", () => {
    playAudio("https://grappa.example/uploads/abc");
    expect(activeAudio()).toEqual({ href: "https://grappa.example/uploads/abc" });
  });

  it("playAudio on a second link swaps the source (one instance, not two)", () => {
    playAudio("https://grappa.example/uploads/first");
    playAudio("https://grappa.example/uploads/second");
    expect(activeAudio()).toEqual({ href: "https://grappa.example/uploads/second" });
  });

  it("closeAudio clears the active audio", () => {
    playAudio("https://grappa.example/uploads/abc");
    closeAudio();
    expect(activeAudio()).toBeNull();
  });

  it("token rotation closes an open player (identity-scoped)", () => {
    setToken("tokA");
    playAudio("https://grappa.example/uploads/abc");
    expect(activeAudio()).not.toBeNull();

    setToken("tokB");
    expect(activeAudio()).toBeNull();
  });
});
