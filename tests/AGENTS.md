# Tests Agent Guide

This directory holds the repository-root suites that `npm run test:scripts` runs
with the native Node test runner. Workspace unit tests stay beside their own
package sources.

- These suites are governance evidence: they assert workflow contracts,
  permissions, report provenance, and documentation rules. Do not relax an
  assertion, deadline, or expected identity to make a run pass.
- Prefer `node --test --test-name-pattern` while iterating. The suites are large
  and create real temporary checkouts and child processes.
- Keep dangerous command strings as inert test data. Assert on how they are
  classified instead of executing them.
- Fixtures under `fixtures/outcome-workload` are deliberately failing input for
  the offline proof. Keep the seeded defects intact and repair only the scratch
  copy that `npm run outcome-proof` creates.
- Tests must not read or modify the user's runtime store, installed extensions,
  or a running dashboard.

Run focused checks from the repository root with:

```sh
npm run test:scripts
npm run outcome-proof
```
