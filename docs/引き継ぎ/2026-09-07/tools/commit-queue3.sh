#!/bin/bash
# コミットの待ち行列(第 3 版)。queue/*.job を名前順に 1 件ずつ処理する(同時に 1 本だけ)。
# 第 2 版との違い: コミット前検査が stage 済みの写しで走る(隔離)ようになり、失敗が決定的になったので
# 再試行を 30 回 × 180 秒から 2 回 × 60 秒へ縮めた(index.lock などの一時的な失敗だけを吸収する)。
# job: MSG=<メッセージファイル名> FILES="<git add するパス…>" [POST_ADD=<git add の後に実行する scratchpad のスクリプト名>]
# rules/06 10.20: git add の直後、POST_ADD の前に参照検査(post-add-refcheck.py)を既定で全 job に効かせる。
S=/c/Users/oltot/AppData/Local/Temp/claude/C--Users-oltot-Documents-git-projects-PointerCAD/97bbbc31-8178-49a4-b3da-7d4a3d793e68/scratchpad
PY="C:\Users\oltot\AppData\Local\Programs\Python\Python312\python"
cd /c/Users/oltot/Documents/git-projects/PointerCAD || exit 1
rm -f "$S/queue/STOP"
mkdir -p "$S/queue-done" "$S/queue-failed"
echo "=== 待ち行列(第 3 版) 開始 $(date +%H:%M)"
idle=0
while true; do
  [ -f "$S/queue/STOP" ] && { echo "=== STOP $(date +%H:%M)"; exit 0; }
  job=$(ls "$S/queue"/*.job 2>/dev/null | sort | head -1)
  if [ -z "$job" ]; then
    idle=$((idle+1)); [ $idle -gt 180 ] && { echo "=== 6 時間空なので終了 $(date +%H:%M)"; exit 0; }
    sleep 120; continue
  fi
  idle=0
  MSG=""; FILES=""; POST_ADD=""
  . "$job"
  name=$(basename "$job" .job)
  echo "=== job $name 開始 $(date +%H:%M)"
  git reset -q
  # shellcheck disable=SC2086
  git add $FILES || { echo "=== job $name add 失敗 $(date +%H:%M)"; mv "$job" "$S/queue-failed/"; continue; }
  "$PY" "$S/post-add-refcheck.py" || { echo "=== job $name 参照検査 失敗 $(date +%H:%M)"; git reset -q; mv "$job" "$S/queue-failed/"; continue; }
  if [ -n "$POST_ADD" ]; then
    bash "$S/$POST_ADD" || { echo "=== job $name POST_ADD 失敗 $(date +%H:%M)"; git reset -q; mv "$job" "$S/queue-failed/"; continue; }
  fi
  git diff --cached --stat | tail -1
  k=0
  until git commit -F "$S/$MSG"; do
    k=$((k+1)); echo "=== job $name attempt $k failed at $(date +%H:%M)"
    [ $k -ge 3 ] && break
    [ -f "$S/queue/STOP" ] && break
    sleep 60
  done
  if [ "$(git log -1 --format=%s)" = "$(head -1 "$S/$MSG")" ]; then
    echo "=== job $name committed $(date +%H:%M): $(git log -1 --format=%h)"; mv "$job" "$S/queue-done/"
  else
    echo "=== job $name 失敗 $(date +%H:%M)"; git reset -q; mv "$job" "$S/queue-failed/"
  fi
done
