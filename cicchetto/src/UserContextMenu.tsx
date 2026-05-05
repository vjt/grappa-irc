import { type Component, createEffect, For, onCleanup } from "solid-js";
import { openQueryWindowState } from "./lib/queryWindows";
import { setSelectedChannel } from "./lib/selection";
import {
  pushChannelBan,
  pushChannelDeop,
  pushChannelDevoice,
  pushChannelKick,
  pushChannelOp,
  pushChannelVoice,
  pushWhois,
} from "./lib/socket";

// Right-click context menu for member-list nicks (spec #3, C5.1).
//
// Renders 8 items: op / deop / voice / devoice / kick / ban (all gated on
// own-nick @ mode, disabled-but-NOT-hidden when unmet) + WHOIS + Query
// (always enabled, no perm required).
//
// Dispatches to existing socket.ts push helpers — no new IRC-issuance path.
// Ban mask uses the `nick!*@*` fallback (WHOIS-cache mask derivation is
// deferred per spec #3 note; see commit body for gap flag).
//
// Positioning: absolute at {x, y} from right-click. No viewport-flip logic
// here — the CSS positions from the backdrop's top-left so coordinates are
// already client-relative. Overflow handling is expected to be addressed in
// browser smoke; jsdom doesn't give real viewport dimensions.
//
// Close: backdrop click OR Escape keydown fires `onClose`.

export type Props = {
  networkSlug: string;
  networkId: number;
  channelName: string;
  targetNick: string;
  ownModes: string[];
  position: { x: number; y: number };
  onClose: () => void;
};

type MenuItem = {
  label: string;
  enabled: boolean;
  action: () => void;
};

const UserContextMenu: Component<Props> = (props) => {
  const isOp = (): boolean => props.ownModes.includes("@");

  const items = (): MenuItem[] => [
    {
      label: "Op",
      enabled: isOp(),
      action: () => pushChannelOp(props.networkId, props.channelName, [props.targetNick]),
    },
    {
      label: "Deop",
      enabled: isOp(),
      action: () => pushChannelDeop(props.networkId, props.channelName, [props.targetNick]),
    },
    {
      label: "Voice",
      enabled: isOp(),
      action: () => pushChannelVoice(props.networkId, props.channelName, [props.targetNick]),
    },
    {
      label: "Devoice",
      enabled: isOp(),
      action: () => pushChannelDevoice(props.networkId, props.channelName, [props.targetNick]),
    },
    {
      label: "Kick",
      // Bare KICK, no reason input prompt in C5.1.
      enabled: isOp(),
      action: () => pushChannelKick(props.networkId, props.channelName, props.targetNick, ""),
    },
    {
      label: "Ban",
      // Fallback mask: nick!*@*. WHOIS-cache mask derivation deferred (spec #3 gap).
      enabled: isOp(),
      action: () => pushChannelBan(props.networkId, props.channelName, `${props.targetNick}!*@*`),
    },
    {
      label: "WHOIS",
      // Always enabled — no perm required.
      enabled: true,
      action: () => pushWhois(props.networkId, props.targetNick),
    },
    {
      label: "Query",
      // Always enabled — no perm required. Opens DM window + switches focus.
      enabled: true,
      action: () => {
        openQueryWindowState(props.networkId, props.targetNick, new Date().toISOString());
        setSelectedChannel({
          networkSlug: props.networkSlug,
          channelName: props.targetNick,
          kind: "query",
        });
      },
    },
  ];

  // Escape key closes the menu.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") props.onClose();
  };

  createEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  const handleItemClick = (item: MenuItem): void => {
    if (!item.enabled) return;
    item.action();
    props.onClose();
  };

  return (
    <>
      {/* Backdrop: click-outside closes the menu. Rendered as button for a11y. */}
      <button
        type="button"
        class="context-menu-backdrop"
        aria-label="Close menu"
        onClick={props.onClose}
      />
      <div
        class="context-menu"
        style={{ position: "fixed", top: `${props.position.y}px`, left: `${props.position.x}px` }}
        role="menu"
      >
        <For each={items()}>
          {(item) => (
            <button
              type="button"
              class="context-menu-item"
              classList={{ "context-menu-item-disabled": !item.enabled }}
              disabled={!item.enabled}
              onClick={() => handleItemClick(item)}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>
    </>
  );
};

export default UserContextMenu;
