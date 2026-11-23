"""Claude Code の統括によるデスクトップ調査を PreToolUse で止める。"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PREFIX = "mcp__computer-use__"
PERMISSION_TOOLS = {PREFIX + "request_access", PREFIX + "list_granted_applications"}
CAPTURE_TOOLS = {PREFIX + "screenshot", PREFIX + "zoom"}
MARKER = Path("scratchpad/claude/root-runtime/orchestrator-desktop-capture-allowed.json")
MAX_WINDOW = timedelta(minutes=5)
DELEGATE = "参考の CAD などのアプリの操作と調査は担当へ指示書で出す（利用者 2026-11-18）"
NO_MARKER = "受入の印が無いか消費済み（撮影と拡大を合わせて1回）。"


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("時刻の UTC オフセットが必要です")
    return parsed.astimezone(timezone.utc)


def consume_capture_marker(path: Path, transcript: str) -> str | None:
    """消費できたら None。印が使えない場合は拒否の理由を返す。"""
    lock = path.with_suffix(".lock")
    try:
        lock.mkdir()
    except FileExistsError:
        return "別の呼出しが受入の印を処理中。"
    except FileNotFoundError:
        return NO_MARKER
    except OSError:
        return "受入の印の排他を取れない。"

    try:
        return consume_locked_marker(path, transcript)
    finally:
        try:
            lock.rmdir()
        except OSError:
            print("orchestrator_desktop_guard の警告: 受入の印の排他を解除できない。", file=sys.stderr)


def consume_locked_marker(path: Path, transcript: str) -> str | None:
    try:
        marker = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(marker, dict):
            return "受入の印は JSON オブジェクトにする。"
        reason = marker.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            return "受入の印に理由を書く。"
        if marker.get("transcript_path") != transcript:
            return "受入の印の transcript_path がこのセッションと一致しない。"
        placed, until = (parse_time(marker.get(key)) for key in ("placedAt", "until"))
        if not placed <= datetime.now(timezone.utc) < until or until - placed > MAX_WINDOW:
            return "受入の印の時刻が無効（開始済み・期限内・5分以内が必要）。"

        # 最後の印と理由を残し、有効な印だけを確実に1個消費する。
        path.replace(path.with_suffix(".used.json"))
    except FileNotFoundError:
        return NO_MARKER
    except (OSError, ValueError, TypeError, OverflowError):
        return "受入の印を読めないか消費できない。"
    return None


def hook(payload: dict, allow_unmarked_captures: bool) -> str | None:
    if payload.get("hook_event_name") != "PreToolUse":
        return None
    tool = payload.get("tool_name")
    if not isinstance(tool, str) or not tool:
        raise ValueError("tool_name を読めない")
    if not tool.startswith(PREFIX):
        return None
    if not isinstance(payload.get("tool_input"), dict):
        raise ValueError("tool_input を読めない")
    if tool in PERMISSION_TOOLS:
        return None

    # 既存の Bash・PowerShell 用フックと同じ呼出し元の判定を使う。
    from orchestrator_scope_guard import caller

    role = caller(payload)
    if role == "subagent":
        return None
    if role != "main":
        raise ValueError("統括か担当かを判定できない")
    if tool not in CAPTURE_TOOLS:
        return f"{DELEGATE}。対象: {tool.splitlines()[0]}。"
    if allow_unmarked_captures:
        return None
    marker_error = consume_capture_marker(ROOT / MARKER, payload["transcript_path"])
    if marker_error is None:
        return None
    return f"{DELEGATE}。{marker_error}"


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        if not isinstance(payload, dict):
            raise ValueError("入力は JSON オブジェクトが必要です")
        refusal = hook(payload, "--allow-unmarked-captures" in sys.argv[1:])
    except Exception as exc:
        # orchestrator_scope_guard と同じく入力や呼出し元が読めない場合は通す。
        detail = " ".join(str(exc).split())[:160]
        print(f"POINTERCAD_HOOK_FAIL_OPEN: デスクトップ操作の判定不能: {detail}", file=sys.stderr)
        return 0
    if refusal is None:
        return 0
    print(refusal, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
