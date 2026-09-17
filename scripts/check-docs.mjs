import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import GithubSlugger from 'github-slugger';
import { parse as parseJsonc } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import shellQuote from 'shell-quote';
import { validateCostPolicy } from '../packages/core/dist/index.js';
import { DOC_CHECKS, documentationContext, isDocumentationFile } from './check-ci.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKSPACES = ['core', 'hook-runtime', 'mcp-server', 'copilot-plugin', 'extension'];
const MCP_SPEC = 'specs/mcp/v1/artifact-retrieval.md';
const SPEC_AGENT = '.github/agents/spec-maintainer.agent.md';
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
    } else if (entry.isFile() && isDocumentationFile(relative)) {
      files.push(relative);
    }
  }
  return files.sort();
}

function textOf(node) {
  return node.value ?? (node.children ?? []).map(textOf).join('');
}

function checkMcpSpec(root, tree) {
  const check = (condition, message) => {
    if (!condition) throw new Error(`${MCP_SPEC}: ${message}`);
  };
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fields = (value, keys) =>
    object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  check(tree, 'versioned specification is missing');
  const blocks = tree.children.filter(
    (node) =>
      node.type === 'code' && node.lang === 'json' && node.meta === 'slipstream-mcp-contract',
  );
  check(blocks.length === 1, 'expected exactly one executable contract block');
  const spec = JSON.parse(blocks[0].value);
  check(
    fields(spec, ['contractId', 'version', 'modeRequirement', 'modes', 'examples']) &&
      spec.contractId === 'slipstream.mcp.artifact-retrieval' &&
      spec.version === 1,
    'unsupported contract identity, version, or fields',
  );
  const requirements = tree.children
    .filter((node) => node.type === 'heading' && node.depth === 3)
    .map(textOf)
    .filter((heading) => heading.startsWith('MCP-'));
  check(
    requirements.length > 0 &&
      requirements.every((requirement) => /^MCP-[A-Z0-9-]+$/.test(requirement)) &&
      new Set(requirements).size === requirements.length,
    'requirements need unique MCP-* headings',
  );
  check(requirements.includes(spec.modeRequirement), 'mode requirement has no declaration');
  check(fields(spec.modes, ['standalone', 'retrieval-only']), 'both server modes are required');
  const server = JSON.parse(fs.readFileSync(withinRoot(root, 'server.json'), 'utf8'));
  const modes =
    server._meta['io.modelcontextprotocol.registry/publisher-provided'].localInstall.modes;
  for (const [mode, tools] of Object.entries(spec.modes)) {
    check(
      Array.isArray(tools) &&
        tools.length > 0 &&
        tools.every((tool) => typeof tool === 'string' && tool.length > 0) &&
        new Set(tools).size === tools.length &&
        Array.isArray(modes[mode]?.tools) &&
        JSON.stringify([...tools].sort()) === JSON.stringify([...modes[mode].tools].sort()),
      `${mode} tool inventory is stale or invalid`,
    );
  }
  check(
    Array.isArray(spec.examples) && spec.examples.length > 0,
    'executable examples are missing',
  );
  const ids = new Set();
  const covered = new Set([spec.modeRequirement]);
  let successes = 0;
  let failures = 0;
  for (const example of spec.examples) {
    check(
      fields(example, ['id', 'requirement', 'arguments', 'expected']) &&
        typeof example.id === 'string' &&
        /^[a-z0-9-]{1,80}$/.test(example.id) &&
        !ids.has(example.id) &&
        requirements.includes(example.requirement) &&
        object(example.arguments),
      'example IDs, requirement references, or arguments are invalid',
    );
    ids.add(example.id);
    covered.add(example.requirement);
    const expected = example.expected;
    if (fields(expected, ['body', 'truncated'])) {
      check(
        typeof expected.body === 'string' && typeof expected.truncated === 'boolean',
        `${example.id}: success needs an exact body and truncation flag`,
      );
      successes++;
    } else {
      check(
        fields(expected, ['error']) &&
          typeof expected.error === 'string' &&
          expected.error.trim().length > 0,
        `${example.id}: expected result must describe either success or an error`,
      );
      failures++;
    }
  }
  check(successes > 0 && failures > 0, 'both successful and rejected examples are required');
  check(
    requirements.every((requirement) => covered.has(requirement)),
    'a requirement has no executable example',
  );
}

function headings(tree) {
  const slugs = new Set();
  const slugger = new GithubSlugger();
  visit(tree, 'heading', (node) => slugs.add(slugger.slug(textOf(node))));
  return slugs;
}

