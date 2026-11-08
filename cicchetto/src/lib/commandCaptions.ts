// Command autocomplete captions — the muted line under each `/verb` in the
// `/` menu (CommandMenu.tsx). One caption per builtin verb, in English, a
// few words: the menu's job is to say what the command DOES, not its grammar
// (the grammar is what the user types next).
//
// Completeness is guarded by commandCaptions.test.ts: every verb in
// BUILTIN_VERBS (lib/slashCommands.ts) must have an entry here, so adding a
// verb without a caption fails the suite instead of shipping a bare row.

export const COMMAND_CAPTIONS: Readonly<Record<string, string>> = {
  me: "Sends an action message",
  ame: "Sends an action to every joined channel",
  amsg: "Sends a message to every joined channel",
  ctcp: "Sends a CTCP request",
  ping: "Measures round-trip time to a nick",
  np: "Shares what is now playing",
  join: "Joins a channel",
  part: "Leaves a channel",
  cycle: "Leaves and rejoins a channel",
  topic: "Shows or sets a channel topic",
  nick: "Changes your nick",
  msg: "Sends a private message",
  notice: "Sends a notice",
  query: "Opens a private chat",
  equery: "Opens an encrypted private chat",
  quit: "Disconnects from the network",
  disconnect: "Disconnects a network",
  reconnect: "Reconnects a network",
  connect: "Connects a network",
  away: "Sets or clears your away status",
  op: "Gives operator status",
  deop: "Removes operator status",
  voice: "Gives voice",
  devoice: "Removes voice",
  kick: "Removes a user from a channel",
  kb: "Kicks and bans a user",
  kill: "Disconnects a user from the server",
  ban: "Bans a nick or mask",
  unban: "Removes a ban",
  banlist: "Lists the channel bans",
  invite: "Invites a nick to a channel",
  umode: "Shows or sets your user modes",
  mode: "Shows or sets channel modes",
  who: "Lists users matching a mask",
  names: "Lists the users in a channel",
  list: "Lists channels",
  links: "Lists linked servers",
  recover: "Recovers your nick identity",
  lusers: "Shows server user statistics",
  info: "Shows server information",
  version: "Shows the server version",
  motd: "Shows the message of the day",
  admin: "Shows server admin information",
  stats: "Shows server statistics",
  rehash: "Reloads the server configuration",
  whois: "Shows information about a nick",
  whowas: "Shows information about a nick that left",
  ignore: "Ignores a nick or mask",
  unignore: "Stops ignoring a nick or mask",
  notify: "Watches for a nick coming online",
  watch: "Watches for a nick coming online",
  beep: "Sets the notification sound",
  hilight: "Adds a highlight pattern",
  dehilight: "Removes a highlight pattern",
  highlight: "Adds a highlight pattern",
  credits: "Shows the end credits",
  cs: "Talks to ChanServ",
  ns: "Talks to NickServ",
  ms: "Talks to MemoServ",
  os: "Talks to OperServ",
  hs: "Talks to HelpServ",
  rs: "Talks to RootServ",
  alias: "Defines a command alias",
  unalias: "Removes a command alias",
  quote: "Sends a raw line to the server",
  oper: "Becomes a server operator",
  // Short built-in aliases (slashCommands.ts, post-init): same caption as
  // the verb they stand for.
  q: "Opens a private chat",
  j: "Joins a channel",
  w: "Shows information about a nick",
  n: "Lists the users in a channel",
  kickban: "Kicks and bans a user",
  raw: "Sends a raw line to the server",
};

/** The builtin caption for `verb`, or null when it has none (a user alias). */
export const captionForCommand = (verb: string): string | null =>
  COMMAND_CAPTIONS[verb] ?? null;

// An alias expansion is free-form text the user typed, so it can be long:
// the caption keeps the first 40 characters and marks the cut, so the row
// stays one line on a phone.
const ALIAS_EXPANSION_CAP = 40;

/** The caption for a user alias: what it expands to. */
export const aliasCaption = (expansion: string): string => {
  const trimmed = expansion.trim();
  const shown =
    trimmed.length > ALIAS_EXPANSION_CAP
      ? `${trimmed.slice(0, ALIAS_EXPANSION_CAP)}…`
      : trimmed;
  return `Alias for ${shown}`;
};
