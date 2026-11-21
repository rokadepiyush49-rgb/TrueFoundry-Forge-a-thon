import { promises as fsp } from "fs";
import * as path from "path";
import { tokenize, estimateTokens } from "./tokenize";
import { extractSymbols, pythonImports, SymbolDef } from "./symbols";

export interface FileEntry {
  path: string; // workspace-relative, forward slashes
  size: number;
  text: string;
  lineCount: number;
  tokens: number;
  symbols: SymbolDef[];
  imports: string[]; // resolved workspace-relative files
  kind: "source" | "test" | "doc" | "config" | "other";
}

export interface Chunk {
  id: number;
  file: string;
  startLine: number; // 1-based inclusive
  endLine: number;
  symbol?: string;
  tf: Map<string, number>;
  length: number;
  tokens: number;
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "env", "__pycache__", "dist", "build", "out", ".tox", ".nox",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages", ".idea", ".vscode", "coverage", ".next",
  "target", ".gradle", ".eggs", "htmlcov", ".cache",
]);
const TEXT_EXT =
  /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|java|go|rs|c|cc|cpp|h|hpp|cs|kt|swift|rb|php|md|rst|txt|toml|cfg|ini|yaml|yml|json|html|css|scss|sh|sql)$/i;
const MAX_FILE_BYTES = 400_000;
const PATH_WEIGHT = 1;

function classify(rel: string): FileEntry["kind"] {
  const base = path.posix.basename(rel);
  if (/(^|\/)(tests?|__tests__|spec)\//.test(rel) || /^test_.*\.py$|_test\.(py|go)$|\.(test|spec)\.[jt]sx?$/.test(base)) return "test";
  if (/\.(md|rst|txt)$/i.test(rel) || /(^|\/)docs?\//.test(rel)) return "doc";
  if (/\.(toml|cfg|ini|yaml|yml|json)$/i.test(rel)) return "config";
  if (TEXT_EXT.test(rel)) return "source";
  return "other";
}

async function walk(root: string, rel = "", out: string[] = []): Promise<string[]> {
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.endsWith(".egg-info")) continue;
      await walk(root, r, out);
    } else if (e.isFile() && TEXT_EXT.test(e.name)) {
      out.push(r);
    }
  }
  return out;
}

/** Chunk a file along symbol boundaries; uncovered regions become fixed windows. */
function chunkFile(entry: FileEntry, startId: number): Chunk[] {
  const lines = entry.text.split("\n");
  const ranges: Array<{ s: number; e: number; symbol?: string }> = [];
  // top-level symbols (and methods of very large classes) become chunks
  const top = entry.symbols.filter((s) => s.kind !== "variable" && !s.parent);
  for (const s of top) {
    const span = s.endLine - s.line + 1;
    if (s.kind === "class" && span > 160) {
      const methods = entry.symbols.filter((m) => m.parent === s.name);
      let cursor = s.line;
      for (const m of methods) {
        if (m.line > cursor) ranges.push({ s: cursor, e: m.line - 1, symbol: s.name });
        ranges.push({ s: m.line, e: m.endLine, symbol: `${s.name}.${m.name}` });
        cursor = m.endLine + 1;
      }
      if (cursor <= s.endLine) ranges.push({ s: cursor, e: s.endLine, symbol: s.name });
    } else {
      ranges.push({ s: s.line, e: s.endLine, symbol: s.name });
    }
  }
  ranges.sort((a, b) => a.s - b.s);
  // fill gaps with windows (module docstrings, imports, docs files, configs)
  const filled: typeof ranges = [];
  let cursor = 1;
  const WINDOW = entry.kind === "doc" ? 40 : 60;
  const pushWindows = (from: number, to: number) => {
    for (let s = from; s <= to; s += WINDOW) filled.push({ s, e: Math.min(to, s + WINDOW - 1) });
  };
  for (const r of ranges) {
    if (r.s < cursor) continue; // nested/overlapping
    if (r.s > cursor) pushWindows(cursor, r.s - 1);
    filled.push(r);
    cursor = r.e + 1;
  }
  if (cursor <= lines.length) pushWindows(cursor, lines.length);
  // doc files: split windows at headings for better units
  return filled
    .filter((r) => lines.slice(r.s - 1, r.e).some((l) => l.trim()))
    .map((r, i) => {
      const text = lines.slice(r.s - 1, r.e).join("\n");
      // BM25F-style field weighting: the file path is a short, high-signal
      // field, so its terms count PATH_WEIGHT times (filename matches matter
      // most in code search).
      const pathTerms = tokenize(entry.path.replace(/[/._-]/g, " "));
      const terms = [
        ...Array.from({ length: PATH_WEIGHT }, () => pathTerms).flat(),
        ...tokenize(`${r.symbol ?? ""} ${text}`),
      ];
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      return {
        id: startId + i,
        file: entry.path,
        startLine: r.s,
        endLine: r.e,
        symbol: r.symbol,
        tf,
        length: terms.length,
        tokens: estimateTokens(text),
      };
    });
}

