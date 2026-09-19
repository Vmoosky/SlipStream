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
    /\b(?:rm|Remove-Item)\b(?=[^;|&]*(?:--recursive\b|-(?:Recurse|r)\b|-[^\s]*r[^\s]*\b))/i,
    /\bgit\s+clean\b(?=[^;|&]*-[^\s]*f)/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+push\b(?=[^;|&]*(?:--force(?:-with-lease)?\b|-[^\s]*f[^\s]*\b|\+\S+))/i,
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
