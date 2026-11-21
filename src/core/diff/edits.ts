/**
 * Search/replace edits anchored to text that must already exist in the file.
 * An edit whose `old_string` is not found (or is ambiguous) is rejected before
 * the user ever sees it, so the agent cannot "edit" code that does not exist.
 */
export interface SearchReplaceEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export class EditError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Find the line window most similar to `needle` to help the model self-correct. */
export function closestMatchHint(content: string, needle: string): string | undefined {
  const lines = content.split("\n");
  const target = needle.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!target.length) return undefined;
  const first = target[0];
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (let j = 0; j < target.length && i + j < lines.length; j++) {
      if (lines[i + j].trim() === target[j]) score++;
    }
    if (lines[i].trim().includes(first.slice(0, 20))) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0 || bestScore < 1) return undefined;
  const snippet = lines.slice(best, best + Math.min(target.length + 2, 12)).join("\n");
  return `Closest text starts at line ${best + 1}:\n${snippet}`;
}

/** Dominant line ending of a file, or undefined if it has no line breaks. */
function fileEol(content: string): "\n" | "\r\n" | undefined {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/\n/g) || []).length - crlf;
  if (crlf + lf === 0) return undefined;
  return crlf > lf ? "\r\n" : "\n";
}

function toEol(s: string, eol: "\n" | "\r\n" | undefined): string {
  return eol ? s.replace(/\r?\n/g, eol) : s;
}

/**
 * Apply edits sequentially. Only the edited text is touched: the agent's
 * strings are converted to the file's dominant line ending, and lines outside
 * the edit keep their exact bytes (mixed-ending files stay mixed).
 */
export function applySearchReplace(content: string, edits: SearchReplaceEdit[]): string {
  if (!edits.length) throw new EditError("No edits supplied.");
  const eol = fileEol(content);
  let text = content;
  edits.forEach((edit, i) => {
    // Prefer the anchor exactly as given; otherwise try it in the file's line-ending style.
    const asGiven = edit.old_string;
    const converted = toEol(edit.old_string, eol);
    const oldS = text.includes(asGiven) || asGiven === converted ? asGiven : converted;
    const newS = toEol(edit.new_string, eol);
    if (oldS === newS) throw new EditError(`Edit ${i + 1}: old_string and new_string are identical.`);
    if (!oldS) throw new EditError(`Edit ${i + 1}: old_string is empty; use propose_new_file to create files.`);
    const n = countOccurrences(text, oldS);
    if (n === 0) {
      throw new EditError(
        `Edit ${i + 1}: old_string was not found in the file. Re-read the file and copy the exact text (including indentation).`,
        closestMatchHint(text, oldS),
      );
    }
    if (n > 1 && !edit.replace_all) {
      throw new EditError(
        `Edit ${i + 1}: old_string matches ${n} places; include more surrounding lines to make it unique, or set replace_all.`,
      );
    }
    text = edit.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
  });
  return text;
}
