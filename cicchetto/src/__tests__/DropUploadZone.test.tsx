import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #351 — whole-message-pane drag-and-drop upload target.
//
// The orchestrator is the boundary (mocked); channelKey is mocked to the
// same `${slug} ${name}` shape the ComposeBox tests use. DropUploadZone
// reuses the REAL shared `dropUpload` + `dragHasFiles` (its whole point is
// to not duplicate that wiring), so these tests exercise the real filter +
// guard end-to-end and only stub the network-touching orchestrator.

vi.mock("../lib/uploadOrchestrator", () => ({
  triggerUploads: vi.fn(),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

import DropUploadZone from "../DropUploadZone";
import { triggerUploads } from "../lib/uploadOrchestrator";

const png = (): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", { type: "image/png" });

// jsdom has no DataTransfer; a structural fake is enough — the code reads
// only `.types` (guard) and `.files` (drop). A file drag carries the
// literal "Files" marker in `types`; a text drag does not.
type DtLike = { types: string[]; files: File[] };
const fileDt = (files: File[] = [png()]): DtLike => ({ types: ["Files"], files });
const textDt = (): DtLike => ({ types: ["text/plain"], files: [] });

const zoneEl = (): HTMLElement => {
  const el = document.querySelector(".drop-upload-zone");
  if (el === null) throw new Error("zone not rendered");
  return el as HTMLElement;
};

const dragOverEvent = (dt: DtLike): Event => {
  const ev = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
  return ev;
};

const renderZone = () =>
  render(() => (
    <DropUploadZone networkSlug="freenode" channelName="#a">
      <p data-testid="pane-child">scrollback + compose</p>
    </DropUploadZone>
  ));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DropUploadZone", () => {
  it("renders its children (the scrollback + compose stack pass through)", () => {
    renderZone();
    expect(screen.getByTestId("pane-child")).toBeInTheDocument();
  });

  it("shows no overlay at rest", () => {
    renderZone();
    expect(screen.queryByText(/drop to upload/i)).toBeNull();
  });

  it("arms the 'Drop to upload' overlay when a FILE drag enters", () => {
    renderZone();
    fireEvent.dragEnter(zoneEl(), { dataTransfer: fileDt() });
    expect(screen.getByText(/drop to upload/i)).toBeInTheDocument();
  });

  it("does NOT arm the overlay for a text / in-app-element drag", () => {
    renderZone();
    fireEvent.dragEnter(zoneEl(), { dataTransfer: textDt() });
    expect(screen.queryByText(/drop to upload/i)).toBeNull();
  });

  it("keeps the overlay stable across child boundaries via a depth counter", () => {
    renderZone();
    const el = zoneEl();
    // Two enters (crossing into a child) then one leave — still armed.
    fireEvent.dragEnter(el, { dataTransfer: fileDt() });
    fireEvent.dragEnter(el, { dataTransfer: fileDt() });
    fireEvent.dragLeave(el, { dataTransfer: fileDt() });
    expect(screen.getByText(/drop to upload/i)).toBeInTheDocument();
    // The final balancing leave clears it.
    fireEvent.dragLeave(el, { dataTransfer: fileDt() });
    expect(screen.queryByText(/drop to upload/i)).toBeNull();
  });

  it("preventDefaults a FILE dragover (makes the pane a valid drop target)", () => {
    renderZone();
    const ev = dragOverEvent(fileDt());
    zoneEl().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("does NOT preventDefault a text dragover (leaves native handling alone)", () => {
    renderZone();
    const ev = dragOverEvent(textDt());
    zoneEl().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("uploads on a FILE drop and clears the overlay", () => {
    renderZone();
    const el = zoneEl();
    fireEvent.dragEnter(el, { dataTransfer: fileDt() });
    expect(screen.getByText(/drop to upload/i)).toBeInTheDocument();

    const file = png();
    fireEvent.drop(el, { dataTransfer: fileDt([file]) });

    expect(triggerUploads).toHaveBeenCalledWith("freenode #a", "freenode", "#a", [file]);
    expect(screen.queryByText(/drop to upload/i)).toBeNull();
  });

  it("ignores a text drop — no upload, no overlay", () => {
    renderZone();
    fireEvent.drop(zoneEl(), { dataTransfer: textDt() });
    expect(triggerUploads).not.toHaveBeenCalled();
    expect(screen.queryByText(/drop to upload/i)).toBeNull();
  });
});
