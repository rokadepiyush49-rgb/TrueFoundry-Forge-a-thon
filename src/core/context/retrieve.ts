import * as path from "path";
import { ContextIndex, Chunk } from "./indexer";
import { tokenize, queryIdentifiers, estimateTokens } from "./tokenize";

export interface Evidence {
  signal: "lexical" | "symbol" | "path" | "graph" | "companion" | "mention";
  detail: string;
}

export interface SelectedFile {
  path: string;
  score: number;
  reasons: Evidence[];
  ranges: Array<{ start: number; end: number; symbol?: string }>;
  tokens: number;
  outlineOnly: boolean;
}

export interface ExcludedFile {
  path: string;
  score: number;
  reason: string;
}

export interface ContextReport {
  query: string;
  budget: number;
  used: number;
  selected: SelectedFile[];
  excluded: ExcludedFile[];
  lowConfidence: boolean;
  indexed: { files: number; chunks: number; tokens: number };
  ms: number;
}

export interface RetrieveOptions {
  budget: number;
  /** Files the user explicitly mentioned (@file); always included first. */
  mentions?: string[];
  maxFiles?: number;
  /** When false, only outlines/pointers are returned (cheap "context pack"). */
  includeCode?: boolean;
  /** Maximum one-line pointers (default 10). */
  maxPointers?: number;
}

/**
 * Design note (see docs/evaluation.md): an earlier version fused all signals
 * with weighted reciprocal rank fusion. It beat BM25 on the development set
 * but lost to it on a held-out set (MRR 0.54 vs 0.78), i.e. it overfit. The
 * shipped design therefore lets BM25 alone order the primary files; the other
 * signals only explain choices and add supporting files (definitions of named
 * identifiers, tests/docs of the primaries, import neighbours) into the budget.
 */
const PRIMARY_FILES = 6;
const MAX_SUPPORT = 4;
/** Share of the budget kept for one-line pointers to lower-ranked candidates. */
const POINTER_RESERVE = 0.15;

function stemOf(rel: string): string {
  return path.posix.basename(rel).replace(/\.[^.]+$/, "").replace(/^test_|_test$|\.test$|\.spec$/g, "").toLowerCase();
}

/**
 * Hybrid retrieval: BM25 over symbol-level chunks, exact symbol matches, path
 * matches, and import-graph neighbours, fused with reciprocal rank fusion and
 * packed greedily into a token budget. Every selected file carries the
 * evidence that put it there; every candidate left out says why.
 */
