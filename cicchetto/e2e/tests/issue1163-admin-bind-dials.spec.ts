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
// construction. What this spec needs, and it has to get it somewhere, is a
// network with an ENABLED SERVER.
//
// ## Why it borrows the seeded network instead of building its own
//
// The first version of this spec built a throwaway network and attached a
// server to it. It passed — and 26 minutes later, in the same run, it failed
// two assertions in `ux-6-g-admin-mobile-h-scroll.spec.ts`, which measures
// that no admin table is wider than a phone panel: 393px against a 365px
// panel, 28px of overflow, read identically by that spec's scrollLeft clamp.
//
// The throwaway network could not be deleted. `Networks.delete_network/1`
// refuses a network that has scrollback, and this is the only spec whose
// network gets a LIVE session — the moment it dials, the server's `$server`
// notices are persisted against that network. The teardown's DELETE was
// refused, the best-effort `catch` swallowed the refusal, and a row with a
// 27-character slug sat in the Networks tab for the rest of the run
// (`workers: 1`, so every later spec saw it). The width failure was this
// spec's leak, arriving late and wearing another spec's name.
//
// So it binds a throwaway USER to the SEEDED `bahamut-test` network instead.
// That network is already in the Networks tab and the baseline already fits
// it, so this spec adds nothing to any measured table. The seeded vjt / m9b
// CREDENTIALS other specs depend on are untouched: a second credential on the
// same network is additive, and unbind removes it and stops its session.
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
import { getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

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

// The seeded network is the one with an enabled server (`bahamut-test:6667`),
// which is the whole reason this spec can dial at all. Resolved by slug rather
// than hardcoded: the id is assigned by whichever order the seeder ran in.
async function seededNetworkId(token: string): Promise<number> {
  const res = await api(token, "GET", "/admin/networks");
  if (!res.ok) throw new Error(`seededNetworkId: ${res.status}`);
  const body = (await res.json()) as { networks: { id: number; slug: string }[] };
  const net = body.networks.find((n) => n.slug === NETWORK_SLUG);
  if (net === undefined) throw new Error(`seededNetworkId: no network ${NETWORK_SLUG}`);
  return net.id;
}

// Unbind is the teardown that matters: it stops the live session this spec
// started, so the upstream connection does not outlive the test.
//
// It reports instead of swallowing. A silent best-effort teardown is what
// turned the first version of this spec into a cascade poisoner — the cleanup
// was refused, said nothing, and a later spec paid for it. A leak here cannot
// be allowed to fail the test (that would mask the real verdict), so it lands
// as a test annotation: visible in the report, attached to the spec that
// caused it, and not to the one that trips over it 26 minutes later.
async function unbind(
  token: string,
  userId: string,
  networkId: number,
  testInfo: import("@playwright/test").TestInfo,
): Promise<void> {
  try {
    const res = await api(token, "DELETE", `/admin/credentials/${userId}/${networkId}`);
    if (!res.ok) {
      testInfo.annotations.push({
        type: "leak",
        description: `unbind ${userId}:${networkId} → ${res.status}; a live session may survive this spec`,
      });
    }
  } catch (err) {
    testInfo.annotations.push({ type: "leak", description: `unbind threw: ${String(err)}` });
  }
}

// The user carries this spec's scrollback (the `$server` notices its session
// receives), which CASCADEs away with the row. Deleting the user is therefore
// what keeps the seeded network free of this spec's residue.
async function deleteUser(
  token: string,
  userId: string,
  testInfo: import("@playwright/test").TestInfo,
): Promise<void> {
  try {
    const res = await api(token, "DELETE", `/admin/users/${userId}`);
    if (!res.ok) {
      testInfo.annotations.push({
        type: "leak",
        description: `deleteUser ${userId} → ${res.status}; a throwaway user survives this spec`,
      });
    }
  } catch (err) {
    testInfo.annotations.push({ type: "leak", description: `deleteUser threw: ${String(err)}` });
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
  // An IRC nick caps at 30 chars, so the stamp is shortened here rather than
  // reused whole.
  const nick = `b1163-${Date.now() % 1_000_000}-${testInfo.workerIndex}${testInfo.repeatEachIndex}`;

  const networkId = await seededNetworkId(admin.token);
  let userId: string | null = null;

  try {
    userId = await createUser(admin.token, userName);

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
    await page.getByTestId("admin-credentials-bind-network").selectOption({ label: NETWORK_SLUG });
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
    if (userId !== null) {
      await unbind(admin.token, userId, networkId, testInfo);
      await deleteUser(admin.token, userId, testInfo);
    }
  }
});
