import { type Component, createEffect, createSignal, on, Show } from "solid-js";
import { activeAudio, closeAudio } from "./lib/audioPlayer";

// Docked audio mini-player (GH #115) — a slim transport bar pinned above
// the compose box. Non-modal: scrollback stays scrollable + readable
// while audio plays (CLAUDE.md "IRC stays text only" — audio routes here
// instead of MediaViewerModal). Persistent: switching the active channel
// doesn't kill playback; a new audio link swaps the source on the single
// <audio> element. The store (lib/audioPlayer.ts) holds the active href;
// this component owns the element + transport UI.
//
// The <audio> element is mounted UNCONDITIONALLY (it has no `controls`,
// so it renders nothing visible) and only the chrome is gated by <Show>.
// This keeps the `audioEl` ref assigned before the activeAudio effect
// runs — wrapping the element itself in <Show> would race ref-assignment
// against the effect on the open transition.

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

const AudioMiniPlayer: Component = () => {
  let audioEl: HTMLAudioElement | undefined;
  const [playing, setPlaying] = createSignal(false);
  const [current, setCurrent] = createSignal(0);
  const [duration, setDuration] = createSignal(0);

  // Point the element at the active href + autoplay on open; on close,
  // stop + detach the source so a closed player holds no buffered audio.
  createEffect(
    on(activeAudio, (a) => {
      if (audioEl === undefined) return;
      if (a === null) {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load();
        setCurrent(0);
        setDuration(0);
        return;
      }
      audioEl.src = a.href;
      setCurrent(0);
      setDuration(0);
      // Autoplay may be blocked (no user gesture / iOS policy); the user
      // taps play in that case — swallow the rejection, don't surface it.
      void audioEl.play().catch(() => {});
    }),
  );

  const togglePlay = (): void => {
    if (audioEl === undefined) return;
    if (audioEl.paused) void audioEl.play().catch(() => {});
    else audioEl.pause();
  };

  const onSeek = (e: { currentTarget: HTMLInputElement }): void => {
    if (audioEl === undefined) return;
    audioEl.currentTime = Number(e.currentTarget.value);
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: plays arbitrary user-uploaded
          audio (voice / audio shares, GH #115) — no transcript or caption data
          exists on the wire (the player gets a slug-only href), so a <track>
          would be a hollow no-op element. Captions are N/A by construction. */}
      <audio
        ref={audioEl}
        data-testid="audio-mini-player-el"
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setCurrent(audioEl?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioEl?.duration ?? 0)}
      />
      <Show when={activeAudio() !== null}>
        <div class="audio-mini-player" data-testid="audio-mini-player">
          <button
            type="button"
            class="audio-mini-player-toggle"
            data-testid="audio-mini-player-toggle"
            onClick={togglePlay}
            aria-label={playing() ? "pause" : "play"}
          >
            {playing() ? "⏸" : "▶"}
          </button>
          <input
            type="range"
            class="audio-mini-player-seek"
            data-testid="audio-mini-player-seek"
            min="0"
            max={duration() || 0}
            step="any"
            value={current()}
            onInput={onSeek}
            aria-label="seek"
          />
          <span class="audio-mini-player-time" data-testid="audio-mini-player-time">
            {formatTime(current())} / {formatTime(duration())}
          </span>
          {/* Same-origin download: the `download` attribute forces a save
              (overriding the server's `inline` Content-Disposition) and
              inherits the server-sent filename — cic has no filename on
              the wire (slug only), so no `download` value is set. */}
          <a
            class="audio-mini-player-download"
            data-testid="audio-mini-player-download"
            href={activeAudio()?.href}
            download=""
            aria-label="download"
          >
            ⬇
          </a>
          <button
            type="button"
            class="audio-mini-player-close"
            data-testid="audio-mini-player-close"
            onClick={closeAudio}
            aria-label="close"
          >
            ✕
          </button>
        </div>
      </Show>
    </>
  );
};

export default AudioMiniPlayer;
