#!/usr/bin/env bash
# 使い方: codex-launch.sh <job名> <model> <指示書ファイル> [sandbox=workspace-write] [mode=repo]
# codex-run.sh の写しを job ディレクトリに作ってから nohup で起動する(走行中に元を編集しても影響しない)
SP="C:/Users/oltot/AppData/Local/Temp/claude/C--Users-oltot-Documents-git-projects-PointerCAD/97bbbc31-8178-49a4-b3da-7d4a3d793e68/scratchpad"
name="$1"; model="$2"; instr="$3"; sandbox="${4:-workspace-write}"; mode="${5:-repo}"
out="$SP/codex/$name"; mkdir -p "$out"
cp "$SP/codex-run.sh" "$out/run.sh"
nohup bash "$out/run.sh" "$name" "$model" "$sandbox" "$instr" "$mode" > "$out/nohup.txt" 2>&1 &
echo "$name ($model) pid $!"
