"""待ち行列の job を束ねて 1 コミットにする(利用者の決定 2026-09-05 17:55)。
各 job の MSG の本文(題・末尾の Co-Authored-By/Claude-Session を除く)を連ねた 1 つのメッセージと、
FILES を合わせた 1 つの job を作り、元の job は queue-merged/ へ移す。
"""
import io
import os
import re
import shutil
import sys

S = r"C:\Users\oltot\AppData\Local\Temp\claude\C--Users-oltot-Documents-git-projects-PointerCAD\97bbbc31-8178-49a4-b3da-7d4a3d793e68\scratchpad"
TRAILER = ("Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\n"
           "Claude-Session: https://claude.ai/code/session_01Uuq67vPd8xbP8Uui8ay6Dp\n")


def read_job(name):
    text = io.open(os.path.join(S, "queue", name), encoding="utf-8").read()
    msg = re.search(r"^MSG=(.+)$", text, re.M).group(1).strip()
    files = re.search(r'^FILES="(.*)"$', text, re.M).group(1).split()
    return msg, files


def body_of(msgfile):
    lines = io.open(os.path.join(S, msgfile), encoding="utf-8").read().rstrip("\n").split("\n")
    title = lines[0]
    body = [l for l in lines[1:] if not l.startswith("Co-Authored-By:") and not l.startswith("Claude-Session:")]
    while body and body[0] == "":
        body.pop(0)
    while body and body[-1] == "":
        body.pop()
    return title, "\n".join(body)


def merge(new_job, new_msg, title, intro, jobs):
    parts = []
    all_files = []
    for j in jobs:
        msg, files = read_job(j)
        t, b = body_of(msg)
        parts.append(f"[{t}]\n{b}")
        for f in files:
            if f not in all_files:
                all_files.append(f)
    out = title + "\n\n" + intro + "\n\n" + "\n\n".join(parts) + "\n\n" + TRAILER
    io.open(os.path.join(S, new_msg), "w", encoding="utf-8", newline="\n").write(out)
    io.open(os.path.join(S, "queue", new_job), "w", encoding="utf-8", newline="\n").write(
        f'MSG={new_msg}\nFILES="{" ".join(all_files)}"\n')
    os.makedirs(os.path.join(S, "queue-merged"), exist_ok=True)
    for j in jobs:
        shutil.move(os.path.join(S, "queue", j), os.path.join(S, "queue-merged", j))
    print("merged", new_job, "files", len(all_files), "from", jobs)


merge(
    "410-p5-kernel-should.job", "commit-msg-p5-kernel-should.txt",
    "kernel に Should 群の形を作る関数 7 種(押し出しの終端とテーパ・抜き勾配・ミラー/移動/拡大縮小・スイープ・リブ・エンボス・曲面)を追加",
    "P5 タスク33・34・35・37・38・39・41。いずれも occt/ の新しい関数(段・輸出・性能検査はタスク42)で互いに独立。\n"
    "隔離したコミット前検査が 1 件 14〜20 分かかるため、利用者の決定(2026-09-05 17:55)で同じ組を 1 コミットに束ねた。\n"
    "以下、各タスクの記録(角括弧は元の題)。",
    ["410-p5-t35.job", "420-p5-t33.job", "430-p5-t34.job", "440-p5-t39.job", "450-p5-t38.job", "460-p5-t37.job", "470-p5-t41.job"],
)
merge(
    "480-p5-kernel-cut-could.job", "commit-msg-p5-kernel-cut-could.txt",
    "kernel に平面による切断(makeCut)と Could 群(くり抜き・薄板押し出し・可変半径フィレット)を追加",
    "P5 タスク27b 前半・タスク53。いずれも occt/ の新しい関数(段・輸出・性能検査はタスク42)。\n"
    "隔離したコミット前検査の回数を減らすため、利用者の決定(2026-09-05 17:55)で 1 コミットに束ねた。\n"
    "以下、各タスクの記録(角括弧は元の題)。",
    ["480-p5-t27b.job", "490-p5-t53.job"],
)
