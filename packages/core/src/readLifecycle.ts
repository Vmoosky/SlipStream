import { createHash } from 'node:crypto';

export type ReadState = 'fresh' | 'unchanged' | 'modified';

export interface ReadRecord {
  path: string;
  contentHash: string;
  bytes: number;
  lines: number;
  /** Artifact holding the exact bytes returned for this read. */
  artifactId: string;
  readCount: number;
  lastReadAt: number;
}

export interface ReadClassification {
  state: ReadState;
  previous?: ReadRecord;
  contentHash: string;
}

/**
 * Tracks what the model has already been shown for each file.
 *
 * In a real agent loop most file reads are repeats: the same file is read,
 * edited, and read again. Re-sending the whole file each time is the single
 * largest avoidable cost, so we return a marker when nothing changed and a
 * diff when something did.
 */
export class ReadLifecycle {
  private readonly records = new Map<string, ReadRecord>();

  classify(absPath: string, content: string): ReadClassification {
    const key = normalizeKey(absPath);
    const contentHash = hashContent(content);
    const previous = this.records.get(key);
    if (!previous) {
      return { state: 'fresh', contentHash };
    }
    return {
      state: previous.contentHash === contentHash ? 'unchanged' : 'modified',
      previous,
      contentHash,
    };
  }

  /** Record what we actually returned, so the next read can diff against it. */
  commit(params: {
    absPath: string;
    contentHash: string;
    content: string;
    artifactId: string;
  }): ReadRecord {
    const key = normalizeKey(params.absPath);
    const previous = this.records.get(key);
    const record: ReadRecord = {
      path: params.absPath,
      contentHash: params.contentHash,
      bytes: Buffer.byteLength(params.content, 'utf8'),
      lines: params.content === '' ? 0 : params.content.split('\n').length,
      artifactId: params.artifactId,
      readCount: (previous?.readCount ?? 0) + 1,
      lastReadAt: Date.now(),
    };
    this.records.set(key, record);
    return record;
  }

  get(absPath: string): ReadRecord | undefined {
    return this.records.get(normalizeKey(absPath));
  }

  stats(): { tracked: number; totalReads: number } {
    let totalReads = 0;
    for (const record of this.records.values()) {
      totalReads += record.readCount;
    }
    return { tracked: this.records.size, totalReads };
  }

  reset(): void {
    this.records.clear();
  }
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/** Windows paths are case-insensitive; normalize so `C:\A` and `c:\a` match. */
function normalizeKey(absPath: string): string {
  return process.platform === 'win32' ? absPath.toLowerCase() : absPath;
}
