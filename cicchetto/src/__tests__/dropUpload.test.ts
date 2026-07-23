import { beforeEach, describe, expect, it, vi } from "vitest";

// #351 — the shared drop/paste → upload entry point, factored out of
// ComposeBox so the whole message pane (Shell's DropUploadZone) and the
// compose box share ONE orchestrator wiring. The orchestrator is the
// boundary (mocked); channelKey is mocked to the same `${slug} ${name}`
// shape the ComposeBox tests use so the assertions read plainly.

vi.mock("../lib/uploadOrchestrator", () => ({
  triggerUploads: vi.fn(),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

import { dragHasFiles, dropUpload } from "../lib/dropUpload";
import { triggerUploads } from "../lib/uploadOrchestrator";

const png = (): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", { type: "image/png" });
const junk = (): File =>
  new File([new Uint8Array(4)], "setup.exe", { type: "application/x-msdownload" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dropUpload", () => {
  it("filters to uploadable categories and enqueues with key + slug + channel", () => {
    const a = png();
    dropUpload([a], "freenode", "#a");
    expect(triggerUploads).toHaveBeenCalledWith("freenode #a", "freenode", "#a", [a]);
  });

  it("uploads only the uploadable files from a mixed batch", () => {
    const a = png();
    const j = junk();
    dropUpload([a, j], "freenode", "#a");
    expect(triggerUploads).toHaveBeenCalledWith("freenode #a", "freenode", "#a", [a]);
  });

  it("is a no-op when no file is uploadable (does NOT call the orchestrator)", () => {
    dropUpload([junk()], "freenode", "#a");
    expect(triggerUploads).not.toHaveBeenCalled();
  });

  it("is a no-op for an empty drop", () => {
    dropUpload([], "freenode", "#a");
    expect(triggerUploads).not.toHaveBeenCalled();
  });
});

describe("dragHasFiles", () => {
  it("true when the drag carries files (types includes 'Files')", () => {
    expect(dragHasFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
  });

  it("false for a text / in-app-element drag", () => {
    expect(dragHasFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
  });

  it("false when dataTransfer is null", () => {
    expect(dragHasFiles(null)).toBe(false);
  });
});