function checkSpecAgent(root) {
  const check = (condition, message) => {
    if (!condition) throw new Error(`${SPEC_AGENT}: ${message}`);
  };
  const target = withinRoot(root, SPEC_AGENT);
  check(fs.existsSync(target), 'manual spec maintainer configuration is missing');
  const source = fs.readFileSync(target, 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  check(frontmatter, 'YAML frontmatter is missing');
  const document = parseDocument(frontmatter[1]);
  check(document.errors.length === 0, 'invalid YAML frontmatter');
  const agent = document.toJS({ maxAliasCount: 0 });
  const keys = [
    'name',
    'description',
    'target',
    'user-invocable',
    'disable-model-invocation',
    'agents',
    'tools',
  ];
  check(
    agent &&
      Object.keys(agent).sort().join(',') === keys.sort().join(',') &&
      agent.name === 'Spec Maintainer' &&
      typeof agent.description === 'string' &&
      agent.description.trim().length > 0 &&
      agent.target === 'vscode' &&
      agent['user-invocable'] === true &&
      agent['disable-model-invocation'] === true &&
      Array.isArray(agent.agents) &&
      agent.agents.length === 0,
    'expected a manual-only VS Code agent without models, hooks, or delegation',
  );
  const extension = JSON.parse(
    fs.readFileSync(withinRoot(root, 'packages/extension/package.json'), 'utf8'),
  );
  const names = [
    'slipstream_readFile',
    'slipstream_runCommand',
    'slipstream_retrieveArtifact',
    'slipstream_getSavings',
  ];
  const references = names.map((name) => {
    const tool = extension.contributes.languageModelTools.find((entry) => entry.name === name);
    check(
      tool?.canBeReferencedInPrompt &&
        typeof tool.toolReferenceName === 'string' &&
        tool.toolReferenceName.length > 0,
      `required extension tool ${name} has no prompt reference`,
    );
    return `${extension.publisher}.${extension.name}/${tool.toolReferenceName}`;
  });
  check(
    Array.isArray(agent.tools) &&
      agent.tools.every((tool) => typeof tool === 'string') &&
      JSON.stringify([...agent.tools].sort()) ===
        JSON.stringify(['search', 'edit', ...references].sort()),
    'tool allowlist does not match the Slipstream extension prompt references',
  );
}

function checkNpmExamples(root, file, node, manifest) {
  const languages = ['sh', 'bash', 'shell', 'console', 'zsh', 'powershell', 'pwsh', 'cmd', 'bat'];
  const result = { checked: 0, errors: [], review: [] };
  if (node.type !== 'inlineCode' && !languages.includes(node.lang?.toLowerCase())) return result;
  let directory = '';
  for (const [offset, source] of node.value.split(/\r?\n/).entries()) {
    const line = node.position.start.line + offset + (node.type === 'code' ? 1 : 0);
    const review = (reason) => result.review.push({ file, line, reason });
    let tokens;
    try {
      tokens = shellQuote.parse(source.replace(/^\s*\$\s+/, ''), (name) => `$${name}`);
    } catch {
      if (/\bnpm\b/.test(source)) review('Command quoting requires manual review.');
      continue;
    }
    const commands = [[]];
    for (const token of tokens) {
      if (token?.comment !== undefined) break;
      if ([';', '&&', '||', '|', '&'].includes(token?.op)) commands.push([]);
      else commands.at(-1).push(token);
    }
    for (const command of commands) {
      while (typeof command[0] === 'string' && /^[A-Za-z_]\w*=/.test(command[0])) command.shift();
      if (command[0] === 'cd') {
        try {
          if (
            directory === null ||
            command.length !== 2 ||
            typeof command[1] !== 'string' ||
            /[$<>~\\]/.test(command[1]) ||
            path.posix.isAbsolute(command[1]) ||
            /^[A-Za-z]:/.test(command[1])
          ) {
            directory = null;
          } else {
            const target = withinRoot(root, path.posix.join(directory, command[1]));
            directory = fs.statSync(target).isDirectory()
              ? path.relative(root, target).split(path.sep).join('/')
              : null;
          }
        } catch {
          directory = null;
        }
        continue;
      }
      if (!['npm', 'npm.cmd'].includes(command[0])) continue;
      const separator = command.indexOf('--');
      const args = command.slice(1, separator < 0 ? undefined : separator);
      if (
        directory === null ||
        args.some((value) => typeof value !== 'string' || /[$<>`]/.test(value))
      ) {
        review('Dynamic or external npm command requires manual review.');
        continue;
      }
      const options = {
        workspace: { type: 'string', short: 'w', multiple: true },
        workspaces: { type: 'boolean' },
        prefix: { type: 'string' },
        'include-workspace-root': { type: 'boolean' },
        'if-present': { type: 'boolean' },
        silent: { type: 'boolean', short: 's' },
      };
      let parsed;
      try {
        parsed = parseArgs({ args, options, allowPositionals: true });
      } catch {
        review('Npm options require manual review.');
        continue;
      }
      const [action, script] = parsed.positionals;
      if (!['run', 'run-script'].includes(action) || !script) continue;
      if (
        parsed.values.prefix &&
        (path.posix.isAbsolute(parsed.values.prefix) ||
          /[~\\]|^[A-Za-z]:/.test(parsed.values.prefix))
      ) {
        review('External npm prefix requires manual review.');
        continue;
      }
      try {
        const selectedDirectory = parsed.values.prefix
          ? path.posix.join(directory, parsed.values.prefix)
          : directory;
        const selected = manifest(selectedDirectory);
        let targets = [selected];
        if (parsed.values.workspace || parsed.values.workspaces) {
          const workspaces = (selected.workspaces ?? []).map((relative) => ({
            relative,
            value: manifest(path.posix.join(selectedDirectory, relative)),
          }));
          if (workspaces.length === 0) throw new Error('no npm workspaces defined');
          const selectors = parsed.values.workspace ?? [];
          const matches = ({ relative, value }, selector) =>
            selector === value.name || path.posix.relative(selector, relative) === '';
          targets = workspaces
            .filter(
              (workspace) =>
                parsed.values.workspaces ||
                selectors.some((selector) => matches(workspace, selector)),
            )
            .map(({ value }) => value);
          for (const selector of selectors) {
            if (!workspaces.some((workspace) => matches(workspace, selector))) {
              throw new Error(`unknown npm workspace: ${selector}`);
            }
          }
          if (parsed.values['include-workspace-root']) targets.push(selected);
        }
        result.checked++;
        for (const target of targets) {
          if (!Object.hasOwn(target.scripts ?? {}, script) && !parsed.values['if-present']) {
            throw new Error(`unknown npm script: ${script}`);
          }
        }
      } catch (error) {
        result.errors.push(`${file}:${line}: ${error.message}`);
      }
    }
  }
  return result;
}

export function checkDocs(root = REPO_ROOT, { write = false, context = null } = {}) {
  root = path.resolve(root);
  const errors = [];
  const written = [];
  let contracts;
  let sourceContext = null;
  try {
    if (context !== null) {
      if (write) throw new Error('CI documentation validation must be check-only.');
      sourceContext = documentationContext(root, context);
    }
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
  const files = sourceContext?.documents ?? markdownFiles(root);
  const documents = new Map(
    files.map((file) => [file, parser.parse(fs.readFileSync(withinRoot(root, file), 'utf8'))]),
  );
  try {
    checkMcpSpec(root, documents.get(MCP_SPEC));
  } catch (error) {
    errors.push(error.message);
  }
  try {
    checkSpecAgent(root);
  } catch (error) {
    errors.push(error.message);
  }
  const anchors = new Map([...documents].map(([file, tree]) => [file, headings(tree)]));
  let localLinks = 0;
  let jsonExamples = 0;
  let npmCommands = 0;
  const manualExamples = [];
  const manifests = new Map();
  const manifest = (directory) => {
    const file = path.posix.join(directory, 'package.json');
    if (!manifests.has(file)) {
      manifests.set(file, JSON.parse(fs.readFileSync(withinRoot(root, file), 'utf8')));
    }
    return manifests.get(file);
  };
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
    visit(tree, ['code', 'inlineCode'], (node) => {
      const npm = checkNpmExamples(root, file, node, manifest);
      npmCommands += npm.checked;
      errors.push(...npm.errors);
      manualExamples.push(...npm.review);
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
    coverage: { markdownFiles: files.length, localLinks, jsonExamples, npmCommands },
    scope: {
      kind: 'repository-wide',
      checks: [...DOC_CHECKS],
      files,
      context: sourceContext,
    },
    manualExamples,
    residual: [
      'Narrative claims, external links, dynamic commands, runtime enforcement, and live-provider outcomes require review.',
    ],
    errors,
    written,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      write: { type: 'boolean', default: false },
      report: { type: 'string' },
      ci: { type: 'boolean', default: false },
    },
  });
  let context = null;
  if (values.ci || process.env.SLIPSTREAM_DOCS_CI === 'true') {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    context = {
      revision: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      eventName: process.env.GITHUB_EVENT_NAME,
      workflow: process.env.GITHUB_WORKFLOW_REF,
      headRevision: event.pull_request?.head?.sha ?? process.env.GITHUB_SHA,
      baseRevision: event.pull_request?.base?.sha ?? event.before ?? null,
    };
  }
  const report = checkDocs(REPO_ROOT, { write: values.write, context });
  if (values.report) {
    const target = withinRoot(REPO_ROOT, values.report);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
