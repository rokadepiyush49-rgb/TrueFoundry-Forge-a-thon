"""Shared helpers for the adversarial task verifiers.

Each verifier is run from the root of a pallets/flask 3.1.3 checkout with the
Python interpreter of an environment where that checkout is installed
editable (pip install -e .), e.g.:

    /path/to/venv/bin/python /path/to/forgepilot/test/verify/verify_task_a.py

Checks are REQUIRED (the task as worded) or STRICT (a careful engineer would
also do this). The exit code is non-zero if any REQUIRED check fails.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

PRISTINE = "22d92470"  # tag 3.1.3


@dataclass
class Report:
    title: str
    results: list = field(default_factory=list)

    def check(self, name: str, ok: bool, detail: str = "", level: str = "REQUIRED") -> bool:
        self.results.append((level, name, bool(ok), detail))
        return bool(ok)

    def finish(self) -> int:
        print(f"\n=== {self.title} ===")
        width = max(len(n) for _, n, _, _ in self.results) if self.results else 10
        for level, name, ok, detail in self.results:
            mark = "PASS" if ok else ("FAIL" if level == "REQUIRED" else "WARN")
            print(f"[{mark}] {level:<8} {name:<{width}}  {detail}")
        req_fail = sum(1 for lv, _, ok, _ in self.results if lv == "REQUIRED" and not ok)
        strict_fail = sum(1 for lv, _, ok, _ in self.results if lv == "STRICT" and not ok)
        total_req = sum(1 for lv, *_ in self.results if lv == "REQUIRED")
        print(f"\nREQUIRED: {total_req - req_fail}/{total_req} passed; STRICT warnings: {strict_fail}")
        return 1 if req_fail else 0


def run(cmd, cwd=None, env=None, timeout=600):
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def git(*args, cwd="."):
    return run(["git", *args], cwd=cwd).stdout


def changed_files(repo=".") -> list[str]:
    """Tracked files modified plus untracked files, ignoring caches."""
    out = git("status", "--porcelain", "--untracked-files=all", cwd=repo)
    files = []
    for line in out.splitlines():
        p = line[3:].strip().strip('"')
        if "__pycache__" in p or p.endswith(".pyc") or ".pytest_cache" in p:
            continue
        files.append(p)
    return files


def pytest_failures(args: list[str], repo: str, extra_env: dict | None = None) -> tuple[int, set[str], str]:
    """Run pytest and return (exit code, failing node ids, tail of output)."""
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    r = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-rf", *args], cwd=repo, env=env)
    fails = set(re.findall(r"^(?:FAILED|ERROR) (\S+)", r.stdout, re.M))
    return r.returncode, fails, "\n".join(r.stdout.strip().splitlines()[-4:])


def baseline_failures(repo: str = ".") -> set[str]:
    """Failures of the pristine 3.1.3 test suite in THIS environment (cached)."""
    key = hashlib.sha1(f"{sys.executable}{sys.version}{PRISTINE}".encode()).hexdigest()[:12]
    cache = Path(tempfile.gettempdir()) / f"forgepilot-flask-baseline-{key}.json"
    if cache.exists():
        return set(json.loads(cache.read_text()))
    with tempfile.TemporaryDirectory() as td:
        wt = Path(td) / "pristine"
        run(["git", "worktree", "add", "--detach", str(wt), PRISTINE], cwd=repo)
        try:
            # PYTHONPATH puts the pristine sources ahead of the editable install
            _, fails, _ = pytest_failures([], str(wt), {"PYTHONPATH": str(wt / "src")})
        finally:
            run(["git", "worktree", "remove", "--force", str(wt)], cwd=repo)
    cache.write_text(json.dumps(sorted(fails)))
    return fails


def diff_added_line_ranges(path: str, repo: str = ".") -> list[tuple[int, int]]:
    """Changed line ranges (in the NEW file) for a tracked file."""
    out = git("diff", "-U0", PRISTINE, "--", path, cwd=repo)
    ranges = []
    for m in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", out, re.M):
        start, n = int(m.group(1)), int(m.group(2) or "1")
        ranges.append((start, start + max(n, 1) - 1))
    return ranges


def function_span(path: str, name: str) -> tuple[int, int] | None:
    import ast

    tree = ast.parse(Path(path).read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            start = min([node.lineno] + [d.lineno for d in node.decorator_list])
            return start, node.end_lineno
    return None
