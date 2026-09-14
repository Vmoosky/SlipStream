import { detectContentKind, isWorthCompressing } from '../contentRouter.js';
import type { EngineConfig } from '../engine.js';
import type { ContentKind, Segment } from '../types.js';
import { planBlobCompression } from './blobCompressor.js';
import { planCodeCompression } from './codeCompressor.js';
import { planConfigCompression } from './configCompressor.js';
import { planDiffCompression } from './diffCompressor.js';
import { planJsonCompression } from './jsonCompressor.js';
import { planLogCompression } from './logCompressor.js';
import { planNearDupCompression } from './nearDupCompressor.js';
import { planPrefixFold } from './prefixCompressor.js';
import { planSearchCompression } from './searchCompressor.js';
import { planTabularCompression } from './tabularCompressor.js';

export interface CompressionInput {
  text: string;
  lines: readonly string[];
  source: 'output' | 'file';
  fileExtension?: string;
  forceLogCompression?: boolean;
  config: Readonly<EngineConfig>;
}

export interface CompressionContext extends CompressionInput {
  kind: ContentKind;
  bigEnough: boolean;
}

export interface CompressionPlan {
  strategy: string;
  segments: Segment[];
  artifactText?: string;
}

export interface Compressor {
  readonly name: string;
  detect(context: CompressionContext): boolean;
  compress(context: CompressionContext): CompressionPlan | null;
}

export const DEFAULT_COMPRESSORS: readonly Compressor[] = [
  {
    name: 'code',
    detect: ({ source }) => source === 'file',
    compress: ({ text, fileExtension, config }) => {
      const plan = planCodeCompression(text, fileExtension ?? '', config.code);
      return plan && { strategy: 'code', segments: plan.segments };
    },
  },
  {
    name: 'json',
    detect: ({ source, kind }) => source === 'output' && kind === 'json',
    compress: ({ text, config }) => {
      const plan = planJsonCompression(text, config.json);
      return plan && { strategy: `json:${plan.format}`, segments: plan.segments, artifactText: plan.text };
    },
  },
  {
    name: 'diff',
    detect: ({ source, kind }) => source === 'output' && kind === 'diff',
    compress: ({ lines, config }) => {
      const plan = planDiffCompression(lines, config.diff);
      return plan && { strategy: `diff:${plan.format}`, segments: plan.segments };
    },
  },
  {
    name: 'search',
    detect: ({ source, kind }) => source === 'output' && kind === 'search',
    compress: ({ lines, config }) => {
      const plan = planSearchCompression(lines, config.search);
      return plan && { strategy: 'search', segments: plan.segments };
    },
  },
  {
    name: 'tabular',
    detect: ({ source, kind }) => source === 'output' && kind === 'tabular',
    compress: ({ lines, config }) => {
      const plan = planTabularCompression(lines, config.tabular);
      return plan && { strategy: `tabular:${plan.format}`, segments: plan.segments };
    },
  },
  {
    name: 'config',
    detect: ({ source, kind }) => source === 'output' && kind === 'config',
    compress: ({ lines, config }) => {
      const plan = planConfigCompression(lines, config.config);
      return plan && { strategy: `config:${plan.format}`, segments: plan.segments };
    },
  },
  {
    name: 'blob',
    detect: ({ source }) => source === 'output',
    compress: ({ lines, config }) => {
      const plan = planBlobCompression(lines, config.blob);
      return plan && { strategy: 'blob', segments: plan.segments };
    },
  },
  {
    name: 'log',
    detect: ({ source, kind, forceLogCompression, bigEnough }) =>
      source === 'output' && (kind === 'log' || Boolean(forceLogCompression)) && bigEnough,
    compress: ({ lines, config }) => {
      const plan = planLogCompression(lines, config.log);
      return { strategy: `log:${plan.format}`, segments: plan.segments };
    },
  },
  {
    name: 'neardup',
    detect: ({ source }) => source === 'output',
    compress: ({ lines, config }) => {
      const plan = planNearDupCompression(lines, config.neardup);
      return plan && { strategy: 'neardup', segments: plan.segments };
    },
  },
  {
    name: 'prefix',
    detect: ({ source }) => source === 'output',
    compress: ({ text, config }) => {
      const plan = planPrefixFold(text, config.prefix);
      return plan && {
        strategy: 'prefix',
        artifactText: plan.text,
        segments: [{ kind: 'kept', startLine: 1, endLine: plan.lineCount }],
      };
    },
  },
];

export class CompressorRegistry {
  private readonly compressors: readonly Compressor[];

  constructor(compressors: readonly Compressor[] = DEFAULT_COMPRESSORS) {
    this.compressors = [...compressors];
  }

  compress(input: CompressionInput): CompressionPlan | null {
    if (!input.config.enabled ||
      !(input.source === 'file' ? input.config.readLifecycle : input.config.compressLogs)) {
      return null;
    }
    const context: CompressionContext = {
      ...input,
      kind: detectContentKind(input.text, input.fileExtension),
      bigEnough: isWorthCompressing(input.text, input.lines.length),
    };
    for (const compressor of this.compressors) {
      if (!compressor.detect(context)) continue;
      const plan = compressor.compress(context);
      if (plan) return plan;
    }
    return null;
  }
}