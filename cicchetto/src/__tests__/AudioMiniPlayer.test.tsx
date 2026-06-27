import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AudioMiniPlayer from "../AudioMiniPlayer";
import { activeAudio, closeAudio, playAudio } from "../lib/audioPlayer";

// jsdom does not implement HTMLMediaElement playback — stub the methods
// the player drives so the component mounts without "Not implemented".
// Real playback is e2e/device territory (Playwright + iPhone dogfood);
// these tests pin the bar's show/hide + control wiring only.
let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(() => Promise.resolve());
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  closeAudio();
});

afterEach(() => {
  closeAudio();
  vi.restoreAllMocks();
});

describe("AudioMiniPlayer", () => {
  it("renders no bar when no audio is active", () => {
    render(() => <AudioMiniPlayer />);
    expect(screen.queryByTestId("audio-mini-player")).toBeNull();
  });

  it("shows the bar and starts playback when an audio link is played", () => {
    render(() => <AudioMiniPlayer />);
    playAudio("https://grappa.example/uploads/abc");

    expect(screen.getByTestId("audio-mini-player")).toBeInTheDocument();
    expect(playSpy).toHaveBeenCalled();
  });

  it("close button stops playback and hides the bar", () => {
    render(() => <AudioMiniPlayer />);
    playAudio("https://grappa.example/uploads/abc");

    screen.getByTestId("audio-mini-player-close").click();

    expect(pauseSpy).toHaveBeenCalled();
    expect(screen.queryByTestId("audio-mini-player")).toBeNull();
    expect(activeAudio()).toBeNull();
  });

  it("renders the transport controls (toggle, seek, time)", () => {
    // Structure only — actual play/pause + seek behavior depends on
    // real media state jsdom does not implement; that is pinned by the
    // Playwright e2e + iPhone dogfood, not here.
    render(() => <AudioMiniPlayer />);
    playAudio("https://grappa.example/uploads/abc");

    expect(screen.getByTestId("audio-mini-player-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("audio-mini-player-seek")).toBeInTheDocument();
    expect(screen.getByTestId("audio-mini-player-time")).toBeInTheDocument();
  });
});
