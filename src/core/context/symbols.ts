export interface SymbolDef {
  name: string;
  kind: "function" | "class" | "method" | "variable";
  file: string; // workspace-relative
  line: number; // 1-based, first line of the definition (decorators included)
  endLine: number; // 1-based inclusive
  signature: string;
  parent?: string;
}

export interface ImportRef {
  module: string; // dotted, possibly relative (".helpers")
  names: string[]; // imported names ("*" allowed), empty for `import x`
  line: number;
}

const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)\s*[(:]/;
const PY_ASSIGN = /^([A-Z_][A-Z0-9_]*|[a-z_]\w*)\s*(?::[^=]+)?=(?!=)/;

function indentOf(line: string): number {
  const m = line.match(/^[ \t]*/)![0];
  return m.replace(/\t/g, "    ").length;
}

/** Extract Python definitions with their full line span (decorators included). */
export function pythonSymbols(file: string, text: string): SymbolDef[] {
  const lines = text.split("\n");
  const defs: SymbolDef[] = [];
  const stack: Array<{ name: string; indent: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(PY_DEF) || line.match(PY_CLASS);
    if (!m) {
      if (indentOf(line) === 0 && line.trim() && !line.startsWith("#") && !line.startsWith("@")) {
        const a = line.match(PY_ASSIGN);
        if (a) defs.push({ name: a[1], kind: "variable", file, line: i + 1, endLine: i + 1, signature: line.trim().slice(0, 120) });
      }
      continue;
    }
    const indent = m[1].replace(/\t/g, "    ").length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const isClass = line.trimStart().startsWith("class");
    let start = i;
    while (start > 0 && lines[start - 1].trim().startsWith("@") && indentOf(lines[start - 1]) === indent) start--;
    // end = last line before the next non-blank line with indent <= this indent
    let end = i;
    let parenDepth = 0;
    for (let j = i; j < lines.length; j++) {
      const l = lines[j];
      if (j > i && parenDepth <= 0 && l.trim() && !l.trim().startsWith("#") && indentOf(l) <= indent) break;
      for (const ch of l) {
        if (ch === "(" || ch === "[" || ch === "{") parenDepth++;
        else if (ch === ")" || ch === "]" || ch === "}") parenDepth--;
      }
      if (l.trim()) end = j;
    }
    const parent = stack.length ? stack[stack.length - 1].name : undefined;
    defs.push({
      name: m[2],
      kind: isClass ? "class" : parent ? "method" : "function",
      file,
      line: start + 1,
      endLine: end + 1,
      signature: line.trim().replace(/:\s*$/, "").slice(0, 160),
      parent,
    });
    stack.push({ name: m[2], indent });
  }
  return defs;
}

export function pythonImports(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = l.match(/^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/);
    if (m) {
      let names = m[2];
      if (names.includes("(") && !names.includes(")")) {
        let j = i + 1;
        while (j < lines.length && !lines[j].includes(")")) names += " " + lines[j++];
        if (j < lines.length) names += " " + lines[j];
      }
      const list = names
        .replace(/[()]/g, " ")
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter((s) => /^[\w*]+$/.test(s));
      out.push({ module: m[1], names: list, line: i + 1 });
      continue;
    }
    m = l.match(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/);
    if (m) for (const mod of m[1].split(",")) out.push({ module: mod.trim(), names: [], line: i + 1 });
  }
  return out;
}

const TS_DEF =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*=)/;

/** Brace-matched definitions for JS/TS-like languages. */
export function braceSymbols(file: string, text: string): SymbolDef[] {
  const lines = text.split("\n");
  const defs: SymbolDef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TS_DEF);
    if (!m) continue;
    const name = m[1] || m[2] || m[3] || m[4] || m[5];
    let depth = 0;
    let seen = false;
    let end = i;
    for (let j = i; j < lines.length && j < i + 2000; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          seen = true;
        } else if (ch === "}") depth--;
      }
      end = j;
      if (seen && depth <= 0) break;
      if (!seen && j > i + 2 && /;\s*$/.test(lines[j])) break;
    }
    defs.push({
      name,
      kind: m[2] ? "class" : "function",
      file,
      line: i + 1,
      endLine: end + 1,
      signature: lines[i].trim().slice(0, 160),
    });
  }
  return defs;
}

export function extractSymbols(file: string, text: string): SymbolDef[] {
  if (file.endsWith(".py")) return pythonSymbols(file, text);
  if (/\.(ts|tsx|js|jsx|mjs|cjs|java|go|rs|c|cc|cpp|h|hpp|cs|kt|swift)$/.test(file)) return braceSymbols(file, text);
  return [];
}
