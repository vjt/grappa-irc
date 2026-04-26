import { Route, Router } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import Login from "../Login";

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

import * as auth from "../lib/auth";

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
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /log in/i })).toBeInTheDocument();
  });

  it("calls auth.login with form values on submit", async () => {
    vi.mocked(auth.login).mockResolvedValue(undefined);
    renderLogin();
    fireEvent.input(screen.getByLabelText(/name/i), {
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

  it("displays an error message when login rejects", async () => {
    vi.mocked(auth.login).mockRejectedValue(new Error("invalid_credentials"));
    renderLogin();
    fireEvent.input(screen.getByLabelText(/name/i), {
      target: { value: "alice" },
    });
    fireEvent.input(screen.getByLabelText(/password/i), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/invalid/i);
    });
  });
});
