# Repository Automation Agent Guide

This directory contains trusted development, documentation, maintenance, and
governance automation. Script behavior is part of the repository's CI and
review evidence contract.

- Prefer deterministic, bounded filesystem and process handling; reject
  ambiguous or unsafe input rather than guessing.
- Preserve exact revision, provenance, approval, and cancellation checks in
  governance scripts.
- Keep documentation generation limited to designated generated blocks;
  authored prose is not generator output.
- Do not weaken CI, review, permissions, or rollback requirements to make a
  check pass.

Run focused checks from the repository root with:

```sh
node --test tests/readiness.test.mjs
node --test tests/check-docs.test.mjs
npm run check:docs
```
