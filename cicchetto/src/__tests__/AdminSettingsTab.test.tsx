import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminSettingsView } from "../lib/api";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminGetSettings: vi.fn(),
    adminPutSettings: vi.fn(),
  };
});

import AdminSettingsTab from "../AdminSettingsTab";

// UX-6-B2 (2026-05-21) — AdminSettingsTab unit suite. Covers:
//   * GET /admin/settings on mount + form pre-population
//   * unit conversion: per-file cap shown in MB, global in GB
//   * Save → PUT /admin/settings with full upload subtree
//   * 422 invalid_setting surfaces the offending field highlight
//   * generic ApiError surfaces in the top-of-tab error banner
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// AdminPane's mount gate is the reachability boundary; per-class
// loop applies at the M-7 layer, not here.

const DEFAULTS: AdminSettingsView = {
  upload: {
    active_host: "embedded",
    per_file_cap_bytes: 10 * 1024 * 1024,
    global_cap_bytes: 10 * 1024 * 1024 * 1024,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdminSettingsTab — initial render", () => {
  it("calls adminGetSettings on mount", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(api.adminGetSettings).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("pre-populates the form fields from the GET response", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue({
      upload: {
        active_host: "litterbox",
        per_file_cap_bytes: 5 * 1024 * 1024,
        global_cap_bytes: 20 * 1024 * 1024 * 1024,
      },
    });

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      const select = screen.getByTestId("admin-settings-active-host") as HTMLSelectElement;
      expect(select.value).toBe("litterbox");
    });

    const perFile = screen.getByTestId("admin-settings-per-file-cap") as HTMLInputElement;
    expect(perFile.value).toBe("5");

    const global = screen.getByTestId("admin-settings-global-cap") as HTMLInputElement;
    expect(global.value).toBe("20");
  });

  it("renders an error banner when the initial fetch fails", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockRejectedValue(
      new api.ApiError(500, "internal", { error: "internal" }),
    );

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-error")).toHaveTextContent("error: internal");
    });
  });
});

describe("AdminSettingsTab — save", () => {
  it("PUTs the form values converted to bytes", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);
    vi.mocked(api.adminPutSettings).mockResolvedValue(DEFAULTS);

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-active-host")).toBeInTheDocument();
    });

    const select = screen.getByTestId("admin-settings-active-host") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "litterbox" } });

    const perFile = screen.getByTestId("admin-settings-per-file-cap") as HTMLInputElement;
    fireEvent.input(perFile, { target: { value: "25" } });

    const global = screen.getByTestId("admin-settings-global-cap") as HTMLInputElement;
    fireEvent.input(global, { target: { value: "50" } });

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(api.adminPutSettings).toHaveBeenCalledWith("test-bearer", {
        upload: {
          active_host: "litterbox",
          per_file_cap_bytes: 25 * 1024 * 1024,
          global_cap_bytes: 50 * 1024 * 1024 * 1024,
        },
      });
    });
  });

  it("shows a 'saved' indicator after a successful PUT", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);
    vi.mocked(api.adminPutSettings).mockResolvedValue(DEFAULTS);

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-saved")).toBeInTheDocument();
    });
  });

  it("flags the offending field on 422 invalid_setting", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);
    vi.mocked(api.adminPutSettings).mockRejectedValue(
      new api.ApiError(422, "invalid_setting", {
        error: "invalid_setting",
        field: "upload.per_file_cap_bytes",
      }),
    );

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      const input = screen.getByTestId("admin-settings-per-file-cap");
      expect(input).toHaveClass("admin-settings-field-error");
    });
  });

  it("surfaces generic ApiError on save failure", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);
    vi.mocked(api.adminPutSettings).mockRejectedValue(
      new api.ApiError(500, "internal", { error: "internal" }),
    );

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-error")).toHaveTextContent("error: internal");
    });
  });
});

describe("AdminSettingsTab — refresh", () => {
  it("re-fetches on refresh-button click", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(api.adminGetSettings).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTestId("admin-settings-refresh"));

    await waitFor(() => {
      expect(api.adminGetSettings).toHaveBeenCalledTimes(2);
    });
  });
});
