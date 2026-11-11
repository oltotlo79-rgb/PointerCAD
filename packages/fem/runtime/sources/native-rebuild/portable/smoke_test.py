"""Root-only smoke/regression for rebuild-oofem-pyodide.sh path safety and refusals. No compilation: the positive
case stops after the patched source stage (--stop-after source). Uses argv lists only (never a shell). Writes only
under --work, which must not exist. Nothing is deleted. Exit 0 only if every case passes.

  python3 smoke_test.py --script PATH --work NEW_DIR --oofem-tar FILE --pybind11-tar FILE --timer-patch FILE \
    --util-patch FILE --venv DIR --emsdk-env FILE --xbuildenv DIR --wheelhouse DIR [--r1-script PATH]

r16: --wheelhouse is the exact 13-file wheelhouse (wheelhouse-SHA256SUMS); its files are copied into the hostile
path, because the r15 recipe refuses any other wheelhouse at step 10w (an empty one made every positive case fail).

--r1-script runs the same hostile-path inputs against the r1 script as a negative control. It is expected to fail
at 10-inputs (the apostrophe ends its single-quoted bash -c text) or to create a canary; it stops before the build.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

# Characters a shell would interpret if a path ever became program text.
HOSTILE = "in dir 'q' ;$(touch PWNED_DOLLAR) `touch PWNED_TICK` & * \"dq\""
CANARIES = ('PWNED_DOLLAR', 'PWNED_TICK')
p = argparse.ArgumentParser()
for name in ('script', 'work', 'oofem-tar', 'pybind11-tar', 'timer-patch', 'util-patch', 'venv', 'emsdk-env', 'xbuildenv', 'wheelhouse'):
    p.add_argument('--' + name, required=True)
p.add_argument('--r1-script')
a = p.parse_args()
work = pathlib.Path(a.work)
if not work.is_absolute() or work.exists():
    raise SystemExit('--work must be absolute and must not exist')
work.mkdir()
cwd = work / 'cwd'
cwd.mkdir()
hostile = work / HOSTILE
hostile.mkdir()
inputs = {}
for key in ('oofem-tar', 'pybind11-tar', 'timer-patch', 'util-patch'):
    src = pathlib.Path(getattr(a, key.replace('-', '_')))
    dst = hostile / ('copy ' + src.name)
    shutil.copyfile(src, dst)
    inputs[key] = dst
wheelhouse = hostile / 'wheel house'
wheelhouse.mkdir()
for src in sorted(pathlib.Path(a.wheelhouse).iterdir()):
    if not src.is_file() or src.is_symlink():
        raise SystemExit('--wheelhouse must hold regular files only')
    shutil.copyfile(src, wheelhouse / src.name)
bad = hostile / 'corrupt.tar.gz'
data = bytearray(inputs['oofem-tar'].read_bytes()); data[-1] ^= 0xFF
bad.write_bytes(bytes(data))
truncated = hostile / 'truncated.tar.gz'
truncated.write_bytes(inputs['oofem-tar'].read_bytes()[:4096])


def argv(script, out, **override):
    values = {'--oofem-tar': inputs['oofem-tar'], '--pybind11-tar': inputs['pybind11-tar'],
              '--timer-patch': inputs['timer-patch'], '--util-patch': inputs['util-patch'], '--venv': a.venv,
              '--emsdk-env': a.emsdk_env, '--xbuildenv': a.xbuildenv, '--wheelhouse': wheelhouse, '--out': out,
              '--stop-after': 'source'}
    values.update(override)
    cmd = ['setsid', '--wait', 'bash', str(script)]
    for k, v in values.items():
        if v is not None:
            cmd += [k, str(v)]
    return cmd


def run(cmd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=1800)
    return r.returncode, r.stdout[-2000:], r.stderr[-2000:]


def tree(root):
    return sorted(str(x.relative_to(work)) for x in root.rglob('*'))


def digest(root):
    h = hashlib.sha256()
    for x in sorted(root.rglob('*')):
        h.update(str(x.relative_to(root)).encode('utf-8', 'surrogateescape'))
        if x.is_file():
            h.update(x.read_bytes())
    return h.hexdigest()


def no_canary():
    # Exact names only: the hostile directory name itself contains the canary text as a substring.
    return not any(x.name in CANARIES for x in work.rglob('*'))


results = []
def case(name, ok, detail):
    results.append({'case': name, 'pass': bool(ok), 'detail': detail})

outs = hostile / 'out dir'
outs.mkdir()
# A: hostile paths reach the patched source stage with no injection and no files outside --out.
before = set(tree(work))
out_a = outs / "a 'out' $(x)"
rc, so, se = run(argv(a.script, out_a))
util = out_a / 'src/oofem-oofem-214b161/bindings/python/oofem/util.py'
created = sorted(set(tree(work)) - before - {x for x in tree(work) if x.startswith(str(out_a.relative_to(work)))})
case('A hostile paths, source stage', rc == 0 and (out_a / 'logs/done.txt').read_text().startswith('SOURCE OK')
     and hashlib.sha256(util.read_bytes()).hexdigest() == 'd443986373a3a2aca6cd903e464941d417236607eceb66991f41f2224868e692'
     and no_canary() and created == [], {'rc': rc, 'createdOutsideOut': created, 'stderr': se})
# B: an existing output is refused before anything is written, and it is left byte-identical.
d0 = digest(out_a)
rc, so, se = run(argv(a.script, out_a))
case('B duplicate output refused', rc == 64 and 'output already exists' in se and digest(out_a) == d0, {'rc': rc, 'stderr': se})
# C/D: wrong bytes are refused at 10-inputs, before extraction.
for label, archive in (('C corrupt archive', bad), ('D truncated archive', truncated)):
    out = outs / label
    rc, so, se = run(argv(a.script, out, **{'--oofem-tar': archive}))
    exit_file = out / 'logs/10-inputs.exit'
    case(label + ' refused', rc != 0 and exit_file.is_file() and exit_file.read_text().strip() != '0'
         and not any((out / 'src').iterdir()) and no_canary(), {'rc': rc, 'stderr': se})
# E/F/G: argument refusals create no output at all.
for label, override in (('E relative path', {'--wheelhouse': 'relative/wheelhouse'}), ('F jobs out of range', {'--jobs': '9'}),
                        ('G unknown stop point', {'--stop-after': 'build'})):
    out = outs / label
    rc, so, se = run(argv(a.script, out, **override))
    case(label + ' refused', rc == 64 and not out.exists(), {'rc': rc, 'stderr': se})
# Negative control: the r1 script with the same hostile paths (no --stop-after in r1).
if a.r1_script:
    out = outs / 'r1 control'
    rc, so, se = run(argv(a.r1_script, out, **{'--stop-after': None}))
    exit_file = out / 'logs/10-inputs.exit'
    failed_at_inputs = exit_file.is_file() and exit_file.read_text().strip() != '0'
    case('R1 negative control fails on hostile paths', failed_at_inputs or not no_canary(),
         {'rc': rc, 'failedAt10Inputs': failed_at_inputs, 'canaryCreated': not no_canary(), 'stderr': se})
print(json.dumps(results, indent=2))
sys.exit(0 if all(r['pass'] for r in results) else 1)
