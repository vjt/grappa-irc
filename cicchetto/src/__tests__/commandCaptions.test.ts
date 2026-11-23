import { describe, expect, it } from "vitest";
import { aliasCaption, COMMAND_CAPTIONS, captionForCommand } from "../lib/commandCaptions";
import { BUILTIN_VERBS } from "../lib/slashCommands";

// Command autocomplete captions (lib/commandCaptions.ts): the muted line
// under each `/verb` in the `/` menu. The completeness guard is the point:
// a verb added to DISPATCH without a caption must fail the suite, not ship
// a bare row.

describe("commandCaptions", () => {
  it("every builtin verb has a non-empty caption", () => {
    const missing = BUILTIN_VERBS.filter((verb) => captionForCommand(verb) === null);
    expect(missing).toEqual([]);
    for (const verb of BUILTIN_VERBS) {
      expect(COMMAND_CAPTIONS[verb]).toMatch(/\S/);
    }
  });

  it("a verb with no builtin caption has none", () => {
    expect(captionForCommand("notaverb")).toBeNull();
  });

  it("an alias caption names its expansion", () => {
    expect(aliasCaption("whois $1")).toBe("Alias for whois $1");
  });

  it("a long alias expansion is cut at 40 characters", () => {
    const expansion = "msg nick this is a very long expansion that keeps going";
    expect(aliasCaption(expansion)).toBe(`Alias for ${expansion.slice(0, 40)}…`);
    expect(aliasCaption(expansion).length).toBe("Alias for ".length + 40 + 1);
  });
});
