import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveProjectLabel } from '../src/projectLabel.js';

let workspace: string;

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-project-')));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('resolveProjectLabel', () => {
  it('returns undefined without a start path', () => {
    expect(resolveProjectLabel(undefined)).toBeUndefined();
  });

  it('names the enclosing package root', () => {
    const project = path.join(workspace, 'slipstream');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{}');
    const file = path.join(project, 'src', 'engine.ts');
    fs.writeFileSync(file, '');

    expect(resolveProjectLabel(file)).toBe('slipstream');
    expect(resolveProjectLabel(project)).toBe('slipstream');
  });

  it('prefers the git repository over a nested package in a monorepo', () => {
    const repo = path.join(workspace, 'slipstream');
    const pkg = path.join(repo, 'packages', 'core');
    fs.mkdirSync(pkg, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');

    // The parent folder holds several such repos, mirroring "Repo/slipstream".
    expect(resolveProjectLabel(path.join(pkg, 'index.ts'))).toBe('slipstream');
  });
});
