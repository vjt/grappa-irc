import { describe, expect, it } from "vitest";
import { channelKey } from "../lib/channelKey";
import { jumpToMessageRequest, requestJumpToMessage } from "../lib/jumpToMessageCommand";

// issue 2333 — the jump-to-message command. The pane serves a request by its
// nonce, so a second tap on the SAME row must still be a new request.
describe("jumpToMessageCommand", () => {
  it("names the window and the message", () => {
    requestJumpToMessage("freenode", "#grappa", 42);
    const req = jumpToMessageRequest();
    expect(req?.key).toBe(channelKey("freenode", "#grappa"));
    expect(req?.id).toBe(42);
  });

  it("gives two identical taps two distinct nonces", () => {
    requestJumpToMessage("freenode", "#grappa", 42);
    const first = jumpToMessageRequest()?.nonce;
    requestJumpToMessage("freenode", "#grappa", 42);
    const second = jumpToMessageRequest()?.nonce;
    expect(first).toBeDefined();
    expect(second).toBe((first ?? 0) + 1);
  });
});
