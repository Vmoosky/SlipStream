import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Walk from `startPath` up to the filesystem root, returning the first ancestor
 * (inclusive) that directly contains `marker`. Returns undefined when no such
 * directory exists.
 */
function findMarkerRoot(startPath: string, marker: string): string | undefined {
  let dir = path.resolve(startPath);
  // A file path resolves to its directory; a directory resolves to itself.
  try {
    if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
  } catch {
    // Path may not exist yet; treat the resolved value as a directory.
  }

  while (true) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve a human-readable project name for `startPath`.
 *
 * The enclosing git repository is the truest notion of "the project", so a
 * `.git` boundary wins even inside a monorepo where individual packages carry
 * their own `package.json`. When nothing is version-controlled, fall back to the
 * nearest package root so single-folder projects still get a meaningful name.
 *
 * Returns the basename of the resolved root, or undefined when neither marker is
 * found (for example an empty or unsaved workspace).
 */
export function resolveProjectLabel(startPath: string | undefined): string | undefined {
  if (!startPath) return undefined;
  const root = findMarkerRoot(startPath, '.git') ?? findMarkerRoot(startPath, 'package.json');
  if (!root) return undefined;
  return path.basename(root) || undefined;
}