/** Map dotted module names to files, supporting flat and src/ layouts. */
function moduleTable(files: string[]): Map<string, string> {
  const table = new Map<string, string>();
  for (const f of files) {
    if (!f.endsWith(".py")) continue;
    const noExt = f.replace(/\.py$/, "").replace(/\/__init__$/, "");
    const parts = noExt.split("/");
    // register every suffix so "flask.helpers" resolves for "src/flask/helpers.py"
    for (let i = 0; i < parts.length; i++) {
      const mod = parts.slice(i).join(".");
      if (!table.has(mod)) table.set(mod, f);
    }
  }
  return table;
}

function resolvePyImport(fromFile: string, module: string, names: string[], table: Map<string, string>): string[] {
  let mod = module;
  if (mod.startsWith(".")) {
    const dots = mod.match(/^\.+/)![0].length;
    const pkgParts = fromFile.replace(/\.py$/, "").split("/");
    pkgParts.pop(); // drop module name -> package
    for (let i = 1; i < dots; i++) pkgParts.pop();
    // drop leading src/ style roots so the dotted lookup works
    const base = pkgParts.join(".");
    mod = [base, mod.slice(dots)].filter(Boolean).join(".");
    const found = table.get(mod) || table.get(mod.split(".").slice(1).join("."));
    const out = found ? [found] : [];
    for (const n of names) {
      const sub = table.get(`${mod}.${n}`);
      if (sub) out.push(sub);
    }
    return out;
  }
  const out: string[] = [];
  const direct = table.get(mod);
  if (direct) out.push(direct);
  for (const n of names) {
    const sub = table.get(`${mod}.${n}`);
    if (sub) out.push(sub);
  }
  return out;
}

export interface IndexStats {
  files: number;
  chunks: number;
  symbols: number;
  tokens: number;
  ms: number;
}

/** In-memory index of a workspace: files, symbol-level chunks, BM25 statistics and an import graph. */
export class ContextIndex {
  files = new Map<string, FileEntry>();
  chunks: Chunk[] = [];
  df = new Map<string, number>();
  avgLen = 1;
  symbolsByName = new Map<string, SymbolDef[]>();
  importedBy = new Map<string, Set<string>>();
  stats: IndexStats = { files: 0, chunks: 0, symbols: 0, tokens: 0, ms: 0 };

  constructor(readonly root: string) {}

