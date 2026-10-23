import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { token } from "./lib/auth";
import {
  type CloseReason,
  openChannel,
  openPairing,
  type PairingChannel,
  pairingUrl,
  type Rendezvous,
} from "./lib/e2e/pairing";
import { errorMessage } from "./lib/friendlyApiError";
import { qrSvgWithLabel } from "./lib/qr";

// issue 2430, X1 — the showing side of a pairing: open a rendezvous and show
// its code as a QR for the new device's OS camera, which lands it on `/pair`
// (PairScan). The ephemeral key in the code is the caller's, from the ECIES
// layer; this component only puts it in the code, holds the channel while
// the code is on screen, and closes the rendezvous when it leaves the screen.
// When the rendezvous ends it drops the QR and tells the caller why; saying
// so is the caller's (AddDevicePanel), which knows what the pairing came to.

type Stage =
  | { tag: "opening" }
  | { tag: "showing"; rendezvous: Rendezvous; url: string }
  | { tag: "failed"; message: string }
  | { tag: "ended" };

const AddDeviceQr: Component<{
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
      const rendezvous = await openPairing(t);
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
      setStage({
        tag: "showing",
        rendezvous,
        url: pairingUrl(window.location.origin, { id: rendezvous.id, curve: props.curve }),
      });
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

  const showing = () => {
    const s = stage();
    return s.tag === "showing" ? s : null;
  };
  const failed = () => {
    const s = stage();
    return s.tag === "failed" ? s : null;
  };

  return (
    <section class="add-device-qr">
      <Show when={stage().tag === "opening"}>
        <p>Preparing a pairing code…</p>
      </Show>
      <Show when={showing()}>
        {(s) => (
          <>
            <p>Scan this code with the camera of the device you are adding.</p>
            <div
              class="qr-frame"
              data-testid="pair-qr"
              innerHTML={qrSvgWithLabel(s().url, "pairing QR code")}
            />
            <p class="pair-url" data-testid="pair-url">
              {s().url}
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

export default AddDeviceQr;
