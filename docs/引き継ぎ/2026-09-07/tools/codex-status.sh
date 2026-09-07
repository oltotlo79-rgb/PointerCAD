#!/usr/bin/env bash
# 使い方: codex-status.sh [job名...]  引数なし = 全 job。各 job の状態・最終更新・件数・最後の操作を 1 行ずつ出す
SP="C:/Users/oltot/AppData/Local/Temp/claude/C--Users-oltot-Documents-git-projects-PointerCAD/97bbbc31-8178-49a4-b3da-7d4a3d793e68/scratchpad"
now=$(date +%s)
if [ $# -eq 0 ]; then set -- $(ls "$SP/codex"); fi
for j in "$@"; do
  d="$SP/codex/$j"; [ -d "$d" ] || continue
  ev="$d/events.jsonl"
  if [ -f "$ev" ]; then
    m=$(stat -c %Y "$ev"); age=$(( (now - m) / 60 ))
    n=$(grep -c '"item.completed"' "$ev")
    done_line=$(grep -o '=== DONE rc=[0-9]* ===' "$ev" | tail -1)
    last=$(python - "$ev" <<'PY'
import json,sys
last=''
for l in open(sys.argv[1],encoding='utf-8'):
    l=l.strip()
    if not l.startswith('{'): continue
    try: e=json.loads(l)
    except Exception: continue
    it=e.get('item') or {}
    t=it.get('type')
    if t=='command_execution': last='cmd: '+(it.get('command') or '')[:110].replace('\n',' ')
    elif t=='agent_message': last='msg: '+(it.get('text') or '')[:110].replace('\n',' ')
    elif t=='file_change': last='file: '+json.dumps(it.get('changes',''),ensure_ascii=False)[:110]
    elif t=='reasoning': last='reasoning: '+(it.get('text') or '')[:110].replace('\n',' ')
    elif e.get('type')=='turn.completed': last='turn.completed usage='+json.dumps(e.get('usage'))
print(last)
PY
)
    echo "[$j] ${done_line:-走行中} 最終更新 ${age} 分前 items=$n | $last"
  else
    echo "[$j] events なし: $(cat "$d/status.txt" 2>/dev/null | head -1)"
  fi
done
