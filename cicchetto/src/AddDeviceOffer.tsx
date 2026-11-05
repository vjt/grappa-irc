import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { token } from "./lib/auth";
import {
  type CloseReason,
  openChannel,
  openPairing,
  type PairingChannel,
  type Rendezvous,
} from "./lib/e2e/pairing";
import { offeringFromHere } from "./lib/e2e/pairingOffer";
import { errorMessage } from "./lib/friendlyApiError";

// issue 2430, X1 — the holder's side of a pairing: open a rendezvous with the
// caller's ephemeral key (from the ECIES layer), hold its channel while the
// pairing waits, and close it when it leaves the screen. When the rendezvous
// ends it says nothing and tells the caller why; saying so is the caller's
// (AddDevicePanel), which knows what the pairing came to.
//
// Issue 2537: the key rides the open, so grappa offers the rendezvous to the
// account's other devices (lib/e2e/pairingOffer); this tab marks the key as
// its own first, since the offer is pushed back to it too.
//
// Issue 2549: that offer is the ONLY way the pairing travels. This used to
// show the code as a QR, as a link, and with a copy button; a link opens in
// the system browser, not in the installed app, so the identity ended up in
// a browser nobody meant to pair. Here the user is told where to accept it.

type Stage =
  | { tag: "opening" }
  | { tag: "waiting"; rendezvous: Rendezvous }
  | { tag: "failed"; message: string }
  | { tag: "ended" };

const AddDeviceOffer: Component<{
  curve: string;
  onChannel: (channel: PairingChannel) => void;
  onMessage: (payload: string) => void;
  onClosed: (reason: CloseReason) => void;
}> = (props) => {
  const [stage, setStage] = createSignal<Stage>({ tag: "opening" });
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1_000);
  let channel: PairingChannel | null = null;
  let gone = false;

  onMount(async () => {
    const t = token();
    if (t === null) {
      setStage({ tag: "failed", message: "Log in first." });
      return;
    }
    try {
      offeringFromHere(props.curve);
      const rendezvous = await openPairing(t, props.curve);
      channel = openChannel(t, rendezvous, {
        onMessage: props.onMessage,
        onClosed: (reason) => {
          setStage({ tag: "ended" });
          props.onClosed(reason);
        },
      });
      // Left the screen while the open was in flight: the cleanup found no
      // channel to close, so this rendezvous would sit open for its whole TTL.
      if (gone) {
        void channel.close();
        return;
      }
      setStage({ tag: "waiting", rendezvous });
      props.onChannel(channel);
    } catch (err) {
      setStage({ tag: "failed", message: errorMessage(err) });
    }
  });

  onCleanup(() => {
    gone = true;
    clearInterval(tick);
    void channel?.close();
  });

  const countdown = (expiresAt: string): string => {
    const s = Math.max(0, Math.floor((Date.parse(expiresAt) - now()) / 1000));
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
  };

  const waiting = () => {
    const s = stage();
    return s.tag === "waiting" ? s : null;
  };
  const failed = () => {
    const s = stage();
    return s.tag === "failed" ? s : null;
  };

  return (
    <section>
      <Show when={stage().tag === "opening"}>
        <p>Preparing the pairing…</p>
      </Show>
      <Show when={waiting()}>
        {(s) => (
          <>
            <p data-testid="pair-waiting">
              Open grappa on the device you are adding, signed in to this account, and tap "Pair
              this browser" on the banner it shows.
            </p>
            <p>
              Expires in{" "}
              <span data-testid="pair-countdown">{countdown(s().rendezvous.expires_at)}</span>
            </p>
          </>
        )}
      </Show>
      <Show when={failed()}>
        {(s) => (
          <p role="alert" data-testid="pair-failed">
            {s().message}
          </p>
        )}
      </Show>
    </section>
  );
};

export default AddDeviceOffer;
