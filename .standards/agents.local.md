# Repository instructions

- Preserve unrelated changes and verify the behavior affected by your work.
- Complete all agreed product features in the browser and obtain explicit owner usability acceptance before iOS/macOS feature work.
  Then advance one native platform at a time; follow [the product sequence](docs/product-development.md).
- Use matching skills in `.agents/skills/` when relevant, loading only the references needed for the current task.
- Public documentation uses English `*.md` files and Japanese `*.ja.md` counterparts.
  This convention does not change the language of user conversations or the app UI.
- Before editing documentation, read [the documentation rules](docs/rules/documentation.md).
  Read only the affected documents and sections; do not load or retranslate the entire documentation tree.
- Update the affected English/Japanese sections together. Preserve commands, identifiers,
  dated evidence, and distinctions between implemented, tested, and planned behavior.
- After documentation changes, run `npm run docs:check` and `mise run lint`.
  Documentation-only changes do not require native builds, model calls, or performance benchmarks.
- Keep this file short. Put detailed documentation policy in `docs/rules/documentation.md`;
  do not duplicate that policy in separate agent-specific instruction files.
