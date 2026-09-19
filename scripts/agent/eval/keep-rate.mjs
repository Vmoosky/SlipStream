import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_REVIEW_LIMITS, validateAgentReviewDispositions } from '../../check-agent-review.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function readBoundedFile(root, file, limit) {
  if (process.platform !== 'linux') {
    throw new Error('Evidence evaluation requires Linux opened-file containment checks');
  }
  const canonicalRoot = fs.realpathSync.native(root);
  const requested = path.resolve(canonicalRoot, file);
  const requestedRelative = path.relative(canonicalRoot, requested);
  if (
    !requestedRelative ||
    requestedRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(requestedRelative)
  ) {
    throw new Error('Evidence files must be inside the repository');
  }
  assertNoSymlinkComponents(canonicalRoot, requestedRelative);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(requested, fs.constants.O_RDONLY | noFollow);
  try {
    assertOpenedFileIsInsideRoot(canonicalRoot, requestedRelative, descriptor);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(limit)) {
      throw new Error('Evidence file is invalid or exceeds its byte limit');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (bytes.length !== Number(before.size) || !sameFileSnapshot(before, after)) {
      throw new Error('Evidence file changed while it was read');
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function sameFileSnapshot(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function assertNoSymlinkComponents(root, relativeFile) {
  let current = root;
  for (const component of relativeFile.split(path.sep)) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Evidence files must not use symbolic links');
    }
  }
}

function assertOpenedFileIsInsideRoot(root, relativeFile, descriptor) {
  const target = fs.realpathSync.native(`/proc/self/fd/${descriptor}`);
  const targetRelative = path.relative(root, target);
  if (
    !targetRelative ||
    targetRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(targetRelative)
  ) {
    throw new Error('Evidence files must resolve inside the repository');
  }
}

export function calculateKeepRate(pairs, root = ROOT) {
  if (!Array.isArray(pairs)) throw new Error('Evidence pairs must be an array');
  const counts = { reports: 0, findings: 0, accepted: 0, rejected: 0, deferred: 0, untriaged: 0 };
  for (const pair of pairs) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !pair.every((file) => typeof file === 'string')
    ) {
      throw new Error('Each evidence pair requires a review report and disposition record');
    }
    const result = validateAgentReviewDispositions(
      readBoundedFile(root, pair[1], AGENT_REVIEW_LIMITS.outputBytes),
      readBoundedFile(root, pair[0], AGENT_REVIEW_LIMITS.inputBytes),
    );
    counts.reports++;
    for (const key of ['total', 'accepted', 'rejected', 'deferred', 'untriaged']) {
      counts[key === 'total' ? 'findings' : key] += result.counts[key];
    }
  }
  const resolved = counts.accepted + counts.rejected;
  return {
    schemaVersion: 1,
    kind: 'agent-review-keep-rate',
    evidence: 'local-consistency-only',
    counts,
    resolvedFindings: resolved,
    keepRate: resolved === 0 ? null : counts.accepted / resolved,
    denominator: 'accepted + rejected findings; deferred and untriaged findings are excluded',
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length % 2 !== 0) {
    throw new Error('Usage: keep-rate.mjs [REVIEW_REPORT DISPOSITION_RECORD]...');
  }
  const pairs = Array.from({ length: args.length / 2 }, (_, index) =>
    args.slice(index * 2, index * 2 + 2),
  );
  console.log(JSON.stringify(calculateKeepRate(pairs), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
