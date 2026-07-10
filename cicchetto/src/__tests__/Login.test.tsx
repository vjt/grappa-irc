import { Route, Router } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import Login from "../Login";
import { ApiError } from "../lib/api";

// `auth.login` is the boundary the form drives — mock it instead of the
// raw HTTP layer so the form test stays focused on form behavior, not
// transport. The auth-store ⇄ api wiring is covered separately in
// auth.test.ts.
vi.mock("../lib/auth", () => ({
  login: vi.fn(),
  logout: vi.fn(),
  token: vi.fn(() => null),
  isAuthenticated: vi.fn(() => false),
  setToken: vi.fn(),
}));

vi.mock("../lib/captcha", () => ({
  mountCaptchaWidget: vi.fn(),
}));

import * as auth from "../lib/auth";
import { mountCaptchaWidget } from "../lib/captcha";

const renderLogin = () =>
  render(() => (
    <Router>
      <Route path="/" component={() => <Login />} />
    </Router>
  ));

// #204 — the password field lives behind the collapsed "Advanced" section.
// Every test that needs the password must open it first. Centralize the
// interaction so a label/aria change updates one place.
const openAdvanced = () => fireEvent.click(screen.getByRole("button", { name: /advanced/i }));

const nickField = () => screen.getByLabelText(/nick or email/i);
const connectBtn = () => screen.getByRole("button", { name: /connect|log in/i });

afterEach(() => {
  vi.clearAllMocks();
});

describe("Login — #204 foolproof minimal view", () => {
  it("shows the nick field + Connect + Advanced toggle, but NOT the password, by default", () => {
    renderLogin();
    expect(nickField()).toBeInTheDocument();
    expect(connectBtn()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /advanced/i })).toBeInTheDocument();
    // Password is collapsed away in the minimal view (conditional render,
    // not display:none — so it is absent from the DOM, not just hidden).
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it("keeps the big IRC branding wordmark visible", () => {
    renderLogin();
    // vjt: "IRC" must be visible, big letters — not only "cicchetto".
    expect(screen.getByText(/^IRC$/)).toBeInTheDocument();
  });

  it("reveals the password field when Advanced is expanded", () => {
    renderLogin();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    openAdvanced();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("marks the Advanced toggle's expanded state via aria-expanded", () => {
    renderLogin();
    const toggle = screen.getByRole("button", { name: /advanced/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("places the Advanced toggle BETWEEN the nick input and the Connect button (vjt layout fix)", () => {
    renderLogin();
    const nick = nickField();
    const toggle = screen.getByRole("button", { name: /advanced/i });
    const connect = connectBtn();
    // DOM order: nick → Advanced → Connect. Node.compareDocumentPosition
    // returns DOCUMENT_POSITION_FOLLOWING (4) when the argument follows.
    expect(nick.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does NOT render the A2HS install arrow on the login screen (vjt Q2: splash-only)", () => {
    renderLogin();
    expect(screen.queryByTestId("install-a2hs-arrow")).toBeNull();
  });
});

describe("Login — #204 on-submit nick sanitization", () => {
  it("substitutes spaces with underscores and submits the sanitized nick", async () => {
    vi.mocked(auth.login).mockResolvedValue(undefined);
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "my nick" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      // No "@" → nick branch → `my nick` becomes `my_nick` at submit time.
      // No password (Advanced collapsed) → null, matching the existing
      // auth.login(identifier, password|null, captcha?) boundary.
      expect(auth.login).toHaveBeenCalledWith("my_nick", null);
    });
  });

  it("rewrites the visible field to the sanitized value so the user sees the correction", async () => {
    // On a FAILED login the form comes back — and it must show the
    // sanitized value (`my nick` → `my_nick`), proving the correction was
    // reflected into the field, not just into the submitted payload.
    vi.mocked(auth.login).mockRejectedValue(new ApiError(401, "invalid_credentials"));
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "my nick" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect((nickField() as HTMLInputElement).value).toBe("my_nick");
  });

  it("submits the password too when Advanced is open", async () => {
    vi.mocked(auth.login).mockResolvedValue(undefined);
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice" } });
    openAdvanced();
    fireEvent.input(screen.getByLabelText(/password/i), { target: { value: "secret" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(auth.login).toHaveBeenCalledWith("alice", "secret");
    });
  });

  it("rejects an illegal nick inline WITHOUT calling auth.login", async () => {
    renderLogin();
    // Leading digit is illegal server-side (@nick_regex first-char rule).
    fireEvent.input(nickField(), { target: { value: "123abc" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/nickname/i);
    });
    expect(auth.login).not.toHaveBeenCalled();
  });

  it("treats an @-bearing value as an email and submits it verbatim", async () => {
    vi.mocked(auth.login).mockResolvedValue(undefined);
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice@example.com" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      // Email branch: no nick stripping — the "@"/"." survive.
      expect(auth.login).toHaveBeenCalledWith("alice@example.com", null);
    });
  });

  it("rejects a malformed email inline WITHOUT calling auth.login", async () => {
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice@localhost" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/email/i);
    });
    expect(auth.login).not.toHaveBeenCalled();
  });
});

describe("Login — #204 connecting feedback", () => {
  it("replaces the form with a spinner + connecting copy while the request is in flight", async () => {
    // A never-resolving login keeps the form in the connecting state so we
    // can observe the spinner + the anchor reassurance line.
    vi.mocked(auth.login).mockReturnValue(new Promise<void>(() => {}));
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(screen.getByTestId("login-connecting")).toBeInTheDocument();
    });
    expect(screen.getByText(/connecting to IRC/i)).toBeInTheDocument();
    // The form controls are gone while connecting.
    expect(screen.queryByLabelText(/nick or email/i)).toBeNull();
  });

  it("reverts to the form (with the error) when the request fails", async () => {
    vi.mocked(auth.login).mockRejectedValue(new ApiError(401, "invalid_credentials"));
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/invalid name or password/i);
    });
    // Back to the form — the nick field is visible again.
    expect(nickField()).toBeInTheDocument();
    expect(screen.queryByTestId("login-connecting")).toBeNull();
  });
});

