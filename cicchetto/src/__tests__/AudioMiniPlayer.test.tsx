import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import AudioDock from "../AudioDock";
import AudioMiniPlayer from "../AudioMiniPlayer";
import {
  activeAudio,
  audioFailureLabel,
  audioShareToasts,
  closeAudio,
  dismissAudioShareToast,
  playAudio,
  playerHidden,
  showPlayer,
} from "../lib/audioPlayer";
import type { RadioStation } from "../lib/radioStations";

// issue 2501 — the ⬇ download became share, like the media viewer's. Share is
// offered only where the Web Share API exists and jsdom has none, so a test
// that expects the control installs one; `afterEach` takes it back. Defined on
// `navigator` itself rather than stubbing the global, because the player also
// reads `navigator.mediaSession`.
const restoreNavigator: Array<() => void> = [];

const defineOnNavigator = (key: "share" | "canShare", value: unknown): void => {
  const original = Object.getOwnPropertyDescriptor(navigator, key);
  Object.defineProperty(navigator, key, { value, configurable: true });
  restoreNavigator.push(() => {
    if (original === undefined) Reflect.deleteProperty(navigator, key);
    else Object.defineProperty(navigator, key, original);
  });
};

const stubWebShare = (
  respond: (data: ShareData) => Promise<void>,
): Mock<(data: ShareData) => Promise<void>> => {
  const share = vi.fn<(data: ShareData) => Promise<void>>(respond);
  defineOnNavigator("share", share);
  defineOnNavigator("canShare", () => true);
  return share;
};

const sheetCloses = (): Promise<void> => Promise.resolve();

// jsdom does not implement HTMLMediaElement playback — stub the methods
// the player drives so the component mounts without "Not implemented".
// Real playback is e2e/device territory (Playwright + iPhone dogfood);
// these tests pin the bar's show/hide + control wiring only.
// #1896 — the bar is PORTALLED into a dock now (the element is mounted once
// above Shell's regime branch so a rotation cannot tear it down), so a player
// rendered on its own has nowhere to put its chrome and every test here mounts
// the pair. The dock comes FIRST: its `ref` registers during that element's
// creation, so the player's first render already sees one and the bar is in the
// DOM synchronously, exactly as it was before this issue.
const renderPlayer = () =>
  render(() => (
    <>
      <AudioDock />
      <AudioMiniPlayer />
    </>
  ));

let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;
let loadSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(() => Promise.resolve());
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  // #1700 — held, not discarded: `load()` is the only call that re-fetches, so
  // the resume path is now asserted through it.
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  // #1701 — an OFFLINE `fetch`, for every test in this file, installed before
  // any of them can tune anything.
  //
  // Two tests here call `playAudio("https://ice.somafm.com/groovesalad-128-mp3",
  // …)` to exercise the transport, and neither of them is about the feed — but
  // `tunedStation()` is DERIVED, not declared: `radio.ts` matches
  // `activeAudio()?.href` against the curated table, so those two calls tune
  // Groove Salad as far as the rest of the app is concerned. `nowPlaying.ts`'s
  // effect then polls `api.somafm.com` IMMEDIATELY, and in CI — where a network
  // exists and this sandbox's does not — that is a live third-party request
  // issued from a unit test. Measured: the run that caught it reported
  // `Expected "Trestal — A Land Unknown", Received "Alex Cortiz — Paluka days"`,
  // a real track that was genuinely on the air.
  //
  // It also RACED. The in-flight real answer clears the poll's own guard
  // (`tunedStation() !== station`, `?.songsUrl !== url` before #1835) because
  // the feed test tunes the SAME
  // station, so it lands on top of the stub. That guard is not the defect and
  // is deliberately left alone — it is asking the right question; the barrier
  // below is what let a stale answer reach it at the wrong moment.
  //
  // Rejecting rather than answering `ok: false`: both leave `track` null via the
  // poll's catch, and "there is no network here" is the honest one to model. A
  // test that WANTS a feed says so by overriding this — see `tuneWithFeed`.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("offline: a unit test must not reach the network")),
  );
  closeAudio();
  showPlayer();
});

afterEach(() => {
  closeAudio();
  showPlayer();
  for (const restore of restoreNavigator.splice(0)) restore();
  for (const toast of audioShareToasts()) dismissAudioShareToast(toast.id);
  vi.restoreAllMocks();
  // #1698 — `restoreAllMocks` does NOT undo `stubGlobal`, so without this the
  // feed stub the track tests install would outlive them and sit under every
  // later test in the file. Same pairing `RailRadio.test.tsx` already uses.
  vi.unstubAllGlobals();
});

