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
import { refreshSlot } from "../admin/refreshSlot";

// UX-6-B2 (2026-05-21) — AdminSettingsTab unit suite. Covers:
//   * GET /admin/settings on mount + form pre-population
//   * unit conversion: image per-file cap shown in MB, global in GB
//   * Save → PUT /admin/settings with full upload subtree
//   * 422 invalid_setting surfaces the offending field highlight
//   * generic ApiError surfaces in the top-of-tab error banner
//   * issue 2202 — the `dcc` subtree: both ceilings seed from the view,
//     leave in BYTES, and own their own 422 highlight.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.
// AdminPane's mount gate is the reachability boundary; per-class
// loop applies at the M-7 layer, not here.

const DEFAULTS: AdminSettingsView = {
  upload: {
    active_host: "embedded",
    image_per_file_cap_bytes: 10 * 1024 * 1024,
    video_per_file_cap_bytes: 50 * 1024 * 1024,
    document_per_file_cap_bytes: 10 * 1024 * 1024,
    audio_per_file_cap_bytes: 25 * 1024 * 1024,
    global_cap_bytes: 10 * 1024 * 1024 * 1024,
    // issue 2175 — the server's own defaults. Read-back only in this
    // tab today: the form has no control for either ceiling, so `onSave`
    // omits both keys and the controller leaves them where they were.
    per_user_cap_bytes: 1024 * 1024 * 1024,
    per_visitor_cap_bytes: 100 * 1024 * 1024,
    video_max_duration_seconds: 90,
  },
  // issue 2185 server defaults — 100 MiB per transfer, 10 GiB spool.
  dcc: {
    max_transfer_bytes: 100 * 1024 * 1024,
    global_cap_bytes: 10 * 1024 * 1024 * 1024,
  },
  // issue 2359 — nothing stored, so the server's boot config applies.
  // 2s is off the ladder on purpose (the integration env's value): the
  // "server config (…)" entry must name ANY fallback, not only a rung.
  auto_away: { default_debounce_seconds: null, fallback_debounce_seconds: 2 },
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

  it("pre-populates the form fields from the GET response — four per-type caps (Task 7 + audio)", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue({
      auto_away: DEFAULTS.auto_away,
      upload: {
        active_host: "litterbox",
        image_per_file_cap_bytes: 5 * 1024 * 1024,
        video_per_file_cap_bytes: 60 * 1024 * 1024,
        document_per_file_cap_bytes: 15 * 1024 * 1024,
        audio_per_file_cap_bytes: 30 * 1024 * 1024,
        global_cap_bytes: 20 * 1024 * 1024 * 1024,
        per_user_cap_bytes: 2 * 1024 * 1024 * 1024,
        per_visitor_cap_bytes: 200 * 1024 * 1024,
        video_max_duration_seconds: 90,
      },
      dcc: DEFAULTS.dcc,
    });

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      const select = screen.getByTestId("admin-settings-active-host") as HTMLSelectElement;
      expect(select.value).toBe("litterbox");
    });

    const imageCap = screen.getByTestId("admin-settings-image-cap") as HTMLInputElement;
    expect(imageCap.value).toBe("5");

    const videoCap = screen.getByTestId("admin-settings-video-cap") as HTMLInputElement;
    expect(videoCap.value).toBe("60");

    const documentCap = screen.getByTestId("admin-settings-document-cap") as HTMLInputElement;
    expect(documentCap.value).toBe("15");

    const audioCap = screen.getByTestId("admin-settings-audio-cap") as HTMLInputElement;
    expect(audioCap.value).toBe("30");

    const global = screen.getByTestId("admin-settings-global-cap") as HTMLInputElement;
    expect(global.value).toBe("20");

    // #201 — seconds straight through, no unit conversion.
    const videoDuration = screen.getByTestId(
      "admin-settings-video-max-duration",
    ) as HTMLInputElement;
    expect(videoDuration.value).toBe("90");
  });

  // issue 2202 — the two DCC ceilings landed in 1.5.8 with a working admin
  // API and no form at all, so the only way to move them was a hand-rolled
  // PUT (which is how prod's per-transfer cap went 100 → 200 MiB). Same
  // MiB/GiB-in-the-UI, bytes-on-the-wire contract as the upload caps.
  it("pre-populates the two DCC fields from the GET response (issue 2202)", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue({
      upload: DEFAULTS.upload,
      auto_away: DEFAULTS.auto_away,
      dcc: {
        max_transfer_bytes: 200 * 1024 * 1024,
        global_cap_bytes: 25 * 1024 * 1024 * 1024,
      },
    });

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-dcc-max-transfer")).toBeInTheDocument();
    });

    const maxTransfer = screen.getByTestId("admin-settings-dcc-max-transfer") as HTMLInputElement;
    expect(maxTransfer.value).toBe("200");

    const spoolCap = screen.getByTestId("admin-settings-dcc-global-cap") as HTMLInputElement;
    expect(spoolCap.value).toBe("25");
  });

  // Scope item 3. The subtitle names the scope of everything below the
  // toolbar, and "upload limits" stopped being true the moment a second
  // family of caps got a form. Asserted on the rendered subtitle rather
  // than on a literal, so it survives a rewording that keeps DCC named.
  it("the toolbar subtitle names DCC, not uploads alone (issue 2202)", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);

    const { container } = render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(container.querySelector(".adm-toolbar-sub")).not.toBeNull();
    });
    expect(container.querySelector(".adm-toolbar-sub")?.textContent).toMatch(/DCC/);
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

    const imageCap = screen.getByTestId("admin-settings-image-cap") as HTMLInputElement;
    fireEvent.input(imageCap, { target: { value: "25" } });

    const videoCap = screen.getByTestId("admin-settings-video-cap") as HTMLInputElement;
    fireEvent.input(videoCap, { target: { value: "75" } });

    const documentCap = screen.getByTestId("admin-settings-document-cap") as HTMLInputElement;
    fireEvent.input(documentCap, { target: { value: "12" } });

    const audioCap = screen.getByTestId("admin-settings-audio-cap") as HTMLInputElement;
    fireEvent.input(audioCap, { target: { value: "20" } });

    const global = screen.getByTestId("admin-settings-global-cap") as HTMLInputElement;
    fireEvent.input(global, { target: { value: "50" } });

    const videoDuration = screen.getByTestId(
      "admin-settings-video-max-duration",
    ) as HTMLInputElement;
    fireEvent.input(videoDuration, { target: { value: "45" } });

    // issue 2202 — MiB/GiB in, bytes out. The numbers differ from every
    // upload field above so a subtree crossed with another is a red, and
    // they differ from their own byte value so shipping the raw MiB is one
    // too.
    const dccMaxTransfer = screen.getByTestId(
      "admin-settings-dcc-max-transfer",
    ) as HTMLInputElement;
    fireEvent.input(dccMaxTransfer, { target: { value: "200" } });

    const dccGlobalCap = screen.getByTestId("admin-settings-dcc-global-cap") as HTMLInputElement;
    fireEvent.input(dccGlobalCap, { target: { value: "8" } });

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(api.adminPutSettings).toHaveBeenCalledWith("test-bearer", {
        upload: {
          active_host: "litterbox",
          image_per_file_cap_bytes: 25 * 1024 * 1024,
          video_per_file_cap_bytes: 75 * 1024 * 1024,
          document_per_file_cap_bytes: 12 * 1024 * 1024,
          audio_per_file_cap_bytes: 20 * 1024 * 1024,
          global_cap_bytes: 50 * 1024 * 1024 * 1024,
          video_max_duration_seconds: 45,
        },
        dcc: {
          max_transfer_bytes: 200 * 1024 * 1024,
          global_cap_bytes: 8 * 1024 * 1024 * 1024,
        },
        // Untouched select → the stored null goes back as null.
        auto_away: { default_debounce_seconds: null },
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
        field: "upload.image_per_file_cap_bytes",
      }),
    );

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      const input = screen.getByTestId("admin-settings-image-cap");
      expect(input).toHaveClass("admin-settings-field-error");
    });
  });

  it("422 on the video cap highlights the video input ONLY (Task 7)", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);
    vi.mocked(api.adminPutSettings).mockRejectedValue(
      new api.ApiError(422, "invalid_setting", {
        error: "invalid_setting",
        field: "upload.video_per_file_cap_bytes",
      }),
    );

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-video-cap")).toHaveClass(
        "admin-settings-field-error",
      );
    });
    expect(screen.getByTestId("admin-settings-image-cap")).not.toHaveClass(
      "admin-settings-field-error",
    );
    expect(screen.getByTestId("admin-settings-document-cap")).not.toHaveClass(
      "admin-settings-field-error",
    );
  });

  // issue 2202 — `global_cap_bytes` is a member of BOTH closed key sets and
  // means a different budget in each, which is why the controller carries
  // the family on the SUBTREE and not the key name. A highlight keyed on
  // the bare key would light the upload global cap here; keying it on the
  // dotted `dcc.` path is what keeps the two apart.
  it("422 on dcc.max_transfer_bytes marks that field and no upload one", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);
    vi.mocked(api.adminPutSettings).mockRejectedValue(
      new api.ApiError(422, "invalid_setting", {
        error: "invalid_setting",
        field: "dcc.max_transfer_bytes",
      }),
    );

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-dcc-max-transfer")).toHaveClass(
        "admin-settings-field-error",
      );
    });
    expect(screen.getByTestId("admin-settings-dcc-global-cap")).not.toHaveClass(
      "admin-settings-field-error",
    );
    expect(screen.getByTestId("admin-settings-image-cap")).not.toHaveClass(
      "admin-settings-field-error",
    );
    expect(screen.getByTestId("admin-settings-global-cap")).not.toHaveClass(
      "admin-settings-field-error",
    );
  });

  it("422 on dcc.global_cap_bytes marks it and NOT the upload global cap", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);
    vi.mocked(api.adminPutSettings).mockRejectedValue(
      new api.ApiError(422, "invalid_setting", {
        error: "invalid_setting",
        field: "dcc.global_cap_bytes",
      }),
    );

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-dcc-global-cap")).toHaveClass(
        "admin-settings-field-error",
      );
    });
    expect(screen.getByTestId("admin-settings-global-cap")).not.toHaveClass(
      "admin-settings-field-error",
    );
  });

  // The mirror of the pair above: an UPLOAD 422 on the shared key name must
  // not light the DCC row either.
  it("422 on upload.global_cap_bytes marks it and NOT the DCC spool cap", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);
    vi.mocked(api.adminPutSettings).mockRejectedValue(
      new api.ApiError(422, "invalid_setting", {
        error: "invalid_setting",
        field: "upload.global_cap_bytes",
      }),
    );

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-global-cap")).toHaveClass(
        "admin-settings-field-error",
      );
    });
    expect(screen.getByTestId("admin-settings-dcc-global-cap")).not.toHaveClass(
      "admin-settings-field-error",
    );
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

