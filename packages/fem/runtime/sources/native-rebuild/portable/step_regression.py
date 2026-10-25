"""Root-only discriminating regression for step() in rebuild-oofem-pyodide.sh (NOT executed by the worker).

    python3 step_regression.py --script PATH --work NEW_DIR [--expect old-defect]

Takes the script's exact step() definition (from 'step() {' to the first line that is exactly '}'), runs it in a
small bash harness with the same `set -Eeuo pipefail` and the variables step() logs, and checks:
  1 fail-then-success: `false; true` inside the step function -> the harness exits nonzero and the .exit file is 1;
  2 success: a passing step -> exit 0 and the .exit file is 0;
  3 explicit code: `return 7` -> exit 7;
  4 quoting: an argument with spaces, quotes, $() and backticks reaches the function verbatim and creates no canary;
  5 later steps do not run after a failed step.
With --expect old-defect (run against the unpatched portable2 script), case 1 must instead show the defect:
exit 0 and later steps running. That is the negative control proving the regression discriminates.
argv lists only (no shell=True). Writes only under --work, which must not exist; nothing is deleted."""
import argparse
import json
import pathlib
import subprocess
import sys

p = argparse.ArgumentParser()
p.add_argument("--script", required=True)
p.add_argument("--work", required=True)
p.add_argument("--expect", choices=["fixed", "old-defect"], default="fixed")
a = p.parse_args()
work = pathlib.Path(a.work)
if not work.is_absolute() or work.exists():
    raise SystemExit("--work must be absolute and must not exist")
work.mkdir()
lines = pathlib.Path(a.script).read_text(encoding="utf-8").splitlines(keepends=True)
start = lines.index("step() {\n")
end = start + lines[start:].index("}\n")
step_def = "".join(lines[start:end + 1])
(work / "step.sh").write_text(step_def, encoding="utf-8")
HOSTILE = "a b 'q' \"dq\" $(touch PWNED) `touch PWNED2` ; & *"
harness = r'''set -Eeuo pipefail
LOG="$1/logs"; mkdir -p -- "$LOG"
OOFEM_TAR= PYBIND_TAR= TIMER_PATCH= UTIL_PATCH= VENV= EMSDK_ENV= XBUILDENV= WHEELHOUSE= OUT="$1" JOBS=1
PIP_FIND_LINKS= PIP_CONSTRAINT= TMPDIR="$1"
. "$2"
f_fail_then_ok() { false; echo reached-after-false; true; }
f_ok() { echo ok; }
f_seven() { return 7; }
f_args() { printf '%s\n' "$@" > "$LOG/args.txt"; }
f_marker() { touch "$LOG/later-step-ran"; }
case "$3" in
  fail) step 01-fail f_fail_then_ok; step 02-later f_marker ;;
  ok) step 01-ok f_ok ;;
  seven) step 01-seven f_seven ;;
  args) step 01-args f_args "$4" ;;
esac
'''
(work / "harness.sh").write_text(harness, encoding="utf-8")
results = []


def run(case, *extra):
    out = work / case
    r = subprocess.run(["bash", str(work / "harness.sh"), str(out), str(work / "step.sh"), case, *extra],
                       cwd=work, capture_output=True, text=True, timeout=120)
    return r.returncode, out / "logs"


rc, log = run("fail")
stdout = (log / "01-fail.stdout").read_text() if (log / "01-fail.stdout").exists() else ""
if a.expect == "fixed":
    ok = rc != 0 and (log / "01-fail.exit").read_text().strip() == "1" and "reached-after-false" not in stdout \
        and not (log / "later-step-ran").exists()
else:
    ok = rc == 0 and (log / "01-fail.exit").read_text().strip() == "0" and "reached-after-false" in stdout \
        and (log / "later-step-ran").exists()
results.append({"case": "1 fail-then-success (" + a.expect + ")", "pass": ok, "rc": rc})
if a.expect == "fixed":
    rc, log = run("ok")
    results.append({"case": "2 success", "pass": rc == 0 and (log / "01-ok.exit").read_text().strip() == "0", "rc": rc})
    rc, log = run("seven")
    results.append({"case": "3 explicit code", "pass": rc == 7 and (log / "01-seven.exit").read_text().strip() == "7", "rc": rc})
    rc, log = run("args", HOSTILE)
    got = (log / "args.txt").read_text() if (log / "args.txt").exists() else None
    canary = any(x.name in ("PWNED", "PWNED2") for x in work.rglob("*"))
    results.append({"case": "4 quoting", "pass": rc == 0 and got == HOSTILE + "\n" and not canary, "rc": rc})
print(json.dumps(results, indent=2))
sys.exit(0 if all(r["pass"] for r in results) else 1)