describe("AudioMiniPlayer", () => {
  it("renders no bar when no audio is active", () => {
    renderPlayer();
    expect(screen.queryByTestId("audio-mini-player")).toBeNull();
  });

  it("shows the bar and starts playback when an audio link is played", () => {
    renderPlayer();
    playAudio("https://grappa.example/uploads/abc", null);

    expect(screen.getByTestId("audio-mini-player")).toBeInTheDocument();
    expect(playSpy).toHaveBeenCalled();
  });

  it("close button stops playback and hides the bar", () => {
    renderPlayer();
    playAudio("https://grappa.example/uploads/abc", null);

    screen.getByTestId("audio-mini-player-close").click();

    expect(pauseSpy).toHaveBeenCalled();
    expect(screen.queryByTestId("audio-mini-player")).toBeNull();
    expect(activeAudio()).toBeNull();
  });

  it("renders the transport controls (toggle, seek, time)", () => {
    // Structure only — actual play/pause + seek behavior depends on
    // real media state jsdom does not implement; that is pinned by the
    // Playwright e2e + iPhone dogfood, not here.
    renderPlayer();
    playAudio("https://grappa.example/uploads/abc", null);

    expect(screen.getByTestId("audio-mini-player-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("audio-mini-player-seek")).toBeInTheDocument();
    expect(screen.getByTestId("audio-mini-player-time")).toBeInTheDocument();
  });

  it("offers share where the download was, and nothing that saves by anchor (issue 2501)", () => {
    // The ⬇ was a same-origin `download=""` anchor, the one the media viewer's
    // download copied, and on an iOS PWA that anchor opened a preview the app
    // could not be left from. vjt's ruling: share here too, like the viewer.
    stubWebShare(sheetCloses);
    renderPlayer();
    playAudio("https://grappa.example/uploads/abc", null);

    expect(screen.getByTestId("audio-mini-player-share")).toHaveAttribute("aria-label", "share");
    expect(document.querySelector("[download]")).toBeNull();
  });

  // #682 — LIVE mode. The transport was written for a FILE: it renders a
  // position slider and a "cur / dur" read, both meaningless against an
  // endless Icecast stream. The mode is DERIVED from the element's own
  // `duration` (non-finite ⇒ nothing to scrub within), not from a flag the
  // caller sets — so it is right for ANY endless source, not just the radio
  // stations that motivated it, and cannot drift from the element's truth.
  //
  // jsdom implements no media pipeline, so `duration` is stubbed on the
  // INSTANCE and the metadata event replayed by hand — the same seam the
  // play/pause spies above use, at the one property the mode reads.
  const loadMetadataWithDuration = (duration: number): void => {
    const el = screen.getByTestId("audio-mini-player-el");
    Object.defineProperty(el, "duration", { configurable: true, value: duration });
    el.dispatchEvent(new Event("loadedmetadata"));
  };

  it("a finite duration keeps the seek control and share", () => {
    stubWebShare(sheetCloses);
    renderPlayer();
    playAudio("https://grappa.example/uploads/abc", null);

    loadMetadataWithDuration(212);

    expect(screen.getByTestId("audio-mini-player-seek")).toBeInTheDocument();
    expect(screen.getByTestId("audio-mini-player-share")).toBeInTheDocument();
    expect(screen.queryByTestId("audio-mini-player-live")).toBeNull();
  });

  it("an endless stream drops the seek control — there is nothing to scrub", () => {
    renderPlayer();
    playAudio("https://ice.somafm.com/groovesalad-128-mp3", "Groove Salad");

    loadMetadataWithDuration(Number.POSITIVE_INFINITY);

    expect(screen.queryByTestId("audio-mini-player-seek")).toBeNull();
    expect(screen.getByTestId("audio-mini-player-live")).toBeInTheDocument();
  });

  it("an endless stream offers no share — the download's gate, carried over", () => {
    // Share took the download's place under the download's gate (#682): a
    // source with no end is no file to hand over. Web Share is installed so
    // the absence is the gate's, not the platform's.
    stubWebShare(sheetCloses);
    renderPlayer();
    playAudio("https://ice.somafm.com/groovesalad-128-mp3", "Groove Salad");

    loadMetadataWithDuration(Number.POSITIVE_INFINITY);

    expect(screen.queryByTestId("audio-mini-player-share")).toBeNull();
  });

  it("an unknown (NaN) duration is treated as live, not as a zero-length file", () => {
    // `duration` is NaN whenever the element cannot state a length. Seeking
    // is exactly as meaningless there as against Infinity, so the predicate
    // is "not a finite number" rather than "=== Infinity".
    renderPlayer();
    playAudio("https://ice.somafm.com/dronezone-128-mp3", "Drone Zone");

    loadMetadataWithDuration(Number.NaN);

    expect(screen.queryByTestId("audio-mini-player-seek")).toBeNull();
    expect(screen.getByTestId("audio-mini-player-live")).toBeInTheDocument();
  });

  it("shows the source label when one was supplied", () => {
    // On mobile the right rail is a drawer slid off-screen
    // (`transform: translateX(100%)`), so while a station plays this docked
    // bar is the ONLY thing on screen naming it. Without the label the phone
    // cannot answer "what am I listening to".
    renderPlayer();
    playAudio("https://ice.somafm.com/groovesalad-128-mp3", "Groove Salad");

    expect(screen.getByTestId("audio-mini-player-label")).toHaveTextContent("Groove Salad");
  });

  it("renders no label slot for an unlabelled source", () => {
    renderPlayer();
    playAudio("https://grappa.example/uploads/abc", null);

    expect(screen.queryByTestId("audio-mini-player-label")).toBeNull();
  });

  // issue 2501 — share runs the media viewer's flow (`createMediaSharer`, whose
  // arms are pinned in MediaViewerModal.test.tsx). What is pinned here is what
  // this door adds: where a failure is said, the fetch dying with the source,
  // and a refused file belonging to ONE source on a player that outlives it.
  describe("issue 2501 — share, like the media viewer", () => {
    // Same-origin, so the FILE path is reachable: built from the live origin.
    const OWN_TRACK = `${window.location.origin}/uploads/abcdefghijklmnopqrstuvwxyz.mp3`;
    const OTHER_OWN_TRACK = `${window.location.origin}/uploads/zyxwvutsrqponmlkjihgfedcba.mp3`;
    const FOREIGN_TRACK = "https://elsewhere.example/uploads/song.mp3";
    const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);

    const shareButton = (): HTMLElement => screen.getByTestId("audio-mini-player-share");

    // The served bytes, as the upload route answers them.
    const stubServedTrack = (): void => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            status: 200,
            blob: () => Promise.resolve(new Blob([MP3_BYTES], { type: "audio/mpeg" })),
          }),
        ),
      );
    };

    it("offers no share where the Web Share API is absent", () => {
      renderPlayer();
      playAudio(OWN_TRACK, null);

      expect(screen.getByTestId("audio-mini-player-toggle")).toBeInTheDocument();
      expect(screen.queryByTestId("audio-mini-player-share")).toBeNull();
    });

    it("shares the FILE of an own upload", async () => {
      stubServedTrack();
      const share = stubWebShare(sheetCloses);
      renderPlayer();
      playAudio(OWN_TRACK, null);

      shareButton().click();

      await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      const [file] = share.mock.calls[0]?.[0]?.files ?? [];
      expect(file?.name).toBe("abcdefghijklmnopqrstuvwxyz.mp3");
      expect(file?.type).toBe("audio/mpeg");
      expect(audioShareToasts()).toHaveLength(0);
    });

    it("names a refused share in a toast instead of failing inert", async () => {
      // A LINK share, so there is nothing smaller to fall back to: the refusal
      // is reported as the platform worded it.
      stubWebShare(() => Promise.reject(new DOMException("share refused", "NotAllowedError")));
      renderPlayer();
      playAudio(FOREIGN_TRACK, null);

      shareButton().click();

      await vi.waitFor(() => expect(audioShareToasts()).toHaveLength(1));
      expect(audioShareToasts()[0]?.message).toMatch(/share refused/);
    });

    it("says nothing when the reader dismisses the share sheet", async () => {
      const share = stubWebShare(() => Promise.reject(new DOMException("cancelled", "AbortError")));
      renderPlayer();
      playAudio(FOREIGN_TRACK, null);

      shareButton().click();

      await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      // Flush the rejection before asserting the absence of what it would write.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(audioShareToasts()).toHaveLength(0);
    });

    it("opens no share sheet once the source has closed under the fetch", async () => {
      // A fetch that honours its signal, as the platform's does, AND answers on
      // its own a tick later: a stub that only settled on abort would hang with
      // the abort unwired, and the test would pass for a player that never
      // cancels anything.
      vi.stubGlobal(
        "fetch",
        (_href: string, init: { signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const answer = setTimeout(() => {
              resolve({
                ok: true,
                status: 200,
                blob: () => Promise.resolve(new Blob([MP3_BYTES], { type: "audio/mpeg" })),
              });
            }, 0);
            init.signal.addEventListener("abort", () => {
              clearTimeout(answer);
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );
      const share = stubWebShare(sheetCloses);
      renderPlayer();
      playAudio(OWN_TRACK, null);

      shareButton().click();
      closeAudio();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(share).not.toHaveBeenCalled();
      expect(audioShareToasts()).toHaveLength(0);
    });

    it("a refused FILE turns only that source to its link, not the next one", async () => {
      // The viewer forgets a refusal when it closes; this player outlives every
      // source it plays, so the refusal is keyed on the href instead.
      stubServedTrack();
      const share = stubWebShare(sheetCloses);
      share.mockImplementationOnce(() =>
        Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
      );
      renderPlayer();
      playAudio(OWN_TRACK, null);

      shareButton().click();
      await vi.waitFor(() =>
        expect(audioShareToasts()[0]?.message).toMatch(/tap share again to send the link/),
      );

      shareButton().click();
      await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(2));
      expect(share.mock.calls[1]?.[0]).toEqual({ url: OWN_TRACK });

      playAudio(OTHER_OWN_TRACK, null);
      shareButton().click();
      await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(3));
      expect(share.mock.calls[2]?.[0]?.files?.[0]?.name).toBe("zyxwvutsrqponmlkjihgfedcba.mp3");
    });
  });

  // #1697 — the bar was permanent once a station was tuned: the only way off
  // the screen was the ✕, which STOPS. Hiding is a different gesture and the
  // two must not be one control.
  //
  // Why these assertions and not a screenshot: jsdom implements no media
  // pipeline, so "it kept playing" is not directly observable here. What IS
  // observable — and is the entire mechanism — is that the <audio> element
  // survives the gesture with its source attached and that neither `pause()`
  // nor a fresh `play()` is issued. Those three together are exactly the
  // footprint of "nothing in the element's effect chain ran".
  describe("#1697 — hiding the surface without stopping the audio", () => {
    const STATION = "https://ice.somafm.com/groovesalad-128-mp3";

    it("hiding removes the bar but leaves the source loaded and untouched", () => {
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      playSpy.mockClear();
      pauseSpy.mockClear();

      screen.getByTestId("audio-mini-player-hide").click();

      expect(screen.queryByTestId("audio-mini-player")).toBeNull();
      expect(screen.getByTestId("audio-mini-player-el")).toHaveAttribute("src", STATION);
      expect(activeAudio()).not.toBeNull();
      expect(playerHidden()).toBe(true);
    });

    it("hiding issues no pause and no re-play — the element is not disturbed", () => {
      // The mutation this kills: reaching for `activeAudio` to carry the hidden
      // flag. That re-fires `on(activeAudio)`, which reassigns `audioEl.src`
      // and calls `play()` again — a visible re-buffer of a live stream, which
      // is precisely the thing "hide ≠ stop" forbids.
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      playSpy.mockClear();
      pauseSpy.mockClear();

      screen.getByTestId("audio-mini-player-hide").click();

      expect(pauseSpy).not.toHaveBeenCalled();
      expect(playSpy).not.toHaveBeenCalled();
    });

    it("the bar comes back with the same source still attached", () => {
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      screen.getByTestId("audio-mini-player-hide").click();
      playSpy.mockClear();

      showPlayer();

      expect(screen.getByTestId("audio-mini-player")).toBeInTheDocument();
      expect(screen.getByTestId("audio-mini-player-el")).toHaveAttribute("src", STATION);
      expect(playSpy).not.toHaveBeenCalled();
    });

    it("hide and close stay two distinct controls, and only close stops", () => {
      // Guards against the tempting simplification of folding them: the ✕ is
      // the STOP verb (#115) and the phone's only reachable one while the rail
      // is slid off-screen.
      renderPlayer();
      playAudio(STATION, "Groove Salad");

      expect(screen.getByTestId("audio-mini-player-hide")).toBeInTheDocument();
      screen.getByTestId("audio-mini-player-close").click();

      expect(activeAudio()).toBeNull();
      expect(pauseSpy).toHaveBeenCalled();
    });

    it("a new source re-shows a hidden bar rather than playing behind it", () => {
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      screen.getByTestId("audio-mini-player-hide").click();

      playAudio("https://grappa.example/uploads/abc", null);

      expect(screen.getByTestId("audio-mini-player")).toBeInTheDocument();
    });
  });

  // #1698 — the track, on the one surface a phone can see.
  //
  // The SAME argument the label above is defended with, applied one field
  // further: `.shell-members` is `translateX(100%)` on mobile, so the rail's
  // chrome is off-screen while the station plays and this bar is the only
  // place the track can appear at all. Rail-only would have meant the phone —
  // where a radio is most used — never learns what is on.
  describe("the now-playing track (#1698)", () => {
    const TRACK = "Trestal — A Land Unknown";

    /** Render the bar, tune the first curated station against a stubbed feed
        and wait for the track to reach the row. Returns the station, so a
        caller can assert against the title the table actually carries rather
        than a copy of it. */
    const tuneWithFeed = async (): Promise<RadioStation> => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ songs: [{ title: "A Land Unknown", artist: "Trestal" }] }),
        } as unknown as Response),
      );
      const { tuneStation } = await import("../lib/radio");
      const { RADIO_STATIONS } = await import("../lib/radioStations");
      const station = RADIO_STATIONS[0];
      if (station === undefined) throw new Error("the curated table must carry a station");

      renderPlayer();
      tuneStation(station);

      // #1701 — wait for the STUBBED TEXT, not for the element.
      //
      // Presence is not the state this helper promises. Any answer at all mounts
      // the span, so a barrier keyed on `toBeInTheDocument` returns on WHICHEVER
      // read landed first and hands the caller a row it never checked the
      // provenance of. With the offline default above there is only one possible
      // answer left — but a barrier that is correct only because nothing else
      // can happen is one leak away from deciding by timing again, and this one
      // already did once (a live SomaFM track, in CI). Keyed on the text, the
      // helper cannot return until the feed IT installed is the one on screen.
      await vi.waitFor(() =>
        expect(screen.getByTestId("audio-mini-player-track")).toHaveTextContent(TRACK),
      );
      return station;
    };

    it("names the track next to the station once the feed has answered", async () => {
      const station = await tuneWithFeed();

      expect(screen.getByTestId("audio-mini-player-track")).toHaveTextContent(TRACK);
      // Both, not one: the station answers "what am I listening to" and the
      // track answers "what is on". Collapsing them would cost the phone the
      // station name, which is the #682 reason this label exists.
      expect(screen.getByTestId("audio-mini-player-label")).toHaveTextContent(station.title);
    });

    it("shows no track slot for an audio upload", () => {
      // An upload is not a station and has no feed. The slot must be absent
      // rather than empty — an empty span still takes its gap.
      renderPlayer();
      playAudio("https://grappa.example/uploads/abc", null);

      expect(screen.queryByTestId("audio-mini-player-track")).toBeNull();
    });

    // Where the two slices meet, and the one case neither of them owns alone.
    //
    // #1697 gave the transport a HIDDEN state; #1698 put a live fact on that
    // transport. The chrome half needs no code: the span sits inside the same
    // <Show> the hide predicate narrows, so a hidden bar cannot render a track
    // — showing one on a surface that is not there would be nothing at all.
    //
    // The half that DOES need stating is the other one. `/np` is a COMMAND, not
    // chrome, and an operator who hid the bar to get their screen back is
    // exactly the operator who then asks the channel what is on. So the fact
    // must outlive the surface — which it does because the poll is keyed on
    // `tunedStation()`, i.e. on the AUDIO, and hiding deliberately says nothing
    // about the audio. Keying it on visibility instead would have made `/np`
    // answer "nothing is playing" in the state a phone spends most of its time
    // in, and that refusal would have been a lie rather than a report.
    it("hiding the bar takes the track off screen without taking it from /np", async () => {
      const station = await tuneWithFeed();
      const { nowPlayingLabel } = await import("../lib/nowPlaying");
      const { tunedStation } = await import("../lib/radio");

      screen.getByTestId("audio-mini-player-hide").click();

      expect(screen.queryByTestId("audio-mini-player-track")).toBeNull();
      expect(nowPlayingLabel()).toBe(TRACK);
      // The mechanism, not a proxy for it: routing the hidden flag through
      // `activeAudio` — the shape #1697's own comment forbids — would null this
      // out, and the poll keyed on it would stop with the chrome.
      expect(tunedStation()).toBe(station);
    });
  });

  // #1700 — pressing play could not bring an interrupted live stream back.
  //
  // THE MECHANISM, stated precisely, because the issue's one-liner ("play never
  // re-fetches") is not quite what the contract says. `play()` DOES invoke the
  // resource selection algorithm — but only when `networkState` is
  // NETWORK_EMPTY, and an Icecast connection that drops mid-stream does not
  // land there. `load()` runs that algorithm unconditionally, and the only
  // `load()` in this component was on the CLOSE path, where it DETACHES a
  // source. Nothing on the resume path re-fetched. (Read off the HTML media
  // element spec, not measured in a browser — see the test-level notes below
  // for what these assertions do and do not establish.)
  //
  // TWO SOURCES OF TRUTH FOR ONE CONTROL, which is the deeper half. The
  // button's LABEL came from the `playing()` signal (driven by events) and its
  // ACTION came from `audioEl.paused` (the element's own property). Those agree
  // until something goes wrong and then they do not, and a control whose action
  // disagrees with its label does the opposite of what the operator read. The
  // fix is not a third state: it is deriving both from `playing()`.
  //
  // WE DO NOT DISTINGUISH "paused" FROM "interrupted", and that is deliberate
  // rather than a gap we could not close. There is no reliable signal for it —
  // but more to the point, the question does not need answering. The axis that
  // matters is "is there a POSITION worth resuming to", and for a live source
  // there is none: `currentTime` is elapsed-since-tune-in, not a place in a
  // work. Resuming a live stream in place is not a feature being sacrificed, it
  // is a defect of its own — you come back to buffered audio and stay exactly
  // that far behind live, forever. So re-fetching a live source on resume is
  // the CORRECT behaviour independently of any interruption having happened.
  describe("#1700 — resuming after an interruption", () => {
    const STATION = "https://ice.somafm.com/groovesalad-128-mp3";
    const UPLOAD = "https://grappa.example/uploads/abc";

    const element = (): HTMLElement => screen.getByTestId("audio-mini-player-el");
    const toggle = (): HTMLElement => screen.getByTestId("audio-mini-player-toggle");

    /** Replay one media event by hand. jsdom runs no media pipeline and the
        methods above are stubbed, so nothing fires on its own — the same seam
        `loadMetadataWithDuration` uses, at the events the transport listens to. */
    const fire = (type: string): void => {
      element().dispatchEvent(new Event(type));
    };

    /** Put the element in the state a dropped fetch leaves it in: a MediaError
        set, and — per the spec's resource-fetch failure path, which sets
        `error` and `networkState` and says nothing about `paused` — still not
        paused. Stubbed on the INSTANCE, like `duration` above. */
    const interrupt = (): void => {
      Object.defineProperty(element(), "error", {
        configurable: true,
        value: { code: 2, message: "network" },
      });
      Object.defineProperty(element(), "paused", { configurable: true, value: false });
      fire("error");
    };

    const clearSpies = (): void => {
      playSpy.mockClear();
      pauseSpy.mockClear();
      loadSpy.mockClear();
    };

    it("re-fetches a live source before playing it again", () => {
      // The reported symptom. `play()` on an element whose media resource is
      // gone resolves and produces silence; only `load()` goes back for a new
      // one.
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      loadMetadataWithDuration(Number.POSITIVE_INFINITY);
      fire("play");
      fire("pause");
      clearSpies();

      toggle().click();

      expect(loadSpy).toHaveBeenCalled();
      expect(playSpy).toHaveBeenCalled();
    });

    it("resumes a paused FILE in place, without re-fetching it", () => {
      // The other side of the same predicate, and the reason it is not "always
      // reload": a file HAS a position, resuming at `currentTime` is the whole
      // point of pausing one, and re-fetching would throw that away along with
      // whatever is already buffered.
      renderPlayer();
      playAudio(UPLOAD, null);
      loadMetadataWithDuration(212);
      fire("play");
      fire("pause");
      clearSpies();

      toggle().click();

      expect(loadSpy).not.toHaveBeenCalled();
      expect(playSpy).toHaveBeenCalled();
    });

    it("re-fetches a FILE too once its resource is in error", () => {
      // A file whose fetch failed has no position left to preserve either, so
      // the same rule covers it. This is the half the issue called the broader
      // form, and it costs nothing to include: `error !== null` is exactly
      // "cannot continue from here".
      renderPlayer();
      playAudio(UPLOAD, null);
      loadMetadataWithDuration(212);
      fire("play");
      interrupt();
      clearSpies();

      toggle().click();

      expect(loadSpy).toHaveBeenCalled();
      expect(playSpy).toHaveBeenCalled();
    });

    it("stops claiming to play once the element reports an error", () => {
      // Half the reason nobody noticed the bug: with no `error` handler the bar
      // kept showing ⏸ over silence, so the transport looked like it had
      // worked.
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      fire("play");
      expect(toggle()).toHaveAttribute("aria-label", "pause");

      interrupt();

      expect(toggle()).toHaveAttribute("aria-label", "play");
    });

    it("keeps claiming to play through a stall — a stall is not a stop", () => {
      // Deliberately NOT wired, against the issue's suggestion of
      // `onStalled`. A stall or a wait is recoverable buffering: clearing the
      // state there would flip the button to ▶ over audio that is still
      // coming, which is the same lie in the other direction. Only `error` is
      // terminal, and only `error` is listened to.
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      fire("play");

      fire("stalled");
      fire("waiting");

      expect(toggle()).toHaveAttribute("aria-label", "pause");
    });

    it("acts on what the button SAYS, not on the element's paused flag", () => {
      // The divergence, made concrete: our signal says not-playing (the error
      // cleared it) while the element still says not-paused. Reading
      // `audioEl.paused` here makes the control PAUSE when its own label reads
      // ▶ — the operator presses play and gets a pause. Reading `playing()`
      // makes label and action one fact.
      //
      // What this establishes: that the two can disagree and which one wins.
      // What it does NOT establish: that a real browser leaves `paused` false
      // after a dropped stream. That is a spec reading, and the device verdict
      // is owed either way.
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      fire("play");
      interrupt();
      expect(toggle()).toHaveAttribute("aria-label", "play");
      expect(element()).toHaveProperty("paused", false);
      clearSpies();

      toggle().click();

      expect(pauseSpy).not.toHaveBeenCalled();
      expect(playSpy).toHaveBeenCalled();
    });

    it("still pauses a healthy source, and does not re-fetch to do it", () => {
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      loadMetadataWithDuration(Number.POSITIVE_INFINITY);
      fire("play");
      clearSpies();

      toggle().click();

      expect(pauseSpy).toHaveBeenCalled();
      expect(loadSpy).not.toHaveBeenCalled();
      expect(playSpy).not.toHaveBeenCalled();
    });
  });

  // #1734 — LEAVING A WINDOW AND COMING BACK.
  //
  // The source is MODULE state and outlives this component, but the ELEMENT
  // does not: navigating a scrollback window → home / list / mentions / admin
  // unmounts the player. Coming back re-mounts it, the `on(activeAudio, …)`
  // effect runs its FIRST execution, and a re-mount is indistinguishable from
  // a new source at that point — so a file used to restart from zero, unasked.
  //
  // MEASURED before the fix, and the second line is why the shape below is
  // what it is:
  //
  //   [FILE]   before: play=1 currentTime=42 duration=180 seek-max=180
  //            after:  play=2 currentTime=0                seek-max=0
  //   [STREAM] before: live-badge=true
  //            after:  live-badge=FALSE  seek-present=TRUE
  //
  // A re-mounted STREAM came back dressed as a file. `live()` reads `duration`,
  // a signal of THIS component, and a re-mount recreates it at 0 — a finite
  // number. So #1700's `mustRefetch` (`el.error !== null || live()`) answers
  // "no re-fetch needed" for a stream too, and cannot tell the two apart at the
  // one moment that matters. Restoring the remembered `duration` BEFORE
  // consulting it is what puts the predicate back in a position to answer, and
  // is why there is no second predicate here.
  //
  // WHY RESUME AND NOT SIT STILL. Sitting still needs the same remembered
  // `duration` (a stream must still re-tune — #1700's rule), and it needs the
  // position too or the transport reads 0:00 on a file that is at 0:42. Once
  // both are restored the only thing left to decide is whether to call
  // `play()`, and the operator never asked for a stop: they changed window. So
  // the transport is preserved rather than chosen — playing resumes, paused
  // stays paused. Anything else is cic originating state.
  describe("#1734 — re-mounting after leaving the window", () => {
    const UPLOAD = "https://grappa.example/uploads/abc";
    const STATION = "https://ice.somafm.com/groovesalad-128-mp3";

    const element = (): HTMLAudioElement =>
      screen.getByTestId("audio-mini-player-el") as HTMLAudioElement;

    /** Bring the element to the state a played source leaves it in: metadata
        arrived, the transport is at `at`, and it is playing or not. jsdom runs
        no media pipeline, so the properties are stubbed on the INSTANCE and the
        events replayed by hand — the same seam the rest of this file uses. */
    const settleAt = (duration: number, at: number, isPlaying: boolean): void => {
      const el = element();
      Object.defineProperty(el, "duration", { configurable: true, value: duration });
      el.dispatchEvent(new Event("loadedmetadata"));
      el.currentTime = at;
      el.dispatchEvent(new Event("timeupdate"));
      el.dispatchEvent(new Event(isPlaying ? "play" : "pause"));
    };

    /** The metadata round the re-mounted element does on its own. The position
        can only be applied once the element knows its length, which is why the
        fix waits for this event rather than writing `currentTime` next to
        `.src` — that write is dropped by a real browser before metadata. */
    const metadataArrives = (duration: number): void => {
      const el = element();
      Object.defineProperty(el, "duration", { configurable: true, value: duration });
      el.dispatchEvent(new Event("loadedmetadata"));
    };

    it("a FILE that was playing comes back at its position, still playing", () => {
      playAudio(UPLOAD, null);
      const first = renderPlayer();
      settleAt(180, 42, true);
      playSpy.mockClear();

      first.unmount();
      renderPlayer();
      metadataArrives(180);

      expect(element().currentTime).toBe(42);
      expect(playSpy).toHaveBeenCalled();
    });

    it("a FILE that was PAUSED comes back at its position and stays paused", () => {
      // The half that separates "resume" from "restart something": a re-mount
      // the operator did not ask for must not start audio they had stopped.
      playAudio(UPLOAD, null);
      const first = renderPlayer();
      settleAt(180, 42, false);
      playSpy.mockClear();

      first.unmount();
      renderPlayer();
      metadataArrives(180);

      expect(element().currentTime).toBe(42);
      expect(playSpy).not.toHaveBeenCalled();
    });

    it("a STREAM still re-tunes, and never wears the file chrome on the way", () => {
      // #1700's rule, unchanged: re-tuning IS the correct resume for a stream.
      // The second assertion is the measured regression above — the bar must
      // not draw a seek slider across an endless source while the re-mounted
      // element waits for metadata it will never usefully answer.
      playAudio(STATION, "Groove Salad");
      const first = renderPlayer();
      settleAt(Number.POSITIVE_INFINITY, 42, true);
      playSpy.mockClear();

      first.unmount();
      renderPlayer();

      expect(playSpy).toHaveBeenCalled();
      expect(screen.getByTestId("audio-mini-player-live")).toBeInTheDocument();
      expect(screen.queryByTestId("audio-mini-player-seek")).toBeNull();
    });

    it("a NEW source does not inherit the previous one's position", () => {
      // The invalidation, and the reason the remembered point needs no href of
      // its own: every writer of `activeAudio` clears it, so a point that
      // exists belongs to the source that is active. This test is what keeps
      // that invariant from being quietly broken by a fourth writer.
      playAudio(UPLOAD, null);
      const first = renderPlayer();
      settleAt(180, 42, true);
      first.unmount();

      renderPlayer();
      playAudio("https://grappa.example/uploads/second", null);
      metadataArrives(90);

      expect(element().currentTime).toBe(0);
    });
  });

  // #1744 — A STREAM THAT NEVER STARTS SAID NOTHING TO ANYONE.
  //
  // MEASURED on the harness above with `MediaError` code 4, the codec case:
  //
  //   el.error.code                    4      ← the element populates it
  //   elements naming the error        0      ← nobody reads it for display
  //   toggle                           "▶" / aria-label="play"
  //   LIVE badge                       false
  //   SEEK slider                      present, max="0"
  //   readout                          "0:00 / 0:00"
  //   download link                    present
  //
  // NOT MERELY MUTE — LYING, and the second half is why this is more than one
  // span. `loadedmetadata` never arrives, so `duration` stays at 0, which is a
  // FINITE number, so `live()` answers false and the bar dresses a dead endless
  // stream as a FILE: a scrubber over nothing and a `0:00 / 0:00` readout. The
  // failure therefore REPLACES the readout rather than joining it.
  //
  // THE DOWNLOAD ANCHOR IS THE EXCEPTION, and finding it is what split that
  // <Show> in two. It sat inside the file readout because the two share a
  // predicate, not because they answer the same question — and an upload the
  // browser cannot DECODE is exactly the upload the operator wants to SAVE.
  // Taking it away would remove the remedy at the moment it is needed. So the
  // notice replaces the readout, and the anchor keeps #682's own `live()`
  // gate, unchanged.
  //
  // WHY THIS IS NOT A SECOND PREDICATE BESIDE `mustRefetch` (#1700's rule that
  // the predicate is one). Two independent reasons, and either is sufficient:
  //   * `mustRefetch` is `el.error !== null || live()`, so it is TRUE for every
  //     healthy live stream. A surface gated on it would show a failure on
  //     every station that works.
  //   * It is a question ASKED OF THE ELEMENT at the instant of a decision, and
  //     `el.error` is a plain property. Solid cannot subscribe to it, so no
  //     amount of asking re-renders anything. The signal below is the reactive
  //     record of the EVENT, which is a different object with a different job:
  //     `mustRefetch` decides whether to call `load()`, this decides what the
  //     operator is told. They can legitimately disagree — a retry clears the
  //     notice while `el.error` is still set until the new fetch lands.
  describe("#1744 — saying so when the source will not play", () => {
    const STATION = "https://ice.somafm.com/groovesalad-128-mp3";
    const UPLOAD = "https://grappa.example/uploads/abc";

    const element = (): HTMLElement => screen.getByTestId("audio-mini-player-el");
    const toggle = (): HTMLElement => screen.getByTestId("audio-mini-player-toggle");

    /** Put the element in the state a failed load leaves it in, at `code`. Same
        instance-stub seam as `interrupt()` above, parameterised because the
        REASON is what this slice is about. */
    const failWith = (code: number): void => {
      Object.defineProperty(element(), "error", {
        configurable: true,
        value: { code, message: "" },
      });
      element().dispatchEvent(new Event("error"));
    };

    /** Stub `duration` and replay the metadata round, as the file above does. */
    const metadataArrives = (duration: number): void => {
      Object.defineProperty(element(), "duration", { configurable: true, value: duration });
      element().dispatchEvent(new Event("loadedmetadata"));
    };

    it("names the failure on the bar", () => {
      renderPlayer();
      playAudio(STATION, "Groove Salad");

      failWith(2);

      expect(screen.getByTestId("audio-mini-player-error")).toHaveTextContent(
        audioFailureLabel("network"),
      );
    });

    it("says which failure it was — a codec is not a dropped connection", () => {
      // The distinction the operator acts on: a lost connection is worth
      // pressing play for, a source this browser cannot decode never will be.
      // Kohina on iOS < 18.4 is the second kind, permanently.
      renderPlayer();
      playAudio(STATION, "Groove Salad");

      failWith(4);

      const said = screen.getByTestId("audio-mini-player-error");
      expect(said).toHaveTextContent(audioFailureLabel("unsupported"));
      expect(said).not.toHaveTextContent(audioFailureLabel("network"));
    });

    it("drops the FILE readout a failed load leaves behind", () => {
      // The measured lie, and the reason the failure REPLACES the readout
      // instead of sitting beside it: with no metadata `duration` is a finite
      // 0, so the bar would otherwise draw a scrubber and a `0:00 / 0:00`
      // clock over a source that produced no audio at all.
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      expect(screen.getByTestId("audio-mini-player-seek")).toBeInTheDocument();

      failWith(4);

      expect(screen.queryByTestId("audio-mini-player-seek")).toBeNull();
      expect(screen.queryByTestId("audio-mini-player-time")).toBeNull();
      expect(screen.getByTestId("audio-mini-player-error")).toBeInTheDocument();
    });

    it("keeps share on a file it could not decode — that IS the remedy", () => {
      // The one piece of chrome a failure must NOT take, and the reason the
      // control was lifted out of the readout's <Show>: an upload this browser
      // cannot decode is exactly the upload the operator wants to hand to
      // something that can. It is not a claim about playback — it is what to
      // do about the notice beside it. (A download until issue 2501.)
      stubWebShare(sheetCloses);
      renderPlayer();
      playAudio(UPLOAD, null);

      failWith(4);

      expect(screen.getByTestId("audio-mini-player-share")).toBeInTheDocument();
      expect(screen.getByTestId("audio-mini-player-error")).toBeInTheDocument();
    });

    it("a failed LIVE source still has no share — #682's gate is untouched", () => {
      // The gate stays `live()`, so a stream that had stated its length keeps
      // offering no file it could never finish fetching. What this does NOT
      // fix, and what is unchanged from before this issue: a stream that
      // failed BEFORE metadata reads `duration = 0`, which is finite, so it is
      // not live as far as this predicate can see.
      stubWebShare(sheetCloses);
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      metadataArrives(Number.POSITIVE_INFINITY);

      failWith(2);

      expect(screen.queryByTestId("audio-mini-player-share")).toBeNull();
    });

    it("drops the LIVE chrome too, when metadata had arrived before the drop", () => {
      // The other arm of the same <Show>. A stream that played and then died
      // keeps `duration = Infinity`, so it wears the live badge and an elapsed
      // counter that has stopped counting — a clock that says the stream is
      // still on.
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      metadataArrives(Number.POSITIVE_INFINITY);
      expect(screen.getByTestId("audio-mini-player-live")).toBeInTheDocument();

      failWith(2);

      expect(screen.queryByTestId("audio-mini-player-live")).toBeNull();
      expect(screen.queryByTestId("audio-mini-player-time")).toBeNull();
      expect(screen.getByTestId("audio-mini-player-error")).toBeInTheDocument();
    });

    it("keeps naming the source — the failure is ABOUT something", () => {
      // The label survives on purpose. "connection lost" with nothing beside it
      // does not tell the operator which station to re-pick.
      renderPlayer();
      playAudio(STATION, "Groove Salad");

      failWith(2);

      expect(screen.getByTestId("audio-mini-player-label")).toHaveTextContent("Groove Salad");
    });

    it("takes the now-playing track off the row — the loudest of the lies", async () => {
      // A live-updating track name is the single thing that makes a dead
      // station look like a playing one, and the feed keeps answering: it polls
      // `tunedStation()`, which is derived from the SOURCE and knows nothing
      // about whether the element decoded it.
      const TRACK = "Trestal — A Land Unknown";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ songs: [{ title: "A Land Unknown", artist: "Trestal" }] }),
        } as unknown as Response),
      );
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      // #1701's barrier, for its reason: keyed on the STUBBED TEXT, so it
      // cannot return on whichever answer happened to land first.
      await vi.waitFor(() =>
        expect(screen.getByTestId("audio-mini-player-track")).toHaveTextContent(TRACK),
      );

      failWith(4);

      expect(screen.queryByTestId("audio-mini-player-track")).toBeNull();
      expect(screen.getByTestId("audio-mini-player-error")).toBeInTheDocument();
    });

    // The family defect, pinned for the third time. #1697 (`hidden`) and #1734
    // (`resumePoint`) each proved that a field added to `AudioPlayerState`
    // re-fires `on(activeAudio, …)`, whose body assigns `audioEl.src` — and a
    // re-assignment re-invokes the media load algorithm even at an unchanged
    // URL. Here that would mean the error handler RESTARTING the source, which
    // for a codec failure is an infinite retry loop nobody asked for.
    it("reporting the failure does not re-tune the source", () => {
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      playSpy.mockClear();
      loadSpy.mockClear();

      failWith(4);

      expect(playSpy).not.toHaveBeenCalled();
      expect(loadSpy).not.toHaveBeenCalled();
      expect(element()).toHaveAttribute("src", STATION);
    });

    it("pressing play clears the notice and goes back for the resource", () => {
      // The retry is #1700's, unchanged — `mustRefetch` still decides to
      // `load()`. What is new is that the notice describes the LAST ATTEMPT, so
      // it must go when a new one starts.
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      failWith(2);

      toggle().click();

      expect(screen.queryByTestId("audio-mini-player-error")).toBeNull();
      expect(loadSpy).toHaveBeenCalled();
      expect(playSpy).toHaveBeenCalled();
    });

    it("a retry that fails again says so again", () => {
      // Without the clear above, the second failure would write the same value
      // to the same signal, nothing would re-render, and the operator would tap
      // play and watch the bar do nothing at all.
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      failWith(4);
      toggle().click();
      expect(screen.queryByTestId("audio-mini-player-error")).toBeNull();

      failWith(4);

      expect(screen.getByTestId("audio-mini-player-error")).toHaveTextContent(
        audioFailureLabel("unsupported"),
      );
    });

    it("tuning something else clears the previous source's failure", () => {
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      failWith(4);

      playAudio(UPLOAD, null);

      expect(screen.queryByTestId("audio-mini-player-error")).toBeNull();
      expect(screen.getByTestId("audio-mini-player-seek")).toBeInTheDocument();
    });

    // #1704 — the SHIP ARGUMENT for Kohina, bound to the row that actually
    // shipped rather than to a URL typed here.
    //
    // Kohina is the table's first Ogg Vorbis row, and per the vendored
    // caniuse-lite iOS Safari does not decode Ogg Vorbis below 17.4 and is
    // partial from 17.4 to 18.3. #1703's standing condition was that such a
    // station must not ship while a stream that fails says nothing — so the
    // condition is discharged by THIS behaviour, and if it ever regresses the
    // row should come out of the table. A test tied to a hand-typed URL would
    // keep passing after the row was renamed or dropped; this one reads the
    // table.
    it("names the failure for the curated Ogg station, whose population needs it", async () => {
      const { RADIO_STATIONS } = await import("../lib/radioStations");
      const ogg = RADIO_STATIONS.find((s) => s.streamUrl.endsWith(".ogg"));
      if (ogg === undefined) throw new Error("the table no longer carries an ogg station");

      renderPlayer();
      playAudio(ogg.streamUrl, ogg.title);

      failWith(4);

      expect(screen.getByTestId("audio-mini-player-error")).toHaveTextContent(
        audioFailureLabel("unsupported"),
      );
      expect(screen.getByTestId("audio-mini-player-label")).toHaveTextContent(ogg.title);
      // And it is not wearing the file chrome the measurement found: no
      // scrubber over a stream that produced nothing.
      expect(screen.queryByTestId("audio-mini-player-seek")).toBeNull();
    });

    it("still reads ▶, and pressing it is still the retry", () => {
      // Deliberately unchanged. The toggle was never the lie — it says "not
      // playing", which is true, and #1700 already made pressing it re-fetch.
      // What was missing was the operator knowing there was something to retry,
      // and that is the span above, not a fourth glyph.
      renderPlayer();
      playAudio(STATION, "Groove Salad");
      element().dispatchEvent(new Event("play"));

      failWith(2);

      expect(toggle()).toHaveAttribute("aria-label", "play");
    });
  });
});
