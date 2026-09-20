import { spawn } from 'node:child_process';

export async function runQuiet(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', (error) => reject(error));
    child.once('close', (code, signal) => {
      if (code === 0) return resolve();
      const status = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      reject(new Error(`${command} ${args.join(' ')} failed (${status})\n${output}`.trim()));
    });
  });
}

export async function runNpmQuiet(args, options) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return runQuiet(npm, args, options);
}
