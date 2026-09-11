import { addAlias, delAlias } from "../aliasList";
import { playBeep } from "../beep";
import { openCreditsModal } from "../creditsModal";
import { applyNotificationSound } from "../notificationPrefs";
import { NOTIFICATION_SOUND_PRESETS } from "../notificationSound";
import { requestOpenSettings } from "../settingsNav";
import type { CommandHandler } from "./context";

/**
 * The arms that reach no network: two client-side stores, two UI deep-links,
 * and the parser's own failure arriving as a pseudo-verb. None of them resolves
 * a network id or puts a frame on the wire, which is why none of them reads
 * anything off the context record.
 */

/**
 * #356 — a bare watch-family verb (`/notify`, `/watch`, `/hilight`,
 * `/highlight`, `/dehilight`) opens the unified watch-lists settings section
 * rather than printing inline. Opening the drawer IS the feedback, so this is a
 * silent success.
 */
export const openSettingsCommand: CommandHandler<"open-settings"> = async (cmd) => {
  requestOpenSettings(cmd.section);
  return { ok: true };
};

/**
 * #1958 — `/credits` opens the end titles: the same `openCreditsModal` the
 * settings drawer's last entry calls, one verb deep instead of menu → settings
 * → scroll to the bottom. The drawer entry stays — the verb is a shortcut, the
 * drawer is where people find the things they cannot name. Opening the modal
 * IS the feedback, so this is a silent success.
 */
export const openCreditsCommand: CommandHandler<"open-credits"> = async () => {
  openCreditsModal();
  return { ok: true };
};

/**
 * #385 — `/alias <name> <expansion>` defines or overwrites a user alias.
 * Round-tripped through the aliasList store (full-map PUT, server normalizes +
 * validates); a 422 (bad name/expansion, cap exceeded) is thrown as an ApiError
 * and surfaces via `friendlyError` in the dispatcher's catch with the per-field
 * message. The green confirmation echoes the normalized definition.
 */
export const aliasDefineCommand: CommandHandler<"alias-define"> = async (cmd) => {
  await addAlias(cmd.name, cmd.expansion);
  return { ok: `alias: /${cmd.name} → ${cmd.expansion}` };
};

/** #385 — `/unalias <name>` removes a user alias. */
export const unaliasCommand: CommandHandler<"unalias"> = async (cmd) => {
  await delAlias(cmd.name);
  return { ok: `alias: removed /${cmd.name}` };
};

/**
 * #1480 — `/beep <preset>` selects the in-app notification sound. The parser
 * has already narrowed the argument to a real preset name (`on`/`off` resolved
 * there), so this only has to persist it.
 *
 * The write is a server round-trip, not a local flag: the setting converges
 * across devices like every other preference, and the command is a shortcut
 * INTO it rather than a parallel store. A rejected PUT throws and the
 * dispatcher's catch renders it — no silent no-op.
 *
 * The confirmation PLAYS the sound it just selected. This is the one place the
 * feedback can be the thing itself, and it doubles as the user gesture that
 * un-suspends the AudioContext, exactly like the drawer's preview button —
 * which matters most here, because someone who reaches for `/beep` is
 * explicitly avoiding the drawer.
 */
export const beepCommand: CommandHandler<"beep"> = async (cmd) => {
  await applyNotificationSound(cmd.sound);
  playBeep(cmd.sound);
  return { ok: `beep: ${NOTIFICATION_SOUND_PRESETS[cmd.sound].label}` };
};

/**
 * A parser-level failure — an unknown verb, or a verb whose arguments did not
 * validate. Not a command: `parseSlash` returns it in the same union so the
 * dispatcher has one shape to route, and the message it carries is the
 * parser's, not this module's.
 */
export const errorCommand: CommandHandler<"error"> = async (cmd) => {
  return { error: cmd.message };
};
