import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/imageUploadOrchestrator", () => ({
  privacyModalState: vi.fn(),
  acknowledgePrivacy: vi.fn(),
  dismissUpload: vi.fn(),
}));

import { channelKey } from "../lib/channelKey";
import * as orch from "../lib/imageUploadOrchestrator";
import PrivacyModal from "../PrivacyModal";

const TEST_KEY = channelKey("freenode", "#a");

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PrivacyModal", () => {
  it("renders nothing when modal is closed", () => {
    vi.mocked(orch.privacyModalState).mockReturnValue({
      open: false,
      host: null,
      key: null,
    });
    render(() => <PrivacyModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a dialog when modal is open", () => {
    vi.mocked(orch.privacyModalState).mockReturnValue({
      open: true,
      host: {
        id: "litterbox",
        displayName: "litterbox.catbox.moe",
        retentionStatement:
          "a public temporary host. Anyone with the URL can view files there for the next 24 hours.",
        ttlOptions: [],
        defaultTtl: null,
        acceptedMimeTypes: { image: [], video: [], document: [] },
        maxFileSizeBytes: () => null,
        supportsProgress: false,
        upload: () => Promise.resolve(""),
      },
      key: TEST_KEY,
    });
    render(() => <PrivacyModal />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("interpolates host.displayName + retentionStatement into the modal copy", () => {
    vi.mocked(orch.privacyModalState).mockReturnValue({
      open: true,
      host: {
        id: "litterbox",
        displayName: "litterbox.catbox.moe",
        retentionStatement:
          "a public temporary host. Anyone with the URL can view files there for the next 24 hours.",
        ttlOptions: [],
        defaultTtl: null,
        acceptedMimeTypes: { image: [], video: [], document: [] },
        maxFileSizeBytes: () => null,
        supportsProgress: false,
        upload: () => Promise.resolve(""),
      },
      key: TEST_KEY,
    });
    render(() => <PrivacyModal />);
    expect(screen.getByRole("dialog")).toHaveTextContent(/litterbox\.catbox\.moe/);
    expect(screen.getByRole("dialog")).toHaveTextContent(/24 hours/);
    expect(screen.getByRole("dialog")).toHaveTextContent(/anyone with the URL/i);
  });

  it("Continue button calls acknowledgePrivacy(false) when 'Don't show again' is unchecked", () => {
    vi.mocked(orch.privacyModalState).mockReturnValue({
      open: true,
      host: {
        id: "litterbox",
        displayName: "litterbox.catbox.moe",
        retentionStatement: "...",
        ttlOptions: [],
        defaultTtl: null,
        acceptedMimeTypes: { image: [], video: [], document: [] },
        maxFileSizeBytes: () => null,
        supportsProgress: false,
        upload: () => Promise.resolve(""),
      },
      key: TEST_KEY,
    });
    render(() => <PrivacyModal />);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(orch.acknowledgePrivacy).toHaveBeenCalledWith(false);
  });

  it("Continue button calls acknowledgePrivacy(true) when 'Don't show again' is checked", () => {
    vi.mocked(orch.privacyModalState).mockReturnValue({
      open: true,
      host: {
        id: "litterbox",
        displayName: "litterbox.catbox.moe",
        retentionStatement: "...",
        ttlOptions: [],
        defaultTtl: null,
        acceptedMimeTypes: { image: [], video: [], document: [] },
        maxFileSizeBytes: () => null,
        supportsProgress: false,
        upload: () => Promise.resolve(""),
      },
      key: TEST_KEY,
    });
    render(() => <PrivacyModal />);
    const checkbox = screen.getByRole("checkbox", { name: /don't show/i });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(orch.acknowledgePrivacy).toHaveBeenCalledWith(true);
  });

  it("Cancel button calls dismissUpload with the modal's key", () => {
    vi.mocked(orch.privacyModalState).mockReturnValue({
      open: true,
      host: {
        id: "litterbox",
        displayName: "litterbox.catbox.moe",
        retentionStatement: "...",
        ttlOptions: [],
        defaultTtl: null,
        acceptedMimeTypes: { image: [], video: [], document: [] },
        maxFileSizeBytes: () => null,
        supportsProgress: false,
        upload: () => Promise.resolve(""),
      },
      key: TEST_KEY,
    });
    render(() => <PrivacyModal />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(orch.dismissUpload).toHaveBeenCalledWith(TEST_KEY);
  });

  it("Esc key calls dismissUpload", () => {
    vi.mocked(orch.privacyModalState).mockReturnValue({
      open: true,
      host: {
        id: "litterbox",
        displayName: "litterbox.catbox.moe",
        retentionStatement: "...",
        ttlOptions: [],
        defaultTtl: null,
        acceptedMimeTypes: { image: [], video: [], document: [] },
        maxFileSizeBytes: () => null,
        supportsProgress: false,
        upload: () => Promise.resolve(""),
      },
      key: TEST_KEY,
    });
    render(() => <PrivacyModal />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(orch.dismissUpload).toHaveBeenCalledWith(TEST_KEY);
  });
});
