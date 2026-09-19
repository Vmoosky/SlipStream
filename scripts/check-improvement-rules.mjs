import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DOC_CONTRACTS } from './check-ci.mjs';

export const IMPROVEMENT_REGISTRY_PATH = '.github/improvement-regressions.json';
export const IMPROVEMENT_RULE_LIMITS = Object.freeze({
  registryBytes: 64 * 1024,
  versions: 16,
  active: 4,
  criterionBytes: 1000,
});

function requireRule(value) {
  if (!value) throw new Error('Invalid learned improvement rules');
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function boundedText(value, limit) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= limit &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (
        code < 32 ||
        (code >= 127 && code <= 159) ||
        (code >= 0x2028 && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function improvementRulePayload(rule) {
  return {
    id: rule.id,
    version: rule.version,
    files: [...rule.files].sort(),
    criterion: rule.criterion,
    source: { kind: rule.source.kind, findingId: rule.source.findingId },
    preventionTest: { file: rule.preventionTest.file, name: rule.preventionTest.name },
  };
}

export function improvementRuleHash(rule) {
  return sha256(JSON.stringify(improvementRulePayload(rule)));
}

export function validateImprovementRules(registry) {
  requireRule(registry?.schemaVersion === 1 && Array.isArray(registry.regressions));
  const registryKeys = ['schemaVersion', 'regressions'];
  for (const key of ['agentReviewRepairs', 'learnedRules']) {
    if (Object.hasOwn(registry, key)) registryKeys.push(key);
  }
  requireRule(exactKeys(registry, registryKeys));
  const rules = Object.hasOwn(registry, 'learnedRules') ? registry.learnedRules : [];
  requireRule(Array.isArray(rules) && rules.length <= IMPROVEMENT_RULE_LIMITS.versions);
  const versions = new Set();
  const active = new Set();
  for (const rule of rules) {
    const keys = [
      'id',
      'version',
      'status',
      'files',
      'criterion',
      'source',
      'preventionTest',
      'reason',
    ];
    if (rule && Object.hasOwn(rule, 'promotion')) keys.push('promotion');
    requireRule(exactKeys(rule, keys));
    requireRule(typeof rule.id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(rule.id));
    requireRule(Number.isSafeInteger(rule.version) && rule.version > 0);
    requireRule(['proposed', 'active', 'retired'].includes(rule.status));
    requireRule(
      Array.isArray(rule.files) &&
        rule.files.length > 0 &&
        rule.files.length <= DOC_CONTRACTS.length &&
        new Set(rule.files).size === rule.files.length &&
        rule.files.every((file) => DOC_CONTRACTS.includes(file)),
    );
    requireRule(boundedText(rule.criterion, IMPROVEMENT_RULE_LIMITS.criterionBytes));
    requireRule(boundedText(rule.reason, 2000));
    requireRule(exactKeys(rule.source, ['kind', 'findingId']));
    requireRule(['ci-regression', 'agent-review'].includes(rule.source.kind));
    requireRule(
      typeof rule.source.findingId === 'string' && /^[a-f0-9]{64}$/.test(rule.source.findingId),
    );
    requireRule(exactKeys(rule.preventionTest, ['file', 'name']));
    requireRule(
      boundedText(rule.preventionTest.file, 300) &&
        /^(?:tests|e2e|packages)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
          rule.preventionTest.file,
        ) &&
        !rule.preventionTest.file.split('/').some((part) => part === '.' || part === '..'),
    );
    requireRule(boundedText(rule.preventionTest.name, 300));
    if (Object.hasOwn(rule, 'promotion')) {
      requireRule(rule.status !== 'proposed');
      requireRule(exactKeys(rule.promotion, ['pullRequest', 'fixCommit', 'afterRunId']));
      requireRule(
        Number.isSafeInteger(rule.promotion.pullRequest) && rule.promotion.pullRequest > 0,
      );
      requireRule(
        typeof rule.promotion.fixCommit === 'string' &&
          /^[a-f0-9]{40}$/.test(rule.promotion.fixCommit),
      );
      requireRule(
        typeof rule.promotion.afterRunId === 'string' &&
          /^[1-9]\d{0,15}$/.test(rule.promotion.afterRunId) &&
          Number.isSafeInteger(Number(rule.promotion.afterRunId)),
      );
    }
    const key = `${rule.id}/${rule.version}`;
    requireRule(!versions.has(key));
    versions.add(key);
    if (rule.status === 'active') {
      requireRule(!active.has(rule.id));
      active.add(rule.id);
    }
  }
  requireRule(active.size <= IMPROVEMENT_RULE_LIMITS.active);
  return rules;
}

export function validateImprovementRuleTransition(before, after) {
  const previous = validateImprovementRules(before);
  const next = validateImprovementRules(after);
  for (const rule of previous) {
    const retained = next.find((entry) => entry.id === rule.id && entry.version === rule.version);
    requireRule(retained && improvementRuleHash(retained) === improvementRuleHash(rule));
    requireRule(
      retained.status === rule.status ||
        (rule.status === 'proposed' && ['active', 'retired'].includes(retained.status)) ||
        (rule.status === 'active' && retained.status === 'retired'),
    );
  }
  for (const rule of next) {
    if (previous.some((entry) => entry.id === rule.id && entry.version === rule.version)) continue;
    requireRule(rule.status === 'proposed');
    requireRule(
      previous
        .filter((entry) => entry.id === rule.id)
        .every((entry) => entry.version < rule.version),
    );
  }
  return next;
}

export function retireImprovementRule(registry, id, version, reason) {
  const rules = validateImprovementRules(registry);
  requireRule(typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id));
  requireRule(Number.isSafeInteger(version) && version > 0);
  requireRule(boundedText(reason, 2000));
  const index = rules.findIndex((rule) => rule.id === id && rule.version === version);
  requireRule(index >= 0 && rules[index].status === 'active');
  const next = structuredClone(registry);
  next.learnedRules[index] = {
    ...next.learnedRules[index],
    status: 'retired',
    reason: reason.trim(),
  };
  validateImprovementRuleTransition(registry, next);
  return next;
}

export function parseImprovementRuleRegistry(bytes) {
  requireRule(
    Buffer.isBuffer(bytes) &&
      bytes.length > 0 &&
      bytes.length <= IMPROVEMENT_RULE_LIMITS.registryBytes,
  );
  const registry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  validateImprovementRules(registry);
  return registry;
}

export function readImprovementRules(root) {
  let target = root;
  const parts = IMPROVEMENT_REGISTRY_PATH.split('/');
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') return { rules: [], registrySha256: null };
      throw error;
    }
    requireRule(!stat.isSymbolicLink());
    requireRule(index === parts.length - 1 ? stat.isFile() : stat.isDirectory());
    if (index === parts.length - 1) requireRule(stat.size <= IMPROVEMENT_RULE_LIMITS.registryBytes);
  }
  const bytes = fs.readFileSync(target);
  const registry = parseImprovementRuleRegistry(bytes);
  return { registry, rules: validateImprovementRules(registry), registrySha256: sha256(bytes) };
}

export function selectImprovementRules(root, files) {
  const { rules, registrySha256 } = readImprovementRules(root);
  const selected = rules
    .filter((rule) => rule.status === 'active' && rule.files.some((file) => files.includes(file)))
    .map(improvementRulePayload)
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : left.version - right.version,
    );
  return {
    rules: selected,
    registrySha256,
    rulesetSha256: sha256(JSON.stringify(selected)),
    supplied: selected.map((rule) => ({
      id: rule.id,
      version: rule.version,
      payloadSha256: improvementRuleHash(rule),
    })),
  };
}
