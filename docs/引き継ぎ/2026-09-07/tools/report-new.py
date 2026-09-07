"""報告記録の先頭(記入様式の後、最新の節の前)へ新しい節を差し込む。
使い方: python report-new.py <節の本文(UTF-8。「## YYYY-MM-DD HH:mm 表題」から始まる)>
"""
import io, sys
p = "docs/報告記録.md"
lines = io.open(p, encoding="utf-8", newline="").read().split("\n")
start = next(i for i, l in enumerate(lines) if l.startswith("## 20"))
text = io.open(sys.argv[1], encoding="utf-8").read().strip("\r\n")
lines[start:start] = text.split("\n") + [""]
io.open(p, "w", encoding="utf-8", newline="").write("\n".join(lines))
print("ok: inserted new section at line", start + 1)
