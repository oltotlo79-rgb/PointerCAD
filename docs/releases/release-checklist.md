# 公開手順の点検表

この表は[`rules/05-リリース.md`](../../rules/05-リリース.md) §11.2の公開の順序を、2026-09-24時点で実在するスクリプト・workflowの名前に対応づけたものです。手順の追加・変更・削除、スクリプト名の変更があれば、この表も同じ変更でそろえてください。

`rules/05-リリース.md` §11.2は「実装までは上記(整合検査)を手動チェックリストとして1項目ずつ確認し、結果を`docs/報告記録.md`へ記録する」としています。本表がその手動チェックリストです。各回の公開作業で1行ずつ確認し、結果(合格・不合格・保留とその理由)を`docs/報告記録.md`へ記録してください。

## 手順と対応する実物

| # | rules/05 §11.2の手順 | 実在するスクリプト・workflow | 備考 |
|---|---|---|---|
| 1 | 機能凍結 | (対応するスクリプトなし) | 新規実装の着手を止め、公開対象のcommitを確定する運用上の区切り。以降の各項目は同じcommitに対して行う。 |
| 2 | ヘルプ・画像の更新 | (専用の更新スクリプトなし) | 本文は`packages/help-content/docs/ja/`配下のMarkdownを直接編集する。参照する画像が存在しない場合は次の`scripts/manual/generate.mjs`の生成時に検出される。 |
| 3 | 撮影(撮影台本によるスクリーンショットの自動生成) | `scripts/manual/captureRegistry.mjs`(`register`\|`check`) | 実際の画面撮影はPlaywrightの各台本(`e2e/tests/`配下。本表の実在確認の範囲〔`scripts/`・`.github/`〕の外にあるため個別の台本名はここに挙げない)が行い、`packages/help-content/docs/ja/images/capture-manifest.json`へ撮影の来歴(台本・fixtureのSHA-256・撮影日時・版)を記録する。`register`は新規画像を登録、`check`は書き込まずに登録済み内容の整合を確認する。 |
| 4 | 取扱説明書の生成(ヘルプのMarkdownから章を作る) | `scripts/manual/generate.mjs <出力名>`(HTML) → `scripts/manual/generate-pdf.mjs <HTML出力名> <PDF出力名>`(PDF) | 生成後、現在のヘルプ本文と照合する場合は`scripts/manual/verify.mjs <出力名>`を使う。`.github/workflows/release.yml`の`desktop`・`web`の各jobも同じ2スクリプトを同じ順で呼ぶ。 |
| 5 | 整合検査(`check-release-ready.ps1`。ヘルプと取扱説明書の1対1対応・文言一致・画像の生成元一致・機能の過不足なし。NFR-MA-6) | `scripts/check-release-ready.ps1`(内部で`node scripts/release/releaseReadiness.mjs`を呼ぶ) | **作成中。完成後に手順を書き足す。** 2026-09-24 12:52時点で`scripts/check-release-ready.ps1`・`scripts/release/releaseReadiness.mjs`は未追跡(`git status`で`??`)で、並行の担当(`w30a`)が実装中(`scratchpad/claude/agents/registry.md`で稼働中と確認)。完成後は入力に5つの候補フォルダー(Windows/Linuxデスクトップ・Web・`release-manifest.json`・`sbom.json`)が要る。これらは下表10.・11.の配布CI(`release.yml`のdesktop/web/combineの3job)の生成物であるため、実務では10.・11.を経てから5.を実行することになる(rules/05 §11.2の記載順はそのまま維持し、本表もその順で並べている)。 |
| 6 | `scripts/check.ps1` 合格 | `scripts/check.ps1`(既定で`-Level Push`相当の全段。公開前は`-Full`) | 統括が独立コピーで実行する(rules/01 §1、rules/03 §7)。作業担当はルートで実行しない。 |
| 7 | リリースノート(日本語)作成 | `docs/releases/v<版>.md`(新規作成。生成スクリプトなし) | 内容は実装済みの機能・README・ヘルプの記述と照合して書く(rules/05 §11.3: 内部用語を使わない)。 |
| 8 | コミット | git(`git commit`。統括が実行) | rules/01 §1で統括が直接実行してよい操作。専用スクリプトなし。コミットメッセージの規約は`rules/03-品質ゲート.md` §6。 |
| 9 | タグ | git(`git tag`。統括が実行) | ルート・`apps/desktop`・`apps/web`の`package.json`、electron-builderの設定、gitタグの版を一致させる(rules/05 §11.1)。専用スクリプトなし。 |
| 10 | デスクトップ成果物(Windows: NSISとポータブル版 / Linux: AppImage。取扱説明書(PDF)を同梱)の生成と起動確認 | `.github/workflows/release.yml`(`desktop`job): `scripts/release/build-desktop-output.mjs` → `scripts/manual/generate.mjs` → `scripts/manual/generate-pdf.mjs` → `scripts/release/assemble-desktop.mjs` → `scripts/release/package-desktop.mjs` | 起動確認はアプリの起動を伴うため統括が実機で行う(rules/01 §1: アプリの起動と終了は統括だけ)。専用の確認スクリプトなし。 |
| 11 | Web版(Cloudflare Pages。取扱説明書を同梱)のデプロイ確認 | `.github/workflows/release.yml`(`web`job): `scripts/release/build-web-offline.mjs` → `scripts/manual/generate.mjs` → `scripts/manual/generate-pdf.mjs` → `scripts/release/assemble-web-offline.mjs` | Cloudflare Pagesへの実際のアップロードを自動化するworkflowは`.github/`に無い(`release.yml`冒頭のコメントで公開操作は範囲外と明記)。管理画面からの直接アップロードと公開後の確認手順は`docs/standards/cloudflare-pages.md`を参照(本担当の編集範囲外のため参照のみ)。 |

## 配布CI(`release.yml`)を通しで動かす前提

上表3.〜5.・10.・11.をまとめて実行する`.github/workflows/release.yml`は、`workflow_dispatch`(手動起動)だけで動く。起動時に対象commitのフルSHA(40桁16進小文字)を入力する(ブランチ名・タグ名・短縮SHAは拒否される)。任意でタグ(`vX.Y.Z`)も入力でき、指定すると`package.json`の`version`と一致するかを確認する。`resolve`jobが通常CI(`ci.yml`)の集約チェック「`checks (windows-latest)`」「`checks (ubuntu-latest)`」の成功を確認できない限り、以降の`desktop`・`web`・`combine`の各jobは実行されない。生成した各artifactの保持期間は14日、署名は行わない。詳細は`scripts/release/README.md`の「配布CI(P13-16)」節を参照。

## この表の実在確認(2026-09-24 実施)

次のファイルはすべて実在を確認した(確認方法: `ls`によるパスの存在確認。範囲は`scripts/`・`.github/`)。

- `.github/workflows/release.yml`
- `.github/workflows/ci.yml`
- `scripts/check.ps1`
- `scripts/check-release-ready.ps1`(未追跡・作成中。上表5.参照)
- `scripts/manual/generate.mjs`
- `scripts/manual/generate-pdf.mjs`
- `scripts/manual/verify.mjs`
- `scripts/manual/captureRegistry.mjs`
- `scripts/release/build-desktop-output.mjs`
- `scripts/release/assemble-desktop.mjs`
- `scripts/release/package-desktop.mjs`
- `scripts/release/build-web-offline.mjs`
- `scripts/release/assemble-web-offline.mjs`
- `scripts/release/build-release-manifest.mjs`
- `scripts/release/build-sbom.mjs`
- `scripts/release/README.md`
