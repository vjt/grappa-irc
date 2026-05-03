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

afterEach(() => {
  vi.clearAllMocks();
});

describe("Login", () => {
  it("renders name + password fields and a submit button", () => {
    renderLogin();
    expect(screen.getByLabelText(/nick or email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /log in/i })).toBeInTheDocument();
  });

  it("calls auth.login with form values on submit", async () => {
    vi.mocked(auth.login).mockResolvedValue(undefined);
    renderLogin();
    fireEvent.input(screen.getByLabelText(/nick or email/i), {
      target: { value: "alice" },
    });
    fireEvent.input(screen.getByLabelText(/password/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));
    await waitFor(() => {
      expect(auth.login).toHaveBeenCalledWith("alice", "secret");
    });
  });

  it("displays a friendly error when ApiError code is invalid_credentials (S47)", async () => {
    vi.mocked(auth.login).mockRejectedValue(new ApiError(401, "invalid_credentials"));
    renderLogin();
    fireEvent.input(screen.getByLabelText(/nick or email/i), {
      target: { value: "alice" },
    });
    fireEvent.input(screen.getByLabelText(/password/i), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/invalid name or password/i);
    });
  });

  it("renders captcha widget when login responds 400 captcha_required", async () => {
    vi.mocked(auth.login).mockRejectedValueOnce(
      new ApiError(400, "captcha_required", {
        site_key: "k",
        provider: "turnstile",
      }),
    );
    vi.mocked(mountCaptchaWidget).mockResolvedValue(() => undefined);
    renderLogin();
    fireEvent.input(screen.getByLabelText(/nick or email/i), {
      target: { value: "alice" },
    });
    fireEvent.input(screen.getByLabelText(/password/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));
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
        new ApiError(400, "captcha_required", {
          site_key: "k",
          provider: "turnstile",
        }),
      )
      .mockResolvedValueOnce(undefined);
    vi.mocked(mountCaptchaWidget).mockResolvedValue(() => undefined);
    renderLogin();
    fireEvent.input(screen.getByLabelText(/nick or email/i), {
      target: { value: "alice" },
    });
    fireEvent.input(screen.getByLabelText(/password/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));
    await waitFor(() => {
      expect(mountCaptchaWidget).toHaveBeenCalled();
    });
    const call = vi.mocked(mountCaptchaWidget).mock.calls[0];
    if (call === undefined) throw new Error("mountCaptchaWidget not called");
    const onSolve = call[3];
    onSolve("solved-token");
    await waitFor(() => {
      expect(auth.login).toHaveBeenCalledWith("alice", "secret", "solved-token");
    });
  });

  it("renders too_many_sessions copy on 429", async () => {
    vi.mocked(auth.login).mockRejectedValue(new ApiError(429, "too_many_sessions"));
    renderLogin();
    fireEvent.input(screen.getByLabelText(/nick or email/i), {
      target: { value: "alice" },
    });
    fireEvent.input(screen.getByLabelText(/password/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "You're already connected to this network from another device or tab. Close one before opening a new session.",
      );
    });
  });

  it("falls through to the raw ApiError message for unrelated codes (S47)", async () => {
    // S47 strict-equality regression: an unrelated code that contains
    // the substring "invalid_credentials" must NOT be mapped to the
    // friendly message. The shape `${status} ${code}` is the wire-token
    // surface, so an `Error.message` containing that substring would
    // historically have collided.
    vi.mocked(auth.login).mockRejectedValue(new ApiError(500, "some_invalid_credentials_thing"));
    renderLogin();
    fireEvent.input(screen.getByLabelText(/nick or email/i), {
      target: { value: "alice" },
    });
    fireEvent.input(screen.getByLabelText(/password/i), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/some_invalid_credentials_thing/);
    });
    expect(screen.queryByText(/invalid name or password/i)).toBeNull();
  });

  // B2.5 — captcha widget mount-error handling
  //
  // The four scenarios below cover the H3/H4/M-cic-2/M-cic-5 cluster:
  //
  //   * H3: mountCaptchaWidget rejects (e.g. CDN blocked by ad-blocker
  //     / firewall / network failure) — the prior code dropped the
  //     promise rejection on the floor with `void`, leaving the
  //     submit button stuck disabled and no user-visible signal.
  //   * H4: server emits `captcha_required` with `provider="disabled"`
  //     (operator misconfig — captcha demanded but no provider wired).
  //     Without a friendlyMessage arm this leaks the raw wire token
  //     "400 captcha_required" to the UI.
  //   * M-cic-5: rapid captcha state changes captured `cleanup` at
  //     component scope, so a second mount overwrote the first
  //     cleanup before it ran — widget leak.
  //   * Unmount-before-resolve race: if the component unmounts while
  //     `mountCaptchaWidget` is still pending, the resolved cleanup
  //     must still be invoked — otherwise the widget stays alive
  //     after the form is gone.
  describe("captcha widget mount errors", () => {
    it("shows error toast when captcha CDN fails to load (H3)", async () => {
      // Production code intentionally `console.warn`s the mount failure
      // for operator-visible diagnostics (Login.tsx:123). The warn
      // would otherwise print to the test runner stdout on every run;
      // silence it for this single test instead of blanket-suppressing.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(auth.login).mockRejectedValueOnce(
        new ApiError(400, "captcha_required", {
          site_key: "k",
          provider: "turnstile",
        }),
      );
      vi.mocked(mountCaptchaWidget).mockRejectedValueOnce(
        new Error("failed to load https://challenges.cloudflare.com/turnstile/v0/api.js"),
      );
      renderLogin();
      fireEvent.input(screen.getByLabelText(/nick or email/i), {
        target: { value: "alice" },
      });
      fireEvent.input(screen.getByLabelText(/password/i), {
        target: { value: "secret" },
      });
      const button = screen.getByRole("button", { name: /log in/i });
      fireEvent.click(button);
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(/captcha unavailable/i);
      });
      // Button must be re-enabled so the user can retry.
      expect((button as HTMLButtonElement).disabled).toBe(false);
      warnSpy.mockRestore();
    });

    it("shows generic message when provider is 'disabled' (H4)", async () => {
      vi.mocked(auth.login).mockRejectedValueOnce(
        new ApiError(400, "captcha_required", {
          site_key: "",
          provider: "disabled",
        }),
      );
      renderLogin();
      fireEvent.input(screen.getByLabelText(/nick or email/i), {
        target: { value: "alice" },
      });
      fireEvent.input(screen.getByLabelText(/password/i), {
        target: { value: "secret" },
      });
      fireEvent.click(screen.getByRole("button", { name: /log in/i }));
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(
          /verification temporarily unavailable/i,
        );
      });
      // Raw wire token must NOT leak.
      expect(screen.queryByText(/captcha_required/)).toBeNull();
      // No widget should have mounted.
      expect(mountCaptchaWidget).not.toHaveBeenCalled();
    });

    it("clears prior cleanup before re-mount when captcha re-renders (M-cic-5)", async () => {
      const cleanup1 = vi.fn();
      const cleanup2 = vi.fn();
      vi.mocked(auth.login)
        .mockRejectedValueOnce(
          new ApiError(400, "captcha_required", {
            site_key: "k1",
            provider: "turnstile",
          }),
        )
        .mockRejectedValueOnce(
          new ApiError(400, "captcha_required", {
            site_key: "k2",
            provider: "turnstile",
          }),
        );
      vi.mocked(mountCaptchaWidget).mockResolvedValueOnce(cleanup1).mockResolvedValueOnce(cleanup2);
      renderLogin();
      fireEvent.input(screen.getByLabelText(/nick or email/i), {
        target: { value: "alice" },
      });
      fireEvent.input(screen.getByLabelText(/password/i), {
        target: { value: "secret" },
      });
      fireEvent.click(screen.getByRole("button", { name: /log in/i }));
      await waitFor(() => {
        expect(mountCaptchaWidget).toHaveBeenCalledTimes(1);
      });
      // Drive the solve callback so the form retries auth.login —
      // login rejects again with captcha_required, captcha signal is
      // re-set, the createEffect re-runs, and a SECOND
      // mountCaptchaWidget is issued. The first cleanup MUST run
      // before the second mount captures its cleanup.
      const firstCall = vi.mocked(mountCaptchaWidget).mock.calls[0];
      if (firstCall === undefined) throw new Error("first mount missing");
      firstCall[3]("token-1");
      await waitFor(() => {
        expect(mountCaptchaWidget).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(cleanup1).toHaveBeenCalledTimes(1);
      });
      expect(cleanup2).not.toHaveBeenCalled();
    });

    it("invokes captcha cleanup if component unmounts before mount promise resolves", async () => {
      const cleanup = vi.fn();
      let resolveMount: ((c: () => void) => void) | undefined;
      vi.mocked(auth.login).mockRejectedValueOnce(
        new ApiError(400, "captcha_required", {
          site_key: "k",
          provider: "turnstile",
        }),
      );
      vi.mocked(mountCaptchaWidget).mockImplementationOnce(
        () =>
          new Promise<() => void>((res) => {
            resolveMount = res;
          }),
      );
      const { unmount } = renderLogin();
      fireEvent.input(screen.getByLabelText(/nick or email/i), {
        target: { value: "alice" },
      });
      fireEvent.input(screen.getByLabelText(/password/i), {
        target: { value: "secret" },
      });
      fireEvent.click(screen.getByRole("button", { name: /log in/i }));
      await waitFor(() => {
        expect(mountCaptchaWidget).toHaveBeenCalledTimes(1);
      });
      // Unmount BEFORE the mount promise resolves.
      unmount();
      // Now resolve — cleanup must still run (the local flag triggers
      // immediate invocation since onCleanup already fired).
      if (resolveMount === undefined) throw new Error("resolveMount not captured");
      resolveMount(cleanup);
      await waitFor(() => {
        expect(cleanup).toHaveBeenCalledTimes(1);
      });
    });
  });
});
