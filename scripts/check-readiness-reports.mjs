import * as fs from 'node:fs';
import * as path from 'node:path';

const REPORT_FILENAMES = Object.freeze({
  'bounded-agent-review': 'agent-review.json',
  'pr-observability': 'pr-observability.json',
  'continuous-improvement-review': 'improvement.json',
});

export function writeReadinessReport(root, bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024) {
    throw new Error('Invalid readiness report bytes');
  }
  const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (report?.schemaVersion !== 1 || !Object.hasOwn(REPORT_FILENAMES, report.kind)) {
    throw new Error('Unsupported readiness report');
  }
  const directory = path.join(root, 'reports');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Readiness reports require a real output directory');
  }
  const relative = `reports/${REPORT_FILENAMES[report.kind]}`;
  fs.writeFileSync(path.join(root, relative), bytes, { flag: 'wx', mode: 0o600 });
  return relative;
}
