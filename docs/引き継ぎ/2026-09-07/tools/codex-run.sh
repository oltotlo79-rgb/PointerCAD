#!/usr/bin/env bash
# 使い方: codex-run.sh <job名> <model> <sandbox: read-only|workspace-write> <指示書ファイル> [cwd: repo|self]
#   repo: 作業場所 = 本体リポジトリ(書込可)、報告先 = scratchpad/codex/<job名>(書込可)
#   self: 作業場所 = scratchpad/codex/<job名> だけ書込可(リポジトリは読み取りのみ)
set -u
# rules/06 10.21: 走行中の bash スクリプトを編集すると、bash が続きを読む位置がずれて壊れる。
# 本体を関数にして最後に呼ぶことで、起動時に全文を読み終えてから実行する。さらに起動側は job ごとに写しを作って実行する。
main() {
  SP="C:/Users/oltot/AppData/Local/Temp/claude/C--Users-oltot-Documents-git-projects-PointerCAD/97bbbc31-8178-49a4-b3da-7d4a3d793e68/scratchpad"
  REPO="C:/Users/oltot/Documents/git-projects/PointerCAD"
  name="$1"; model="$2"; sandbox="$3"; instr="$4"; mode="${5:-repo}"
  # 推論の深さ: 環境変数 EFFORT で上書き可。既定は model 別(terra=medium, sol=high, astra=xhigh)
  case "${EFFORT:-}" in
    "") case "$model" in *terra*) effort=medium;; *sol*) effort=high;; *) effort=xhigh;; esac;;
    *) effort="$EFFORT";;
  esac
  out="$SP/codex/$name"
  mkdir -p "$out"
  echo "start $(date '+%F %T') model=$model effort=$effort sandbox=$sandbox mode=$mode instr=$instr" > "$out/status.txt"
  # 指示書 = 共通の規律(instr-common.md、あれば) + 本文。報告先のパスを __OUT__ で差し込む
  full="$out/instruction.md"
  { [ -f "$SP/instr-common.md" ] && [ "$mode" = "repo" ] && cat "$SP/instr-common.md"; cat "$instr"; } | sed "s#__OUT__#$out#g" > "$full"
  if [ "$mode" = "self" ]; then
    codex exec -m "$model" -c model_reasoning_effort="\"$effort\"" -s "$sandbox" -C "$out" --skip-git-repo-check --color never --json -o "$out/last.md" - < "$full" > "$out/events.jsonl" 2> "$out/stderr.txt"
  else
    codex exec -m "$model" -c model_reasoning_effort="\"$effort\"" -s "$sandbox" -C "$REPO" --add-dir "$out" --add-dir "C:/Users/oltot/AppData/Local/pnpm" --color never --json -o "$out/last.md" - < "$full" > "$out/events.jsonl" 2> "$out/stderr.txt"
  fi
  rc=$?
  echo "end $(date '+%F %T') rc=$rc" >> "$out/status.txt"
  echo "=== DONE rc=$rc ===" >> "$out/events.jsonl"
  return $rc

}
main "$@"
exit $?
