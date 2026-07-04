// UX-6-I.2 (2026-05-22) — real-bundle-swap fixture.
//
// The bundle-refresh spec in bundle-refresh-banner.spec.ts stubs
// the SW + caches API + reload to assert the wiring chain. That proves
// performRefresh INVOKES the right sequence — it does NOT prove the
// browser + nginx + real precache actually converge to the new bundle
// in ONE press (the UX-6-I user-visible bug: "3 presses to pick up a
// new bundle on iPhone PWA").
//
// This fixture supports a higher-fidelity flow:
//   1. snapshotBundle(): copy the current dist (built by cicchetto-
//      build-test) into a side directory so we can restore it after.
//      Self-healing: if a previous run crashed mid-swap and left
//      synthetic bundle B in place, restore from the prior snapshot
//      BEFORE taking the new one (H1 reviewer fix).
//   2. swapToBundleB(): atomically rewrite index.html to point at a
//      freshly-written /assets/index-<newHash>.js stub + drop the stub
//      JS in place. nginx serves from the same bind-mount RO, so the
//      next navigate fetches the new bundle once SW caches are purged.
//   3. restore(): put the original index.html + assets back so
//      subsequent specs (which assume the seeded bundle) see clean
//      state. Per-entry try/catch so a single unwritable leftover
//      doesn't swallow the spec's primary assertion failure (L2
//      reviewer fix).
//
// The runner mounts ../../runtime/e2e/cicchetto-dist at /work/dist-test
// (RW for the swap). Nginx-test mounts the same host path at
// /usr/share/nginx/html (RO) — file swaps on the host land in both
// containers' views, and nginx serves from disk on every request (no
// in-memory cache).
//
// Why a hand-crafted bundle B vs a real vite rebuild:
//   - A real rebuild adds ~30s+ to the spec and depends on bun + node_
//     modules availability inside the test runner image. Out of scope.
//   - The behavior under test is "post-purge reload converges to
//     whatever index.html nginx now serves" — a synthetic index.html
//     pointing at a stub JS asset proves the same convergence without
//     the build overhead. The stub JS doesn't need to boot the SPA;
//     the spec asserts on the script-src hash after reload, not on
//     full page initialization. fsync ordering between the JS write
//     and the HTML rename (M3 reviewer concern) is therefore not a
//     correctness boundary — the assertion is post-reload DOM, not
//     fetched-JS-executes.

import * as fs from "node:fs/promises";
import * as path from "node:path";

