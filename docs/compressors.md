# Compressors

The strategies that actually remove tokens, the order they are tried in, and the
thresholds that govern each one.

See [architecture.md](architecture.md) for how this fits into the wider system.

---

## The shape of a strategy

Every compressor implements the same three-part interface
(`compressorRegistry.ts:33-38`):

```ts
interface Compressor {
  readonly name: string;
  detect(context: CompressionContext): boolean;
  compress(context: CompressionContext): CompressionPlan | null;
}
```

A **plan** is a list of segments — `kept` and `omitted` line ranges — and
optionally an `artifactText` that those ranges index into
(`compressorRegistry.ts:27-31`). Kept ranges are rendered verbatim; omitted ones
become markers.

There are two models here, and the distinction matters:

- **Segment compressors** omit line ranges from the text as-is. Most
  compressors work this way.
- **Whole-text compressors** (`json`, `prefix`) return rewritten
  `artifactText` — pretty-printed JSON, or a legend-plus-body fold. The store
  holds the *rewritten* text, because that is what the line ranges address.

## Routing

`detectContentKind` sniffs the content once and cheaply (`contentRouter.ts:17`).
Order is deliberate, because the tests overlap:

1. **diff** — `diff --git` or `@@ -n,m +n,m @@` hunk headers.
2. **json** — starts with `{`/`[` *and* actually parses (capped at 2 MB).
3. **code** — by file extension, file reads only.
4. **search** — `path:line:content`. Checked **before** the log heuristic,
   because matched content often contains words like `error` that would
   otherwise route it to `log`.
5. **tabular** — markdown / CSV / TSV.
6. **log** — stack frames, severity words, `error TSxxxx`, `npm ERR!`.
7. **config** — YAML/TOML/INI. Checked **after** log so structured logs are not
   mistaken for config.
8. **text** — nothing matched.

A size gate applies alongside: content under 40 lines *and* under 4000 chars is
not worth a marker at all (`contentRouter.ts:56`).

## Registry order

The first compressor whose `detect` passes **and** whose `compress` returns a
non-null plan wins (`compressorRegistry.ts:136-145`). Specific detectors must
precede general ones.

| # | Name | Fires on | Approach |
| --- | --- | --- | --- |
| 1 | `code` | file reads | outline bodies, keep signatures |
| 2 | `json` | `kind === json` | head/tail of arrays, keep outliers |
| 3 | `diff` | `kind === diff` | trim context between hunks |
| 4 | `search` | `kind === search` | head/tail of matches per file |
| 5 | `tabular` | `kind === tabular` | head/tail rows, keep outliers |
| 6 | `config` | `kind === config` | collapse comment/blank runs |
| 7 | `blob` | any output | elide opaque payloads |
| 8 | `log` | `kind === log`, big enough | severity-aware selection |
| 9 | `neardup` | any output | fold templated runs |
| 10 | `prefix` | any output | fold repeated path prefixes |

The last three are deliberately general and sit at the end: they are fallbacks
for output no structured strategy claimed.

## The strategies

### code — `codeCompressor.ts`

Outlines a source file: keeps declarations and signatures, omits bodies. Only
applies to file reads, where a structural outline is usually what the model
wanted. Unlike `json` nothing is reformatted — segments index into the original
file lines, so kept lines are the file's own bytes and only whole-body runs are
ever omitted. Defaults: `minLines: 60`, `minBlockLines: 6`, `minOmitted: 12`.

### json — `jsonCompressor.ts`

Pretty-prints so each element lands on its own addressable line, then keeps the
first `headItems` and last `tailItems` of long arrays. Notably it also keeps any
element whose serialised length exceeds the **median × `sizeOutlierRatio: 3`** —
an element far larger than its siblings is usually the interesting one.
Defaults: `minItems: 8`, head 2, tail 1.

### diff — `diffCompressor.ts`

Keeps hunk headers and `contextLines: 3` around each change, omitting long
unchanged runs between them.

### search — `searchCompressor.ts`

Groups `path:line:content` matches by file and keeps `headPerFile: 2` /
`tailPerFile: 1`. `keepDistinctRatio: 0.5` is a safety gate: when the matched
text itself is the payload — heading, symbol or definition listings — folding it
away would destroy the result, so a run whose content column is at least that
distinct is kept. Default `minMatches: 20`.

### tabular — `tabularCompressor.ts`

Keeps the header, `headRows: 3`, `tailRows: 2`, and any row longer than the
median row × `sizeOutlierRatio: 3`. Default `minRows: 20`.

### config — `configCompressor.ts`

Collapses runs of comments and blank lines that the log path ignores. Defaults:
`minLines: 40`, `minRunToOmit: 6`.

### blob — `blobCompressor.ts`

Elides opaque payloads: base64, data URIs, minified bundles, hex dumps. Two
mechanisms, because blobs arrive in two shapes.

**Single long lines.** A line over `minLineLength: 2000` that is at least
`opaqueRatio: 0.85` opaque and under `maxWhitespaceRatio: 0.08` whitespace.

