import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import GithubSlugger from 'github-slugger';
import { parse as parseJsonc } from 'jsonc-parser';
import { validateCostPolicy } from '../packages/core/dist/index.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKSPACES = ['core', 'hook-runtime', 'mcp-server', 'copilot-plugin', 'extension'];
const OMIT_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'coverage',
  'test-results',
]);
const parser = unified().use(remarkParse);

function withinRoot(root, relative) {
  const target = path.resolve(root, relative);
  const resolved = path.relative(root, target);
  if (resolved.startsWith(`..${path.sep}`) || resolved === '..' || path.isAbsolute(resolved)) {
    throw new Error('Path is outside the repository');
  }
  if (fs.existsSync(target)) {
    const real = path.relative(fs.realpathSync(root), fs.realpathSync(target));
    if (real.startsWith(`..${path.sep}`) || real === '..' || path.isAbsolute(real)) {
      throw new Error('Link is outside the repository');
    }
  }
  return target;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function cell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '')
    .replaceAll('|', '&#124;')
    .replaceAll('`', '&#96;')
    .replace(/\r?\n/g, ' ');
}

function table(headings, rows) {
  return [
    `| ${headings.join(' | ')} |`,
    `| ${headings.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function section(id, heading, inputs, body) {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical(inputs)))
    .digest('hex');
  return {
    start: `<!-- slipstream-reference:${id}:start -->`,
    end: `<!-- slipstream-reference:${id}:end -->`,
    content: [
      `<!-- slipstream-reference:${id}:start -->`,
      `## ${heading}`,
      '',
      'Generated from the public manifests by `npm run docs:write`. Check with `npm run check:docs`.',
      '',
      body,
      '',
      `<!-- source-sha256: ${digest} -->`,
      `<!-- slipstream-reference:${id}:end -->`,
    ].join('\n'),
  };
}

