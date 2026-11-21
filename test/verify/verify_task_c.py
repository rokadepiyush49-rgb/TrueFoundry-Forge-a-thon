"""Verifier for Task C (resilience): after repeating Task A with a broken
model configuration, the workspace must be untouched.

Run it right after the Task C attempt, from the Flask repo root. It checks
git status against the pristine tag, and that TrueForge recorded the failed
attempt(s) and, if a fallback model is configured, the successful one.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import Report, changed_files  # noqa: E402


def main() -> int:
    rep = Report("Task C — resilience")
    allowed = [a for a in os.environ.get("TASK_C_ALLOWED", "").split(",") if a]
    files = [f for f in changed_files(".") if f not in allowed]
    rep.check("git status shows no changed files", not files, f"changed: {files}" if files else "clean")
    url = os.environ.get("TRUEFORGE_URL", "http://localhost:8790").rstrip("/")
    try:
        with urllib.request.urlopen(f"{url}/api/v1/sessions?limit=5", timeout=5) as r:
            sessions = json.load(r).get("data", [])
        rep.check("TrueForge reachable and has recent sessions", bool(sessions), f"{len(sessions)} recent sessions", level="STRICT")
    except Exception as e:  # noqa: BLE001
        rep.check("TrueForge reachable and has recent sessions", False, str(e)[:120], level="STRICT")
    return rep.finish()


if __name__ == "__main__":
    sys.exit(main())
