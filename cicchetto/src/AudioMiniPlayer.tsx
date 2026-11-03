import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { audioDock } from "./AudioDock";
import {
  activeAudio,
  audioFailureLabel,
  clearPlaybackFailure,
  closeAudio,
  hidePlayer,
  playbackFailure,
  playerHidden,
  rememberResumePoint,
  reportAudioShareFailure,
  reportPlaybackFailure,
  resumePoint,
} from "./lib/audioPlayer";
import { errorMessage } from "./lib/friendlyApiError";
import {
  applyMediaSession,
  mediaSessionMetadata,
  setMediaSessionHandlers,
  setMediaSessionPlaybackState,
} from "./lib/mediaSession";
import { createMediaSharer, type MediaSharer } from "./lib/mediaShare";
import { nowPlayingLabel } from "./lib/nowPlaying";
import { canNativeShare } from "./lib/platform";

// Docked audio mini-player (GH #115) — a slim transport bar pinned BELOW
// the compose box (#1701: between it and the mobile bottom bar; it used to
// sit above compose). Non-modal: scrollback stays scrollable + readable
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
//
// #1896 — and the component itself is now mounted unconditionally too, ONCE,
// above Shell's `<Show when={isMobile()}>`. That branch is a JSX split and not
// a CSS one, so a phone crossing 768px on rotation used to destroy the subtree
// holding this element and build a fresh one in the other regime — a new
// `<audio>`, a first-tune effect, and for a stream a new HTTP connection. The
// element does not move any more; the CHROME travels instead, portalled into
// whichever `<AudioDock />` is live (see that module for the whole argument).
// The bar is therefore rendered only when a dock exists, which is exactly the
// window kinds that have a compose column to dock to.
//
// #682 — LIVE mode. This bar was written for a FILE, and an internet-radio
// station is not one: an Icecast stream has no end, so a position slider and
// a "cur / dur" read are both meaningless against it. Live mode is DERIVED
// from the element's own `duration` (see `live` below) rather than flagged by
// the caller — so it is correct for ANY endless source, not just the radio
// stations that motivated it, and it cannot drift from the element's truth.
// It is the general rule, not the incident.
//
// #1697 — HIDING. The bar was permanent once a source was tuned: the only way
// off the screen was the ✕, which STOPS. Hiding is now a second control and a
// second signal (`playerHidden`), and the mechanism costs nothing because the
// element is ALREADY mounted outside the <Show> below — the unconditional mount
// documented just above, put there for the ref-assignment race, is exactly what
// makes "hide while it keeps playing" free. Narrowing the <Show> predicate
// cannot reach the element.
//
// Two shapes this must NOT become, both of which break playback:
//   * hiding by unmounting this component from Shell — that destroys the
//     element;
//   * carrying the hidden flag inside `activeAudio` — that re-fires the effect
//     below, which reassigns `.src` and re-buffers a live stream.
//
// The door back is in `RailActions`, not here: a restore handle left in this
// slot would still have to clear the 44px tap floor, so it would give back
// almost none of the vertical space that motivated hiding.
//
// #1701 — what unmounting ACTUALLY did, measured, because the first bullet
// above used to end "(which is why leaving chat for home already stops
// playback)" and that was not what happened. The source is MODULE state
// (`lib/audioPlayer.ts`) and outlives the component, so leaving a scrollback
// window for home / list / mentions / admin destroyed the element — and coming
// back RE-MOUNTED it: the `on(activeAudio, …)` effect below ran on its first
// execution, reassigned `.src` and called `play()`. The semantics were
// kill-and-re-tune, not stop. A station re-buffered (#1700's `mustRefetch` says
// re-tuning IS the correct resume for one), and an UPLOAD restarted from the
// beginning, unasked — "a defect in its own right and not this file's to fix",
// as this paragraph used to close.
//
// #1896 CLOSED IT, and not as a bonus: the hoist that stops a ROTATION tearing
// the element down necessarily lifts the component above the `<Switch>` too,
// because the regime `<Show>` encloses it. There is one arithmetic here, not
// two decisions — you cannot mount above the branch and remain inside the
// window-kind Match. So a window switch no longer touches the element at all;
// what changes is only whether a DOCK exists to portal the chrome into. On
// home / list / mentions the audio keeps playing with no bar on screen, which
// is the state #1697 already ships deliberately (`playerHidden`), and the doors
// out of it are the same ones: `RailRadio` + `RailActions` live in
// `.shell-members`, OUTSIDE the `<Switch>`, so stop and un-hide are reachable
// on every window kind in both regimes.
//
// Where "stop" genuinely lives, and neither of the two depends on where this
// component is mounted: `closeAudio` (the ✕ — it clears the source, and the
// effect below pauses and detaches on null), and the `identityScopedStore`
// wrapper around the store, whose `onIdentityChange` nulls the same signal.
// That second one is what keeps a logout or a token rotation from playing the
// previous identity's audio over the new identity's shell.

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

  // #1734 — a position waiting for the element to know its own length.
  // `currentTime` written next to `.src` is dropped by a real browser: the
  // seekable range does not exist until metadata arrives, which is why this
  // is applied from `onLoadedMetadata` below and not two lines after the
  // assignment. Always cleared at the top of the effect, so a source that
  // changes mid-flight cannot land the previous one's position.
  let pendingSeek: number | null = null;

  // Point the element at the active href + autoplay on open; on close,
  // stop + detach the source so a closed player holds no buffered audio.
  createEffect(
    on(activeAudio, (a) => {
      if (audioEl === undefined) return;
      pendingSeek = null;
      if (a === null) {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load();
        setCurrent(0);
        setDuration(0);
        return;
      }

      // #1734 — this effect's FIRST execution cannot tell a new source from a
      // re-mount: the source is module state and outlives the component, so
      // leaving a scrollback window for home / list / mentions / admin and
      // coming back re-runs exactly this code. A remembered point is the
      // difference, and there is one only after a destruction.
      //
      // Restoring `duration` FIRST is load-bearing and is why no second
      // predicate was added: `mustRefetch` asks `live()`, which reads the
      // `duration` signal — recreated at a finite 0 on a fresh element. Left
      // at 0 the predicate answers "no re-fetch" for a stream as well, which
      // is both the wrong resume AND, measured, a seek slider drawn across an
      // endless source. Fed the remembered length it answers correctly for
      // both, exactly as it does everywhere else.
      const resume = resumePoint();
      setCurrent(resume?.position ?? 0);
      setDuration(resume?.duration ?? 0);

      audioEl.src = a.href;

      if (resume !== null && !mustRefetch(audioEl)) {
        // A healthy FILE: come back where it was, and preserve the transport
        // rather than pick one. The operator changed window; they did not ask
        // for a stop, and they did not ask for a start either.
        pendingSeek = resume.position;
        if (resume.playing) void audioEl.play().catch(() => {});
        return;
      }

      // Everything else — a first tune, or a stream, whose correct resume IS
      // re-tuning (#1700). Unchanged.
      //
      // Autoplay may be blocked (no user gesture / iOS policy); the user
      // taps play in that case — swallow the rejection, don't surface it.
      void audioEl.play().catch(() => {});
    }),
  );

  // #1734 — the element is about to be destroyed; the transport's position is
  // about to go with it. One write, at the only instant that has the fact.
  //
  // #1896 narrowed WHEN that happens without changing what it must do. The
  // component no longer dies on a window switch or a rotation, so the last
  // destruction in a session is Shell's own teardown (logout / identity
  // change). Kept, and kept correct: a destruction that still happens is
  // exactly the one this was written for, and the effect above still cannot
  // tell a first tune from a re-mount without it.
  onCleanup(() => {
    if (audioEl === undefined || activeAudio() === null) return;
    rememberResumePoint({
      position: audioEl.currentTime,
      duration: audioEl.duration,
      playing: playing(),
    });
  });

  // Endless source? `duration` starts at 0 — a FINITE number, so a source
  // whose metadata has not arrived yet keeps today's file chrome and does not
  // flash a "live" badge at every upload. Only `onLoadedMetadata` writes it
  // again, and at that point the element is stating what it knows:
  //   * a file    → a finite length  → scrubbable
  //   * a stream  → Infinity         → not scrubbable
  //   * unknown   → NaN              → not scrubbable either, and the reason
  //                                    is the same one, so the predicate is
  //                                    "not a finite number" rather than
  //                                    "=== Infinity".
  const live = (): boolean => !Number.isFinite(duration());

  // #1700 — can this element continue from where it is, or must the resource
  // be fetched again? Two disjoint reasons, and note that neither of them is
  // "was it interrupted":
  //   * `error` — the media resource is gone. There is nothing to continue.
  //   * live    — there is no POSITION to continue TO. `currentTime` on an
  //               endless source is elapsed-since-tune-in, not a place in a
  //               work, so resuming in place returns to buffered audio and
  //               stays exactly that far behind live from then on. Re-tuning
  //               IS the correct resume for a stream; it is not a sacrifice
  //               made to fix something else.
  // A healthy paused FILE matches neither and keeps resuming at its position,
  // which is the whole point of pausing one.
  const mustRefetch = (el: HTMLAudioElement): boolean => el.error !== null || live();

  // #1702 split these two out of `togglePlay`. A lock screen does not send a
  // toggle — it sends `play` and `pause` as distinct actions, and handing it a
  // toggle would PAUSE on a `play` that arrives while the stream is already on
  // (the OS re-asserts intent freely). So the verbs are the primitive and the
  // toggle is built from them, rather than the toggle being the only door.
  const pauseNow = (): void => {
    if (audioEl === undefined) return;
    audioEl.pause();
  };

  const playNow = (): void => {
    if (audioEl === undefined) return;
    // #1744 — a new attempt invalidates the verdict on the last one, and the
    // clear is what makes a REPEATED failure visible: the same reason written
    // to the same signal changes nothing, so without this the operator presses
    // play on a source that cannot play and the bar sits there unchanged.
    // It deliberately does NOT touch `el.error`, which stays set until the
    // fetch below lands — that property is `mustRefetch`'s, not the surface's.
    clearPlaybackFailure();
    // `play()` re-runs resource selection only from NETWORK_EMPTY, which is not
    // where a dropped stream lands; `load()` runs it unconditionally. The other
    // `load()` in this file DETACHES a source on close — same call, opposite
    // intent, and until now the only one.
    if (mustRefetch(audioEl)) audioEl.load();
    void audioEl.play().catch(() => {});
  };

  const togglePlay = (): void => {
    // #1700 — branch on `playing()`, NOT on `audioEl.paused`. The glyph and the
    // accessible name below read from this signal, and a control must act on
    // the fact it DISPLAYS: after a failed fetch the element is still not
    // `paused` while the transport already shows ▶, so reading the element here
    // pauses at the moment the operator pressed play. One fact, one control.
    if (playing()) pauseNow();
    else playNow();
  };

  // #1702 — tell the OS what is playing. Until this, an iOS lock screen showed
  // "Cicchetto" and nothing else: nothing ever set `navigator.mediaSession`.
  //
  // THREE effects rather than one, because they track three different facts
  // and folding them would re-run all three whenever any one moved — which for
  // the handlers means re-registering them on every track change, and for the
  // metadata means rebuilding a `MediaMetadata` on every play/pause.
  //
  // The projection itself lives in `lib/mediaSession.ts`; what belongs HERE is
  // only what needs the element. That is why the handlers are wired in this
  // file and not in the lib: they must drive the SAME element the in-app bar
  // drives, or the lock screen and the transport end up as two controls over
  // one stream, disagreeing.
  createEffect(() => {
    applyMediaSession(mediaSessionMetadata());
  });

  createEffect(() => {
    // Cleared with the source: a lock screen still holding handlers for a
    // stopped player would send actions to an element with no `src`.
    setMediaSessionHandlers(activeAudio() === null ? null : { play: playNow, pause: pauseNow });
  });

  createEffect(() => {
    // Mirrored from `playing()` — the same signal the glyph reads, for the same
    // reason #1700 gives: the OS must show the state the operator is being
    // shown, not one it inferred from the audio pipeline.
    if (activeAudio() === null) setMediaSessionPlaybackState("none");
    else setMediaSessionPlaybackState(playing() ? "playing" : "paused");
  });

  const onSeek = (e: { currentTarget: HTMLInputElement }): void => {
    if (audioEl === undefined) return;
    audioEl.currentTime = Number(e.currentTarget.value);
  };

  // issue 2501 — share, where the ⬇ download was: vjt's ruling, the media
  // viewer's flow (lib/mediaShare.ts) at a second door. The viewer builds its
  // sharer per open; this component outlives every source it plays, so it
  // builds one per SOURCE, with the controller that aborts its fetch. Closing
  // the bar or tuning another source mid-fetch therefore opens no sheet for a
  // track that is gone, and a file refused on one track is forgotten with it.
  // A failure is told in a toast; the bar has no line to say it on.
  let sourceShare: { share: MediaSharer; abort: AbortController } | null = null;
  createEffect(
    on(activeAudio, (source) => {
      sourceShare?.abort.abort();
      if (source === null) {
        sourceShare = null;
        return;
      }
      const abort = new AbortController();
      sourceShare = {
        abort,
        share: createMediaSharer(source.href, window.location.origin, abort.signal, errorMessage),
      };
    }),
  );
  onCleanup(() => {
    sourceShare?.abort.abort();
  });
  const shareSource = async (): Promise<void> => {
    const attempt = sourceShare?.share();
    if (attempt === undefined || attempt === "busy") return;
    const failure = await attempt;
    if (failure !== null) reportAudioShareFailure(failure);
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
        /* #1700 — a failure that is never observed can never be recovered
           from, and an unobserved one here also made the bar LIE: a stream
           that dies without firing `pause` left this signal true, so the
           button kept showing ⏸ over silence and the transport looked like it
           had worked.
           `stalled` and `waiting` are deliberately NOT wired. They are
           recoverable buffering, not a stop, and clearing the state on them
           would flip the button to ▶ over audio that is still coming — the
           same lie in the other direction. `error` is the terminal one, so
           `error` is the one listened to.
           #1744 — and it is now REPORTED, not only absorbed. Clearing the
           transport was half the answer: it stopped the bar claiming to play
           and left it looking like a station the operator had PAUSED. The
           element's own `error` goes to the store, which classifies it once
           (`reportPlaybackFailure`); every surface reads the reason from
           there. */
        onError={() => {
          setPlaying(false);
          reportPlaybackFailure(audioEl?.error ?? null);
        }}
        onTimeUpdate={() => setCurrent(audioEl?.currentTime ?? 0)}
        onLoadedMetadata={() => {
          setDuration(audioEl?.duration ?? 0);
          // #1734 — the element now has a seekable range, so the position
          // remembered from the last destruction can finally be applied. The
          // browser clamps it to the real length, so a source that turned out
          // shorter lands at its end rather than nowhere.
          if (pendingSeek !== null && audioEl !== undefined) {
            audioEl.currentTime = pendingSeek;
            setCurrent(audioEl.currentTime);
            pendingSeek = null;
          }
        }}
      />
      {/* #1896 — the chrome goes to the DOCK, the element stays here.
          Gated on a dock EXISTING rather than letting Portal fall back to
          `document.body`: a bar appended to the end of the document would be
          unstyled and unplaceable, and "no dock" is a real state (home / list /
          mentions render no compose column). The container Portal creates is
          classed through its `ref` so the stylesheet can take both wrappers out
          of layout — see `.audio-dock` in default.css. */}
      <Show when={audioDock()}>
        {(dock) => (
          <Portal
            mount={dock()}
            ref={(container: HTMLDivElement) => {
              container.className = "audio-dock-portal";
            }}
          >
            <Show when={activeAudio() !== null && !playerHidden()}>
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
                {/* #682 — the source's name, when it has one. An upload passes
              null and this renders nothing; a radio station passes its title,
              which on mobile is the ONLY place naming it (the rail that holds
              the station chrome is a drawer slid off-screen while playing). */}
                <Show when={activeAudio()?.label}>
                  {(label) => (
                    <span class="audio-mini-player-label" data-testid="audio-mini-player-label">
                      {label()}
                    </span>
                  )}
                </Show>
                {/* #1744 — THE NOTICE TAKES THE TRACK'S SLOT. The feed polls
              `tunedStation()`, which is derived from the SOURCE and knows
              nothing about whether the element decoded it — so a live-updating
              track name keeps scrolling over silence, which is the single
              loudest way a dead station looks like a playing one. The row is
              also one row: on a phone it IS the player, so the notice takes a
              slot rather than adding one.
              The LABEL above deliberately stays. "connection lost" with nothing
              beside it does not tell the operator which station to re-pick. */}
                <Show
                  when={playbackFailure()}
                  fallback={
                    /* #1698 — what the station is playing, on the surface a phone can
                 actually see. The rail carries the same fact, and on mobile the
                 rail is `translateX(100%)` off-screen while the station plays —
                 the identical argument that put the label above here in #682,
                 one field further. Absent for an upload, which has no feed, and
                 absent for a station whose feed has gone quiet: the store's
                 `nowPlayingLabel` is null on every arm but `playing`, so the
                 stale rule reaches this row without this row knowing about it. */
                    <Show when={nowPlayingLabel()}>
                      {(track) => (
                        <span class="audio-mini-player-track" data-testid="audio-mini-player-track">
                          {track()}
                        </span>
                      )}
                    </Show>
                  }
                >
                  {(failure) => (
                    /* `role="status"`: this appears without the operator having done
                 anything, so an assistive technology must be able to learn
                 about it without polling the bar. */
                    <span
                      class="audio-mini-player-error"
                      data-testid="audio-mini-player-error"
                      role="status"
                    >
                      {`⚠ ${audioFailureLabel(failure())}`}
                    </span>
                  )}
                </Show>
                {/* THE READOUT, and #1744 gives it a third arm: NONE.
              Measured on a source the browser refuses (MediaError code 4):
              `loadedmetadata` never arrives, so `duration` stays at a finite 0,
              so `live()` answers false and this row drew the FILE readout over
              a dead endless stream — a scrubber at `max="0"` and a `0:00 /
              0:00` clock. Both are statements about a resource that does not
              exist, and the live arm is no better: an elapsed counter frozen at
              a "live" badge says the stream is still on. A failed source has no
              readout, so it is given none. */}
                <Show when={playbackFailure() === null}>
                  <Show
                    when={!live()}
                    fallback={
                      <>
                        <span class="audio-mini-player-live" data-testid="audio-mini-player-live">
                          live
                        </span>
                        {/* Elapsed since tune-in, NOT a position: there is no total
                      to divide it by, so it is shown alone rather than as one
                      half of a "cur / dur" pair with a hollow denominator. */}
                        <span class="audio-mini-player-time" data-testid="audio-mini-player-time">
                          {formatTime(current())}
                        </span>
                      </>
                    }
                  >
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
                  </Show>
                </Show>
                {/* issue 2501 — SHARE, where a same-origin `download=""` anchor
              was: the anchor the media viewer's download copied. The viewer's
              opened a preview an iOS PWA could not be left from (reported);
              this one very likely did too (not verified on a device). vjt
              ruled share at both doors.
              The FILE where the platform takes it, the link otherwise (see
              lib/mediaShare.ts); only where the Web Share API exists, the one
              feature-detect every share door uses. Where it does not (desktop
              Firefox, Linux Chromium) the bar offers no save at all, which
              also takes #1744's remedy below away there: a track that browser
              cannot decode can only be saved from the scrollback link.
              #682 — gated OFF for a live source, kept from the download: a
              source with no end is no file to hand over.
              #1744 — LIFTED OUT of the file readout above, and it is the one
              piece of chrome a failure does NOT take away. The two were one
              <Show> only because they share a predicate, and that merge made
              this case unsayable: an upload the browser cannot DECODE is
              exactly the upload the operator wants to hand to something that
              can. This control is not a claim about playback — it is the
              remedy for the notice standing beside it.
              ⚠️ Still gated on `live()` and therefore still loose in one
              corner: a STREAM that failed before metadata has a finite
              `duration` of 0, so it is not live as far as this predicate can
              tell, and share renders on an endless href. On a cross-origin
              stream (the curated stations are) that shares the link and
              fetches nothing; the anchor used to navigate the operator out of
              the app there instead. */}
                <Show when={!live() && canNativeShare()}>
                  <button
                    type="button"
                    class="audio-mini-player-share"
                    data-testid="audio-mini-player-share"
                    onClick={() => void shareSource()}
                    aria-label="share"
                  >
                    ⤴
                  </button>
                </Show>
                {/* #1697 — HIDE, beside the ✕ and never merged with it. The ✕ is the
              STOP verb, and on a phone it is the only reachable one while the
              rail that holds the station chrome is slid off-screen; collapsing
              the two would cost the operator the ability to stop. The glyph is
              a chevron down (the surface leaves downward, past the compose
              box), and the accessible name says what survives the gesture. */}
                <button
                  type="button"
                  class="audio-mini-player-hide"
                  data-testid="audio-mini-player-hide"
                  onClick={hidePlayer}
                  aria-label="hide player, keep playing"
                >
                  ⌄
                </button>
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
          </Portal>
        )}
      </Show>
    </>
  );
};

export default AudioMiniPlayer;
