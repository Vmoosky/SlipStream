import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesRoot = fileURLToPath(new URL('./packages/', import.meta.url));
const dependencyLayers = {
  core: [],
  'hook-runtime': ['core'],
  'mcp-server': ['core'],
  'copilot-plugin': ['core', 'hook-runtime', 'mcp-server'],
  extension: ['core', 'hook-runtime', 'mcp-server'],
};
const workspacePackages = Object.entries(dependencyLayers).map(([directory, dependencies]) => ({
  directory,
  dependencies,
  name: directory === 'extension' ? 'slipstream-vscode' : `@slipstream/${directory}`,
}));

function workspaceForFile(filename) {
  const relative = path.relative(packagesRoot, filename);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    return undefined;
  const directory = relative.split(path.sep)[0];
  return workspacePackages.find((workspace) => workspace.directory === directory);
}

const importBoundaries = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      direction: '{{source}} cannot depend on {{target}}.',
      publicEntry:
        'Import {{target}} through its public package name, not a workspace path or subpath.',
    },
  },
  create(context) {
    const owner = workspaceForFile(context.filename);
    if (!owner) return {};

    function check(source) {
      const specifier =
        source?.type === 'TemplateLiteral' && source.expressions.length === 0
          ? source.quasis[0].value.cooked
          : source?.value;
      if (typeof specifier !== 'string') return;
      let target;
      if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
        target = workspaceForFile(path.resolve(path.dirname(context.filename), specifier));
      } else if (specifier.startsWith('file:')) {
        try {
          target = workspaceForFile(fileURLToPath(specifier));
        } catch {
          return;
        }
      } else {
        target = workspacePackages.find(
          (workspace) => specifier === workspace.name || specifier.startsWith(`${workspace.name}/`),
        );
      }
      if (!target || target === owner) return;
      if (!owner.dependencies.includes(target.directory)) {
        context.report({
          node: source,
          messageId: 'direction',
          data: { source: owner.name, target: target.name },
        });
      } else if (specifier !== target.name) {
        context.report({ node: source, messageId: 'publicEntry', data: { target: target.name } });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.argument?.literal ?? node.argument),
      TSExternalModuleReference: (node) => check(node.expression),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require')
          check(node.arguments[0]);
      },
    };
  },
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/test-results/**',
      '.agents/skills/codeblend-ai-composite/**',
      '.outcome-proof-*/**',
      '.slipstream*/**',
      'tests/fixtures/outcome-workload/src/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
      'no-sparse-arrays': 'error',
      'no-unsafe-finally': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    files: ['packages/**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: { workspace: { rules: { 'import-boundaries': importBoundaries } } },
    rules: { 'workspace/import-boundaries': 'error' },
  },
  {
    files: [
      'scripts/check-*.mjs',
      'scripts/develop.mjs',
      'scripts/maintenance.mjs',
      'tests/check-docs.test.mjs',
      'tests/readiness.test.mjs',
      'eslint.config.mjs',
      'playwright.config.ts',
    ],
    rules: js.configs.recommended.rules,
  },
];
