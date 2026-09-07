"""報告記録の先頭の節(最新)の「残件」行の直前に、追記の行を差し込む。
使い方: python report-append.py <追記本文のUTF-8ファイル> [<新しい残件行のUTF-8ファイル>]
追記本文の先頭に「- **追記(実時計 HH:MM、M/D)**: 」は呼び出し側が含める。
"""
import io
import sys

p = "docs/報告記録.md"
lines = io.open(p, encoding="utf-8", newline="").read().split("\n")
# 先頭の節の見出し(「## 20」で始まる最初の行)を探し、その節の「残件」行を見つける
start = next(i for i, l in enumerate(lines) if l.startswith("## 20"))
idx = next(i for i in range(start, len(lines)) if lines[i].startswith("- **残件**"))
text = io.open(sys.argv[1], encoding="utf-8").read().strip("\r\n")
lines.insert(idx, text)
if len(sys.argv) > 2:
    lines[idx + 1] = io.open(sys.argv[2], encoding="utf-8").read().strip("\r\n")
io.open(p, "w", encoding="utf-8", newline="").write("\n".join(lines))
print("ok: inserted at line", idx + 1, "remain updated:", len(sys.argv) > 2)
