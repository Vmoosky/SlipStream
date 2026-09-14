/** Deterministic, realistic build/test output used by the compression tests. */

export function jestFailureLog(passingSuites = 40): string {
  const lines: string[] = [];
  lines.push('> lumos@1.0.0 test');
  lines.push('> jest --runInBand');
  lines.push('');
  for (let i = 0; i < passingSuites; i++) {
    lines.push(`PASS src/services/module${i}/module${i}.spec.ts (${(2 + (i % 5)).toFixed(3)} s)`);
    lines.push(`  module${i}`);
    lines.push(`    \u2713 resolves the configured endpoint (${3 + (i % 9)} ms)`);
    lines.push(`    \u2713 retries on transient failure (${2 + (i % 7)} ms)`);
    lines.push(`    \u2713 emits a telemetry event (${1 + (i % 4)} ms)`);
    lines.push('');
  }
  lines.push('FAIL src/services/billing/invoice.spec.ts');
  lines.push('  Invoice totals');
  lines.push('    \u2715 applies proportional discounts (14 ms)');
  lines.push('');
  lines.push('  \u25cf Invoice totals \u203a applies proportional discounts');
  lines.push('');
  lines.push('    expect(received).toBe(expected) // Object.is equality');
  lines.push('');
  lines.push('    Expected: 142.5');
  lines.push('    Received: 150');
  lines.push('');
  lines.push('      at Object.<anonymous> (src/services/billing/invoice.spec.ts:48:23)');
  lines.push('      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)');
  lines.push('      at asyncGeneratorStep (node_modules/jest-circus/build/utils.js:231:3)');
  lines.push('      at _next (node_modules/jest-circus/build/utils.js:252:9)');
  lines.push('      at processTicksAndRejections (node:internal/process/task_queues:95:5)');
  lines.push('');
  lines.push('Test Suites: 1 failed, 40 passed, 41 total');
  lines.push('Tests:       1 failed, 120 passed, 121 total');
  lines.push('Snapshots:   0 total');
  lines.push('Time:        92.418 s');
  lines.push('Ran all test suites.');
  return lines.join('\n');
}

/** `count` occurrences of one recurring type error, plus two distinct ones. */
export function tscRepeatedErrors(count = 60): string {
  const lines: string[] = ['> tsc --noEmit', ''];
  for (let i = 0; i < count; i++) {
    lines.push(
      `src/generated/api.ts(${100 + i},${5 + (i % 3)}): error TS2339: Property 'traceId' does not exist on type 'RequestContext'.`,
    );
  }
  lines.push(
    "src/app/router.ts(42,11): error TS2345: Argument of type 'string' is not assignable to parameter of type 'RouteId'.",
  );
  lines.push(
    "src/app/store.ts(88,3): error TS7006: Parameter 'state' implicitly has an 'any' type.",
  );
  lines.push('');
  lines.push(`Found ${count + 2} errors in 3 files.`);
  return lines.join('\n');
}

/** Install output that is almost entirely progress noise. */
export function npmInstallLog(packages = 300): string {
  const lines: string[] = ['> npm install'];
  for (let i = 0; i < packages; i++) {
    lines.push(`npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} ${20 + (i % 400)}ms`);
  }
  lines.push('npm WARN deprecated request@2.88.2: request has been deprecated');
  lines.push('');
  lines.push('added 1284 packages, and audited 1285 packages in 41s');
  lines.push('found 0 vulnerabilities');
  return lines.join('\n');
}

export function sourceFile(lineCount = 200, marker = 'alpha'): string {
  const lines: string[] = [
    "import { createLogger } from './logger';",
    '',
    `export const VARIANT = '${marker}';`,
    '',
  ];
  for (let i = 0; i < lineCount; i++) {
    lines.push(`export function handler${i}(input: string): string {`);
    lines.push(`  return \`${marker}-\${input}-${i}\`;`);
    lines.push('}');
  }
  return lines.join('\n');
}
