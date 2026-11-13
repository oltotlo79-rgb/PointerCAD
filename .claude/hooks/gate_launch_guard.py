"""gate の自己試験・型・lint の段の間は Agent（担当）の起動を拒否する（rules/06 §10.463）。

静かな窓（scratchpad/claude/root-runtime/quiet-window.json、owner=gate、期限内）が有効で、最新の delivery
（scratchpad/claude/deliveries/<id>/state.json のうち startedAt が最新）の status が gate の終わった状態（failed・pushed・succeeded・committed-no-push・passed・scheduler-start-failed）以外
（waiting-for-external-load・waiting-for-quiet-cpu・checking-hook-selftests・full-check-running など全て）なら、窓の期限まで起動を拒否する
（2026-11-07 11:51 統括の判断。追補 6。以前の「check.ps1 の最初の 40 分」の制限は外した）。
統括の印 scratchpad/claude/root-runtime/launch-during-gate.json（{"reason": …, "placedAt": …}。placedAt は窓の開始以後）が
ある時だけ許し、印は 1 回の起動で消して scratchpad/claude/state/launch-during-gate.jsonl に記録する。
窓が無い・delivery が無い・他の status なら通す。読めないファイルは警告して通す（起動を止めすぎない）。
入出力は opus_concurrency_guard.py と同じ（拒否は標準出力の JSON の permissionDecision=deny、終了コード 0。
判定できない時は POINTERCAD_HOOK_FAIL_OPEN を標準エラーへ出して通す）。
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WINDOW = "scratchpad/claude/root-runtime/quiet-window.json"
MARKER = "scratchpad/claude/root-runtime/launch-during-gate.json"
MARKER_LOG = "scratchpad/claude/state/launch-during-gate.jsonl"
DELIVERIES = "scratchpad/claude/deliveries"
WINDOW_MAX = timedelta(minutes=90)  # quiet_window.py の MAX_MINUTES・diag.py の QUIET_WINDOW_MAX_MINUTES と同じ上限
# gate が終わった(または起動していない)とみなす status。これ以外の全ての status の間は、窓の期限まで担当の起動を止める(追補 6)。
# 2026-11-07 11:58 統括の判断: committed-no-push・passed・scheduler-start-failed も gate が終わった状態として通す。
FINISHED_STATUSES = ("failed", "pushed", "succeeded", "committed-no-push", "passed", "scheduler-start-failed")
RULE = "rules/06 §10.463"


def local_time(value) -> datetime:
    """ISO 8601 の文字列をこの機械の現地時刻（タイムゾーン無し）にする（quiet_window.py の parse_time と同じ）。"""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"時刻が文字列ではありません: {value!r}")
    parsed = datetime.fromisoformat(value.strip())
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def minutes(delta: timedelta) -> int:
    return max(0, int(delta.total_seconds() // 60))


def read_window(root: Path, now: datetime, warnings: list[str]) -> dict | None:
    """有効な gate の窓（owner=gate、開始 <= 今 < min(終了, 開始+90 分)）なら {"start", "end"}、それ以外は None。"""
    path = root / WINDOW
    try:
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as exc:
        warnings.append(f"静かな窓 {WINDOW} を読めません（{type(exc).__name__}: {exc}）")
        return None
    try:
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("最上位が JSON のオブジェクトではありません")
        start = local_time(data.get("startedAt"))
        declared_end = local_time(data.get("endsAt"))
        if declared_end <= start:
            raise ValueError("endsAt が startedAt 以前です")
    except (ValueError, TypeError) as exc:
        warnings.append(f"静かな窓 {WINDOW} が正しくありません（{type(exc).__name__}: {exc}）")
        return None
    if data.get("owner") != "gate":
        return None
    end = min(declared_end, start + WINDOW_MAX)
    if not start <= now < end:
        return None
    return {"start": start, "end": end}


def latest_delivery(root: Path, warnings: list[str]) -> dict | None:
    """deliveries/<id>/state.json のうち startedAt が最新の物。読めない state.json は警告して飛ばす。"""
    base = root / DELIVERIES
    try:
        directories = [path for path in base.iterdir() if path.is_dir()]
    except FileNotFoundError:
        return None
    except OSError as exc:
        warnings.append(f"{DELIVERIES} を読めません（{type(exc).__name__}: {exc}）")
        return None
    latest = None
    for directory in directories:
        label = f"{DELIVERIES}/{directory.name}/state.json"
        try:
            text = (directory / "state.json").read_text(encoding="utf-8-sig")
        except FileNotFoundError:
            continue
        except (OSError, UnicodeError) as exc:
            warnings.append(f"{label} を読めません（{type(exc).__name__}: {exc}）")
            continue
        try:
            state = json.loads(text)
            if not isinstance(state, dict):
                raise ValueError("最上位が JSON のオブジェクトではありません")
            started = local_time(state.get("startedAt"))
        except (ValueError, TypeError) as exc:
            warnings.append(f"{label} が正しくありません（{type(exc).__name__}: {exc}）")
            continue
        if latest is None or started > latest["started"]:
            latest = {"id": str(state.get("deliveryId") or directory.name), "state": state, "started": started}
    return latest


def blocking_reason(delivery: dict, window: dict, now: datetime) -> str | None:
    status = delivery["state"].get("status")
    if status in FINISHED_STATUSES:
        return None
    return (f"gate（delivery {delivery['id']}）が {status} の間で、gate の起動から {minutes(now - delivery['started'])} 分、"
            f"静かな窓は {window['end']:%H:%M} まで。担当の起動の負荷で gate の自己試験・型・lint・単体が時間切れになる（{RULE}）。"
            f"gate が {'・'.join(FINISHED_STATUSES)} になるか窓が終わるまで起動を待つ。どうしても要る時だけ統括が {MARKER} に "
            '{"reason": "<理由>", "placedAt": "<今の時刻>"} を置く（1 回の起動で消える）。')


# rules/06 §10.502(候補): 全体検査の起動の直後は、印があっても担当の起動を止める(c11_gate_early_launch.py の部品 G)。
EARLY_GATE_TERMINAL = ("failed", "pushed", "succeeded", "committed", "committed-no-push", "passed", "scheduler-start-failed")
EARLY_GATE_MARK = "段「check-ps1」の起動前確認"
EARLY_GATE_MAX_AGE = timedelta(hours=6)
EARLY_GATE_RULE = "rules/06 §10.502"


def _early_gate_time(value) -> datetime:
    parsed = datetime.fromisoformat(str(value).strip())
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def early_gate(deliveries: Path, now: datetime) -> dict | None:
    """全体検査が起動の直後(2 回目の起動前検査の前)なら {"id","status","started"}、そうでなければ None(読むだけ)。"""
    latest = None
    try:
        directories = [entry for entry in deliveries.iterdir() if entry.is_dir()] if deliveries.is_dir() else []
    except OSError:
        return None
    for directory in directories:
        try:
            state = json.loads((directory / "state.json").read_text(encoding="utf-8-sig"))
            started = _early_gate_time(state["startedAt"])
        except (OSError, UnicodeError, ValueError, TypeError, KeyError):
            continue
        if latest is None or started > latest[1]:
            latest = (directory, started, state)
    if latest is None:
        return None
    directory, started, state = latest
    status = str(state.get("status") or "")
    if status in EARLY_GATE_TERMINAL or now - started > EARLY_GATE_MAX_AGE:
        return None
    try:
        log = (directory / "gate.log").read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        log = ""
    except OSError:
        return None
    if EARLY_GATE_MARK in log:
        return None
    return {"id": str(state.get("deliveryId") or directory.name), "status": status, "started": started}


def early_gate_reason(gate: dict, now: datetime, what: str) -> str:
    return (f"全体検査（delivery {gate['id']}、{gate['status']}、起動から {max(0, int((now - gate['started']).total_seconds() // 60))} 分）は、"
            f"まだ 2 回目の起動前検査（段 check-ps1）を通っていない。今{what}と、その起動前検査が「直前 3 分以内の起動」と"
            f"「稼働の担当」で全体検査を止める（{EARLY_GATE_RULE}。2026-11-13 04:13 に約 10 分を失った）。gate.log に"
            f"「{EARLY_GATE_MARK}」の行が出てから{what}（全体検査の間の起動の印 launch-during-gate.json はこの間は使わない）。")


def consume_marker(root: Path, window: dict, now: datetime, delivery: dict, payload: dict,
                   warnings: list[str]) -> tuple[str, str]:
    """("none" | "valid" | "invalid", 説明)。valid の時は印を消し、記録を 1 行足す。"""
    path = root / MARKER
    if not path.exists():
        return "none", ""
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            raise ValueError("最上位が JSON のオブジェクトではありません")
        reason = data.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("reason が空です")
        placed = local_time(data.get("placedAt"))
    except (OSError, UnicodeError, ValueError, TypeError) as exc:
        return "invalid", f"印 {MARKER} が正しくないため使いません（{type(exc).__name__}: {exc}）。"
    if placed < window["start"]:
        return "invalid", (f"印 {MARKER} の placedAt（{placed:%Y-%m-%d %H:%M}）が静かな窓の開始（{window['start']:%Y-%m-%d %H:%M}）"
                           "より前のため使いません（前の gate の印は使わない）。")
    reason = " ".join(reason.split())
    try:
        path.unlink()
    except OSError as exc:
        warnings.append(f"印 {MARKER} を消せません（{type(exc).__name__}: {exc}）。統括が消すこと")
    entry = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    record = {
        "time": now.isoformat(timespec="seconds"), "deliveryId": delivery["id"],
        "status": delivery["state"].get("status"), "reason": reason, "placedAt": data.get("placedAt"),
        "description": str(entry.get("description", "")),
    }
    log_path = root / MARKER_LOG
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:
        warnings.append(f"{MARKER_LOG} へ記録できません（{type(exc).__name__}: {exc}）")
    return "valid", (f"gate（delivery {delivery['id']}、{delivery['state'].get('status')}）の段の間の起動を、統括の印で許しました"
                     f"（理由: {reason}、placedAt {data.get('placedAt')}）。印は 1 回で消しました（{RULE}）。")


def hook(payload: dict, now: datetime, root: Path | None = None) -> tuple[dict | None, list[str]]:
    root = ROOT if root is None else root
    warnings: list[str] = []
    if payload.get("hook_event_name") != "PreToolUse" or payload.get("tool_name") != "Agent":
        return None, warnings
    window = read_window(root, now, warnings)
    if window is None:
        return None, warnings
    delivery = latest_delivery(root, warnings)
    if delivery is None:
        return None, warnings
    reason = blocking_reason(delivery, window, now)
    if reason is None:
        return None, warnings
    early = early_gate(root / DELIVERIES, now)
    if early is not None:
        # 印は使わずに残す(2 回目の起動前検査の後に使える)。
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": early_gate_reason(early, now, "担当を起動する"),
        }}, warnings
    status, detail = consume_marker(root, window, now, delivery, payload, warnings)
    if status == "valid":
        return {"systemMessage": detail}, warnings
    if status == "invalid":
        reason = f"{reason} {detail}"
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason,
    }}, warnings


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("入力は JSON のオブジェクトが必要です")
        result, warnings = hook(payload, datetime.now())
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: gate の段の間の起動の判定不能: {exc}", file=sys.stderr)
        return 0
    if warnings:
        text = "gate_launch_guard の警告（読めないファイルは飛ばして判定した）: " + " / ".join(warnings)
        print(text, file=sys.stderr)
        if result is None:
            result = {"systemMessage": text}
        else:
            result["systemMessage"] = f"{result['systemMessage']} {text}" if "systemMessage" in result else text
    if result is not None:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
