# Task verifiers

Independent, adversarial checks for the three fixed tasks on `pallets/flask`
3.1.3. They live outside the workspace the agent edits, the agent is never
shown them, and nothing in ForgePilot's prompts or retrieval mentions the
tasks.

```bash
# one-time: an environment with the Flask checkout installed editable
python3 -m venv ../venv-flask
../venv-flask/bin/pip install -e ../flask-3.1.3 "pytest==8.4.2" "python-dotenv==1.2.1" "asgiref==3.11.0"

PYTHON=../venv-flask/bin/python test/verify/run_all.sh selftest ../flask-3.1.3  # prove the verifiers work
PYTHON=../venv-flask/bin/python test/verify/run_all.sh a ../flask-3.1.3         # after Task A
PYTHON=../venv-flask/bin/python test/verify/run_all.sh b ../flask-3.1.3         # after Task B
PYTHON=../venv-flask/bin/python test/verify/run_all.sh c ../flask-3.1.3         # after Task C
```

`pytest==8.4.2` is the version in Flask 3.1.3's `uv.lock`; newer pytest
removed `_pytest.monkeypatch.notset`, which `tests/test_cli.py` imports.

## What is checked

**Task A** (`verify_task_a.py`): the brief's exact command; all 47 casings of
`0/false/no/off/n` are false; unset/empty are false; 15 other values stay true
(catches prefix over-matching such as `nope`, `offline`, `on`); the docstring
lists every false value (the Python constant `False` does not count); only
`src/flask/helpers.py` changed and only inside `get_debug_flag`; no new test
failures against the pristine 3.1.3 baseline.

**Task B** (`verify_task_b.py`): at least three files; `config` listed in
`flask --help`; runs against a sample app with planted secrets, a
`timedelta`, nested values and a lower-case secret key: valid JSON, every key
present, secrets exactly `"***"`, no secret string anywhere in stdout or
stderr, nothing else masked, non-JSON values do not crash; documented in
`docs/cli.rst`; `pytest tests/test_cli.py -q` passes; the new tests invoke
the command and assert the masking; **mutation check** — with the
implementation reverted the new tests must fail; no new suite failures.

**Task C** (`verify_task_c.py`): `git status` shows no changed files.

## Verifying the verifiers (`selftest.py`)

A verifier that cannot fail proves nothing. The self-test runs each verifier
on pristine Flask (must fail), on a hand-written reference solution
(`reference/*.patch`, must pass) and on plausible wrong solutions, each of
which must be caught by the intended check:

| Mutant | Caught by |
|---|---|
| case-sensitive comparison | every casing is false |
| prefix over-matching (`startswith`) | other values stay true |
| docstring not updated | docstring lists every value |
| edit outside the selected function | scope check |
| `json.dumps` without a `timedelta` fallback | `flask config` exits 0 |
| forgot to mask `KEY` | no secret leaks |
| command not registered | listed in `flask --help` |
| masks every value | nothing else masked |
| tests that assert nothing | tests assert the `"***"` masking |

The reference patches exist only to validate the verifiers. They are never
given to the agent.

## Environment note

On Python 3.14 the pristine 3.1.3 suite has one pre-existing failure
(`tests/test_reqctx.py::test_bad_environ_raises_bad_request`), so the
verifiers check for **new** failures against a baseline computed in a
temporary git worktree of the pristine tag.