describe("AdminSettingsTab — auto-away site default (issue 2359)", () => {
  const autoAwaySelect = async (): Promise<HTMLSelectElement> => {
    await waitFor(() => {
      expect(screen.getByTestId("admin-settings-auto-away-default")).toBeInTheDocument();
    });
    return screen.getByTestId("admin-settings-auto-away-default") as HTMLSelectElement;
  };

  it("the null entry names the server config value it stands for", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);

    render(() => <AdminSettingsTab />);
    const select = await autoAwaySelect();

    expect(select.value).toBe("");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "server config (2 seconds)",
      "off",
      "1 minute",
      "5 minutes",
      "10 minutes",
      "30 minutes",
      "1 hour",
    ]);
  });

  it("pre-selects a STORED value, off included", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue({
      ...DEFAULTS,
      auto_away: { default_debounce_seconds: 0, fallback_debounce_seconds: 600 },
    });

    render(() => <AdminSettingsTab />);
    const select = await autoAwaySelect();

    expect(select.value).toBe("0");
    expect(select.options[0]?.textContent).toBe("server config (10 minutes)");
  });

  it("PUTs the picked rung as seconds, and the config entry as null", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);
    vi.mocked(api.adminPutSettings).mockResolvedValue(DEFAULTS);

    render(() => <AdminSettingsTab />);
    const select = await autoAwaySelect();

    fireEvent.change(select, { target: { value: "1800" } });
    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(api.adminPutSettings).toHaveBeenCalledWith(
        "test-bearer",
        expect.objectContaining({ auto_away: { default_debounce_seconds: 1800 } }),
      );
    });

    fireEvent.change(select, { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(api.adminPutSettings).toHaveBeenLastCalledWith(
        "test-bearer",
        expect.objectContaining({ auto_away: { default_debounce_seconds: 0 } }),
      );
    });

    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(api.adminPutSettings).toHaveBeenLastCalledWith(
        "test-bearer",
        expect.objectContaining({ auto_away: { default_debounce_seconds: null } }),
      );
    });
  });

  it("422 on auto_away.default_debounce_seconds marks the select", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);
    vi.mocked(api.adminPutSettings).mockRejectedValue(
      new api.ApiError(422, "invalid_setting", { field: "auto_away.default_debounce_seconds" }),
    );

    render(() => <AdminSettingsTab />);
    const select = await autoAwaySelect();

    fireEvent.click(screen.getByTestId("admin-settings-save"));

    await waitFor(() => {
      expect(select.classList.contains("admin-settings-field-error")).toBe(true);
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

    fireEvent.click(await screen.findByTestId("admin-settings-refresh"));

    await waitFor(() => {
      expect(api.adminGetSettings).toHaveBeenCalledTimes(2);
    });
  });

  // #1411 (review K-S5) — Settings was the eighth tab, and the only one whose
  // refresh stayed a hand-rolled `<button>` after the extraction; the
  // `AdminToolbar` moduledoc still claimed it had no refresh at all. The copy
  // cost it the shared button's `aria-label`/`aria-busy` (its accessible name
  // was the literal text, which swaps to "loading…" mid-fetch, so a screen
  // reader announces a state change as a control rename) and kept it out of
  // the slot the rail's ☰ renders from on a phone.
  it("publishes its refresh through the shared slot", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);

    render(() => <AdminSettingsTab />);

    await waitFor(() => {
      expect(refreshSlot()).not.toBeNull();
    });
    expect(refreshSlot()?.testId).toBe("admin-settings-refresh");
    expect(refreshSlot()?.label).toBe("refresh settings");
  });

  it("names the button once, so the name does not change mid-fetch", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.adminGetSettings).mockResolvedValue(DEFAULTS);

    render(() => <AdminSettingsTab />);

    const button = await screen.findByTestId("admin-settings-refresh");
    expect(button).toHaveAccessibleName("refresh settings");
  });
});
