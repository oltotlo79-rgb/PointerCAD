"""Reject future timestamps in operational records (Claude Code hook and scan CLI)."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DATED = re.compile(r"(?<!\d)(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?!\d)")
BARE = re.compile(r"(?<!\d)(\d{2}:\d{2})(?!\d)")
FORECAST = ("見込み", "予定", "予測", "目標", "までに", "resets")
RECENT = timedelta(minutes=3)
# 2026-09-24 統括の指示: 統括自身が1.5分ほど先の時刻を書いた際、2分の許容(旧値)の中に
# 収まって拒否されなかった(rules/06 §10.320の再発)。許容を0分にし、書いた分が現在の
# 分より後なら拒否する(同じ分は許す)。stampは常に秒0、nowは実秒を持つため、比較
# `stamp > now + ALLOWANCE` を変えずにALLOWANCEを0にするだけで「同じ分は許す・
# 1分先以上は拒否する」という挙動になる(検査を弱める変更ではなく強める変更)。
ALLOWANCE = timedelta(minutes=0)


def kind(path: Path, root: Path = ROOT) -> str | None:
    relative = path.resolve().relative_to(root).as_posix()
    if relative == "docs/報告記録.md":
        return "report"
    if re.fullmatch(r"scratchpad/claude/agents/[^/]+/progress\.md", relative):
        return "progress"
    if relative in (
        "scratchpad/claude/agents/registry.md",
        "scratchpad/claude/plans/orchestrator-queue.md",
    ):
        return "registry"
    if re.fullmatch(r"scratchpad/claude/deliveries/[^/]+/MANIFEST\.txt", relative):
        return "manifest"
    if re.fullmatch(r"scratchpad/claude/instructions/[^/]+\.md", relative):
        return "instruction"
    if relative == "rules/06-過去の失敗と対策.md":
        return "rules"
    return None


def candidates(root: Path = ROOT) -> list[Path]:
    # 2026-09-24 OPS-24(w35b): root引数を追加(既定は本物のROOTのままで挙動は不変)。
    # 自己試験が一時の根で候補を探せるようにし、本物のscratchpad/claude/agents/へ
    # 使い捨ての先の時刻ファイルを置いて他の担当のPostToolUse走査を誤って止める
    # ことを避ける(record_time_guard.selftest.pyのtest_post_block参照)。
    paths = [root / "docs/報告記録.md", root / "rules/06-過去の失敗と対策.md"]
    paths.extend((root / "scratchpad/claude/agents").glob("*/progress.md"))
    paths.extend((root / "scratchpad/claude/instructions").glob("*.md"))
    paths.extend((root / "scratchpad/claude/deliveries").glob("*/MANIFEST.txt"))
    paths.extend(
        (root / name for name in (
            "scratchpad/claude/agents/registry.md",
            "scratchpad/claude/plans/orchestrator-queue.md",
        ))
    )
    return [path for path in paths if path.is_file()]


def future_times(path: Path, content: str, now: datetime, root: Path = ROOT) -> list[tuple[int, str]]:
    file_kind = kind(path, root)
    if file_kind is None:
        return []
    found: list[tuple[int, str]] = []
    for line_number, line in enumerate(content.splitlines(), 1):
        if any(word in line for word in FORECAST):
            continue
        if file_kind == "progress" and not DATED.match(line):
            continue
        dates = list(DATED.finditer(line))
        for match in dates:
            try:
                stamp = datetime.strptime(match.group(), "%Y-%m-%d %H:%M" if " " in match.group() else "%Y-%m-%dT%H:%M")
            except ValueError:
                continue
            if stamp > now + ALLOWANCE:
                found.append((line_number, match.group()))
        if file_kind not in ("registry", "manifest", "instruction"):
            continue
        for match in BARE.finditer(line):
            if any(date.start() <= match.start() < date.end() for date in dates):
                continue
            if file_kind == "registry":
                before, after = line[:match.start()], line[match.end():]
                relevant = bool(
                    re.search(r"\|\s*$|完了\s*$|停止→\s*$|再開\s*$", before)
                    or re.search(r"^\s*更新\b|^\s*に\b", after)
                )
                if not relevant:
                    continue
            elif file_kind == "instruction":
                # OPS-16: 年月日の無い時刻は次の記入の文脈にあるものだけを見る(registryの
                # relevantと同じ考え方)。1行目の見出し、「HH:MM に 取得/作成/測/不在/確認」、
                # 「状態（HH:MM）」以外(数式の例・過去の時刻の説明等)は今までどおり見ない。
                before, after = line[:match.start()], line[match.end():]
                relevant = bool(
                    (line_number == 1 and line.startswith("# 指示書"))
                    or re.match(r"\s*に\s*(SHA-256|取得|作成|測|不在|確認)", after)
                    or (re.search(r"状態[（(]\s*$", before) and re.match(r"\s*[）)]", after))
                )
                if not relevant:
                    continue
            # file_kind == "manifest": MANIFEST.txtは1行目の人手の見出しコメントに
            # HH:MM(:SS)が埋め込まれる書式で、他の行はpath sha256の組(コロンを含まない)
            # だけなので、registryのような文脈手がかりを要求せずbare一致を全て見る。
            try:
                hour, minute = map(int, match.group().split(":"))
                if hour > 23 or minute > 59:
                    continue
            except ValueError:
                continue
            ahead = (hour * 60 + minute - now.hour * 60 - now.minute) % (24 * 60)
            if 0 < ahead <= 180:
                found.append((line_number, match.group()))
    return found


def reason(path: Path, findings: list[tuple[int, str]], now: datetime, root: Path = ROOT) -> str:
    where = path.relative_to(root).as_posix()
    locations = ", ".join(f"{stamp} (行{line})" for line, stamp in findings[:8])
    return (
        f"{where}: 未来の時刻 {locations}。現在 {now:%Y-%m-%d %H:%M}。"
        "date '+%Y-%m-%d %H:%M' で取得した値を書く（rules/06 §10.320）。"
    )


def scan(paths: list[Path], now: datetime, root: Path = ROOT) -> list[str]:
    messages = []
    for path in paths:
        if kind(path, root) is None:
            continue
        findings = future_times(path, path.read_text(encoding="utf-8"), now, root)
        if findings:
            messages.append(reason(path, findings, now, root))
    return messages


def hook(payload: dict, now: datetime, root: Path = ROOT) -> dict | None:
    event = payload.get("hook_event_name")
    tool = payload.get("tool_name")
    if event == "PreToolUse" and tool in ("Write", "Edit", "MultiEdit"):
        entry = payload.get("tool_input", {})
        path = Path(entry["file_path"])
        if not path.is_absolute():
            path = root / path
        if kind(path, root) is None:
            return None
        edits = ([{"new_string": entry["content"]}] if tool == "Write" else
                 [entry] if tool == "Edit" else entry["edits"])
        current = path.read_text(encoding="utf-8") if tool != "Write" and path.is_file() else ""
        findings = []
        for edit in edits:
            old = edit.get("old_string", "")
            offset = current.count("\n", 0, current.find(old)) if old and old in current else 0
            findings.extend((line + offset, stamp) for line, stamp in
                            future_times(path, edit["new_string"], now, root))
            if old:
                current = current.replace(old, edit["new_string"], 1)
        if findings:
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse", "permissionDecision": "deny",
                "permissionDecisionReason": reason(path, findings, now, root),
            }}
    if event == "PostToolUse" and tool in ("Bash", "PowerShell"):
        threshold = now.timestamp() - RECENT.total_seconds()
        paths = [path for path in candidates(root) if path.stat().st_mtime >= threshold]
        messages = scan(paths, now, root)
        if messages:
            return {"decision": "block", "reason": "\n".join(messages)}
    return None


def main() -> int:
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--scan", action="store_true")
        parser.add_argument("files", nargs="*")
        args = parser.parse_args()
        now = datetime.now()
        if args.scan:
            messages = scan([Path(name).resolve() for name in args.files] if args.files else candidates(), now)
            for message in messages:
                print(message)
            print(f"未来時刻: {len(messages)} ファイル")
            return 1 if messages else 0
        payload = json.load(sys.stdin)
        output = hook(payload, now)
        if output is not None:
            print(json.dumps(output, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"POINTERCAD_HOOK_FAIL_OPEN: 時刻の判定不能: {exc}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
