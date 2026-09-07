#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
post-add-refcheck.py — commit-queue3.sh の `git add` 直後に走る参照検査(rules/06 10.20)。

目的: stage したファイルの中身が、"見えない"(HEAD にも今回の stage にも無い)ファイルを
参照していないかを確かめる。job 1255 の事故(help-content の index.ts がヘルプ 6 本を
参照しているのに、その .md が job の一覧に無かった)の再発を防ぐ。

通常モード:
    "$PY" post-add-refcheck.py
  - `git diff --cached --name-only` で stage 済み一覧を取り、対象ファイルの中身は
    `git show :<path>` (stage 済みの内容) を読む。

simulate モード(統括の自己検証用。git add はしない):
    "$PY" post-add-refcheck.py --simulate <path> <path> ...
  - 与えたファイル一覧を「stage したとみなす」対象にする。対象ファイルの中身は
    stage 済みの内容の代わりに **作業ツリー** の内容を読む(git show は使わない)。

いずれのモードも、HEAD の一覧 (`git ls-tree -r --name-only HEAD`) と対象一覧の和集合を
「見える集合」とする。

終了コード: 見つからない参照が 0 件なら 0、1 件以上あれば非 0。
出力: 日本語 1 行 + 欠けの一覧(0 件なら欠けの行は出さない)。
"""

import io
import json
import posixpath
import re
import subprocess
import sys

# Windows のコンソールコードページで日本語が文字化けしないよう、標準出力を UTF-8 に固定する。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def run_git(args, cwd):
    result = subprocess.run(
        ["git"] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return result.returncode, result.stdout, result.stderr


def get_repo_root():
    code, out, err = run_git(["rev-parse", "--show-toplevel"], cwd=None)
    if code != 0:
        sys.stderr.write("git リポジトリのルートが見つかりません: " + err + "\n")
        sys.exit(2)
    return out.strip()


def get_head_files(repo_root):
    code, out, err = run_git(["ls-tree", "-r", "--name-only", "HEAD"], cwd=repo_root)
    if code != 0:
        sys.stderr.write("HEAD の一覧取得に失敗しました: " + err + "\n")
        sys.exit(2)
    return set(line.strip() for line in out.splitlines() if line.strip())


def get_staged_files(repo_root):
    code, out, err = run_git(["diff", "--cached", "--name-only"], cwd=repo_root)
    if code != 0:
        sys.stderr.write("stage 済み一覧の取得に失敗しました: " + err + "\n")
        sys.exit(2)
    return [line.strip() for line in out.splitlines() if line.strip()]


def read_staged_content(repo_root, path):
    code, out, err = run_git(["show", ":" + path], cwd=repo_root)
    if code != 0:
        return None
    return out


def read_worktree_content(repo_root, path):
    import os

    full = os.path.join(repo_root, path.replace("/", os.sep))
    try:
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


# ---- 相対 import の抜き出し ----

IMPORT_PATTERNS = [
    re.compile(r"""from\s+['"](\.[^'"]+)['"]"""),
    re.compile(r"""import\(\s*['"](\.[^'"]+)['"]\s*\)"""),
    re.compile(r"""import\s+['"](\.[^'"]+)['"]"""),
]


def extract_relative_imports(content):
    specs = []
    for pattern in IMPORT_PATTERNS:
        for m in pattern.finditer(content):
            specs.append(m.group(1))
    # 順序を保ったまま重複を除く
    seen = set()
    out = []
    for s in specs:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def resolve_candidates(importer_path, spec):
    importer_dir = posixpath.dirname(importer_path)
    target = posixpath.normpath(posixpath.join(importer_dir, spec))
    if target.startswith("../"):
        # リポジトリ外へは出ない想定だが、そのまま候補にする(見える集合に無ければ欠けとして扱う)
        pass
    if target.endswith(".js"):
        base = target[: -len(".js")]
        return [
            base + ".ts",
            base + ".tsx",
            base + ".d.ts",
            base + "/index.ts",
        ]
    # 拡張子なし・.js 以外(稀)はそのまま + 各種候補
    return [
        target,
        target + ".ts",
        target + ".tsx",
        target + ".d.ts",
        target + "/index.ts",
    ]


def check_ts_imports(repo_root, file_path, content, visible, missing):
    for spec in extract_relative_imports(content):
        candidates = resolve_candidates(file_path, spec)
        if not any(c in visible for c in candidates):
            missing.append("%s → %s" % (file_path, spec))


# ---- help-content の目録(index.ts)の .md 参照 ----

HELP_PATH_PATTERN = re.compile(r"""path:\s*'(docs/ja/[^']+\.md)'""")


def check_help_index(file_path, content, visible, missing):
    help_root = "packages/help-content"
    for m in HELP_PATH_PATTERN.finditer(content):
        rel = m.group(1)
        full = posixpath.join(help_root, rel)
        if full not in visible:
            missing.append("%s → %s" % (file_path, full))


# ---- ja.json は JSON として読めることだけ確認 ----


def check_json_parses(file_path, content, missing):
    try:
        json.loads(content)
    except (ValueError, TypeError) as exc:
        missing.append("%s → JSON として読めません(%s)" % (file_path, exc))


def main():
    argv = sys.argv[1:]
    simulate_files = None
    if argv and argv[0] == "--simulate":
        simulate_files = [a for a in argv[1:] if a.strip()]

    repo_root = get_repo_root()
    head_files = get_head_files(repo_root)

    if simulate_files is not None:
        target_files = simulate_files
        read_content = lambda p: read_worktree_content(repo_root, p)  # noqa: E731
    else:
        target_files = get_staged_files(repo_root)
        read_content = lambda p: read_staged_content(repo_root, p)  # noqa: E731

    visible = set(head_files) | set(target_files)

    missing = []

    for file_path in target_files:
        if file_path.endswith(".ts") or file_path.endswith(".tsx"):
            content = read_content(file_path)
            if content is None:
                continue
            check_ts_imports(repo_root, file_path, content, visible, missing)
            if file_path == "packages/help-content/src/index.ts":
                check_help_index(file_path, content, visible, missing)
        elif file_path == "packages/ui/src/i18n/ja.json":
            content = read_content(file_path)
            if content is None:
                continue
            check_json_parses(file_path, content, missing)

    if missing:
        print("参照検査: 見える集合に無い参照が %d 件あります" % len(missing))
        for line in missing:
            print("  " + line)
        return 1

    print("参照検査: 問題なし(見える集合に無い参照は 0 件)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