describe("Login — mobile-keyboard guard (#138, carried forward)", () => {
  it("keeps autocapitalize/autocorrect/spellcheck/autocomplete on the nick field", () => {
    renderLogin();
    const field = nickField();
    expect(field).toHaveAttribute("autocapitalize", "none");
    expect(field).toHaveAttribute("autocorrect", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
    expect(field).toHaveAttribute("autocomplete", "username");
  });
});

describe("Login — friendly error copy (carried forward)", () => {
  it("displays a friendly error when ApiError code is invalid_credentials (S47)", async () => {
    vi.mocked(auth.login).mockRejectedValue(new ApiError(401, "invalid_credentials"));
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice" } });
    openAdvanced();
    fireEvent.input(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/invalid name or password/i);
    });
  });

  it("renders too_many_sessions copy on 503", async () => {
    vi.mocked(auth.login).mockRejectedValue(new ApiError(503, "too_many_sessions"));
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /already at the session limit for this network from this device/i,
      );
    });
  });

  it("renders connect_timeout copy on 503", async () => {
    vi.mocked(auth.login).mockRejectedValue(new ApiError(503, "connect_timeout"));
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/handshake didn't complete/i);
    });
  });

  it("falls through to the raw ApiError message for unrelated codes (S47)", async () => {
    vi.mocked(auth.login).mockRejectedValue(new ApiError(500, "some_invalid_credentials_thing"));
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/some_invalid_credentials_thing/);
    });
    expect(screen.queryByText(/invalid name or password/i)).toBeNull();
  });
});

describe("Login — captcha flow (carried forward)", () => {
  it("renders captcha widget when login responds 400 captcha_required", async () => {
    vi.mocked(auth.login).mockRejectedValueOnce(
      new ApiError(400, "captcha_required", { site_key: "k", provider: "turnstile" }),
    );
    vi.mocked(mountCaptchaWidget).mockResolvedValue(() => undefined);
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(mountCaptchaWidget).toHaveBeenCalled();
    });
    const call = vi.mocked(mountCaptchaWidget).mock.calls[0];
    if (call === undefined) throw new Error("mountCaptchaWidget not called");
    expect(call[0]).toBe("turnstile");
    expect(call[1]).toBeInstanceOf(HTMLElement);
    expect(call[2]).toBe("k");
    expect(typeof call[3]).toBe("function");
  });

  it("submits captcha_token after solve callback", async () => {
    vi.mocked(auth.login)
      .mockRejectedValueOnce(
        new ApiError(400, "captcha_required", { site_key: "k", provider: "turnstile" }),
      )
      .mockResolvedValueOnce(undefined);
    vi.mocked(mountCaptchaWidget).mockResolvedValue(() => undefined);
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(mountCaptchaWidget).toHaveBeenCalled();
    });
    const call = vi.mocked(mountCaptchaWidget).mock.calls[0];
    if (call === undefined) throw new Error("mountCaptchaWidget not called");
    const onSolve = call[3];
    onSolve("solved-token");
    await waitFor(() => {
      expect(auth.login).toHaveBeenCalledWith("alice", null, "solved-token");
    });
  });

  it("shows generic message when provider is 'disabled' (H4)", async () => {
    vi.mocked(auth.login).mockRejectedValueOnce(
      new ApiError(400, "captcha_required", { site_key: "", provider: "disabled" }),
    );
    renderLogin();
    fireEvent.input(nickField(), { target: { value: "alice" } });
    fireEvent.click(connectBtn());
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/verification temporarily unavailable/i);
    });
    expect(screen.queryByText(/captcha_required/)).toBeNull();
    expect(mountCaptchaWidget).not.toHaveBeenCalled();
  });
});
