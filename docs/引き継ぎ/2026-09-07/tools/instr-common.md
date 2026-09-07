# 共通の規律(全指示書の先頭。本文より優先する)

1. **子エージェント(Codex のサブエージェント機能・他の AI ツール・別セッション)を起こさない(検査も自分で前景で実行する)。**
2. **git への書き込み禁止(`git stash` を含む)。** commit / add / checkout / reset / worktree / push / stash / branch を一切実行しない。前後比較は `git diff` / `git status` / `git log` の読み取りだけ。
3. **触ってよいファイルは本文の「編集所有ファイル」だけ。** 「読取専用の依存」は読むだけ。それ以外は開いても変更しない。新規ファイルは本文に「新規」と書かれたものだけ作る。
4. 作業場所は `C:/Users/oltot/Documents/git-projects/PointerCAD`(pnpm モノレポ、TypeScript strict)。**他の担当が並行して別のファイルを編集中。** `git status` に自分の所有外の変更が見えても触らない・戻さない(報告に「他担当の変更あり: <ファイル名>」とだけ書く)。全体の typecheck / lint が他担当の書きかけで赤になることがある。自分の所有ファイルに起因する赤が 0 であることを確かめ、他由来の赤はファイル名と件数を報告に書く。
5. 起動禁止: ブラウザ・Electron・開発サーバー(vite dev / preview)・Playwright(E2E)。テストは前景で実行し、背景実行・watch モードにしない。
6. 禁止(rules/02): 型の強制変換 `as`(`as const` を除く)、`any`、`@ts-ignore`、`@ts-expect-error`、`eslint-disable`、テストの期待値や性能上限(`expectWithinBudget` の予算)の緩和、`package.json` の依存変更、`pnpm-lock.yaml`、vendor ファイル、`.github/`、`scripts/`、`e2e/`。既存テストが自分の変更で赤になったら期待値を変えずに実装を直す。**例外は 1 つ**: 指示書が明示的に指示した仕様の変更(鍵の文字列・型の欄・戻り値の形など)を、既存テストが旧仕様の値として厳密に固定している場合は、**その固定を新仕様の厳密な値に置き換えてよい**(検査を弱めるのではなく新仕様を厳密に検査する変更。テスト名・入力・期待値を新仕様に合わせ、report.md に「仕様変更に伴う既存テストの更新」として 1 件ずつ列挙する)。それ以外で仕様の変更が要ると判断したら理由を報告して止まる。
7. 前提が違うときの扱い: **止まるのは「指示された変更が成立しない」「指示に無い設計判断が要る」「依存の API や対象ファイルが存在しない」とき**だけ。編集前に止まり、`progress.md` と最終メッセージに何が違うかと選択肢・推奨を書く(勝手に範囲を広げない)。一方、**行番号のずれ・テスト件数などの参考値のずれ・注記の文言の違いのように、作業の中身を変えない差は、実測値を `progress.md` に書いて続行する**(止まらない)。
8. 検査コマンド(すべて前景):
   - 型: `pnpm -w run typecheck`(全体。他担当の赤は 4 のとおり扱う)
   - lint: `pnpm exec eslint <自分の編集したファイル…>`
   - 単体: `pnpm --filter @pointercad/<pkg> exec vitest run <ファイル名の一部>`(pkg = kernel / model / ui / io / expression / drawing / help-content)。パッケージ全体は `pnpm --filter @pointercad/<pkg> run test`
   - 結果は数値で報告する(合格件数・失敗件数・所要時間)。「たぶん通る」は不可。
   - **sandbox の中では PowerShell の実行ポリシーが `.ps1` の入口を拒み、`.cmd` の入口は Corepack の取得で失敗する。** その場合は `node C:/Users/oltot/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs <引数…>` で直接呼ぶ(第 1 波の担当が実証済み。版 11.25.0)。上の `pnpm …` はすべてこの形に置き換えてよい。
9. 報告: 報告先ディレクトリ `__OUT__` に `progress.md`(10 分ごとに「終えた段階・いま・残り」を追記。統括が停滞監視に使う)と `report.md`(最終報告: 変更ファイル一覧、各段階の検査結果の数値、前提違い・未実証・統括への依頼)を書く。最終メッセージの末尾に「子エージェントの使用: なし」「git への書き込み: なし」の 2 行を必ず書く(使った・書いた場合は内容を明記)。
10. 設計の規律(rules/04): 内部単位は mm / rad。OCCT の所有権は new の単独所有・Handle への移譲・借用 `get()` を分けて扱い、二重解放も解放漏れも作らない(rules/06 10.13)。キャッシュ上の形を OCCT の builder に渡すときは貸した形を変異させない(10.16)。ui は kernel を直接 import しない。状態は Zustand 1 本(スライス合成)。日本語の文言は `packages/ui/src/i18n/ja/<機能>.json`。
11. 規約の正本は `CLAUDE.md` と `rules/00〜06`(読んでよい。本指示書と矛盾したら本指示書を優先し、矛盾を報告に書く)。

---

