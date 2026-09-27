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
| 5 | 整合検査(`check-release-ready.ps1`。ヘルプと取扱説明書の1対1対応・文言一致・画像の生成元一致・機能の過不足なし。NFR-MA-6) | `scripts/check-release-ready.ps1`(内部で`node scripts/release/releaseReadiness.mjs`を呼ぶ) | 説明書だけの判定は`-Mode Manual -Manual <出力名>`(P12-20)。公開前モード(P13-15)は入力に5つの候補フォルダー(Windows/Linuxデスクトップ・Web・`release-manifest.json`・`sbom.json`)が要る。これらは下表10.・11.の配布CI(`release.yml`のdesktop/web/combineの3job)の生成物であるため、実務では10.・11.の組み立てを経てから5.を実行することになる(rules/05 §11.2の記載順はそのまま維持し、本表もその順で並べている)。デスクトップ先行の公開では`-Scope Desktop`を付ける(下の「デスクトップ先行の公開」)。項目・終了コードは`scripts/release/README.md`の「公開前の整合検査」を正とする。 |
| 6 | `scripts/check.ps1` 合格 | `scripts/check.ps1`(既定で`-Level Push`相当の全段。公開前は`-Full`) | 統括が独立コピーで実行する(rules/01 §1、rules/03 §7)。作業担当はルートで実行しない。 |
| 7 | リリースノート(日本語)作成 | `docs/releases/v<版>.md`(新規作成。生成スクリプトなし) | 内容は実装済みの機能・README・ヘルプの記述と照合して書く(rules/05 §11.3: 内部用語を使わない)。 |
| 8 | コミット | git(`git commit`。統括が実行) | rules/01 §1で統括が直接実行してよい操作。専用スクリプトなし。コミットメッセージの規約は`rules/03-品質ゲート.md` §6。 |
| 9 | タグ | git(`git tag`。統括が実行) | ルート・`apps/desktop`・`apps/web`の`package.json`、electron-builderの設定、gitタグの版を一致させる(rules/05 §11.1)。専用スクリプトなし。 |
| 10 | デスクトップ成果物(Windows: NSISとポータブル版 / Linux: AppImage。取扱説明書(PDF)を同梱)の生成と起動確認 | `.github/workflows/release.yml`(`desktop`job): `scripts/release/build-desktop-output.mjs` → `scripts/manual/generate.mjs` → `scripts/manual/generate-pdf.mjs` → `scripts/release/assemble-desktop.mjs` → `scripts/release/package-desktop.mjs` | 起動確認はアプリの起動を伴うため統括が実機で行う(rules/01 §1: アプリの起動と終了は統括だけ)。専用の確認スクリプトなし。 |
| 11 | Web版(Cloudflare Pages。取扱説明書を同梱)のデプロイ確認(デスクトップ先行の公開では、Web版の公開時に行う) | `.github/workflows/release.yml`(`web`job): `scripts/release/build-web-offline.mjs` → `scripts/manual/generate.mjs` → `scripts/manual/generate-pdf.mjs` → `scripts/release/assemble-web-offline.mjs` | Cloudflare Pagesへの実際のアップロードを自動化するworkflowは`.github/`に無い(`release.yml`冒頭のコメントで公開操作は範囲外と明記)。管理画面からの直接アップロードと公開後の確認手順は`docs/standards/cloudflare-pages.md`を参照(本担当の編集範囲外のため参照のみ)。 |

## デスクトップ先行の公開(2026-09-27〜)

利用者の指示「最優先でデスクトップアプリのリリースをすること」「Webアプリ側は進めるがデスクトップアプリのリリースは止めないこと」(2026-09-27 17:3x、`rules/01-役割と委譲.md`冒頭)と決定「配布物は未署名でいい」(同17:2x)により、デスクトップ版(Windowsのインストーラー・ポータブル版、LinuxのAppImage。未署名)を先に公開し、Web版は後日公開する。上表の順序(rules/05 §11.2)は変えず、11.(Web版のデプロイ確認)をWeb版の公開時へ回す。Web版の公開の条件は消さず、公開前検査の`-Scope Desktop`が「後回し」と表示する。`-Scope`を付けない検査(全体モード)は今までどおりWeb版を含む全条件を要求する。