// IMPORTANT: keep in lockstep with `cicchetto/src/lib/bundleHashRe.ts`
// `BUNDLE_HASH_RE`. The e2e runner's TS project (cicchetto/e2e/
// tsconfig.json) doesn't include cicchetto/src, and a cross-project
// import via the runner's bind-mount fails ESM resolution under
// Playwright's native Node loader. Inlining the regex is the
// principle-aligned choice: ONE pattern, two surfaces, one comment
// banner that callers can grep for if Vite ever changes asset-hash
// format. Both files carry a reciprocal "lockstep" comment.
const BUNDLE_HASH_RE = /\/assets\/index-([^."]+)\.js/;

const DIST_DIR = "/work/dist-test";
const SNAPSHOT_DIR = "/work/dist-test-snapshot-ux-6-i2";

const INDEX_HTML = "index.html";
const ASSETS_DIR = "assets";

// Sentinel embedded in synthetic bundle B's index.html script tag +
// stub JS filename. Used by the H1 self-heal path to detect "previous
// run crashed mid-swap, dist is in a synthetic state".
const SYNTH_HASH_PREFIX = "Ux6i2Synth";

export interface BundleSwapResult {
  newHash: string;
  oldHash: string;
}

export interface BundleSnapshot {
  restore: () => Promise<void>;
}

/**
 * Copy the dist tree to a side directory so the in-test swap can be
 * reverted on teardown. Self-healing: if a previous crashed run left
 * synthetic bundle B in the dist AND a snapshot from that run still
 * exists, restore the snapshot first so this run captures clean
 * baseline state.
 */
export async function snapshotBundle(): Promise<BundleSnapshot> {
  // H1 self-heal: detect leftover synthetic state from a crashed prior
  // run. If both (a) the snapshot dir from the prior run exists AND
  // (b) dist/index.html points at a synthetic bundle, restore the
  // snapshot over dist BEFORE taking this run's snapshot. Otherwise
  // we'd capture the synthetic state as "baseline" and restore() at
  // end-of-spec would leave the dist permanently broken.
  const snapshotExists = await pathExists(SNAPSHOT_DIR);
  const distIsSynthetic = await distIndexIsSynthetic();
  if (snapshotExists && distIsSynthetic) {
    await replaceDistFromSnapshot();
  }

  await fs.rm(SNAPSHOT_DIR, { recursive: true, force: true });
  await fs.cp(DIST_DIR, SNAPSHOT_DIR, { recursive: true, force: true });

  return {
    restore: async () => {
      const errors: Error[] = [];
      const distEntries = await fs.readdir(DIST_DIR).catch((err: Error) => {
        errors.push(err);
        return [] as string[];
      });
      await Promise.all(
        distEntries
          .filter((e) => e !== ".gitkeep")
          .map(async (e) => {
            try {
              await fs.rm(path.join(DIST_DIR, e), { recursive: true, force: true });
            } catch (err) {
              // L2 reviewer fix: per-entry try/catch + console.warn so
              // a single unwritable leftover doesn't swallow the spec's
              // primary assertion failure. The collected errors are
              // surfaced AFTER the snapshot restore so the operator
              // sees BOTH the spec failure (already thrown) AND the
              // cleanup-failure on the test-output stream.
              const e2 = err as Error;
              console.warn(`bundleSwap.restore: fs.rm(${e}) failed:`, e2.message);
              errors.push(e2);
            }
          }),
      );
      try {
        await fs.cp(SNAPSHOT_DIR, DIST_DIR, { recursive: true, force: true });
      } catch (err) {
        const e2 = err as Error;
        console.warn("bundleSwap.restore: snapshot copy-back failed:", e2.message);
        errors.push(e2);
      }
      try {
        await fs.rm(SNAPSHOT_DIR, { recursive: true, force: true });
      } catch (err) {
        const e2 = err as Error;
        console.warn("bundleSwap.restore: snapshot dir cleanup failed:", e2.message);
        errors.push(e2);
      }
      if (errors.length > 0) {
        throw new Error(
          `bundleSwap.restore: ${errors.length} cleanup error(s); see console.warn output above`,
        );
      }
    },
  };
}

/**
 * Read the bundle hash from the current dist's index.html. Throws if
 * the index.html is missing or has no Vite script tag.
 */
export async function readCurrentBundleHash(): Promise<string> {
  const html = await fs.readFile(path.join(DIST_DIR, INDEX_HTML), "utf8");
  const m = BUNDLE_HASH_RE.exec(html);
  if (!m?.[1]) {
    throw new Error("readCurrentBundleHash: no /assets/index-<hash>.js in dist/index.html");
  }
  return m[1];
}

/**
 * Replace the dist's index.html script tag with a reference to a
 * freshly-written stub JS asset. Returns the old + new hashes so the
 * spec can assert convergence.
 *
 * The stub JS is a minimal ES module — enough for the browser to fetch
 * + parse without console errors. The spec doesn't require the SPA to
 * actually boot; it only verifies the script tag in the reloaded page
 * carries the NEW hash.
 */
export async function swapToBundleB(): Promise<BundleSwapResult> {
  const oldHash = await readCurrentBundleHash();
  const newHash = `${SYNTH_HASH_PREFIX}${Date.now().toString(36)}`;

  const stubJs =
    `// UX-6-I.2 synthetic bundle B — fixture-generated.\n` +
    `console.log("ux-6-i.2 bundle-b loaded: ${newHash}");\n` +
    `export {};\n`;

  await fs.writeFile(path.join(DIST_DIR, ASSETS_DIR, `index-${newHash}.js`), stubJs);

  const htmlPath = path.join(DIST_DIR, INDEX_HTML);
  const html = await fs.readFile(htmlPath, "utf8");
  const newHtml = html.replace(BUNDLE_HASH_RE, `/assets/index-${newHash}.js`);
  // Atomic replace via rename so nginx never serves a half-written
  // file. tmpPath includes pid + timestamp so two parallel runs (today
  // blocked by playwright `workers: 1 + fullyParallel: false`, but the
  // M4 reviewer defense-in-depth) can't collide on the tmp name.
  const tmpPath = `${htmlPath}.tmp-ux-6-i2-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, newHtml);
  await fs.rename(tmpPath, htmlPath);

  return { newHash, oldHash };
}

// ── Internal helpers ───────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function distIndexIsSynthetic(): Promise<boolean> {
  try {
    const html = await fs.readFile(path.join(DIST_DIR, INDEX_HTML), "utf8");
    return html.includes(`index-${SYNTH_HASH_PREFIX}`);
  } catch {
    return false;
  }
}

async function replaceDistFromSnapshot(): Promise<void> {
  const distEntries = await fs.readdir(DIST_DIR);
  await Promise.all(
    distEntries
      .filter((e) => e !== ".gitkeep")
      .map((e) => fs.rm(path.join(DIST_DIR, e), { recursive: true, force: true })),
  );
  await fs.cp(SNAPSHOT_DIR, DIST_DIR, { recursive: true, force: true });
}
