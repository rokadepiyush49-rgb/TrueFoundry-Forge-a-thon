"""Adversarial verifier for Task B (agent mode: `flask config`).

Task: "Add a new built-in CLI command flask config that prints the loaded
application's configuration as JSON, masking the values of any key containing
SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be
covered by a test, and be documented alongside the other built-in commands."
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import PRISTINE, Report, baseline_failures, changed_files, git, pytest_failures, run  # noqa: E402

SAMPLE_APP = '''
from datetime import timedelta
from flask import Flask

class Opaque:
    def __repr__(self):
        return "<Opaque>"

app = Flask(__name__)
app.config.update(
    SECRET_KEY="sk-SHOULD-NOT-LEAK-1",
    DATABASE_PASSWORD="pw-SHOULD-NOT-LEAK-2",
    GITHUB_TOKEN="tok-SHOULD-NOT-LEAK-3",
    STRIPE_API_KEY="key-SHOULD-NOT-LEAK-4",
    SECRET_KEY_FALLBACKS=["old-SHOULD-NOT-LEAK-5"],
    REFRESH_TOKEN_TTL=timedelta(hours=1),
    PUBLIC_SETTING="visible-value",
    ITEMS_PER_PAGE=25,
    FEATURE_FLAGS={"beta": True},
    my_secret="lower-SHOULD-NOT-LEAK-6",
)
'''

SAMPLE_OPAQUE = SAMPLE_APP + "\napp.config['CUSTOM_OBJECT'] = Opaque()\n"
SECRET_WORDS = ("SECRET", "PASSWORD", "TOKEN", "KEY")


def flask_cli(args, cwd, app_src):
    Path(cwd, "sample_app.py").write_text(app_src)
    env = dict(os.environ, FLASK_APP="sample_app", PYTHONDONTWRITEBYTECODE="1")
    env.pop("FLASK_DEBUG", None)
    return run([sys.executable, "-m", "flask", *args], cwd=cwd, env=env)


def _test_ids(source: str, path: str) -> set[str]:
    """pytest node ids of test functions, including methods of Test* classes."""
    import ast

    ids: set[str] = set()
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return ids
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test"):
            ids.add(f"{path}::{node.name}")
        elif isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub.name.startswith("test"):
                    ids.add(f"{path}::{node.name}::{sub.name}")
    return ids


def new_test_ids(repo: str) -> list[str]:
    """Tests that exist now but not in pristine 3.1.3 (module-level or in classes)."""
    ids: list[str] = []
    for f in changed_files(repo):
        if f.startswith("tests/") and f.endswith(".py") and Path(repo, f).exists():
            before = _test_ids(git("show", f"{PRISTINE}:{f}", cwd=repo), f)
            ids.extend(sorted(_test_ids(Path(repo, f).read_text(), f) - before))
    return ids


def main() -> int:
    rep = Report("Task B — flask config")
    repo = "."
    files = changed_files(repo)
    rep.check("change touches at least three files", len(files) >= 3, f"{len(files)}: {files}")
    src_changed = [f for f in files if f.startswith("src/")]
    rep.check("implementation lives in the flask package", any(f.startswith("src/flask/") for f in src_changed), str(src_changed))

    with tempfile.TemporaryDirectory() as td:
        # appears in flask --help
        r = flask_cli(["--help"], td, SAMPLE_APP)
        listed = re.search(r"^\s+config\s+\S", r.stdout, re.M)
        rep.check("`config` is listed in flask --help with a description", r.returncode == 0 and listed is not None, (r.stdout + r.stderr).strip().splitlines()[-1][:120] if not listed else listed.group(0).strip())
        r = flask_cli(["config", "--help"], td, SAMPLE_APP)
        rep.check("flask config --help works", r.returncode == 0, r.stderr.strip()[-160:])

        # run it against an app with secrets and non-JSON values
        r = flask_cli(["config"], td, SAMPLE_APP)
        rep.check("flask config exits 0", r.returncode == 0, (r.stderr.strip().splitlines() or [""])[-1][:200])
        out = r.stdout
        leaked = [m for m in re.findall(r"\S*SHOULD-NOT-LEAK-\d", out + r.stderr) if "6" not in m]
        rep.check("no secret value appears anywhere in the output", not leaked, f"leaked: {leaked}")
        try:
            data = json.loads(out)
            parsed = True
        except Exception as e:  # noqa: BLE001
            data, parsed = {}, False
            rep.check("output is a single valid JSON document", False, f"{e}; first chars: {out[:80]!r}")
        if parsed:
            rep.check("output is a single valid JSON document", isinstance(data, dict), type(data).__name__)
            sys.path.insert(0, td)
            env_app = __import__("importlib").import_module("sample_app").app
            expected_keys = set(env_app.config.keys())
            rep.check("every config key is present", set(data) == expected_keys, f"missing: {sorted(expected_keys - set(data))[:6]} extra: {sorted(set(data) - expected_keys)[:6]}")
            masked_upper = [k for k in expected_keys if any(w in k for w in SECRET_WORDS)]
            wrong = [k for k in masked_upper if data.get(k) != "***"]
            rep.check("every key containing SECRET/PASSWORD/TOKEN/KEY is exactly \"***\"", not wrong, f"{len(masked_upper)} keys; wrong: {wrong}")
            over = [k for k in expected_keys if not any(w in k.upper() for w in SECRET_WORDS) and data.get(k) == "***"]
            rep.check("no other key is masked", not over, f"over-masked: {over}")
            rep.check("plain values are preserved", data.get("PUBLIC_SETTING") == "visible-value" and data.get("ITEMS_PER_PAGE") == 25 and data.get("FEATURE_FLAGS") == {"beta": True} and data.get("TESTING") is False, "")
            rep.check("timedelta values are serialized, not dropped", "PERMANENT_SESSION_LIFETIME" in data and data["PERMANENT_SESSION_LIFETIME"] not in (None, ""), repr(data.get("PERMANENT_SESSION_LIFETIME")))
            rep.check("lower-case secret key names are masked too", data.get("my_secret") == "***", f"my_secret -> {data.get('my_secret')!r}", level="STRICT")
            sys.path.remove(td)
            sys.modules.pop("sample_app", None)

        r = flask_cli(["config"], td, SAMPLE_OPAQUE)
        rep.check("a non-JSON-serializable config value does not crash the command", r.returncode == 0, (r.stderr.strip().splitlines() or [""])[-1][:160], level="STRICT")

    # documentation alongside the other built-in commands
    docs = Path("docs/cli.rst").read_text()
    rep.check("docs/cli.rst documents `flask config`", re.search(r"flask config", docs) is not None)
    rep.check("docs mention the masking", re.search(r"\*\*\*|mask", docs, re.I) is not None, level="STRICT")

    # tests: the agent's tests pass, and they actually test the feature
    code, fails, tail = pytest_failures(["tests/test_cli.py"], repo)
    rep.check("pytest tests/test_cli.py -q passes", code == 0, tail.splitlines()[-1] if tail else "")
    added = new_test_ids(repo)
    rep.check("at least one new test was added", bool(added), ", ".join(added[:4]))
    # What the new tests assert: a test that never checks the masking does not
    # "cover" the feature even if it fails when the command is missing.
    added_src = "\n".join(
        line[1:] for line in git("diff", PRISTINE, "--", "tests", cwd=repo).splitlines() if line.startswith("+") and not line.startswith("+++")
    )
    for f in changed_files(repo):
        if f.startswith("tests/") and git("ls-files", f, cwd=repo).strip() == "":
            added_src += "\n" + Path(repo, f).read_text()
    invokes = re.search(r"""["']config["']""", added_src) is not None
    asserts_mask = re.search(r"""assert[^\n]*\*\*\*|\*\*\*[^\n]*==|==[^\n]*\*\*\*""", added_src) is not None
    rep.check("new tests invoke the config command and assert the \"***\" masking", invokes and asserts_mask, f"invokes config: {invokes}, asserts ***: {asserts_mask}")
    rep.check("new tests parse the JSON output", "json.loads" in added_src or "get_json" in added_src or ".json" in added_src, level="STRICT")
    if added:
        backups = {}
        try:
            for f in src_changed:
                p = Path(repo, f)
                backups[f] = p.read_text() if p.exists() else None
                original = git("show", f"{PRISTINE}:{f}", cwd=repo)
                if original:
                    p.write_text(original)
                elif p.exists():
                    p.unlink()
            mcode, mfails, mtail = pytest_failures([*added], repo)
            # exit code 5 = no tests collected: inconclusive, which must not count as a pass
            rep.check("mutation check: new tests FAIL when the implementation is removed", mcode not in (0, 5), f"with the feature reverted: {mtail.splitlines()[-1] if mtail else ''}")
        finally:
            for f, content in backups.items():
                p = Path(repo, f)
                if content is None:
                    p.unlink(missing_ok=True)
                else:
                    p.write_text(content)

    base = baseline_failures(repo)
    _, fails, tail = pytest_failures([], repo)
    new = sorted(fails - base)
    rep.check("full test suite: no new failures", not new, f"new: {new[:5]}; pre-existing in pristine 3.1.3: {len(base)}")
    return rep.finish()


if __name__ == "__main__":
    sys.exit(main())