| # | 手順 | 実物 | 合格の条件 |
|---|---|---|---|
| D1 | 版を公開する版(例 `1.0.0`)へそろえ、機能凍結 | ルート・`apps/desktop`・`apps/web`の`package.json`(rules/05 §11.1) | `0.0.0`のままでは公開前検査の「公開用の版」が不合格 |
| D2 | `README.md`の`pointercad:release-links`区間をデスクトップ先行の形にする | `README.md`(下の「READMEの形」) | 公開前検査の「README」が合格 |
| D3 | 配布CIで5つの候補を作る(Web候補も作る。公開一覧と説明書のPDFの元になる) | `.github/workflows/release.yml`(対象commitとタグ`v<版>`を入力) | desktop・web・combineの3jobが成功 |
| D4 | 公開前検査(デスクトップ先行) | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Scope Desktop -Windows <名前> -Linux <名前> -Web <名前> -Release <名前> -Sbom <名前>` | 終了コード0。[後回し]はWebのファイルの大きさ・数(Cloudflareの上限)の2項目だけで、ほかの12項目が[合格] |
| D5 | タグとGitHub Release(統括) | `git tag v<版>`、`gh release create v<版>` | 下の「Releaseに添付するもの」を全て添付する。本文は`docs/releases/v<版>.md` |
| D6 | 公開後の確認(デスクトップ部分。通信する) | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Mode PostRelease -Scope Desktop -Release <名前> -DownloadUrl https://github.com/oltotlo79-rgb/PointerCAD/releases/download/v<版>/` | 終了コード0(配布物3つとPDF全巻を取得して大きさ・SHA-256が`release-manifest.json`と一致し、READMEのDesktopの導線が同じ実物に届く)。結果を`docs/報告記録.md`へ |
| W | Web版の公開時 | READMEのWeb行を`後日公開`から実際のWebアプリのリンクへ替え、説明書の目次(`https://<公開先>/manual/`)を説明書の行へ足す。`-Scope`なしの公開前検査と、11.のデプロイ確認 | 全体モードの公開前検査で終了コード0(公開後の全体モードはWeb版の公開時に実装する。今は終了コード3) |

### READMEの形(デスクトップ先行)

正本は`scripts/release/releaseReadiness.mjs`の`checkReadmeReleaseLinks`(`scope: 'desktop'`)。

- インストーラー・ポータブル版・AppImageの3行: `https://github.com/oltotlo79-rgb/PointerCAD/releases/download/v<版>/<配布物の名前>`(全体モードと同じ)。
- 取扱説明書の行: 同じReleaseに添付したPDF全7巻、`https://github.com/oltotlo79-rgb/PointerCAD/releases/download/v<版>/PointerCAD-<版>-manual-<巻>.pdf`。HTMLはアプリ内のヘルプ(F1)とポータブル版・導入版に同梱の説明書で読めるため、Web版の公開までは説明書の目次(HTML)の行を求めない。
- Webアプリ版の行: `後日公開`と書き、リンクを置かない。`後日公開`はこの行だけに書ける。Web版を`後日公開`とした間は、区間にWebの公開先へのリンクを置かない。「初回リリース時」「準備中」「予定」「未公開」など、ほかの未公開の案内は今までどおり不合格。
- 区間のリンクは、D5でReleaseを作るまで届かない(404)。区間を変えたcommitを`main`へ入れる時期は統括が決める。`README.md`は説明書の画像の指紋(`scripts/vite/webBuildSources.mjs`)に入らないため、機能凍結の後に直しても画像の撮り直しは要らない。`scripts/release/`の中の変更(この点検表の対象の`scripts/release/README.md`を含む)は指紋に入る。

### Releaseに添付するもの

- 配布物3つ: D3の`candidate.json`(`release-manifest.json`の`desktop.windows.assets`・`desktop.linux.assets`)の名前のまま。
- 取扱説明書のPDF全7巻: **Web候補**の`dist/<Web候補>/manual/pdf/<巻>.pdf`を、`PointerCAD-<版>-manual-<巻>.pdf`へ名前だけ変えて添付する(`manualPdfReleaseAssetName`)。公開後の確認は`release-manifest.json`の`web.files`に記録されたこのPDFのSHA-256と照合する。Windows・Linuxの候補の中のPDFは別のjobで印刷したもので、同じ版でもバイト列が同じとは限らないため添付しない。
- そのほかに添付するもの(`SHA256SUMS`・`NOTICE`・`sbom.json`など)は、公開後の確認の照合の対象外。

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