  async build(): Promise<IndexStats> {
    const t0 = Date.now();
    const rels = await walk(this.root);
    this.files.clear();
    for (const rel of rels) {
      const abs = path.join(this.root, rel);
      const st = await fsp.stat(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      const buf = await fsp.readFile(abs);
      if (buf.includes(0)) continue; // binary
      const text = buf.toString("utf8");
      this.files.set(rel, {
        path: rel,
        size: st.size,
        text,
        lineCount: text.split("\n").length,
        tokens: estimateTokens(text),
        symbols: extractSymbols(rel, text),
        imports: [],
        kind: classify(rel),
      });
    }
    this.rebuildDerived();
    this.stats.ms = Date.now() - t0;
    return this.stats;
  }

  /** Re-index a single file after an edit (keeps the index fresh during a session). */
  async refresh(rel: string): Promise<void> {
    const abs = path.join(this.root, rel);
    try {
      const text = await fsp.readFile(abs, "utf8");
      this.files.set(rel, {
        path: rel,
        size: Buffer.byteLength(text),
        text,
        lineCount: text.split("\n").length,
        tokens: estimateTokens(text),
        symbols: extractSymbols(rel, text),
        imports: [],
        kind: classify(rel),
      });
    } catch {
      this.files.delete(rel);
    }
    this.rebuildDerived();
  }

  private rebuildDerived(): void {
    const table = moduleTable([...this.files.keys()]);
    this.importedBy.clear();
    this.symbolsByName.clear();
    this.chunks = [];
    for (const f of this.files.values()) {
      if (f.path.endsWith(".py")) {
        const refs = pythonImports(f.text);
        const resolved = new Set<string>();
        for (const r of refs) for (const target of resolvePyImport(f.path, r.module, r.names, table)) if (target !== f.path) resolved.add(target);
        f.imports = [...resolved];
        for (const t of f.imports) {
          if (!this.importedBy.has(t)) this.importedBy.set(t, new Set());
          this.importedBy.get(t)!.add(f.path);
        }
      }
      for (const s of f.symbols) {
        const k = s.name.toLowerCase();
        if (!this.symbolsByName.has(k)) this.symbolsByName.set(k, []);
        this.symbolsByName.get(k)!.push(s);
      }
      this.chunks.push(...chunkFile(f, this.chunks.length));
    }
    this.df.clear();
    let total = 0;
    for (const c of this.chunks) {
      total += c.length;
      for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
    let syms = 0;
    let toks = 0;
    for (const f of this.files.values()) {
      syms += f.symbols.length;
      toks += f.tokens;
    }
    this.stats = { files: this.files.size, chunks: this.chunks.length, symbols: syms, tokens: toks, ms: this.stats.ms };
  }

  bm25(queryTerms: string[], chunk: Chunk, k1 = 1.2, b = 0.75): number {
    const N = this.chunks.length || 1;
    let score = 0;
    for (const q of new Set(queryTerms)) {
      const f = chunk.tf.get(q);
      if (!f) continue;
      const n = this.df.get(q) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * chunk.length) / this.avgLen)));
    }
    return score;
  }

  findSymbol(name: string): SymbolDef[] {
    const exact = this.symbolsByName.get(name.toLowerCase()) || [];
    if (exact.length) return exact;
    const last = name.split(".").pop()!.toLowerCase();
    return this.symbolsByName.get(last) || [];
  }

  /** Module-level names defined or re-exported by a Python file. */
  exportedNames(rel: string): Set<string> {
    const f = this.files.get(rel);
    const names = new Set<string>();
    if (!f) return names;
    for (const s of f.symbols) if (!s.parent) names.add(s.name);
    for (const r of pythonImports(f.text)) {
      if (r.names.length) r.names.forEach((n) => names.add(n));
      else names.add(r.module.split(".")[0]);
    }
    return names;
  }

  moduleFile(dotted: string): string | undefined {
    return moduleTable([...this.files.keys()]).get(dotted);
  }

  outline(rel: string, max = 40): string {
    const f = this.files.get(rel);
    if (!f) return "";
    return f.symbols
      .filter((s) => s.kind !== "variable")
      .slice(0, max)
      .map((s) => `${s.parent ? "    " : ""}L${s.line}: ${s.signature}`)
      .join("\n");
  }
}
