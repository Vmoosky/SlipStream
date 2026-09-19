import * as fs from 'node:fs';
import * as path from 'node:path';

import { IMPROVEMENT_REGISTRY_PATH } from './check-improvement-rules.mjs';
import { registeredRepairPullRequests } from './check-improvement.mjs';

const [rawPullRequest, reason, ...extra] = process.argv.slice(2);
if (
  !rawPullRequest ||
  !/^[1-9]\d*$/.test(rawPullRequest) ||
  !Number.isSafeInteger(Number(rawPullRequest)) ||
  !boundedText(reason, 2000) ||
  extra.length
) {
  throw new Error(
    'Usage: node scripts/check-remediation-rollback.mjs <repair-pr> <bounded-reason>',
  );
}

let target = process.cwd();
const parts = IMPROVEMENT_REGISTRY_PATH.split('/');
for (const [index, part] of parts.entries()) {
  target = path.join(target, part);
  const stat = fs.lstatSync(target);
  if (
    stat.isSymbolicLink() ||
    (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
  ) {
    throw new Error('Improvement registry must be a regular file under real directories');
  }
}
const registry = JSON.parse(
  new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(target)),
);
if (!registeredRepairPullRequests(registry).includes(Number(rawPullRequest))) {
  throw new Error('Rollback is limited to a repair PR registered in improvement evidence');
}
process.stdout.write(`Registered remediation repair PR ${rawPullRequest}.\n`);

function boundedText(value, limit) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= limit &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) || (code >= 0x2028 && code <= 0x202e);
    })
  );
}
