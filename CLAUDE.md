# CLAUDE.md

Guidance for Claude Code sessions working in this repo. This is a public-facing
project under the user's name — hold shipped docs to that bar, not a prototype's.

## Docs (README, CHANGELOG, docs/*, package.json descriptions)

- No former-name or project-history narrative in shipped docs — no "formerly
  called X," no rename footnotes, no mentions of abandoned approaches. If you
  find residue from an old name or a dropped idea, delete it; don't just stop
  adding to it. This applies to code comments and identifiers too (e.g. a
  variable or directive named after something the project used to be).
- CHANGELOG entries are release notes for someone with no project history: what
  shipped and why it matters, in plain language. Not a chronological log of
  internal implementation steps — `git log`, `docs/design.md`, and
  `docs/architecture.md` are where that detail belongs.
- Technical claims are fine and encouraged (this repo backs its claims with
  measured numbers and executable proofs) — but cash out jargon with what it
  actually does or a real number. Don't drop a subsystem name and assume the
  reader already knows what it means or why they'd care.

## Chat replies

- Don't use bracket/placeholder notation (e.g. `<intro: ...>`) to represent
  real file content or summarize a document's structure — it reads as broken
  or fake. Quote the real text or describe it in plain prose instead.
