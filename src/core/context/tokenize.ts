const STOP = new Set(
  (
    "a an the and or but if then else for to of in on at by with from as is are was were be been being it its this that these those " +
    "add new make use using should must can could would will shall may might do does did done not no yes all any each every some " +
    "into onto over under than too very via so such also just only own same other more most less least out up down off about " +
    "def self return import class pass none true false elif lambda yield async await try except finally raise while break continue " +
    "function const let var export default public private static void null undefined this new extends implements interface type " +
    "value values code file files line lines please want need like get set"
  ).split(/\s+/),
);

/** Split an identifier into lower-case parts: getDebugFlag / get_debug_flag -> get, debug, flag. */
export function identifierParts(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/**
 * Tokenize text for lexical retrieval. Whole identifiers are kept (so an exact
 * symbol name scores strongly) and also split into parts (so "debug flag"
 * matches get_debug_flag).
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  for (const w of words) {
    const lower = w.toLowerCase();
    const parts = identifierParts(w);
    if (parts.length > 1 && lower.length > 2 && !STOP.has(lower)) out.push(lower);
    for (const p of parts) {
      if (p.length < 2 || STOP.has(p)) continue;
      out.push(stem(p));
    }
  }
  return out;
}

/** Identifier-looking words in a query (snake_case, camelCase, dotted, or backticked). */
export function queryIdentifiers(query: string): string[] {
  const ids = new Set<string>();
  for (const m of query.matchAll(/`([^`]+)`/g)) ids.add(m[1].trim());
  for (const m of query.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g)) ids.add(m[0]);
  for (const m of query.matchAll(/\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g)) ids.add(m[0]);
  return [...ids];
}

/** Rough token estimate used for budgeting (about 4 characters per token for code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}
