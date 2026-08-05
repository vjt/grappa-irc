import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #734 / #735 — the two security panes (TOTP + passkeys) shipped with a QR
// container whose class had NO rule behind it, and with buttons that carried
// no class at all under a drawer that had no base <button> treatment.
//
// Two guard flavours here, deliberately:
//   * SOURCE-LEVEL CSS guards. jsdom applies no stylesheet, so the rendered
//     44px height and the QR's real appearance are NOT observable in this
//     suite — only the presence of the rules that produce them. The on-device
//     tap target and the scannability of the code still need a real iPhone.
//   * DOM guards for what jsdom CAN see: which class the QR container asks
//     for, and each remove button's accessible name + confirm step.

const api = vi.hoisted(() => ({
  deletePasskey: vi.fn(),
  getPasskeyStatus: vi.fn(),
  getTotpStatus: vi.fn(),
  startTotpEnrollment: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  confirmTotpEnrollment: vi.fn(),
  deletePasskey: api.deletePasskey,
  disableTotp: vi.fn(),
  finishPasskeyModeChange: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  getPasskeyStatus: api.getPasskeyStatus,
  getTotpStatus: api.getTotpStatus,
  preparePasswordless: vi.fn(),
  startPasskeyModeChange: vi.fn(),
  startPasskeyRegistration: vi.fn(),
  startPasswordlessActivation: vi.fn(),
  startTotpEnrollment: api.startTotpEnrollment,
}));

vi.mock("../lib/auth", () => ({ token: () => "test-token" }));

vi.mock("../lib/passkeys", () => ({
  createPasskey: vi.fn(),
  getPasskey: vi.fn(),
}));

import PasskeySettings from "../PasskeySettings";
import TotpSettings from "../TotpSettings";

describe("#734 TOTP enrolment QR sits in a sized, light-framed box", () => {
  it("the QR frame rule supplies a fixed box and a white background", () => {
    // The #734 defect exactly: `.share-qr` was a data-testid, not a class,
    // so the container had no rule — ruleBody throws when the rule is gone.
    const body = ruleBody(".qr-frame");
    expect(body).toMatch(/width:\s*12rem/);
    expect(body).toMatch(/height:\s*12rem/);
    expect(body).toMatch(/background:\s*#fff/);
  });

  it("the QR frame sizes the injected svg to fill it", () => {
    // lib/qr.ts emits a viewBox-scaled svg with no intrinsic px size, so
    // without this rule the code renders at the UA's replaced-element default.
    const body = ruleBody(".qr-frame svg");
    expect(body).toMatch(/width:\s*100%/);
    expect(body).toMatch(/height:\s*100%/);
  });

  it("the enrolment QR container asks for the sized frame class", async () => {
    api.getTotpStatus.mockResolvedValue({ enabled: false });
    api.getPasskeyStatus.mockResolvedValue({ mode: "disabled", passkeys: [] });
    api.startTotpEnrollment.mockResolvedValue({
      enrollment_token: "enrol-token",
      provisioning_uri: "otpauth://totp/grappa:vjt?secret=ABCD",
      secret: "ABCD",
    });

    render(() => <TotpSettings onBack={() => {}} />);
    await fireEvent.click(await screen.findByRole("button", { name: "enable TOTP" }));

    const form = await screen.findByTestId("totp-enrollment-form");
    expect(form.querySelector(".qr-frame")).not.toBeNull();
  });
});

describe("#735 the settings drawer gives every button a tap floor", () => {
  it("the base drawer button rule floors the height at the HIG minimum", () => {
    // Absolute px, via --tap-min: the html root font-size is 14px, so a rem
    // tap target under-shoots 44px (feedback_cic_tap_target_rem_pitfall).
    const body = ruleBody(":where(.settings-drawer) button");
    expect(body).toMatch(/min-height:\s*var\(--tap-min\)/);
    expect(themeCss).toMatch(/--tap-min:\s*44px/);
  });

  it("dresses the button in the drawer's own font, not the UA's", () => {
    const body = ruleBody(":where(.settings-drawer) button");
    expect(body).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(body).toMatch(/font-size:\s*var\(--font-size\)/);
    // Paired with the floor: under content-box, min-height 44px would mean
    // 44px PLUS padding and border on every button in the drawer.
    expect(body).toMatch(/box-sizing:\s*border-box/);
  });

  it("stays at element-only specificity — a floor, never an override", () => {
    // The load-bearing half of the rule is the `:where()`. Written bare, the
    // selector would weigh (0,1,1) and repaint .settings-back, .logout,
    // .watchlists-remove and the theme cards instead of yielding to them.
    expect(themeCss).toContain(":where(.settings-drawer) button {");
    expect(themeCss).not.toMatch(/^\.settings-drawer button \{/m);
  });

  it("declares no border-radius — the drawer is square by intent", () => {
    // No drawer button class declares a radius (the irssi sharp-corner
    // aesthetic the .settings-section comment states), so a radius on the
    // base rule would round every one of them at once.
    expect(ruleBody(":where(.settings-drawer) button")).not.toMatch(/border-radius/);
  });

  it("a disabled drawer button reads as disabled under the base look", () => {
    // Both panes gate their controls on busy(); custom colours would
    // otherwise drop the UA's own greying-out with nothing in its place.
    // Pinned to the value: `/opacity/` alone passes against `opacity: 1`.
    const body = ruleBody(":where(.settings-drawer) button:disabled");
    expect(body).toMatch(/opacity:\s*0\.5/);
    expect(body).toMatch(/cursor:\s*default/);
  });
});

describe("#735 each passkey remove button names its own passkey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPasskeyStatus.mockResolvedValue({
      mode: "second_factor",
      passkeys: [
        { id: "passkey-1", name: "phone", inserted_at: "2026-08-03T00:00:00Z", last_used_at: null },
        {
          id: "passkey-2",
          name: "laptop",
          inserted_at: "2026-08-03T00:00:00Z",
          last_used_at: null,
        },
      ],
    });
  });

  it("gives every remove button a distinct accessible name", async () => {
    render(() => <PasskeySettings />);

    await screen.findByRole("button", { name: "remove phone" });
    screen.getByRole("button", { name: "remove laptop" });
  });

  it("arms before deleting, so one mis-tap cannot destroy a credential", async () => {
    render(() => <PasskeySettings />);

    // #729 — this used to confirm with an untouched password field and assert
    // `deletePasskey(…, "")`, PINNING the defect: a removal fired with an
    // empty password and came back 401. The arming contract under test here
    // is unchanged; the password is now supplied because the pane refuses
    // without one.
    await fireEvent.input(await screen.findByLabelText("Account password"), {
      target: { value: "correct horse battery staple" },
    });

    await fireEvent.click(screen.getByRole("button", { name: "remove phone" }));
    expect(api.deletePasskey).not.toHaveBeenCalled();

    // The armed label names the passkey too — a screen reader hears WHICH
    // credential the confirmation destroys, not a bare "confirm".
    await fireEvent.click(screen.getByRole("button", { name: "confirm removing phone" }));
    expect(api.deletePasskey).toHaveBeenCalledWith(
      "test-token",
      "passkey-1",
      "correct horse battery staple",
    );
  });

  it("arming one row disarms the other", async () => {
    render(() => <PasskeySettings />);

    await fireEvent.click(await screen.findByRole("button", { name: "remove phone" }));
    await fireEvent.click(screen.getByRole("button", { name: "remove laptop" }));

    expect(screen.getByRole("button", { name: "remove phone" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "confirm removing laptop" })).toBeTruthy();
  });
});
