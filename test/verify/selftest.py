"""Self-test for the task verifiers: a verifier that cannot fail is worthless.

For each task this checks that the verifier
  1. FAILS on pristine Flask 3.1.3,
  2. PASSES on a hand-written reference solution (reference/*.patch), and
  3. FAILS, on the expected check, for each plausible wrong solution (mutant).

Usage (from anywhere):
    /path/to/venv/bin/python test/verify/selftest.py /path/to/flask-3.1.3
The Flask checkout is not modified; work happens in a temporary git worktree.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
PRISTINE = "22d92470"

A_MUTANTS = {
    "case-sensitive comparison": (
        "src/flask/helpers.py",
        'return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})',
        'return bool(val and val not in {"0", "false", "no", "off", "n"})',
        "every casing of 0/false/no/off/n is False",
    ),
    "prefix over-matching": (
        "src/flask/helpers.py",
        'return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})',
        'return bool(val and not val.lower().startswith(("0", "f", "n", "of")))',
        "other values stay True (no over-matching)",
    ),
    "docstring not updated": (
        "src/flask/helpers.py",
        '''    The values ``"0"``, ``"false"``, ``"no"``, ``"off"`` and ``"n"`` are
    treated as false, case-insensitively. Any other non-empty value enables
    debug mode.
''',
        "",
        "docstring lists every false value",
    ),
    "edit outside the selected function": (
        "src/flask/helpers.py",
        "def get_load_dotenv(default: bool = True) -> bool:",
        "def get_load_dotenv(default: bool = True) -> bool:  # touched",
        "every changed line is inside get_debug_flag",
    ),
}

B_MUTANTS = {
    "json.dumps without a fallback for timedelta": (
        "src/flask/cli.py",
        "json.dumps(config, indent=2, sort_keys=True, default=str)",
        "json.dumps(config, indent=2, sort_keys=True)",
        "flask config exits 0",
    ),
    "forgot to mask KEY": (
        "src/flask/cli.py",
        '_SECRET_KEY_PARTS = ("SECRET", "PASSWORD", "TOKEN", "KEY")',
        '_SECRET_KEY_PARTS = ("SECRET", "PASSWORD", "TOKEN")',
        "no secret value appears anywhere in the output",
    ),
    "command not registered": (
        "src/flask/cli.py",
        "            self.add_command(config_command)\n",
        "",
        "`config` is listed in flask --help with a description",
    ),
    "masks every value": (
        "src/flask/cli.py",
        'if any(part in key.upper() for part in _SECRET_KEY_PARTS)',
        "if True",
        "no other key is masked",
    ),
    "tests that test nothing": (
        "tests/test_cli.py",
        '    result = runner.invoke(cli, ["config"])\n    assert result.exit_code == 0, result.output\n    data = json.loads(result.output)\n    for key in ("SECRET_KEY", "DB_PASSWORD", "API_TOKEN", "STRIPE_KEY"):\n        assert data[key] == "***"\n    assert data["GREETING"] == "hello"\n    assert "hunter2" not in result.output\n    assert "PERMANENT_SESSION_LIFETIME" in data\n',
        "    assert app is not None\n",
        "new tests invoke the config command and assert the",
    ),
}


def sh(cmd, cwd, env=None):
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)


def verify(script: str, wt: Path) -> str:
    env = dict(os.environ, PYTHONPATH=str(wt / "src"))
    return sh([sys.executable, str(HERE / script)], wt, env).stdout


def failed(output: str, check: str) -> bool:
    return any(line.startswith("[FAIL]") and check in line for line in output.splitlines())


def all_required_pass(output: str) -> bool:
    return "[FAIL]" not in output and "REQUIRED:" in output


def main() -> int:
    flask_repo = Path(sys.argv[1]).resolve()
    problems = 0
    with tempfile.TemporaryDirectory() as td:
        wt = Path(td) / "wt"
        sh(["git", "worktree", "add", "--detach", str(wt), PRISTINE], flask_repo)
        try:
            for task, script, patch, mutants in (
                ("A", "verify_task_a.py", "task_a.patch", A_MUTANTS),
                ("B", "verify_task_b.py", "task_b.patch", B_MUTANTS),
            ):
                sh(["git", "checkout", "-q", "--", "."], wt)
                sh(["git", "clean", "-qfd"], wt)
                out = verify(script, wt)
                ok = "[FAIL]" in out
                problems += not ok
                print(f"[{'ok' if ok else 'BAD'}] Task {task}: verifier fails on pristine Flask")
                sh(["git", "apply", str(HERE / "reference" / patch)], wt)
                out = verify(script, wt)
                ok = all_required_pass(out)
                problems += not ok
                print(f"[{'ok' if ok else 'BAD'}] Task {task}: verifier passes the reference solution")
                if not ok:
                    print(out)
                for name, (file, old, new, expect) in mutants.items():
                    p = wt / file
                    original = p.read_text()
                    if old not in original:
                        print(f"[BAD] Task {task} mutant '{name}': anchor not found in reference")
                        problems += 1
                        continue
                    p.write_text(original.replace(old, new, 1))
                    out = verify(script, wt)
                    p.write_text(original)
                    ok = failed(out, expect)
                    problems += not ok
                    print(f"[{'ok' if ok else 'BAD'}] Task {task} mutant '{name}' is caught by: {expect}")
                    if not ok:
                        print(out)
        finally:
            sh(["git", "worktree", "remove", "--force", str(wt)], flask_repo)
    print(f"\n{'All verifier self-tests passed.' if not problems else f'{problems} verifier self-test problem(s).'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