**Multi-line runs.** A blob wrapped at a fixed width — MIME base64 at 76
columns, PEM bodies, hex dumps — is invisible to a per-line test, because no
single line is long enough. A run of at least `minRunLines: 8` consecutive lines
each at least `minRunLineLength: 60` chars is folded as a unit.

The guards are tuned so a column of 40-character git SHAs is *not* swallowed. A
short trailing remainder is absorbed into the run, since wrapping rarely divides
evenly and a stranded 8-character fragment helps nobody.

Before the run-folding pass existed, MIME-wrapped base64 compressed **0%** and
was forwarded in full on every turn.

### log — `logCompressor.ts`

The most heavily tuned strategy, because logs are the most common large output.
Keeps `headLines: 6` and `tailLines: 30`, plus errors with `contextBefore: 2` /
`contextAfter: 4`, capping stack frames at 12 and warnings at 20. Clusters
identical lines repeated more than `duplicateThreshold: 3` times. Recognises
jest, vitest, tsc, eslint, npm, cargo, pytest, dotnet, gradle, and a generic
fallback.

`forceLogCompression` routes command-like tools down this path regardless of
what the sniffer concluded.

### neardup — `nearDupCompressor.ts`

Folds **consecutive** lines sharing a normalised template — progress lines,
`processed item N` messages, repeated retries — that differ only by a counter,
timestamp, UUID, or hex id. Exact dedup misses these, and the log compressor only
clusters recognised log lines.

Keeps `head: 2` and `tail: 1` of each run of at least `minRun: 4`.
`minTemplateChars: 8` stops blank lines, separators, and pure-number lines from
folding. Hex normalisation requires at least one digit, so ordinary alphabetic
words that happen to be hex-safe (`added`, `faced`) are left alone.

### prefix — `prefixCompressor.ts`

Path-heavy output repeats the same long directory prefix on line after line.
This defines each prefix once in a small legend and substitutes a short
placeholder throughout.

Semantically lossless rather than segment-based: the legend maps each
placeholder to a fixed literal, so `expandPrefixFold` reconstructs the original
exactly. It **bails out entirely** if the input already contains the placeholder
character, rather than risk an ambiguous fold. Defaults: `minOccurrences: 3`,
`minPrefixLength: 12`, `maxLegend: 6`, `minSavedChars: 40`.

## Layers around the compressors

### ANSI normalisation — `ansiCompressor.ts`

Runs *before* routing, so every compressor sees clean lines. Because
`tokensBefore` is measured on the raw text, stripping escape codes is counted as
a real saving. If nothing else fires but escapes were removed, the result is
labelled `ansi` rather than misreported as passthrough (`engine.ts:768-772`).

### Token-budget refinement — `tokenBudget.ts`

Compressors decide in **lines**; markers cost **tokens**. This pass reverts any
omitted run whose token content does not exceed its marker cost
(`markerTokenCost: 40`, `minNetTokenGain: 8`).

It is purely additive to fidelity — reverting shows *more* verbatim text — and it
trims money-losing markers that an otherwise net-positive plan would keep.

### Cross-turn dedup — `crossTurnDedup.ts`

Runs over surviving kept lines, after compression, so pointers only cover text
that made it through (`engine.ts:828-859`). Two kinds of match, and the
difference is not cosmetic:

- **Exact** — the earlier artifact holds these bytes, so the marker points at
  the **source** artifact.
- **Near** — the differing bytes exist only in *this* output, so the marker must
  point at the **current** artifact. Pointing at the source would hand back the
  wrong content (`markers.ts:47-56`).

Thresholds: `minLines: 3`, `minChars: 120`, `minNearLines: 6`. Indexing is capped
at 200,000 lines.

### Persistent dedup — `persistentDedupIndex.ts`

Extends dedup across sessions via an index rehydrated from the shared storage
dir. Source lines are lazy-loaded from the artifact store and **byte-verified**,
so an evicted source is skipped rather than producing a dangling pointer. Caps:
`maxSources: 800`, `maxSeedsPerSource: 5000`, TTL tracking artifact retention.

## Tuning and verification

Thresholds move per profile — see the table in
[architecture.md](architecture.md#9-configuration). Only `maxFileLines`, `log`,
`json`, `code`, `search`, and `tokenBudget` are profile-controlled; everything
else is set through explicit config overrides.

Adding or retuning a compressor:

```bash
npm test                  # unit tests, including per-compressor suites
npm run proof-table       # measured savings across real scenarios
```

Three failure modes worth testing against explicitly:

**Degenerate fixtures.** Text built from a repeated character folds ~99% via
`neardup` regardless of what you meant to test, so a broken compressor looks
excellent. Use high-entropy content — `crypto.randomBytes(n).toString('base64')`
or a seeded PRNG.

**False positives.** A detector that is too eager swallows content the model
needed. The blob run-folding guards exist specifically so a column of git SHAs
survives; write the negative test alongside the positive one.

**Silent no-ops.** A compressor can be wired in correctly and still never fire
because a threshold excludes real-world input — which is exactly how wrapped
base64 went unnoticed at 0%. Assert the saving, not just the round trip.
