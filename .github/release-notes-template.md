<!--
  Release notes template (issue 2570). The hand-written top of every GitHub
  Release body follows this shape, above the `---` that separates it from the
  "What's Changed" list `gh release create --generate-notes` appends.
  docs/OPERATIONS.md § "Release-cutting" says when it is written.

  Every section is optional EXCEPT "Packaging", which every release carries:
  downstream packagers read it to learn whether the release touches the
  contract in PACKAGING.md, and a missing section cannot tell them "no change"
  from "forgotten".

  Delete these comments when filling it in.
-->
**<one-line headline, optional>** <Cold|Hot> deploy (<why, if cold>). Wire `protocol_version` <N, or "N → M">.

### <Area: Server, cicchetto, Security, ...>
- <change> (#<issue>)

### Packaging
<!--
  One bullet per change to the PACKAGING.md contract this release carries,
  each saying whether it is compatible or incompatible. An incompatible change
  needs a major version bump (PACKAGING.md § "Change policy"). With no change,
  the section is exactly the line below.
-->
No change to the packaging contract.

---
