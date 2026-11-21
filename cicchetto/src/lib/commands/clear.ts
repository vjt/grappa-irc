import { deleteArchiveEntry, getArchiveCount } from "../api";
import { requestConfirm } from "../confirmDialog";
import { selectedChannel } from "../selection";
import { serverProtocol } from "../serverProtocol";
import type { CommandHandler } from "./context";

// issue 2428 — `/clear`: wipe the current window's history, behind a
// confirm modal stating the message count.
//
// Flow: resolve the window ONCE (below), fetch its count, open the #195
// confirm with the count in the body, DELETE on confirm. The modal and the
// DELETE close over the SAME resolved window, so a window switch between
// typing and confirming cannot move the wipe: the window the modal names
// is the window that gets deleted.
//
// The window IS the shell's active window (`selection.selectedChannel`,
// the same store the pane renders and every other context verb reads),
// never re-derived from the name: a channel and a DM are distinguished
// by the store's KIND, not by a sigil sniff (issue 1831). `submittedFrom`
// is deliberately NOT the source here — it names the window the line was
// typed in, and on a submit queued across a window switch that window is
// no longer the one the operator is looking at when the modal opens.
//
// The live window clears on the `:archive_purged` broadcast the DELETE
// emits: `userTopic.ts`'s arm calls `purgeScrollback` on the target key,
// which drops the pane's rows, the load-once gate and the far-behind
// record — and the deleting tab receives its own broadcast, so no local
// clear is done here (scrollback.ts: "No need for a separate REST-204
// client-side hook"). A local purge would only duplicate that path and
// mask a broadcast regression, so this handler performs none.
//
// Encrypted chats are refused: their rows live in the device's own chat
// store, grappa never sees them, so there is no server-side history to
// delete — closing the chat is that window's own delete path.
//
// A count of zero asks nothing: a modal offering to delete zero messages
// is a question with no content, so it answers inline instead.

// The count door arrived with wire protocol 64. Below it the GET falls
// through to the web catch-all and answers 200 text/html (CLIENT_PROTOCOL.md
// §8f) — the narrow would fail on the HTML, so the gate names the cause
// instead of letting the operator read "send failed". `null` (the join
// reply has not landed yet) proceeds: the fetch is the probe then, and its
// failure surfaces inline the same way.
const ARCHIVE_COUNT_PROTOCOL = 64;

// The count spelling is AdminNetworksTab.tsx's (`Delete network and N …`):
// grouped thousands, singular "message" at one.
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export const clearCommand: CommandHandler<"clear"> = async (_cmd, ctx) => {
  const sel = selectedChannel();
  if (sel === null) return { error: "/clear: no window is focused" };
  if (sel.kind === "encrypted") {
    return {
      error:
        "/clear is not available in an encrypted chat — its history lives on this device, not on the server",
    };
  }
  if (sel.kind !== "channel" && sel.kind !== "query" && sel.kind !== "server") {
    return { error: "/clear needs a channel, query or server window" };
  }

  const version = serverProtocol();
  if (version !== null && version < ARCHIVE_COUNT_PROTOCOL) {
    return {
      error: `/clear needs a server speaking wire protocol ${ARCHIVE_COUNT_PROTOCOL} or newer — this one speaks ${version}`,
    };
  }

  const target = sel.channelName;
  // The $server tab is the one window whose stored name is not what the
  // operator calls it: the modal names the window, not the sentinel.
  const display = sel.kind === "server" ? `the server window on ${sel.networkSlug}` : target;
  const { count } = await getArchiveCount(ctx.token, sel.networkSlug, target);
  if (count === 0) return { ok: `/clear: ${display} has no messages to delete` };

  const noun = count === 1 ? "message" : "messages";
  const formatted = COUNT_FORMAT.format(count);
  requestConfirm({
    title: "Clear history",
    body: `Delete ${formatted} ${noun} from ${display}? This cannot be undone.`,
    confirmLabel: "Delete",
    // Detached: `requestConfirm` resolves nothing, so the DELETE cannot be
    // awaited here and its failure cannot surface inline the way the
    // count fetch's does above. Logged with a grep key instead, mirroring
    // the fan-out's detached confirm — and the rows staying put is the
    // visible half of the failure: the purge only arrives on a 204.
    onConfirm: () => {
      void deleteArchiveEntry(ctx.token, sel.networkSlug, target).catch((err) => {
        console.warn(`[/clear] DELETE failed for ${target} on ${sel.networkSlug}:`, err);
      });
    },
    alternative: null,
    attachments: null,
    choice: null,
    toggle: null,
    defaultButton: "cancel",
  });
  return { ok: `/clear: ${formatted} ${noun} in ${display} — confirm to delete` };
};
