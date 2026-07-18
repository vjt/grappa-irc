import { afterEach, describe, expect, it } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { appendToScrollback } from "../lib/scrollback";
import { closeServiceModal, openServiceModal, serviceModalState } from "../lib/serviceModal";
import { SERVER_WINDOW_NAME } from "../lib/windowKinds";

// #290 — the services console modal store. Transient (createRoot) singleton
// holding `{networkSlug, service, sinceId} | null`. `sinceId` is the $server
// high-water mark captured at open, so the modal mirrors ONLY the service
// notices that arrive WHILE it's open (spec: "capturing only while open") —
// derived from the existing $server scrollback, no duplicated buffer.

const SLUG = "azzurra";

const notice = (id: number, sender: string, body: string): ScrollbackMessage => ({
  id,
  network: SLUG,
  channel: SERVER_WINDOW_NAME,
  server_time: id,
  kind: "notice",
  sender,
  body,
  meta: {},
});

describe("serviceModal store (#290)", () => {
  afterEach(() => closeServiceModal());

  it("opens for a service, pinned to the network slug", () => {
    openServiceModal(SLUG, "NickServ");
    expect(serviceModalState()).toMatchObject({ networkSlug: SLUG, service: "NickServ" });
  });

  it("captures the $server high-water mark as sinceId (capture only while open)", () => {
    const key = channelKey(SLUG, SERVER_WINDOW_NAME);
    appendToScrollback(key, notice(41, "NickServ", "stale confirm from a past session"));
    appendToScrollback(key, notice(42, "NickServ", "another stale line"));

    openServiceModal(SLUG, "NickServ");

    expect(serviceModalState()?.sinceId).toBe(42);
  });

  it("sinceId is 0 when the $server window is empty (fresh network)", () => {
    openServiceModal("emptynet", "ChanServ");
    expect(serviceModalState()?.sinceId).toBe(0);
  });

  it("close resets state to null", () => {
    openServiceModal(SLUG, "NickServ");
    closeServiceModal();
    expect(serviceModalState()).toBeNull();
  });
});
