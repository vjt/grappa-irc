import { type Component, Show } from "solid-js";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";
import { addQuoteCommand, addQuoteToCompose } from "./lib/addQuote";
import {
  closeMessageMenu,
  copyMessageRow,
  messageMenu,
  selectMessageText,
} from "./lib/messageMenu";
import { banMenuItems } from "./lib/opsMenu";
import { replyQuote, replyToMessage } from "./lib/replyQuote";

// #1067 — the long-press menu on a scrollback message: Copy / Reply / Select…
//
// It replaces #366's programmatic whole-row select-all as the long-press
// affordance. Copy is what an operator pressing-and-holding actually wanted
// (#366's own stated goal, "grab this whole message"), Select… is the escape
// hatch back to a real adjustable native selection, and Reply is the new verb
// — kept here as well as on the swipe because the menu is the DISCOVERABLE
// door and it costs nothing to offer both.
//
// Reads the open state straight off the store, so the mount site only has to
// render `<MessageContextMenu />` once. The chrome is `ContextMenu`, shared
// with the nick menu.

const MessageContextMenu: Component = () => {
  const items = (target: NonNullable<ReturnType<typeof messageMenu>>): ContextMenuItem[] => [
    {
      label: "Copy",
      // Always available: even a presence row is worth copying.
      enabled: true,
      action: () => void copyMessageRow(target.row),
    },
    {
      label: "Reply",
      // Disabled-but-visible on a row with nothing to quote (a join, a part) —
      // the same posture the nick menu takes for an un-permitted mode change,
      // so the menu's shape does not jump between rows.
      enabled: replyQuote(target.msg) !== null,
      action: () => replyToMessage(target.msg, target.networkSlug, target.channelName),
    },
    {
      // #1107 — the bot command, spelled the way it goes on the wire so there
      // is nothing to learn from the label. Next to Reply because it is the
      // other quoting verb, and before Select… because that one is the escape
      // hatch out of the menu entirely.
      label: "!addquote",
      // Same disabled-but-visible posture as Reply, and the same predicate
      // underneath (`quotableBody`) — a row Reply refuses has nothing for a
      // quote database either.
      enabled: addQuoteCommand(target.msg) !== null,
      action: () => addQuoteToCompose(target.msg, target.networkSlug, target.channelName),
    },
    {
      label: "Select…",
      enabled: true,
      action: () => selectMessageText(target.row),
    },
    // issue 2346 — on a join/part/quit row, the ban rows for the person it is
    // about, after Select… so the row verbs above keep their places. The same
    // builder as the nick menu: one mask, one gate, two doors.
    ...(target.ban === null ? [] : banMenuItems(target.ban)),
  ];

  return (
    <Show when={messageMenu()}>
      {(target) => (
        <ContextMenu
          items={items(target())}
          position={target().at}
          onClose={() => closeMessageMenu()}
        />
      )}
    </Show>
  );
};

export default MessageContextMenu;
