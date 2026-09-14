import * as path from 'node:path';

/**
 * Filesystem guards for tools that accept a caller-supplied path.
 *
 * The model chooses these paths, and model input is attacker-influenced
 * whenever it has read untrusted content. Every path is resolved and checked
 * against the workspace roots before any I/O happens.
 */

/** Files that are never returned even when inside a workspace root. */
const DENY_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env($|\.)/i,
  /(^|[\\/])\.git[\\/]/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|pfx|p12|key|keystore|jks)$/i,
  /(^|[\\/])(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt))?$/i,
  /(^|[\\/])\.aws[\\/]/i,
  /(^|[\\/])\.ssh[\\/]/i,
  /(^|[\\/])\.azure[\\/]/i,
];

export class PathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathAccessError';
  }
}

function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  return resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
}

export function isWithinRoots(target: string, roots: readonly string[]): boolean {
  if (roots.length === 0) {
    return false;
  }
  const resolved = path.resolve(target);
  return roots.some((root) => {
    const normalized = normalizeRoot(root);
    return (
      resolved === normalized.slice(0, -1) ||
      resolved.startsWith(normalized)
    );
  });
}

export function isDeniedPath(target: string): boolean {
  const resolved = path.resolve(target);
  return DENY_PATTERNS.some((re) => re.test(resolved));
}

/**
 * Resolve a caller-supplied path, or throw with a message the model can act on.
 * Returns the absolute, normalized path.
 */
export function assertReadablePath(target: string, roots: readonly string[]): string {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new PathAccessError('A non-empty file path is required.');
  }
  if (target.includes('\0')) {
    throw new PathAccessError('File path contains an illegal null byte.');
  }
  const resolved = path.resolve(target);
  if (!isWithinRoots(resolved, roots)) {
    throw new PathAccessError(
      `Refusing to read "${target}": it is outside the open workspace folders. ` +
        `Only files under ${roots.join(', ') || '(no workspace)'} can be read.`,
    );
  }
  if (isDeniedPath(resolved)) {
    throw new PathAccessError(
      `Refusing to read "${target}": the path matches a protected secret pattern ` +
        `(.env, keys, credentials). Ask the user to open it manually if it is really needed.`,
    );
  }
  return resolved;
}