function references(root) {
  const readJson = (relative) => JSON.parse(fs.readFileSync(withinRoot(root, relative), 'utf8'));
  const manifest = readJson('package.json');
  const expected = WORKSPACES.map((name) => `packages/${name}`);
  if (JSON.stringify([...manifest.workspaces].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error('Workspace contract mapping changed; review the documentation coverage map.');
  }
  const packages = Object.fromEntries(
    expected.map((relative) => [relative, readJson(`${relative}/package.json`)]),
  );
  const extension = packages['packages/extension'];
  const settings = [extension.contributes.configuration]
    .flat()
    .flatMap((entry) => Object.entries(entry.properties));
  const tools = extension.contributes.languageModelTools ?? [];
  const server = readJson('server.json');
  const plugin = readJson('packages/copilot-plugin/.mcp.json');
  const localInstall =
    server._meta['io.modelcontextprotocol.registry/publisher-provided'].localInstall;
  return new Map([
    [
      'docs/architecture.md',
      section(
        'build',
        'Build And Script Reference',
        { manifest, packages },
        [
          `Supported Node.js: ${cell(manifest.engines.node)}. The pinned development runtime is in [.node-version](../.node-version).`,
          '',
          table(
            ['Workspace', 'Path', 'Scripts'],
            Object.entries(packages).map(([relative, pkg]) => [
              pkg.name,
              relative,
              Object.keys(pkg.scripts ?? {}).join(', '),
            ]),
          ),
          '',
          table(['Root npm Script', 'Command'], Object.entries(manifest.scripts)),
        ].join('\n'),
      ),
    ],
    [
      'packages/extension/README.md',
      section(
        'extension',
        'Commands And Settings Reference',
        extension,
        [
          table(
            ['Command ID', 'Title'],
            (extension.contributes.commands ?? []).map((command) => [
              command.command,
              command.title,
            ]),
          ),
          '',
          table(
            ['Tool', 'Required Input', 'Input Fields'],
            tools.map((tool) => [
              tool.name,
              (tool.inputSchema?.required ?? []).join(', '),
              Object.keys(tool.inputSchema?.properties ?? {}).join(', '),
            ]),
          ),
          '',
          table(
            ['Setting', 'Type', 'Default'],
            settings.map(([name, schema]) => [
              name,
              schema.type,
              Object.hasOwn(schema, 'default') ? schema.default : '(not specified)',
            ]),
          ),
        ].join('\n'),
      ),
    ],
    [
      'docs/mcp.md',
      section(
        'mcp',
        'MCP Launch Reference',
        { server, plugin, package: packages['packages/mcp-server'] },
        [
          `Registry identity: ${cell(server.name)}. Distribution: ${cell(server._meta['io.modelcontextprotocol.registry/publisher-provided'].distribution)}.`,
          '',
          table(
            ['Surface', 'Command', 'Arguments'],
            [
              ['Local source', localInstall.command, localInstall.args.join(' ')],
              ...Object.entries(plugin.mcpServers).map(([name, config]) => [
                `Plugin: ${name}`,
                config.command,
                config.args.join(' '),
              ]),
            ],
          ),
          '',
          table(
            ['Mode', 'Additional Arguments', 'Tools'],
            Object.entries(localInstall.modes).map(([name, mode]) => [
              name,
              mode.additionalArgs.join(' '),
              mode.tools.join(', '),
            ]),
          ),
        ].join('\n'),
      ),
    ],
  ]);
}

function markdownFiles(root, directory = '') {
  const files = [];
  for (const entry of fs.readdirSync(withinRoot(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (
        OMIT_DIRECTORIES.has(entry.name) ||
        entry.name.startsWith('.slipstream') ||
        entry.name.startsWith('.outcome-proof-') ||
        relative === '.agents/skills/codeblend-ai-composite'
      )
        continue;
      files.push(...markdownFiles(root, relative));
    } else if (
      entry.isFile() &&
      (entry.name.toLowerCase().endsWith('.md') || relative === 'llms.txt')
    ) {
      files.push(relative);
    }
  }
  return files.sort();
}

function textOf(node) {
  return node.value ?? (node.children ?? []).map(textOf).join('');
}

function headings(tree) {
  const slugs = new Set();
  const slugger = new GithubSlugger();
  visit(tree, 'heading', (node) => slugs.add(slugger.slug(textOf(node))));
  return slugs;
}

export function checkDocs(root = REPO_ROOT, { write = false } = {}) {
  root = path.resolve(root);
  const errors = [];
  const written = [];
  let contracts;
  try {
    contracts = references(root);
  } catch (error) {
    return {
      schemaVersion: 1,
      kind: 'documentation-contracts',
      passed: false,
      errors: [error.message],
      written,
    };
  }
  for (const [file, reference] of contracts) {
    const target = withinRoot(root, file);
    if (!fs.existsSync(target)) {
      errors.push(`${file}: reference document is missing`);
      continue;
    }
    const original = fs.readFileSync(target, 'utf8');
    const current = original.replaceAll('\r\n', '\n');
    const start = current.indexOf(reference.start);
    const end = current.indexOf(reference.end);
    if (
      start < 0 !== end < 0 ||
      (start >= 0 &&
        (end <= start ||
          current.indexOf(reference.start, start + 1) >= 0 ||
          current.indexOf(reference.end, end + 1) >= 0))
    ) {
      errors.push(`${file}: generated reference markers are malformed`);
      continue;
    }
    const desired =
      start < 0
        ? `${current.trimEnd()}\n\n${reference.content}\n`
        : current.slice(0, start) + reference.content + current.slice(end + reference.end.length);
    if (desired !== current) {
      if (write) {
        fs.writeFileSync(
          target,
          original.includes('\r\n') ? desired.replaceAll('\n', '\r\n') : desired,
        );
        written.push(file);
      } else {
        errors.push(`${file}: generated manifest reference is stale; run npm run docs:write`);
      }
    }
  }
  const files = markdownFiles(root);
  const documents = new Map(
    files.map((file) => [file, parser.parse(fs.readFileSync(withinRoot(root, file), 'utf8'))]),
  );
  const anchors = new Map([...documents].map(([file, tree]) => [file, headings(tree)]));
  let localLinks = 0;
  let jsonExamples = 0;
  for (const [file, tree] of documents) {
    visit(tree, ['link', 'image', 'definition'], (node) => {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(node.url)) return;
      localLinks++;
      try {
        const [urlPath, fragment] = node.url.split('#');
        const decoded = decodeURIComponent(urlPath.split('?')[0]);
        const relative = decoded
          ? path.posix.normalize(
              decoded.startsWith('/')
                ? decoded.slice(1)
                : path.posix.join(path.posix.dirname(file), decoded),
            )
          : file;
        const target = withinRoot(root, relative);
        if (!fs.existsSync(target)) throw new Error('target does not exist');
        if (
          fragment &&
          anchors.has(relative) &&
          !anchors.get(relative).has(decodeURIComponent(fragment))
        )
          throw new Error('heading does not exist');
      } catch (error) {
        errors.push(`${file}:${node.position.start.line}: invalid local link (${error.message})`);
      }
    });
    visit(tree, 'code', (node) => {
      if (!['json', 'jsonc'].includes(node.lang)) return;
      jsonExamples++;
      const parseErrors = [];
      const value = parseJsonc(node.value, parseErrors, {
        disallowComments: node.lang === 'json',
        allowTrailingComma: node.lang === 'jsonc',
      });
      if (parseErrors.length || value === undefined) {
        errors.push(`${file}:${node.position.start.line}: invalid ${node.lang} example`);
        return;
      }
      const policy = value?.['slipstream.costPolicy'] ?? value?.costPolicy;
      if (policy !== undefined) {
        try {
          validateCostPolicy(policy);
        } catch {
          errors.push(`${file}:${node.position.start.line}: invalid cost-policy example`);
        }
      }
    });
  }
  return {
    schemaVersion: 1,
    kind: 'documentation-contracts',
    passed: errors.length === 0,
    contracts: [...contracts.keys()],
    coverage: { markdownFiles: files.length, localLinks, jsonExamples },
    residual: [
      'Narrative claims, external links, runtime enforcement, and live-provider outcomes require review.',
    ],
    errors,
    written,
  };
}

function main() {
  const args = process.argv.slice(2);
  const reportIndex = args.indexOf('--report');
  const flags = args.filter((_, index) => index !== reportIndex + 1 || reportIndex < 0);
  if (
    flags.some((flag) => !['--write', '--report'].includes(flag)) ||
    (reportIndex >= 0 && !args[reportIndex + 1])
  ) {
    throw new Error('Usage: check-docs.mjs [--write] [--report relative-path]');
  }
  const report = checkDocs(REPO_ROOT, { write: args.includes('--write') });
  if (reportIndex >= 0) {
    const target = withinRoot(REPO_ROOT, args[reportIndex + 1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
