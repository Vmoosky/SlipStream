import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  IMPROVEMENT_REGISTRY_PATH,
  parseImprovementRuleRegistry,
  retireImprovementRule,
} from './check-improvement-rules.mjs';

const [id, rawVersion, reason, ...extra] = process.argv.slice(2);
if (!id || !rawVersion || !reason || extra.length || !/^[1-9]\d*$/.test(rawVersion)) {
  throw new Error('Usage: node scripts/retire-improvement-rule.mjs <rule-id> <version> <reason>');
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
const registry = parseImprovementRuleRegistry(fs.readFileSync(target));
const retired = retireImprovementRule(registry, id, Number(rawVersion), reason);
fs.writeFileSync(target, `${JSON.stringify(retired, null, 2)}\n`, { encoding: 'utf8' });
process.stdout.write(`Retired learned rule ${id} version ${rawVersion}.\n`);
