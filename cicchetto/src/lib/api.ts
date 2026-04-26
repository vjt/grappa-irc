// Typed fetch client for the grappa REST surface. The wire shapes mirror
// `GrappaWeb.AuthJSON`, `GrappaWeb.MeJSON`, and `GrappaWeb.FallbackController`
// — keep these types in lockstep with `lib/grappa/accounts/wire.ex` and
// `lib/grappa_web/controllers/fallback_controller.ex`.
//
// Errors collapse to a single `ApiError` carrying the wire token (e.g.
// "invalid_credentials", "unauthorized") so callers branch on a stable
// snake_case string, matching the server's A7 envelope convention. The
// unauthenticated 401 from `Plugs.Authn` and the credential-failure 401
// from login both surface here as `ApiError`.

export type LoginRequest = {
  name: string;
  password: string;
};

export type LoginResponse = {
  token: string;
  user: { id: string; name: string };
};

export type MeResponse = {
  id: string;
  name: string;
  inserted_at: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function readError(res: Response): Promise<ApiError> {
  // The grappa server uses `%{error: "<token>"}` for tagged errors and
  // `%{errors: {detail: ...}}` for Phoenix's default 404/500 fallback —
  // try both before giving up. A non-JSON body collapses to the HTTP
  // status text so the caller still gets a useful `code`.
  try {
    const body = (await res.json()) as { error?: string; errors?: { detail?: string } };
    const code = body.error ?? body.errors?.detail ?? res.statusText;
    return new ApiError(res.status, code);
  } catch {
    return new ApiError(res.status, res.statusText || "unknown");
  }
}

export async function login(req: LoginRequest): Promise<LoginResponse> {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as LoginResponse;
}

export async function me(token: string): Promise<MeResponse> {
  const res = await fetch("/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as MeResponse;
}

export async function logout(token: string): Promise<void> {
  const res = await fetch("/auth/logout", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readError(res);
}
