import { createEffect, createRoot, createSignal, on } from "solid-js";
import { token } from "./auth";
import type { ChannelKey } from "./channelKey";

// CP15 B5: cic mirror of the server-side per-(network, channel) window
// state machine. The server splits state across three maps so each
// concern is reactive on its own (lib/grappa/session/server.ex):
//
//   * window_states         : %{channel => :pending | :joined | :failed | :kicked | :parked}
//   * window_failure_reasons: %{channel => String.t()}
//   * window_failure_numerics: %{channel => pos_integer()}
//   * window_kicked_meta    : %{channel => %{by, reason}}
//
// Cic mirrors that split — three signal maps with one signal per
// concern — so a render branch reading "is it failed AND show the
// reason" only re-runs when the failure metadata changes, not when an
// unrelated channel transitions to :joined.
//
// `:parted` is intentionally absent from the broadcast surface — its
// projection is "key removed from windowStateByChannel" (the archive
// section in Sidebar derives from `scrollback present + state absent`).
// `setParted` clears all three maps for the key so a re-join + re-fail
// cycle starts from a fresh slate.
//
// Identity-rotation cleanup mirrors `members.ts` / `scrollback.ts`:
// on token rotation/logout, all three maps are emptied so a new
// bearer doesn't see the prior tenant's window states.

export type WindowState = "pending" | "joined" | "failed" | "kicked" | "parked";

export type WindowFailure = {
  reason: string | null;
  numeric: number;
};

export type WindowKickedMeta = {
  by: string | null;
  reason: string | null;
};

const exports_ = createRoot(() => {
  const [windowStateByChannel, setWindowStateByChannel] = createSignal<
    Record<ChannelKey, WindowState>
  >({});
  const [windowFailureByChannel, setWindowFailureByChannel] = createSignal<
    Record<ChannelKey, WindowFailure>
  >({});
  const [windowKickedMetaByChannel, setWindowKickedMetaByChannel] = createSignal<
    Record<ChannelKey, WindowKickedMeta>
  >({});

  // Identity-transition cleanup. Same shape as scrollback.ts /
  // members.ts: prev != null filters BOTH the initial run
  // (prev === undefined) and the cold-start login (prev === null);
  // only logout (prev = "tokA", t = null) and rotation (prev = "tokA",
  // t = "tokB") clear the maps.
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        setWindowStateByChannel({});
        setWindowFailureByChannel({});
        setWindowKickedMetaByChannel({});
      }
    }),
  );

  const setPending = (key: ChannelKey): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "pending" }));
  };

  const setJoined = (key: ChannelKey): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "joined" }));
    // Joining wipes any prior :failed / :kicked snapshot mirrors —
    // mirrors apply_effects([{:joined, channel} | rest], state) on
    // the server. A successful re-join must not leave stale
    // by/reason/numeric in the maps; the next render reads "joined"
    // and looks up failure metadata that should no longer exist.
    setWindowFailureByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    setWindowKickedMetaByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };

  const setFailed = (key: ChannelKey, reason: string | null, numeric: number): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "failed" }));
    setWindowFailureByChannel((prev) => ({ ...prev, [key]: { reason, numeric } }));
  };

  const setKicked = (key: ChannelKey, by: string | null, reason: string | null): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "kicked" }));
    setWindowKickedMetaByChannel((prev) => ({ ...prev, [key]: { by, reason } }));
  };

  const setParted = (key: ChannelKey): void => {
    // Absence is the projection — drop the entry from all three maps.
    // Idempotent: parting an unknown key is a no-op.
    setWindowStateByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    setWindowFailureByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    setWindowKickedMetaByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };

  return {
    windowStateByChannel,
    windowFailureByChannel,
    windowKickedMetaByChannel,
    setPending,
    setJoined,
    setFailed,
    setKicked,
    setParted,
  };
});

export const windowStateByChannel = exports_.windowStateByChannel;
export const windowFailureByChannel = exports_.windowFailureByChannel;
export const windowKickedMetaByChannel = exports_.windowKickedMetaByChannel;
export const setPending = exports_.setPending;
export const setJoined = exports_.setJoined;
export const setFailed = exports_.setFailed;
export const setKicked = exports_.setKicked;
export const setParted = exports_.setParted;
