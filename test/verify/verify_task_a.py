"""Adversarial verifier for Task A (inline edit of flask.helpers.get_debug_flag).

Task: "Treat the values 'off' and 'n' as false as well, case-insensitively,
and update the docstring to list every value that is treated as false."
"""
from __future__ import annotations

import ast
import importlib
import itertools
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import Report, changed_files, diff_added_line_ranges, function_span, pytest_failures, baseline_failures, run  # noqa: E402

FALSY = ["0", "false", "no", "off", "n"]
TRUTHY = ["1", "true", "yes", "on", "y", "2", "debug", "enable", "True", "YES", "On", "Y", "nope", "offline", "no-op"]


def casings(word: str) -> set[str]:
    out = {word.lower(), word.upper(), word.title()}
    letters = [i for i, c in enumerate(word) if c.isalpha()]
    for mask in itertools.product([False, True], repeat=len(letters)):
        chars = list(word.lower())
        for flip, i in zip(mask, letters):
            if flip:
                chars[i] = chars[i].upper()
        out.add("".join(chars))
    return out


def main() -> int:
    rep = Report("Task A — get_debug_flag")
    repo = "."
    helpers = "src/flask/helpers.py"

    # 1. the exact verification command from the brief
    env = dict(os.environ, FLASK_DEBUG="off")
    r = run([sys.executable, "-c", "from flask.helpers import get_debug_flag; print(get_debug_flag())"], env=env)
    rep.check("brief command prints False for FLASK_DEBUG=off", r.stdout.strip() == "False", repr(r.stdout.strip() or r.stderr.strip()[-200:]))

    # 2. behaviour matrix, in-process
    sys.path.insert(0, str(Path(repo, "src").resolve()))
    import flask.helpers as h

    importlib.reload(h)

    def flag(v):
        if v is None:
            os.environ.pop("FLASK_DEBUG", None)
        else:
            os.environ["FLASK_DEBUG"] = v
        return h.get_debug_flag()

    bad = [v for w in FALSY for v in casings(w) if flag(v) is not False]
    rep.check("every casing of 0/false/no/off/n is False", not bad, f"{sum(len(casings(w)) for w in FALSY)} values; wrong: {bad[:8]}")
    rep.check("unset FLASK_DEBUG is False", flag(None) is False)
    rep.check("empty FLASK_DEBUG is False", flag("") is False)
    wrong_truthy = [v for v in TRUTHY if flag(v) is not True]
    rep.check("other values stay True (no over-matching)", not wrong_truthy, f"wrong: {wrong_truthy}")
    rep.check("returns a real bool", isinstance(flag("off"), bool) and isinstance(flag("1"), bool))
    rep.check(" off  (surrounding spaces)", flag(" off ") is False, "not required by the task", level="STRICT")
    os.environ.pop("FLASK_DEBUG", None)

    # 3. docstring lists every false value
    tree = ast.parse(Path(helpers).read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "get_debug_flag")
    doc = ast.get_docstring(fn) or ""
    # The Python constant ``False`` (e.g. "The default is ``False``") is not the
    # string value "false"; drop it so it cannot satisfy the check by accident.
    doc_values = re.sub(r"``False``|``True``|\bFalse\b|\bTrue\b", " ", doc)
    quoted = {m.lower() for m in re.findall(r"[`'\"]{1,2}([A-Za-z0-9]+)[`'\"]{1,2}", doc_values)}
    missing = [v for v in FALSY if v not in quoted and not re.search(rf"(?<![A-Za-z0-9]){re.escape(v)}(?![A-Za-z0-9])", doc_values, re.I)]
    rep.check("docstring lists every false value", not missing, f"missing: {missing}" if missing else f"found {sorted(set(FALSY) & quoted) or 'all (unquoted)'}")
    rep.check("docstring says matching is case-insensitive", re.search(r"case[- ]?insensitiv|any case|regardless of case|ignor\w* case", doc, re.I) is not None, level="STRICT")
    rep.check("docstring still documents the default", re.search(r"default", doc, re.I) is not None, level="STRICT")

    # 4. scope: only helpers.py changed, only inside get_debug_flag
    files = changed_files(repo)
    rep.check("only src/flask/helpers.py changed", files == [helpers], f"changed: {files}")
    span = function_span(helpers, "get_debug_flag")
    outside = [r for r in diff_added_line_ranges(helpers) if span and (r[0] < span[0] or r[1] > span[1])]
    rep.check("every changed line is inside get_debug_flag", span is not None and not outside, f"function lines {span}, outside hunks: {outside}")

    # 5. no new test failures
    base = baseline_failures(repo)
    _, fails, tail = pytest_failures([], repo)
    new = sorted(fails - base)
    rep.check("full test suite: no new failures", not new, f"new: {new[:5]}; pre-existing in pristine 3.1.3: {len(base)}; {tail.splitlines()[-1] if tail else ''}")
    return rep.finish()


if __name__ == "__main__":
    sys.exit(main())
