// #1163 — binding a credential from the admin CONSOLE dials the upstream.
//
// The defect: `POST /admin/credentials` wrote the row, returned 201 and never
// spawned a session, while writing `connection_state: :connected` (the schema
// default). The operator saw a credential that claimed a live session, had
// nothing to press, and got "That network or resource doesn't exist." from
// every send until the node was restarted.
//
// ## Why admin-credentials.spec.ts could not have caught it
//
// That spec binds against networks it creates with `POST /admin/networks` and
// no server row. A server-less network fails plan resolution, so even the
// FIXED code does not dial there — the scenario is blind to this bug by
// construction. This spec therefore adds the one thing that was missing: an
// enabled server, pointed at the same `bahamut-test:6667` testnet the seeder
// uses. Everything else stays throwaway (own user, own network, own nick), so
// nothing here touches the seeded vjt / m9b credentials other specs depend on.
//
// ## The oracle
//
// The Credentials tab renders two independent readings per row, and #1163 is
// precisely the case where they disagreed:
//
//   * CONNECTION — the DB intent (`connection_state`).
//   * LIVE — the BEAM truth, rendered verbatim as `alive` or `BEAM has no pid`.
//
// Before the fix the row read `connected` + `BEAM has no pid`: the U-0 lie,
// visible in the console itself. After it, `connected` + `alive`. Asserting
// BOTH is what makes this a regression test rather than a smoke test —
// `alive` alone would still pass an implementation that spawned the session
// and forgot to commit the state, and `connected` alone is what shipped.
//
// The assertions are repeated after a full page reload so the witness is a
// second server round-trip, not a client-side artifact of the bind response.

import { expectShellReady, openAdminConsole } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// The testnet endpoint the compose seeder binds `vjt` to. Reaching it by its
// docker alias is what makes the spawn real: a dial that resolves, connects
// and registers.
const TESTNET_HOST = "bahamut-test";
const TESTNET_PORT = 6667;

type Admin = ReturnType<typeof getSeededAdmin>;

async function adminLogin(page: import("@playwright/test").Page, seed: Admin): Promise<void> {
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [seed.token, seed.subjectJson] as const,
  );
  await page.goto("/");
  await expectShellReady(page);
}

async function openCredentialsTab(page: import("@playwright/test").Page): Promise<void> {
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-credentials").click();
  await expect(page.getByTestId("admin-credentials-table")).toBeVisible({ timeout: 10_000 });
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return await fetch(`${GRAPPA_BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createUser(token: string, name: string): Promise<string> {
  const res = await api(token, "POST", "/admin/users", {
    name,
    password: "test-password-not-secret",
  });
  if (!res.ok) throw new Error(`createUser: ${name} → ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function createNetwork(token: string, slug: string): Promise<number> {
  const res = await api(token, "POST", "/admin/networks", { slug });
  if (!res.ok) throw new Error(`createNetwork: ${slug} → ${res.status}`);
  return ((await res.json()) as { id: number }).id;
}

// The step that separates this spec from the existing bind coverage: without
// an enabled server the bind cannot dial even when the code is correct.
async function addTestnetServer(token: string, networkId: number): Promise<void> {
  const res = await api(token, "POST", `/admin/networks/${networkId}/servers`, {
    host: TESTNET_HOST,
    port: TESTNET_PORT,
    tls: false,
  });
  if (!res.ok) throw new Error(`addTestnetServer: ${networkId} → ${res.status}`);
}

// Unbind is the teardown that matters: it stops the live session, so the
// throwaway upstream connection does not outlive the test and count against
// the next one. Best-effort — a failed cleanup must not mask the verdict.
async function cleanup(token: string, userId: string | null, networkId: number | null) {
  try {
    if (userId !== null && networkId !== null) {
      await api(token, "DELETE", `/admin/credentials/${userId}/${networkId}`);
    }
    if (networkId !== null) await api(token, "DELETE", `/admin/networks/${networkId}`);
    if (userId !== null) await api(token, "DELETE", `/admin/users/${userId}`);
  } catch {
    // best-effort
  }
}

test("admin binds a credential from the console and the session dials out", async ({
  page,
}, testInfo) => {
  const admin = getSeededAdmin();

  // Stamped per run, not fixed: this spec registers a nick on a persistent
  // testnet, and a fixed identifier makes it once-per-container — `docs/TESTING.md`
  // iso-rerun triage (`--repeat-each`) has to stay available on it. Worker and
  // repeat indices disambiguate runs that land in the same millisecond.
  const stamp = `${Date.now()}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`;
  const userName = `e2e1163-u-${stamp}`;
  const netSlug = `e2e1163-n-${stamp}`;
  // An IRC nick caps at 30 chars, so the stamp is shortened here rather than
  // reused whole.
  const nick = `b1163-${Date.now() % 1_000_000}-${testInfo.workerIndex}${testInfo.repeatEachIndex}`;

  let userId: string | null = null;
  let networkId: number | null = null;

  try {
    userId = await createUser(admin.token, userName);
    networkId = await createNetwork(admin.token, netSlug);
    await addTestnetServer(admin.token, networkId);

    await adminLogin(page, admin);
    await openCredentialsTab(page);

    // Pre-state: the binding does not exist yet, so the row this test is about
    // to assert on cannot be a leftover from an earlier run.
    const credKey = `${userId}:${networkId}`;
    await expect(page.getByTestId(`admin-credential-row-${credKey}`)).toHaveCount(0);

    // The bind goes through the CONSOLE, not the API — the door the operator
    // in the issue actually used, and the one that had no other door on a
    // release image (#1158).
    await page.getByTestId("admin-credentials-bind-user").selectOption({ label: userName });
    await page.getByTestId("admin-credentials-bind-network").selectOption({ label: netSlug });
    await page.getByTestId("admin-credentials-bind-nick").fill(nick);
    await page.getByTestId("admin-credentials-bind-auth-method").selectOption("none");
    await page.getByTestId("admin-credentials-bind-submit").click();

    const row = page.getByTestId(`admin-credential-row-${credKey}`);
    await expect(row).toHaveCount(1, { timeout: 10_000 });

    // The witness. `alive` is the BEAM reading: a Session.Server exists for
    // this (user, network). Before #1163 this cell read `BEAM has no pid` and
    // stayed that way until the node restarted.
    await expect(row).toContainText("alive", { timeout: 10_000 });
    await expect(row).not.toContainText("BEAM has no pid");

    // The other half of U-0: the DB intent agrees with the BEAM. A row that
    // says `connected` is only honest when the pid above exists.
    await expect(row).toContainText("connected");

    // Same two readings after a fresh load, so the verdict rests on a second
    // GET /admin/credentials rather than on the bind response the tab just
    // rendered.
    await page.reload();
    await openCredentialsTab(page);
    const reloadedRow = page.getByTestId(`admin-credential-row-${credKey}`);
    await expect(reloadedRow).toContainText("alive", { timeout: 10_000 });
    await expect(reloadedRow).toContainText("connected");
  } finally {
    await cleanup(admin.token, userId, networkId);
  }
});
