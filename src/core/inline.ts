/**
 * Inline edit helpers. The inline agent is tool-less: it returns the new text
 * for the selection and ForgePilot turns that into a reviewed diff. This keeps
 * inline edit robust on any model, including small or local ones.
 */

export interface Selection {
  startLine: number; // 1-based inclusive
  endLine: number; // 1-based inclusive
}

export function buildInlinePrompt(opts: {
  relPath: string;
  languageId: string;
  fileText: string;
  sel: Selection;
  instruction: string;
  contextLines?: number;
}): string {
  const lines = opts.fileText.split("\n");
  const ctx = opts.contextLines ?? 25;
  const before = lines.slice(Math.max(0, opts.sel.startLine - 1 - ctx), opts.sel.startLine - 1).join("\n");
  const selected = lines.slice(opts.sel.startLine - 1, opts.sel.endLine).join("\n");
  const after = lines.slice(opts.sel.endLine, opts.sel.endLine + ctx).join("\n");
  return [
    `File: ${opts.relPath} (${opts.languageId})`,
    `Selected lines ${opts.sel.startLine}-${opts.sel.endLine}.`,
    "",
    "Context before the selection (do not return this):",
    "```",
    before,
    "```",
    "",
    "SELECTED LINES (return the full replacement for exactly these):",
    "```",
    selected,
    "```",
    "",
    "Context after the selection (do not return this):",
    "```",
    after,
    "```",
    "",
    `Instruction: ${opts.instruction}`,
  ].join("\n");
}

export class InlineReplyError extends Error {}

/** Extract the replacement from the model's reply: the longest fenced block, or the whole reply if none. */
export function extractReplacement(reply: string): string {
  const blocks = [...reply.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  let code: string;
  if (blocks.length) code = blocks.sort((a, b) => b.length - a.length)[0];
  else {
    const open = reply.match(/```[^\n`]*\n([\s\S]*)$/); // unterminated fence
    code = open ? open[1] : reply;
  }
  code = code.replace(/\n$/, "");
  if (!code.trim()) throw new InlineReplyError("The model returned an empty replacement.");
  return code;
}

const COMMENT = /^\s*(#|\/\/|\/\*|\*|<!--|--)/;
const ELIDED_WORDS = /\.\.\.|…|\brest of\b|\bunchanged\b|\bexisting (code|implementation|logic)\b|\bremaining (code|lines)\b|\bsame as (before|above)\b/i;

/**
 * Guard against "lazy" replies that elide code ("# ... rest unchanged").
 * Lines identical to ones in the original selection are allowed.
 */
export function detectElision(original: string, replacement: string): string | undefined {
  const orig = new Set(original.split("\n").map((l) => l.trim()));
  for (const line of replacement.split("\n")) {
    const t = line.trim();
    if (orig.has(t)) continue;
    // a bare "..." line (Python Ellipsis bodies are allowed only if the original had them)
    if (t === "..." || t === "…") return t;
    // a comment that stands in for omitted code: "# ... rest unchanged", "// existing code"
    if (COMMENT.test(line) && ELIDED_WORDS.test(t)) return t;
  }
  return undefined;
}

/** Re-indent a replacement whose indentation was stripped by the model. */
export function fixIndentation(original: string, replacement: string): string {
  const indentOf = (s: string) => (s.match(/^[ \t]*/) || [""])[0];
  const firstOrig = original.split("\n").find((l) => l.trim());
  const firstNew = replacement.split("\n").find((l) => l.trim());
  if (!firstOrig || !firstNew) return replacement;
  const io = indentOf(firstOrig);
  const inew = indentOf(firstNew);
  if (io === inew || inew.length > 0 || io.length === 0) return replacement;
  return replacement
    .split("\n")
    .map((l) => (l.trim() ? io + l : l))
    .join("\n");
}

/** Apply a replacement to the selected lines of a file. */
export function replaceSelection(fileText: string, sel: Selection, replacement: string): string {
  const lines = fileText.split("\n");
  const crlf = lines[sel.startLine - 1]?.endsWith("\r");
  const rep = replacement.replace(/\r/g, "").split("\n").map((l) => (crlf ? `${l}\r` : l));
  return [...lines.slice(0, sel.startLine - 1), ...rep, ...lines.slice(sel.endLine)].join("\n");
}
