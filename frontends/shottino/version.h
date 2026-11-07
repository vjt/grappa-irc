/* version — what this build of shottino calls itself.
 *
 * ONE definition, reached by everything that states a version: the
 * sidebar header, `--version`, the startup line, and the User-Agent
 * every HTTP request carries. Those User-Agents used to each spell
 * `shottino/0.1` themselves, which is how a client ends up announcing
 * one version to the server and showing another to the person using it.
 *
 * Shottino versions SEPARATELY from grappa. It is a client that talks to
 * whatever grappa it is pointed at, and compatibility is decided by the
 * wire's `protocol_version` (see docs/CLIENT_PROTOCOL.md), not by
 * matching release numbers. Sharing grappa's number would promise a
 * lockstep that does not exist.
 *
 * Overridable at build time (-DSHOTTINO_VERSION=\"...\") so a release
 * can stamp a build without editing a tracked file.
 */
#ifndef SHOTTINO_VERSION_H
#define SHOTTINO_VERSION_H

#ifndef SHOTTINO_VERSION
#define SHOTTINO_VERSION "0.4.3"
#endif

/* What goes on the wire. Kept here so it cannot drift from the number
 * shown in the corner. */
#define SHOTTINO_USER_AGENT "shottino/" SHOTTINO_VERSION

#endif /* SHOTTINO_VERSION_H */
