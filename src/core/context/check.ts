import { spawnSync } from "child_process";
import { ContextIndex } from "./indexer";
import { Proposal } from "../diff/review";

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

function didYouMean(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best && bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

/**
 * Symbol-existence check for Python: every name an added line imports from a
 * module of THIS repository must be defined (or re-exported) by that module.
 * Catches the classic hallucination of importing a helper that does not exist.
 */
export function checkPythonImports(index: ContextIndex, p: Proposal): Map<number, string[]> {
  const warnings = new Map<number, string[]>();
  if (!p.relPath.endsWith(".py")) return warnings;
  const pkgParts = p.relPath.replace(/\.py$/, "").split("/");
  pkgParts.pop();
  for (const h of p.hunks) {
    for (const line of h.newLines) {
      const m = line.match(/^\s*from\s+(\.*[\w.]*)\s+import\s+\(?([\w\s,]+)\)?/);
      if (!m) continue;
      let mod = m[1];
      if (mod.startsWith(".")) {
        const dots = mod.match(/^\.+/)![0].length;
        const parts = [...pkgParts];
        for (let i = 1; i < dots; i++) parts.pop();
        mod = [...parts, mod.slice(dots)].filter(Boolean).join(".");
      }
      const file = index.moduleFile(mod) ?? index.moduleFile(mod.split(".").slice(1).join("."));
      if (!file) continue; // third-party or stdlib: not ours to check
      const exported = index.exportedNames(file);
      for (const raw of m[2].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (!name || name === "*") continue;
        if (exported.has(name) || index.moduleFile(`${mod}.${name}`)) continue;
        const hint = didYouMean(name, exported);
        const msg = `\`${name}\` does not exist in ${file}${hint ? ` (did you mean \`${hint}\`?)` : ""}.`;
        warnings.set(h.id, [...(warnings.get(h.id) || []), msg]);
      }
    }
  }
  return warnings;
}

/** Python syntax check of the full proposed file. Returns an error message or undefined. */
export function pythonSyntaxError(text: string, python = "python3"): string | undefined {
  const r = spawnSync(
    python,
    ["-c", "import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print(f'line {e.lineno}: {e.msg}'); sys.exit(3)"],
    { input: text, encoding: "utf8", timeout: 10000 },
  );
  if (r.error) return undefined; // python unavailable: skip the check rather than block
  if (r.status === 3) return (r.stdout || "").trim() || "syntax error";
  return undefined;
}
