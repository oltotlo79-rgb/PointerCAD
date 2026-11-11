"""Read-only scoped Stop decision with callback metadata audit; no task/report/trust/ACK writes."""
import json
import os
from pathlib import Path
import re
import sys
import stat
from datetime import datetime, timedelta, timezone

ROOT = Path(r'C:\Users\oltot\Documents\git-projects\PointerCAD')
SESSION = '01a102b2-c69e-7571-8195-51baa9208d9f'
JST = timezone(timedelta(hours=9))
STATE = 'scratchpad/claude/root-runtime/stop-guard-state.json'
AUDIT = 'scratchpad/claude/root-runtime/stop-guard-events.jsonl'
AUDIT_LIMIT = 1024 * 1024
REPORT = 'docs/\u5831\u544a\u8a18\u9332.md'


def block(reason):
    return {'decision': 'block', 'reason': reason}


def read_json(path):
    with path.open('rb') as stream:
        data = stream.read(65537)
    if len(data) > 65536:
        raise ValueError('state exceeds 64KiB')
    result = json.loads(data)
    if not isinstance(result, dict):
        raise ValueError('state must be object')
    return result


def owned_stop(event, root, session, worker):
    if (not isinstance(event, dict) or event.get('hook_event_name') != 'Stop'
            or event.get('session_id') != session or worker or event.get('agent_id')):
        return False
    cwd = event.get('cwd')
    if not isinstance(cwd, str) or not cwd.strip():
        return False
    try:
        return Path(cwd).resolve() == root.resolve()
    except (TypeError, ValueError, OSError):
        return False


def decide(event, root=ROOT, session=SESSION, now=None, worker=False):
    # SubagentStop is a different event. Never register Interrupt.
    if not owned_stop(event, root, session, worker):
        return {}
    now = now or datetime.now(JST)
    try:
        state = read_json(root / STATE)
        if state.get('schema') != 'pcad-root-stop-state-v1' or state.get('session_id') != session:
            raise ValueError('state schema/session mismatch')
        if Path(state['project_root']).resolve() != root.resolve():
            raise ValueError('state project mismatch')
        mode = state['mode']
        if mode not in ('continue', 'user_interrupted', 'complete'):
            raise ValueError('invalid explicit mode')
        if not isinstance(state['root_basis'], str) or not state['root_basis'].strip():
            raise ValueError('Root actual instruction/completion basis required')
        stamp = datetime.fromisoformat(state['updated_at'])
        if stamp.tzinfo is None or stamp > now:
            raise ValueError('state time future/naive')
        # Root records actual explicit user pause/completion; hook never infers it.
        if mode in ('user_interrupted', 'complete'):
            return {}
        periodic = state['periodic_reporting_required']
        if type(periodic) is not bool:
            raise ValueError('periodic_reporting_required must be boolean')
        tasks = state['independent_remaining']
        if (not isinstance(tasks, list) or len(tasks) > 32
                or any(not isinstance(t, str) or not t.strip() or len(t) > 500 for t in tasks)):
            raise ValueError('invalid remaining work')
        # Existing report-pump heading contract, without importing its stale pins.
        with (root / REPORT).open(encoding='utf-8-sig') as stream:
            heading = stream.readline(4097).rstrip('\r\n')
        match = re.match(r'^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) JST(?:\s|$)', heading)
        if not match or len(heading) > 4096:
            raise ValueError('latest report heading unknown')
        report_at = datetime.strptime(match[1], '%Y-%m-%d %H:%M').replace(tzinfo=JST)
        if report_at > now:
            raise ValueError('report heading future')
        due = now >= report_at + timedelta(minutes=10)
        if due or tasks or periodic:
            todo = '; '.join(tasks[:4]) or 'Review the real remaining work and current waiting condition.'
            return block('Do not end this active task. '
                         + ('The real report is at least 10 minutes old; update it from actual evidence first. ' if due else '')
                         + ('Periodic reporting remains required: keep the turn active, check actual waiting/work and report when due; do not fabricate a report now. ' if periodic else '')
                         + 'Continue independent work: ' + todo
                         + ' Preserve failures and unknowns. Do not invent progress, completion, estimates or acknowledgments. '
                         + 'If the user explicitly paused, record that actual instruction in Root state. '
                         + 'Repeated Stop is re-evaluated; stop_hook_active is not completion evidence.')
        return {}
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as error:
        return block('Root Stop guard cannot read a valid scoped task/report state: '
                     + type(error).__name__ + '. Review and repair actual state; do not fabricate completion or user pause.')


def append_audit(event, decision, root, session):
    path = root / AUDIT
    parent = path.parent.resolve(strict=True)
    if parent != path.parent.absolute() or path.is_symlink():
        raise ValueError('audit path redirected')
    row = {'schema': 'pcad-root-stop-callback-v1',
           'invoked_at': datetime.now(JST).isoformat(), 'pid': os.getpid(), 'ppid': os.getppid(),
           'session_id': session, 'event': 'Stop',
           'repeat_stop': event.get('stop_hook_active') is True,
           'decision': 'block' if decision.get('decision') == 'block' else 'allow',
           'category': ('invalid-state' if decision.get('reason', '').startswith('Root Stop guard cannot read')
                        else 'active-task' if decision.get('decision') == 'block' else 'explicit-state-or-no-work')}
    data = (json.dumps(row, ensure_ascii=True, separators=(',', ':')) + chr(10)).encode('utf-8')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND | getattr(os, 'O_BINARY', 0), 0o600)
    locked = False
    try:
        if os.name == 'nt':
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        locked = True
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size + len(data) > AUDIT_LIMIT:
            raise ValueError('audit size/type invalid')
        os.lseek(fd, 0, os.SEEK_SET)
        previous = os.read(fd, AUDIT_LIMIT + 1)
        if len(previous) != info.st_size:
            raise OSError('audit read incomplete')
        previous.decode('utf-8', errors='strict')
        if previous and not previous.endswith(bytes([10])):
            raise ValueError('audit has incomplete prior line')
        if os.write(fd, data) != len(data):
            raise OSError('audit append incomplete')
        os.fsync(fd)
    finally:
        try:
            if locked:
                if os.name == 'nt':
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def callback(event, root=ROOT, session=SESSION, now=None, worker=False):
    decision = decide(event, root, session, now, worker)
    if not owned_stop(event, root, session, worker):
        return decision
    try:
        append_audit(event, decision, root, session)
    except (OSError, ValueError, TypeError, OverflowError) as error:
        # An audit error must never discard an already scoped blocking decision.
        decision = {**decision, 'systemMessage': 'Stop callback audit failed: '
                    + type(error).__name__ + '; host delivery/enforcement remains unconfirmed.'}
    return decision


def main():
    raw = sys.stdin.buffer.read(65537)
    try:
        if len(raw) > 65536:
            raise ValueError('event too large')
        event = json.loads(raw)
    except (ValueError, UnicodeError):
        # Cannot establish ownership: do not interfere with another session.
        print(json.dumps({'systemMessage': 'Stop guard input invalid; scope unknown and protection unconfirmed.'}))
        return 0
    worker = bool(os.environ.get('PCAD_WORKER_NAME') or os.environ.get('PCAD_WORKER_KIND'))
    print(json.dumps(callback(event, worker=worker), ensure_ascii=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
