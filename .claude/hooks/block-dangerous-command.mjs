import process from 'node:process';

const input = await readInput();
const command = input?.tool_input?.command;

if (!input || (typeof command === 'string' && isDangerousCommand(command))) {
  denyCommand(
    input
      ? 'Blocked destructive shell command. Use a targeted, reversible operation instead.'
      : 'Blocked command because the hook input was invalid.',
  );
}

function isDangerousCommand(command) {
  return [
    /\brm\b(?=[^\r\n;|&]*(?:--recursive\b|-[^\s]*r[^\s]*\b))(?=[^\r\n;|&]*(?:--force\b|-[^\s]*f[^\s]*\b))/i,
    /\b(?:Remove-Item|rm)\b(?=[^\r\n;|&]*-(?:Recurse|r)\b)(?=[^\r\n;|&]*-(?:Force|f)\b)/i,
    /\bgit\s+clean\b(?=[^\r\n;|&]*-[^\s]*f)/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+push\b(?=[^\r\n;|&]*(?:--force(?:-with-lease)?\b|-f\b|\+\S+))/i,
  ].some((pattern) => pattern.test(command));
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

function denyCommand(permissionDecisionReason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason,
      },
    }),
  );
}
