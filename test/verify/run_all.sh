#!/usr/bin/env bash
# Run the task verifiers.
#   test/verify/run_all.sh selftest <flask-dir>      prove the verifiers can fail and pass
#   test/verify/run_all.sh a|b|c   <flask-dir>       verify the current state of a Flask checkout
# PYTHON must point at an interpreter with that checkout installed editable
# (pip install -e <flask-dir> "pytest==8.4.2" python-dotenv asgiref).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mode="${1:?usage: run_all.sh selftest|a|b|c <flask-dir>}"
flask_dir="$(cd "${2:?flask checkout path required}" && pwd)"
py="${PYTHON:-python3}"
case "$mode" in
  selftest) "$py" "$here/selftest.py" "$flask_dir" ;;
  a|A) (cd "$flask_dir" && "$py" "$here/verify_task_a.py") ;;
  b|B) (cd "$flask_dir" && "$py" "$here/verify_task_b.py") ;;
  c|C) (cd "$flask_dir" && "$py" "$here/verify_task_c.py") ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
