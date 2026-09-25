// #162 — cic-side single source of truth for the per-network ignore list.
//
// Same shape as `highlightList.ts`, for the same reason: the list is server
// `user_settings` with NO broadcast, and every REST mutation answers the
// authoritative post-mutation list (`{masks, mask, outcome}`). Mirroring that
// answer here means the `/ignore` verbs and the ignore-list settings
// sub-page read ONE state that cannot drift — the sub-page refreshes on
// open, and an `/ignore` typed in the compose box updates the list an open
// sub-page is showing.
//
// Keyed by network SLUG, which is how the REST surface and the server-side
// `user_settings.data.ignores` map address it. The value is the ENTRY list
// (issue 2294) — `{mask, text_pattern}` — not the bare masks: an entry is
// identified by the PAIR, so a store keyed on the mask alone could not tell
// two bridged authors apart, and the × would remove the wrong rule.
//
// cic NEVER originates state here: the signal only ever holds what the last
// server round-trip returned. Identity-scoped, so a logout / account switch
// clears the previous account's masks instead of rendering them for the next
// one until a refresh.

import { createSignal } from "solid-js";
import {
  deleteIgnore,
  getIgnores,
  type IgnoreAddResponse,
  type IgnoreEntry,
  type IgnoreRemoveResponse,
  postIgnore,
} from "./api";
import { identityScopedStore } from "./identityScopedStore";

const exports_ = identityScopedStore((onIdentityChange) => {
  const [ignoresBySlug, setIgnoresBySlug] = createSignal<Record<string, IgnoreEntry[]>>({});

  onIdentityChange(() => setIgnoresBySlug({}));

  const mirror = (slug: string, entries: IgnoreEntry[]): void => {
    setIgnoresBySlug((prev) => ({ ...prev, [slug]: entries }));
  };

  // Fetch one network's list (sub-page open, bare `/ignore`). Mirror + return.
  const refreshIgnores = async (token: string, slug: string): Promise<IgnoreEntry[]> => {
    const entries = await getIgnores(token, slug);
    mirror(slug, entries);
    return entries;
  };

  // Add an entry; mirror the list and return the whole answer — the verb
  // prints the outcome on the NORMALISED entry, not the list.
  const addIgnore = async (
    token: string,
    slug: string,
    mask: string,
    textPattern: string | null,
  ): Promise<IgnoreAddResponse> => {
    const r = await postIgnore(token, slug, mask, textPattern);
    mirror(slug, r.entries);
    return r;
  };

  const delIgnore = async (
    token: string,
    slug: string,
    mask: string,
    textPattern: string | null,
  ): Promise<IgnoreRemoveResponse> => {
    const r = await deleteIgnore(token, slug, mask, textPattern);
    mirror(slug, r.entries);
    return r;
  };

  return { ignoresBySlug, refreshIgnores, addIgnore, delIgnore };
});

export const ignoresBySlug = exports_.ignoresBySlug;
export const refreshIgnores = exports_.refreshIgnores;
export const addIgnore = exports_.addIgnore;
export const delIgnore = exports_.delIgnore;
