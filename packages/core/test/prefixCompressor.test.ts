import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import {
  planPrefixFold,
  expandPrefixFold,
} from '../src/compressors/prefixCompressor.js';

const PREFIX = '/home/user/dev/workspace/my-project/packages/core/src/';

function listing(files: string[]): string {
  return files.map((f) => `${PREFIX}${f}`).join('\n');
}

describe('planPrefixFold', () => {
  it('folds a shared long path prefix into a legend', () => {
    const input = listing([
      'engine.ts',
      'contentRouter.ts',
      'compressors/logCompressor.ts',
      'compressors/jsonCompressor.ts',
      'compressors/prefixCompressor.ts',
    ]);
    const plan = planPrefixFold(input);
    expect(plan).not.toBeNull();
    // The legend defines a placeholder mapped to the shared prefix.
    expect(plan!.text).toContain(`= ${PREFIX}`);
    // The body references the placeholder instead of repeating the prefix.
    expect(plan!.legend.length).toBeGreaterThan(0);
    const placeholder = plan!.legend[0].placeholder;
    expect(plan!.text).toContain(`${placeholder}engine.ts`);
    expect(plan!.savedChars).toBeGreaterThan(0);
  });

  it('round-trips byte-for-byte via expandPrefixFold', () => {
    const input = listing([
      'a/one.ts',
      'a/two.ts',
      'b/three.ts',
      'b/four.ts',
      'c/five.ts',
    ]);
    const plan = planPrefixFold(input);
    expect(plan).not.toBeNull();
    expect(expandPrefixFold(plan!.text)).toBe(input);
  });

  it('folds Windows-style paths too', () => {
    const win = 'C:\\Users\\dev\\project\\src\\';
    const input = [
      `${win}engine.ts`,
      `${win}router.ts`,
      `${win}index.ts`,
      `${win}types.ts`,
    ].join('\n');
    const plan = planPrefixFold(input);
    expect(plan).not.toBeNull();
    expect(expandPrefixFold(plan!.text)).toBe(input);
  });

  it('returns null when the prefix occurs too few times', () => {
    const input = listing(['only.ts', 'two.ts']);
    expect(planPrefixFold(input)).toBeNull();
  });

  it.each([
    ['labelC:/dev/project/src/', 'C:/dev/project/src/'],
    ['C:relative\\project\\src\\', 'C:relative\\project\\src\\'],
    ['//server/share/project/src/', '/server/share/project/src/'],
    ['alpha/beta//long-project-name/src/', '/long-project-name/src/'],
    ['root/folder/C:/long-project-name/src/', '/long-project-name/src/'],
    ['relative/@scope/pkg.with-dots/src/', 'relative/@scope/pkg.with-dots/src/'],
  ])('preserves path token boundaries in %s', (prefix, expectedPrefix) => {
    const input = ['one.ts', 'two.ts', 'three.ts', 'four.ts']
      .map((fileName) => `${prefix}${fileName}:42`)
      .join('\n');
    const plan = planPrefixFold(input);
    expect(plan).not.toBeNull();
    expect(plan!.legend[0].value).toBe(expectedPrefix);
    expect(expandPrefixFold(plan!.text)).toBe(input);
  });

  it.each(['', '/file', '\\file'])('bounds work for a long non-path ending in %s', (suffix) => {
    const input = '+'.repeat(200_000) + suffix;
    expect(runInNewContext('planPrefixFold(input)', { planPrefixFold, input }, {
      timeout: 1000,
    })).toBeNull();
  });

  it('returns null when there is no shared long prefix', () => {
    const input = [
      'apples and oranges',
      'a short sentence',
      'nothing pathlike here',
      'plain running text',
    ].join('\n');
    expect(planPrefixFold(input)).toBeNull();
  });

  it('bails out safely when the input already contains a placeholder char', () => {
    const input = `${listing(['a.ts', 'b.ts', 'c.ts', 'd.ts'])}\nsee \u00A7 note`;
    expect(planPrefixFold(input)).toBeNull();
  });
});

describe('expandPrefixFold', () => {
  it('returns the text unchanged when there is no legend', () => {
    expect(expandPrefixFold('just some text\nno legend here')).toBe(
      'just some text\nno legend here',
    );
  });
});
