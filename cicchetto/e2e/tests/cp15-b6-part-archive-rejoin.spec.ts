// CP15 B4 + B6 — Archive section: PART → archive → click → re-join.
//
// Consolidated 2026-05-26 (spec-audit-ez): the prior cp15-b4 spec was
// a strict subset of this lifecycle (PART → archive → click); the only
// unique signal it carried was the "$server is never archived"
// invariant — folded in at the bottom of this spec. b4 deleted.
//
// Asserts the full archive lifecycle:
//   1. PART a joined channel (#bofh, the seeded autojoin) → :parted
//      effect → channel leaves active sidebar + appears in Archive.
//   2. Expand Archive <details> → archive REST fetch → entry visible.
//   3. Click archive entry → ScrollbackPane opens for the parted
//      channel (read-only window — TopicBar still shows the name).
//   4. Type `/join #bofh` in compose → state goes pending → joined.
//      Sidebar entry returns to the active section (channelsBySlug
//      branch); archive entry MUST disappear in the same tick (BUG-A
//      regression guard — the cic-side `visibleArchiveForNetwork`
//      filter mirrors server-side `Scrollback.list_archive/3`'s
//      active_keyset exclusion at render time, so a re-JOINed channel
//      never duplicates between Active + Archive sections).
//   5. $server-never-archived invariant (folded from b4): even with
//      the network archive section open, no "Server" entry appears
//      there — `Scrollback.list_archive/3` filters $server out
//      regardless of active_keyset.
//
// Cleanup: re-JOIN (assertion path itself) leaves #bofh in the
// joined state, matching the seed → no afterEach restoration needed.
// The PART side-effect on autojoin survives across runs otherwise.

import { test, expect } from "../fixtures/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  // Defensive restore — if the re-join assertion failed, #bofh would
  // be left parted and subsequent specs that assume the seed state
  // (M1, BUG7) would fail.
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

test("CP15 B6 — PART → archive → re-join: row moves from active to archive and back; archive list dedup holds", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);

  // PART via REST. server emits :parted → cic drops the channel from
  // channelsBySlug + windowState (own-PART projects to absence per
  // subscribe.ts), so the active sidebar row vanishes.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Expand Archive <details> → loadArchive fires on the open
  // transition → archivedBySlug populates → the parted channel
  // appears as a clickable entry.
  //
  // UX-5 BH (2026-05-19): `.sidebar-network` renamed to
  // `.sidebar-network-section`; legacy `<h3>` per-network header
  // dropped in UX-4 bucket C — `.sidebar-network-header` is the
  // post-C row. Archive `<details>` lifted out of the killed
  // `<section>` wrapper; it's now a flat sibling of the per-network
  // `<ul>` inside the `<For>`. Scoped via xpath sibling axis for
  // forward-compat against multi-network seeds.
  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  const archiveSection = networkSection.locator("xpath=following-sibling::details[@class=\"sidebar-archive\"][1]");
  await archiveSection.locator("summary").click();
  await expect(archiveSection).toHaveAttribute("open", "");
  const archivedEntry = archiveSection.locator("button.sidebar-window-btn", {
    hasText: CHANNEL,
  });
  await expect(archivedEntry).toHaveCount(1, { timeout: 5_000 });

  // Click archive row → ScrollbackPane opens for the parted channel.
  // TopicBar still carries the channel name as the read-only window's
  // header.
  await archivedEntry.click();
  await expect(page.locator(".topic-bar")).toContainText(CHANNEL, { timeout: 5_000 });

  // Re-JOIN via /join in compose. setPending fires synchronously +
  // setSelectedChannel re-focuses; once the upstream JOIN echo lands,
  // channels_changed broadcasts → channelsBySlug refetches → the
  // channel returns to the active section AND the archive list's
  // render-time filter (visibleArchiveForNetwork) drops the entry
  // since it's now in channelsBySlug.
  await composeSend(page, `/join ${CHANNEL}`);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1, { timeout: 5_000 });

  // BUG-A regression guard: the archive entry MUST vanish from the
  // archive section the moment the channel re-enters channelsBySlug.
  // Without the visibleArchiveForNetwork filter (e3934b0), the row
  // would dup-render in both Active + Archive.
  await expect(
    archiveSection.locator("button.sidebar-window-btn", { hasText: CHANNEL }),
  ).toHaveCount(0, { timeout: 5_000 });

  // Final state sanity: members snapshot lands → MembersPane shows
  // the joined branch with vjt-grappa as @ founder.
  const membersPane = page.locator(".members-pane");
  await expect(membersPane.locator("li", { hasText: NETWORK_NICK })).toBeVisible({
    timeout: 5_000,
  });

  // $server-never-archived invariant (folded from cp15-b4 2026-05-26):
  // The Archive section MUST NOT contain a "Server" entry, regardless
  // of active_keyset state — Scrollback.list_archive/3 filters $server
  // out unconditionally. Pin the rule here so a future regression
  // in that filter surfaces in e2e too.
  //
  // We've already re-JOINed #bofh so the archive section is now empty
  // for this network. Re-PART then re-open to verify the rule with a
  // populated archive too.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });
  if (!(await archiveSection.getAttribute("open"))) {
    await archiveSection.locator("summary").click();
    await expect(archiveSection).toHaveAttribute("open", "");
  }
  await expect(
    archiveSection.locator("button.sidebar-window-btn", { hasText: "Server" }),
  ).toHaveCount(0);

  // Restore seed state for downstream specs.
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});