export function retrieve(index: ContextIndex, query: string, opts: RetrieveOptions): ContextReport {
  const t0 = Date.now();
  const terms = tokenize(query);
  const ids = queryIdentifiers(query);
  const reasons = new Map<string, Evidence[]>();
  const addReason = (f: string, e: Evidence) => {
    if (!reasons.has(f)) reasons.set(f, []);
    const list = reasons.get(f)!;
    if (!list.some((x) => x.signal === e.signal && x.detail === e.detail)) list.push(e);
  };

  // 1. lexical (BM25 per chunk, aggregated per file)
  const chunkScores: Array<{ c: Chunk; s: number }> = [];
  for (const c of index.chunks) {
    const s = index.bm25(terms, c);
    if (s > 0) chunkScores.push({ c, s });
  }
  chunkScores.sort((a, b) => b.s - a.s);
  const lexical = new Map<string, number>();
  const bestChunks = new Map<string, Array<{ c: Chunk; s: number }>>();
  for (const cs of chunkScores) {
    const list = bestChunks.get(cs.c.file) || [];
    list.push(cs);
    bestChunks.set(cs.c.file, list);
  }
  for (const [file, list] of bestChunks) {
    const top = list.slice(0, 3);
    lexical.set(file, top[0].s + 0.3 * top.slice(1).reduce((a, x) => a + x.s, 0));
    const matched = [...new Set(terms.filter((t) => top[0].c.tf.has(t)))].slice(0, 5);
    if (matched.length) {
      addReason(file, {
        signal: "lexical",
        detail: `matches ${matched.map((m) => `"${m}"`).join(", ")}${top[0].c.symbol ? ` in ${top[0].c.symbol}` : ""}`,
      });
    }
  }

  // 2. symbols named in the query
  const symbol = new Map<string, number>();
  for (const id of ids) {
    for (const def of index.findSymbol(id)) {
      symbol.set(def.file, (symbol.get(def.file) || 0) + 3);
      addReason(def.file, { signal: "symbol", detail: `defines ${def.parent ? def.parent + "." : ""}${def.name} (L${def.line})` });
    }
  }
  // Plain words that happen to be symbol names ("debug", "run") are weak
  // evidence compared with an explicit identifier, so they form their own,
  // lower-weight signal.
  const incidental = new Map<string, number>();
  const explicitLower = new Set(ids.map((i) => i.toLowerCase()));
  for (const t of new Set(terms)) {
    if (explicitLower.has(t)) continue;
    const defs = index.findSymbol(t).filter((d) => d.kind !== "variable");
    if (defs.length && defs.length <= 6) {
      for (const d of defs) {
        incidental.set(d.file, (incidental.get(d.file) || 0) + 1);
        addReason(d.file, { signal: "symbol", detail: `defines ${d.name} (L${d.line}), a word in the request` });
      }
    }
  }

  // 3. path matches
  const pathScore = new Map<string, number>();
  const distinct = [...new Set(terms)].filter((t) => t.length > 2);
  for (const f of index.files.keys()) {
    const ptoks = new Set(tokenize(f.replace(/[/.]/g, " ")));
    const hits = distinct.filter((t) => ptoks.has(t));
    if (hits.length) {
      pathScore.set(f, hits.length);
      addReason(f, { signal: "path", detail: `path contains ${hits.map((h) => `"${h}"`).join(", ")}` });
    }
  }

  // BM25 alone orders the primary files; they seed the expansion signals
  const lexOrder = [...lexical.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const seeds = lexOrder.slice(0, 5);

  // 4. import graph neighbours of the seeds
  const graph = new Map<string, number>();
  for (const s of seeds) {
    const entry = index.files.get(s);
    for (const imp of entry?.imports || []) {
      if (seeds.includes(imp)) continue;
      graph.set(imp, (graph.get(imp) || 0) + 0.5);
      addReason(imp, { signal: "graph", detail: `imported by ${s}` });
    }
    for (const user of index.importedBy.get(s) || []) {
      if (seeds.includes(user)) continue;
      graph.set(user, (graph.get(user) || 0) + 0.4);
      addReason(user, { signal: "graph", detail: `imports ${s}` });
    }
  }

  // 5. companions: tests and docs that share a seed source file's name
  const companion = new Map<string, number>();
  for (const s of seeds) {
    const se = index.files.get(s);
    if (!se || se.kind !== "source") continue;
    const stem = stemOf(s);
    if (stem.length < 3 || stem === "__init__") continue;
    for (const f of index.files.values()) {
      if (f.path === s) continue;
      if ((f.kind === "test" || f.kind === "doc") && stemOf(f.path) === stem) {
        companion.set(f.path, (companion.get(f.path) || 0) + 1);
        addReason(f.path, { signal: "companion", detail: `${f.kind === "test" ? "tests" : "documents"} ${s}` });
      }
    }
  }

  const byScore = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const primaries = lexOrder.slice(0, PRIMARY_FILES);
  const support: string[] = [];
  for (const f of [...byScore(symbol), ...byScore(companion), ...byScore(graph)]) {
    if (!primaries.includes(f) && !support.includes(f)) support.push(f);
  }
  const topLex = lexical.get(lexOrder[0]) ?? 0;
  // Supporting evidence (named symbol, test/doc companion, import neighbour)
  // sets a score floor so the relevance cutoff never drops a file that is
  // there precisely because of that evidence.
  const supported = new Set([...symbol.keys(), ...companion.keys(), ...graph.keys()]);
  const scoreFor = (f: string) => Math.max((lexical.get(f) ?? 0) / (topLex || 1), supported.has(f) ? 0.5 : 0);
  const shownSupport = support.slice(0, MAX_SUPPORT);
  const ranked = [
    ...primaries.map((f) => ({ f, s: scoreFor(f) })),
    ...shownSupport.map((f) => ({ f, s: scoreFor(f) })),
    ...lexOrder.slice(PRIMARY_FILES).filter((f) => !shownSupport.includes(f)).map((f) => ({ f, s: scoreFor(f) })),
  ];
  void pathScore;
  void incidental;

  // mentioned files go first, unconditionally
  const mentions = (opts.mentions || []).filter((m) => index.files.has(m));
  for (const m of mentions) addReason(m, { signal: "mention", detail: "mentioned by you (@file)" });
  const order = [...mentions, ...ranked.map((r) => r.f).filter((f) => !mentions.includes(f))];
  const scoreOf = new Map(ranked.map((r) => [r.f, r.s]));

  // 6. budget packing: depth (code) for the best files, breadth (one-line
  //    pointers) for the rest, so the agent knows every candidate exists.
  const maxFiles = opts.maxFiles ?? 12;
  const maxPointers = opts.maxPointers ?? 10;
  const includeCode = opts.includeCode ?? true;
  const codeBudget = Math.floor(opts.budget * (1 - POINTER_RESERVE));
  const selected: SelectedFile[] = [];
  const excluded: ExcludedFile[] = [];
  let used = 0;
  let pointers = 0;
  const topScore = ranked[0]?.s ?? 0;
  for (const f of order) {
    const entry = index.files.get(f)!;
    const score = scoreOf.get(f) ?? 1;
    const isMention = mentions.includes(f);
    if (!isMention && score < topScore * 0.25) {
      excluded.push({ path: f, score, reason: "relevance below 25% of the best match" });
      continue;
    }
    const codeFiles = selected.filter((s) => !s.outlineOnly).length;
    const ranges: SelectedFile["ranges"] = [];
    let cost = 0;
    // no single non-mentioned file may take more than a quarter of the budget
    const perFileCap = isMention ? opts.budget : Math.max(400, Math.floor(opts.budget / 4));
    const wantCode = includeCode && (isMention || codeFiles < maxFiles);
    if (wantCode) {
      const chunks = (bestChunks.get(f) || []).slice(0, isMention ? 6 : 3);
      if (chunks.length === 0) {
        // support-only file (test/doc/neighbour): include its head
        const end = Math.min(entry.lineCount, 40);
        const text = entry.text.split("\n").slice(0, end).join("\n");
        ranges.push({ start: 1, end });
        cost += estimateTokens(text);
      }
      for (const { c } of chunks) {
        if (ranges.length > 0 && (used + cost + c.tokens > codeBudget || cost + c.tokens > perFileCap)) break;
        ranges.push({ start: c.startLine, end: c.endLine, symbol: c.symbol });
        cost += c.tokens;
      }
    }
    if (wantCode && (used + cost <= codeBudget || isMention)) {
      used += cost;
      selected.push({ path: f, score, reasons: reasons.get(f) || [], ranges, tokens: cost, outlineOnly: false });
      continue;
    }
    // pointer: path + where to look, about 25 tokens
    const pointerCost = 25;
    if (pointers < maxPointers && used + pointerCost <= opts.budget) {
      used += pointerCost;
      pointers++;
      selected.push({ path: f, score, reasons: reasons.get(f) || [], ranges: [], tokens: pointerCost, outlineOnly: true });
    } else {
      excluded.push({ path: f, score, reason: pointers >= maxPointers ? "beyond the pointer limit" : `over budget (${opts.budget - used} tokens left)` });
    }
  }

  const lowConfidence = ranked.length === 0 || (!symbol.size && (lexical.size === 0 || chunkScores[0].s < 2));
  return {
    query,
    budget: opts.budget,
    used,
    selected,
    excluded: excluded.slice(0, 15),
    lowConfidence,
    indexed: { files: index.stats.files, chunks: index.stats.chunks, tokens: index.stats.tokens },
    ms: Date.now() - t0,
  };
}

/** BM25-only file ranking, kept as an ablation baseline for evaluation. */
export function rankLexical(index: ContextIndex, query: string, n = 12): string[] {
  const terms = tokenize(query);
  const best = new Map<string, number[]>();
  for (const c of index.chunks) {
    const s = index.bm25(terms, c);
    if (s <= 0) continue;
    const list = best.get(c.file) || [];
    list.push(s);
    best.set(c.file, list);
  }
  return [...best.entries()]
    .map(([f, l]) => {
      l.sort((a, b) => b - a);
      return { f, s: l[0] + 0.3 * (l[1] || 0) + 0.3 * (l[2] || 0) };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.f);
}

function reasonText(r: Evidence[]): string {
  return r.map((e) => `${e.signal}: ${e.detail}`).join("; ") || "ranked by fusion";
}

/**
 * Render a report for the model. The most relevant file is placed LAST, next to
 * the task, since models attend worst to the middle of long contexts.
 */
export function renderReport(index: ContextIndex, report: ContextReport, withCode: boolean): string {
  const header = [
    `Context selection for: "${report.query}"`,
    `Budget ${report.budget} tokens, used ~${report.used}. Indexed ${report.indexed.files} files (~${report.indexed.tokens} tokens) — ${Math.round((100 * report.used) / Math.max(1, report.indexed.tokens))}% of the repository is shown.`,
    report.lowConfidence ? "LOW CONFIDENCE: no strong match. Search for specific identifiers before editing." : "",
    "",
    "Selected (most relevant last):",
    ...[...report.selected].reverse().map((s, i) => `  ${report.selected.length - i}. ${s.path} ~${s.tokens} tok — ${reasonText(s.reasons)}${s.outlineOnly ? " [pointer: read_file to see code]" : ""}`),
    report.excluded.length ? "Left out:" : "",
    ...report.excluded.slice(0, 8).map((e) => `  - ${e.path}: ${e.reason}`),
  ].filter((l) => l !== "");
  if (!withCode) return header.join("\n");
  const blocks: string[] = [];
  for (const s of [...report.selected].reverse()) {
    const entry = index.files.get(s.path);
    if (!entry) continue;
    if (s.outlineOnly) continue; // pointers are listed in the header only
    const lines = entry.text.split("\n");
    for (const r of s.ranges) {
      const body = lines
        .slice(r.start - 1, r.end)
        .map((l, i) => `${String(r.start + i).padStart(5)}  ${l}`)
        .join("\n");
      blocks.push(`=== ${s.path} lines ${r.start}-${r.end}${r.symbol ? ` (${r.symbol})` : ""} ===\n${body}`);
    }
  }
  return `${header.join("\n")}\n\n${blocks.join("\n\n")}`;
}
