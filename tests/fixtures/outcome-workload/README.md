# Offline Outcome Workload

This deliberately failing test fixture supplies realistic command output for the
offline proof and compression benchmark. It is not an application, a separate
npm workspace, or a required passing test suite in its original state.

From the repository root, run `npm ci`, `npm run build`, then
`npm run outcome-proof`. The proof copies the fixture to temporary storage,
applies the known fix there, verifies the repaired tests and build, and removes
the temporary files. All tools resolve from the root installation.

Keep the two seeded defects intact. Changes to this workload require review of
the proof's ground-truth fix and measurement assumptions.