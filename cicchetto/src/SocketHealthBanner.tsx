import { type Component, Show } from "solid-js";
import { classifyFailure, shouldShowBanner, socketHealth } from "./lib/socketHealth";

// SocketHealthBanner — sticky top banner shown when the Phoenix
// WebSocket fails to open ERROR_THRESHOLD consecutive times without
// a successful connect.
//
// Two arms:
//   * `origin_rejected` — close code 1006 (abnormal, no server reason
//     reachable) is by far most often the server's `check_origin`
//     allowlist rejecting the browser's Origin header. We can't
//     positively confirm without server log access, so the message is
//     phrased as "most likely cause" with the operator-actionable
//     hint.
//   * `generic` — surface raw close code + any reason string the
//     browser exposed, for everything else.
//
// Auto-dismiss is structural: the parent Show binds to
// shouldShowBanner(); a successful onOpen resets errorCount to 0
// so the banner unmounts on the next render tick.

const SocketHealthBanner: Component = () => {
  return (
    <Show when={shouldShowBanner()}>
      <div class="socket-health-banner" role="alert">
        <strong>WebSocket connection failing</strong>
        <Show
          when={classifyFailure() === "origin_rejected"}
          fallback={
            <span>
              {" — close code "}
              {socketHealth().lastCloseCode ?? "unknown"}
              <Show when={socketHealth().lastCloseReason !== ""}>
                {": "}
                {socketHealth().lastCloseReason}
              </Show>
              {" ("}
              {socketHealth().errorCount}
              {" consecutive errors)."}
            </span>
          }
        >
          <span>
            {" — your browser origin "}
            <code>{socketHealth().browserOrigin}</code>
            {
              " is most likely not in the server's allowed-origin list. Try accessing the app via its configured hostname (the one shown in the server's PHX_HOST setting), or ask the operator to add this origin to the check_origin allowlist."
            }
          </span>
        </Show>
      </div>
    </Show>
  );
};

export default SocketHealthBanner;
