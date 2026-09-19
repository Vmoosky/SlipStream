import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const input = await readInput();
const filePath = input?.tool_input?.file_path;
const projectDirectory = input?.cwd ?? process.env.CLAUDE_PROJECT_DIR;

if (typeof filePath === 'string' && typeof projectDirectory === 'string') {
  const projectPath = resolve(projectDirectory);
  const targetPath = resolve(filePath);

  if (isProjectFile(projectPath, targetPath) && isPrettierFile(targetPath)) {
    const prettier = resolve(projectPath, 'node_modules/prettier/bin/prettier.cjs');

    if (existsSync(prettier)) {
      const result = spawnSync(process.execPath, [prettier, '--write', targetPath], {
        cwd: projectPath,
        stdio: 'ignore',
      });

      if (result.status !== 0) {
        process.stderr.write(`Prettier failed for ${targetPath}.\n`);
        process.exitCode = 2;
      }
    }
  }
}

function isProjectFile(projectPath, targetPath) {
  const pathFromProject = relative(projectPath, targetPath);
  return (
    pathFromProject !== '' && !pathFromProject.startsWith('..') && !pathFromProject.includes('../')
  );
}

function isPrettierFile(filePath) {
  return /\.(?:[cm]?[jt]sx?|json|mdx?|ya?ml|css|html)$/i.test(filePath);
}

async function readInput() {
  let text = '';

  for await (const chunk of process.stdin) {
    text += chunk;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
