# 通信なしで使うWeb版の確認用一式

製品の入力を固定し、他の検査・ビルドが終了した状態で、リポジトリ直下から順に実行する。各出力名は`dist/`直下の新しい名前とし、以前の出力には上書きしない。

```powershell
node scripts/release/build-web-offline.mjs web-offline-source-20260915
node scripts/manual/generate.mjs manual-offline-20260915
node scripts/manual/generate-pdf.mjs manual-offline-20260915 manual-offline-pdf-20260915
node scripts/release/assemble-web-offline.mjs web-offline-source-20260915 manual-offline-20260915 manual-offline-pdf-20260915 web-offline-candidate-20260915
```

1つ目は本体を新しく生成し、入力と出力の内容に加えて生成時のcommit（`sourceCommit`）と未コミットの変更の有無（`dirtySources`）を`web-build.json`へ記録する。追加・削除・変更が生成中に起きた場合は停止する。2つ目と3つ目は同じ本文から全HTMLとPDF巻を生成する。

最後の処理は、本体と説明書の入力が現在の実装と同じこと、`web-build.json`の記録commitが現在のcommitと一致すること、全出力の内容、HTMLとPDFの版・全巻・章の対応を確認する。入力の指紋が同じでも記録commitが現在と違えば停止する（1つ目の実行後に作業ツリーが別のcommitへ進んだ場合など）。本体・説明書・PDF・許諾原文を新しいフォルダーにまとめ、全ファイルの照合後に`offline-assets.json`を最後に書く。途中失敗ではこの一覧を完成させず、以前の一式を変更しない。公開操作は行わない。

この一式は確認用であり、公開済み・完成認定済みという意味ではない。CAD本体の通信なしでの起動・作図・保存・全ヘルプ、容量不足や保存内容の欠落からの復旧、全ページの画像・日本語・PDFの文字と改頁、公開環境での確認、同じ版の両OS検査は別途必要。生成された認定用の値を手でtrueへ変えて代用しない。

## 公開manifestの作成（P13-1）

Windows x64の`candidate.json`（NSIS・ポータブル版）、Linux x64の`candidate.json`（AppImage）、説明書を含むWeb候補の`web-build.json`と`offline-assets.json`が完成した後、同じcommitの作業場所で次を実行する。4つの名前は`dist/`直下のフォルダー名で、最後はまだ存在しない出力名を指定する。

```powershell
node scripts/release/build-release-manifest.mjs <windows-stage> <linux-stage> <web-candidate> <new-output> [v<version>]
```

出力は`dist/<new-output>/release-manifest.json`。この処理は既存の記録とファイルを読み、配布物の組み立てやWeb buildは行わない。ルート・両アプリ・desktop配布設定・tagの版、desktop候補と`web-build.json`双方のcommit（`sourceCommit`）、Web/desktop/説明書の入力指紋、配布ファイルの数・サイズ・SHA-256、全HTML/PDF巻を照合する。`web-build.json`のcommitがこの処理へ渡すcommitと違う場合、または`dirtySources`が`true`の場合は拒否する（commit欄の無い旧い記録はそのまま通す）。記録に無いファイルやmacOS/ARM64候補を拒否する。公開候補を作る前に3つの`package.json`の`version`を同じ公開版へ更新し、その版でWebとdesktopの候補を作り直す。現在の`0.0.0`のままでも模擬検査はできるが、公開版としては扱わない。

後続の検査は`scripts/release/releaseManifest.mjs`の`verifyReleaseManifest`に保存済みJSONと同じ入力を渡して再照合できる。`web.files`はPagesへの全ファイル、`manual.volumes`はHTML/PDF全巻、`desktop.windows/linux.assets`はダウンロード対象の一覧。`releaseCertified: false`は公開前の実起動・リンク・説明書整合の認定を別の工程へ残す。

### 束ねた公開manifest（P13-1・P13-3）

`--sbom <sbom-output>`を付けると、同じ入力から`release-manifest.json`に加えて`publication-manifest.json`（形式`pointercad-publication/1`）も同じフォルダーへ書く。先に`build-sbom.mjs`で`dist/<sbom-output>/sbom.json`を作っておく。付けない場合の動きと`release-manifest.json`の中身は従来と同じ。

```powershell
node scripts/release/build-sbom.mjs sbom-output
node scripts/release/build-release-manifest.mjs desktop-stage-windows desktop-stage-linux web-candidate release-output [v<version>] --sbom sbom-output
```

判定は`scripts/release/publicationManifest.mjs`の`createPublicationManifest`。既存の記録の形式は変えず、束ねる側だけを足した。1つでも外れたら何も書かずに止まる。

- 束ねるもの: `release-manifest.json`（候補2つ・`web-build.json`・`offline-assets.json`・説明書の版をすでに束ねている。配布物から作り直して一致を確かめてから使う）、`sbom.json`（版・commit・原文の欠け・配布ファイルの照合）、撮影の登録簿`packages/help-content/docs/ja/images/capture-manifest.json`。それぞれのSHA-256を記録する。自分自身のhashは記録しない。
- 大きさ: Webの全ファイルを区分（`occt`・`exact-math`・`script-vm`・`fonts`・`manual-pdf`・`manual`・`licenses`・`control`・`application`）ごとに数とバイト数で記録し、1ファイル26,214,400バイト以下・1,000ファイル以下（Pagesの管理画面からの直接アップロード。`docs/standards/cloudflare-pages.md`）と、配布物1つが2GiB未満（GitHub Releases）を確かめる。上限の値は公開前検査（`releaseReadiness.mjs`の`PAGES_MAX_FILE_BYTES`・`PAGES_MAX_FILES`）と同じであることを単体検査で固定している。
- 復元: `occt/manifest.json`の片をWebの読込みと同じくgzipとして明示的に展開し、記録の大きさ・SHA-256、WebAssemblyの先頭と一致すること、Windows・Linuxの候補に入っている展開済みの核と同じであることを確かめる。途中で切れた片、解凍済みのまま置かれた片、2回圧縮した片、記録より大きく展開される片は、それぞれ理由を付けて拒否する。`_headers`が`/occt/`の片へ`Content-Encoding`を付ける設定（通信の途中で解凍され、読込み側で2回目の解凍になる）と、`application/octet-stream`で配らない設定も拒否する。
- 計算部: 追加計算部（`exact-math/runtime/pyodide.asm.wasm`）と自動作図の実行部（`assets/quickjs-pcad-*.wasm`）がWebにあり、両OSの候補と同じ内容であること、字体のファイルがあること、全巻のHTMLとPDFがそろっていることを確かめ、SBOMから核・計算部・数式入力の版（`opencascade.js`・`Pyodide`・`sympy`・`mpmath`・`quickjs-pcad.wasm`・`mathlive`）を読んで記録する。
- 保存済みの`publication-manifest.json`は`verifyPublicationManifest`に同じ入力を渡して作り直し、1か所でも違えば拒否する。`releaseCertified: false`のままで、公開の可否は公開前検査（P13-15）と公開後の確認（P13-20）で決める。

## SBOM・ライセンス一覧の作成（P13-6）

配布に入る直接・推移のnpm依存、数式字体・画面用字体、自動作図(QuickJS-ng)の実行部、追加計算部(Pyodide/SymPy/mpmath等)の固定資産を、既存の`scripts/vite/mathNotices.mjs`・`runtimeNotices.mjs`・`scriptRuntimeNotices.mjs`・`exactMathAssets.mjs`の検査結果から集め、1つのCycloneDX形式`sbom.json`にまとめる。生成やビルドは行わず、既存の記録を読むだけ。

```powershell
node scripts/release/build-sbom.mjs <new-output>
```

出力は`dist/<new-output>/sbom.json`。標準出力には部品数・原文が全く無い件数(`unresolvedNotices`)・SPDX識別子が未分類の件数(`unclassifiedLicenses`)をJSONで表示する。

- 形式はSPDXでなくCycloneDXを採用した(理由の全文は`scripts/release/sbom.mjs`冒頭のコメント)。既存の許諾記録がすでに`name`/`version`/`license`/`notice`/`hash`の平坦な組であり、CycloneDXの`components[]`はその形にそのまま対応する。同梱原文が標準条文と一致すると確認できた部品だけにSPDX識別子を記録し、確認できない部品(`liblzma from XZ 5.2.2`・`SQLite 3.39.0`の2件)にはSPDX識別子を推測で割り当てずに済む。
- `findSbomGaps(sbom)`は「原文そのものが無い(`unresolvedNotices`。NOTICEの「原文未取得」に相当)」と「原文はあるがSPDX識別子が未分類(`unclassifiedLicenses`)」を区別して返す。前者だけを`assertSbomPublishable`が拒否する。
- `matchSbomToReleaseManifest(sbom, releaseManifest)`は、`release-manifest.json`(P13-1)の`web.files`と、SBOMが記録した配布先パス・ハッシュ(`pointercad:distributedFile`)を照合する。対象は原文・小さな固定パスの資産だけで、Viteがビルド時にハッシュを付けるファイル名(字体等)や16MBを超えて分割される資産(`vendor/exact-math/sources/`の一部)は対象外(それぞれ理由をコード内コメントに明記)。`release-manifest.json`が無い状態でも、テストと同じ形の入力を渡せば照合できる。

## 配布CI(P13-16)

上記の手元手順を、GitHub Actionsの`.github/workflows/release.yml`から呼べる。**`workflow_dispatch`(手動起動)だけで動き、push/pull_request/tagでは動かない。** 起動時に対象commitのフルSHA(40桁16進)を入力する(任意でタグ`vX.Y.Z`も入力でき、指定すると`package.json`のversionと一致するか確認する)。

処理の流れ:

1. `resolve`job: 入力commitの形式を確認し、その版を`checkout`した上で、通常CI(`ci.yml`)の集約check run「`checks (windows-latest)`」「`checks (ubuntu-latest)`」が両方とも成功していることを`gh api .../check-runs`で確認する。両方の成功が無ければ以降のjobを実行しない。
2. `desktop`job(Windows/Ubuntuのrunnerでmatrix実行): `build-desktop-output.mjs` → `scripts/manual/generate.mjs` → `scripts/manual/generate-pdf.mjs` → `assemble-desktop.mjs` → `package-desktop.mjs`を順に呼び、Windows(NSIS・ポータブル)/Linux(AppImage)それぞれの候補一式(`app/`・`packaging/`・`artifacts/`・`candidate.json`)をartifactへ保存する。`artifacts/`には配布するファイル(Windowsは`-setup.exe`と`-portable.exe`、Linuxは`.AppImage`)だけを置き、electron-builderの展開済みの本体(`win-unpacked/`・`linux-unpacked/`)・設定の控え・変換したアイコンは`builder/`へ分ける(`builder/`はartifactへ保存しない)。
3. `web`job(Ubuntu runner): `build-web-offline.mjs` → `scripts/manual/generate.mjs` → `scripts/manual/generate-pdf.mjs` → `assemble-web-offline.mjs`を順に呼び、Web候補一式をartifactへ保存する。
4. `combine`job(Ubuntu runner): 対象commitを`checkout`し直し、上記2種のDesktop候補とWeb候補をartifactから取得した上で、`build-sbom.mjs`でSBOMを作り、`build-release-manifest.mjs`で本節冒頭の`release-manifest.json`を組み立てる。別commitの成果物混入・組み立て後のバイト列の変化・古いartifactの再利用は、このスクリプトが呼ぶ`createReleaseManifest`(`releaseManifest.mjs`)自身がsourceCommitの一致・入力指紋の一致・`candidate.json`記録済みhashとの一致で厳密に拒否する(workflow側で検査を緩めることはできない)。結果の`release-manifest.json`と`sbom.json`を1つのartifactへまとめて保存する。

既知の設計上の注意点:

- **Windows/Linux間の改行変換**: このリポジトリの`.gitattributes`は一部のファイル(gitフック・`*.ps1`・許諾原文)だけ改行を固定しており、大半のソースファイルはcheckoutする側のGitの`core.autocrlf`設定に委ねられている。Windows runnerとLinux runnerで既定が異なると、同じcommitでもcheckoutしたバイト列(ひいてはソース指紋のSHA-256)が食い違い得るため、`release.yml`の各jobはcheckout前に`git config --global core.autocrlf false`と`core.eol lf`を設定し、常にリポジトリ保存どおりのバイト列を取り出す。
- **署名は行わない**: `candidate.json`・`desktop-package.json`・`release-manifest.json`はいずれも`signed: false`を記録し、`createReleaseManifest`もそれを前提に検証する。署名鍵などの秘密の値は`release.yml`のどこにも登場しない(初回は未署名の方針。`rules/05-リリース.md`、P13-2の判断待ち)。
- **公開操作は行わない**: GitHub Releasesへの添付、Cloudflare Pagesへのデプロイ等はこのworkflowの範囲外。成果物はActions artifactとして取得し、以降の検証(P13-17)・公開判断(P13-19)へ手動で渡す。
- **artifactの保持期間(`retention-days: 14`)は暫定値**。正式運用でどれだけ保持するかは統括・利用者の判断を要する。
- **Desktop候補のartifactは展開済みの`app/`一式と梱包済みinstaller(`artifacts/`)の両方を含む**ため、実質的に二重のサイズを消費する。`build-release-manifest.mjs`が組み立て後の検証で`app/`側のファイルも読むため、`artifacts/`だけを取り出して縮小することはできない(既存スクリプトの設計)。

### 配布物の起動確認(P13-8・P13-9・P13-17)

`desktop`jobは`package-desktop.mjs`の直後、artifactへ保存する前に、作った配布物そのものを起動して確かめる。設定は`e2e/packaged-desktop.config.ts`、検査は`e2e/release/packagedDesktop.spec.ts`。起動できない配布物はartifactへ保存しない。

- Windows: `dist/desktop-stage/builder/win-unpacked/PointerCAD.exe`の検査に続けて、`artifacts/PointerCAD-<版>-windows-x64-portable.exe`そのものを検査する。単一exeは候補記録の名前・サイズ・SHA-256と照合し、exeだけを別のフォルダーへ移して起動する。無い場合や記録と違う場合は失敗し、展開済み本体で代用しない。
- Linux: runnerにFUSEが無いため、AppImageを`--appimage-extract`でrunnerの一時領域(`$RUNNER_TEMP`)へ展開し、`squashfs-root/AppRun`を`xvfb-run -a`の画面で起動する。展開物は`dist/desktop-stage`へ混ぜない。`--no-sandbox`は検査からは足さず、AppRun自身の判断(利用者の名前空間が使えないときだけ足す)に任せる。
- 渡し方は環境変数`PCAD_PACKAGED_EXECUTABLE`(起動する実行ファイル)と`PCAD_PACKAGED_CANDIDATE`(その配布物の`candidate.json`)。相対パスはリポジトリの根から。
- 確かめる項目(一時のuserDataへの隔離、窓の表示、名前と版の記録との一致、主要な画面、形状・数式の計算部と字体、pageerror、閉じた後のプロセス、実際のプロファイルが変わらないこと)と、導入版での走らせ方は`docs/standards/desktop-distribution.md`の「(d) 配布物の起動確認」。
- 失敗した回は`test-results/packaged-desktop`(項目ごとの結果と所要時間の`packaged-desktop-results.json`、失敗時の画面)を`pointercad-packaged-launch-<OS>-<commit>`のartifactへ14日保存する。
- この確認は`candidate.json`を書き換えない(`packages[].launchVerified`は`false`のまま)。結果はActionsの記録と報告記録に残す。

単一ポータブル版の段は **WindowsのGitHub Actions専用**。`PCAD_PACKAGED_VARIANT=portable`で`portableDesktop.spec.ts`を選び、CI以外では設定と起動口の両方で拒否する。ローカルで実行する手順は設けない。起動器の標準出力の転送に頼らず、専用userDataの`DevToolsActivePort`から接続する。画面準備は通常の配布検査と共通の`packagedStartup.ts`（3D描画、ビューキューブ、入力、再読込みなど）を使い、実際の子プロセスの展開先と全同梱ファイルも照合する。起動60秒・窓60秒・終了30秒、検査全体900秒・再試行0・1 workerを維持する。形状・数式の計算操作と図面の字体の検査は従来のwin-unpacked段で引き続き行う。

単一exeの通常終了後は、今回専用のTEMPの`nsi…tmp`が30秒以内に消えることを、検査自身が削除する前に確かめる。`portable-desktop-results.json`には起動したexe、展開先、本体PID、終了コード、残留の一覧、取得できた片付けのログを保存する。失敗時は`test-results/packaged-desktop/portable`も既存の失敗artifactへ含まれる。次の手動配布CIでは`desktop (windows-latest)`の「ポータブル版の単一exeを起動し終了後の片付けまで確かめる」を確認する。

手元(Windows)でwin-unpackedを確かめる場合は、画面検査の排他を守るため担当が`diag.py`を通して走らせる(配布物の組み立て・起動は統括の指示の後):

```powershell
$env:PCAD_PACKAGED_EXECUTABLE = 'dist\<候補の名前>\builder\win-unpacked\PointerCAD.exe'
$env:PCAD_PACKAGED_CANDIDATE = 'dist\<候補の名前>\candidate.json'
python -B -X utf8 scratchpad/claude/tools/diag.py e2e --owner <担当名> -- --config e2e/packaged-desktop.config.ts
```

## 公開前の整合検査(P12-20・P13-15)

組み立て済みの配布候補を1つの入口で検査し、1件でも外れたら0以外で終わる(`rules/05-リリース.md` §11.2の「整合検査」)。入口は`scripts/check-release-ready.ps1`、判定は`scripts/release/releaseReadiness.mjs`。pnpm・npm・npx・yarnを呼ばずnodeを直接起動する。コミット・pushの検査段(`scripts/check.ps1`)には入れない(`rules/03-品質ゲート.md` §7.1)。候補の組み立て・公開・書き換えはしない。

```powershell
# 公開前モード(既定)。5つの名前はdist/直下のフォルダー名(上の配布CIのcombineと同じ並び)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Windows desktop-stage-windows -Linux desktop-stage-linux -Web web-candidate -Release release-output -Sbom sbom-output
# 同じ判定をnodeで直接(引数はpsと同じ意味)
node scripts/release/releaseReadiness.mjs --mode pre-release --windows desktop-stage-windows --linux desktop-stage-linux --web web-candidate --release release-output --sbom sbom-output
```

- 前提: 5つの候補(Windows・LinuxのDesktop候補、Web候補、`release-manifest.json`、`sbom.json`)が同じcommitから作られ、作業ツリーがそのcommitと同じ内容であること。入力の指紋、今のヘルプ(目録・本文・画面の文言)、3つの`package.json`、`README.md`は作業ツリーから読む。`scripts/release/`・`scripts/vite/`の変更も入力の指紋に入るため、この検査を足したcommitより前に作った候補は「release-manifestの照合」で不合格になる。
- 結果は項目ごとに[合格]・[不合格]・[保留]・[未実装]の一覧で出し、不合格は理由を1行ずつ出す。`-ReportPath <プロジェクトの根からの相対パス>`(nodeでは`--report`)を付けると同じ結果をJSONでも保存する(既存のファイルとdist/の中は不可)。判定は`releaseCertified: false`のままで、公開の完了は公開後モードの確認まで認めない。

| 項目 | 検査すること | 使う既存の部品 |
|---|---|---|
| 説明書① 章と題名 | 今の目録の全章が説明書の記録とページにあり、題名(章・巻のページの見出し)・巻・並びが一致する。目録に無い章・ページを拒否する | Vite SSRで読む`MANUAL_CHAPTERS`・`MANUAL_VOLUMES` |
| 説明書② 操作名・ボタン名 | 今の章の原文の`{{ui:キー}}`を今の画面の文言で引き、章と巻のページに必要な回数だけあること。本文に直接書いたボタン名(「X」ボタン・「X」を押す)が今の画面の文言のどれかと完全に一致すること。画面の部品に説明の漏れが無いこと | `ja`(画面の文言)、`assertNativeControlDescriptions` |
| 説明書③ 機能の双方向の対応 | 説明書と今のヘルプの機能・操作の対応表を両方向に照合し、説明書だけにある(孤立した)機能・操作、説明先の章が無いもの、説明の無い機能(未完)を拒否する | `buildHelpFeatureCoverage`・`buildCommandHelpCoverage`・`assertDocumentedFeatureCoverage` |
| 説明書④ 今の版の画像 | 撮影の登録簿(`scripts/manual/captureRegistry.mjs`)で、説明書の画像が今のアプリの入力の指紋(`applicationInputDigest`。説明書の本文・画像は含まない。commitでない理由: 画像のcommitのたびに版が変わり全画像が古い判定になるため)で撮ったものであること。登録簿に無い画像、別の指紋・版が不明な画像、撮影台本が変わった画像、説明書の中の画像が撮影の置き場の今の画像と違うもの(古い画像を今の名前で持つもの)はいずれも不合格 | `loadCaptureFreshness`・`captureFreshnessFromRegistry`・`assessCaptureImages` |
| 説明書の出力全体 | 入力の指紋・全ページ・画像・対応表が今のヘルプの生成結果とバイト単位で一致する | `verifyCurrentManualEdition`(内部で`verifyManualConsistency`) |
| 版 | 3つの`package.json`、Windows・Linuxの`candidate.json`、`release-manifest.json`、`sbom.json`の版とタグが一致する | — |
| 公開用の版 | 版が`0.0.0`(模擬の版)でない | — |
| 全巻 | 今の目録の全巻(現在7巻)のHTMLとPDFが、Web候補・Windows・Linuxの候補・公開一覧にある | — |
| 資産の大きさ・数 | Web候補の各ファイルが26,214,400バイト以下、ファイル数が1,000以下(Cloudflare Pagesの直接アップロードの上限。`docs/standards/cloudflare-pages.md`) | `OFFLINE_MAX_FILE_BYTES` |
| SBOM | 許諾の原文の欠けが無いこと、SBOMの配布ファイル・版・commitが公開一覧と一致すること。SPDX識別子の未分類は参考として出す | `findSbomGaps`・`assertSbomPublishable`・`matchSbomToReleaseManifest` |
| 公開一覧 | 保存済みの`release-manifest.json`が、候補の記録と実物から作り直した結果と一致する | `verifyReleaseManifest` |
| README | `pointercad:release-links`区間の導線の種類・版・未公開の案内(下記) | `desktopPackagePlan` |

READMEの導線の約束(正本は`releaseReadiness.mjs`の`README_LINK_ROWS`と`checkReadmeReleaseLinks`):

- 行の種類は行の見出し(表なら1列目)の語で決める: 「インストーラ」→Windowsのインストーラー、「ポータブル」→Windowsのポータブル版、「AppImage」→Linux、「説明書」→取扱説明書、「Webアプリ」「ブラウザ」→Web版。導線の種類はURLで決め、行の種類と違う導線(例: インストーラーの行にポータブル版のURL)を拒否する。
- 配布物は`https://github.com/<所有者>/<リポジトリ>/releases/download/v<版>/<配布物の名前>`。タグと名前の版は公開する版と同じにする(`latest`は不可)。3つとも同じリポジトリに置く。
- 説明書は`https://<公開先>/manual/`(HTMLの目次)と、全巻の`https://<公開先>/manual/pdf/<巻>.pdf`。Web版は`https://<公開先>/`。Web・説明書の公開先は1つにそろえる。
- 各種類は1つずつ(PDFは巻ごとに1つ)。「初回リリース時」「準備中」「予定」「未公開」「後日公開」などの未公開の案内、仮の公開先(example.com・localhost・IPアドレス等)、httpsでない導線を拒否する。実際に取得できるかは確かめない(公開後モードで確かめる)。
- デスクトップ先行(`-Scope Desktop`)では約束の一部が変わる(下の「デスクトップ先行」)。

終了コード:

| コード | 意味 |
|---|---|
| 0 | 全項目合格(`-Scope Desktop`では[後回し]の項目を除く全項目) |
| 1 | 1件以上の不合格(読めない候補を含む) |
| 2 | 不合格は無いが、未接続の条件(保留)がある。公開できるとは判定しない |
| 3 | 公開後モードの全体(Webを含む)は未実装。デスクトップ部分は`-Scope Desktop`で判定する |
| 64 | 引数の誤り |
| 70 | 内部の誤り |

### 説明書モード(P12-20)

配布候補を組む前に、`scripts/manual/generate.mjs`で生成した説明書(`dist/<出力名>/`)だけを、上の表の「説明書①〜④」と「説明書の出力全体」の5項目で判定する。判定の本体は公開前モードと同じ関数(`releaseReadiness.mjs`の`MANUAL_CHECK_IDS`)で、公開前モード(P13-15)はWeb候補の中の説明書に同じ5項目を流すため、説明書の検査は1か所だけに実装する。

```powershell
node scripts/manual/generate.mjs manual-preview-20260927
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Mode Manual -Manual manual-preview-20260927
# 同じ判定をnodeで直接
node scripts/release/releaseReadiness.mjs --mode manual --manual manual-preview-20260927
```

- 今のヘルプ(目録・本文・画面の文言・機能の対応)と撮影の登録簿は作業ツリーから読む。生成の後に本文・翻訳・画面の部品を変えたら、新しい名前で生成し直してから検査する(「説明書の出力全体」が入力の変化を拒否する)。
- 終了コードは下の表と同じ(0は説明書の5項目の合格。公開の可否は公開前モードで判定する)。
- 欠章・異なる題・誤ボタン名・旧画像・孤立機能を1つずつ入れた説明書の写しがそれぞれ0以外になることは、`apps/desktop/src/main/releaseReadiness.test.ts`の「説明書モード(P12-20)」で通常の単体検査として確かめる。

### デスクトップ先行(`-Scope Desktop`。2026-09-27〜)

利用者の指示「最優先でデスクトップアプリのリリースをすること」「Webアプリ側は進めるがデスクトップアプリのリリースは止めないこと」(2026-09-27 17:3x、`rules/01-役割と委譲.md`冒頭)により、デスクトップ版をWeb版より先に公開する。Web版の公開の条件は消さずに「後回し」と判定し、`-Scope`を付けない全体モードは上のとおりWeb版を含む全条件を要求する。手順全体は`docs/releases/release-checklist.md`の「デスクトップ先行の公開」。

```powershell
# 公開前(同じ5つの候補。Web候補は公開一覧と説明書のPDFの元なので、デスクトップ先行でも作る)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Scope Desktop -Windows desktop-stage-windows -Linux desktop-stage-linux -Web web-candidate -Release release-output -Sbom sbom-output
node scripts/release/releaseReadiness.mjs --mode pre-release --scope desktop --windows desktop-stage-windows --linux desktop-stage-linux --web web-candidate --release release-output --sbom sbom-output
# 公開後(GitHub Releaseから取得する。--web-urlは取らない)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-release-ready.ps1 -Mode PostRelease -Scope Desktop -Release release-output -DownloadUrl https://github.com/oltotlo79-rgb/PointerCAD/releases/download/v<版>/
node scripts/release/releaseReadiness.mjs --mode post-release --scope desktop --release release-output --download-url https://github.com/oltotlo79-rgb/PointerCAD/releases/download/v<版>/
```

公開前モードで変わるもの(正本は`releaseReadiness.mjs`の`DESKTOP_DEFERRED_CHECK_IDS`・`checkReadmeReleaseLinks`):

- 14項目を全て判定する。Web版の公開だけが要る「資産の大きさ・数」(Cloudflareの上限)の2項目は[後回し]と表示し、今の判定を参考に残して終了コードを止めない。ほかの12項目(説明書の5項目、版、公開用の版、全巻〔Web候補を含む〕、SBOM、公開一覧、README)は全体モードと同じ判定で、1つでも外れれば0以外。
- READMEの導線: 配布物3つは全体モードと同じ。取扱説明書は同じGitHub Releaseに添付したPDF全巻(`https://github.com/<所有者>/<リポジトリ>/releases/download/v<版>/PointerCAD-<版>-manual-<巻>.pdf`。名前は`manualPdfReleaseAssetName`)で満たし、Webの説明書の目次は求めない。Webアプリ版の行は`後日公開`(`WEB_DEFERRED_PHRASE`)とだけ書いてリンクを置かないか、公開後なら実際のリンクを置く(そのときは説明書の目次も要る)。`後日公開`はWebアプリ版の行の外、リンクと同じ行、Webの公開先へのリンクと同じ区間では不合格。全体モードでは`後日公開`もGitHubのPDFも不合格(今までどおりWebアプリ版と説明書の目次を要求する)。

公開後モードのデスクトップ部分(P13-20のDesktop側)は3項目:

| 項目 | 検査すること |
|---|---|
| 公開後 配布物 | `dist/<名前>/release-manifest.json`の配布物3つ(`desktop.windows/linux.assets`)と、説明書の全巻のPDF(`web.files`の`manual/pdf/<巻>.pdf`を`PointerCAD-<版>-manual-<巻>.pdf`として)を`--download-url`から1つずつ取得し(GitHubの転送先へ進み、本文を流しながらSHA-256を取る。1ファイル2GiB未満)、HTTP 200・大きさ・SHA-256が一致すること。`--download-url`のタグが公開一覧の版と一致すること |
| 公開後 README | 作業ツリーの`README.md`の区間がデスクトップ先行の約束を満たし、その配布物・PDFのリンクが全て`--download-url`の下にあり、取得した実物が公開一覧と一致すること(同じURLは1回だけ取得する) |
| 公開後 Web | [後回し]。Web版の公開時に全体モード(`--web-url`)で実装する |

- 取得の処理は`createReleaseDownloader`。単体検査(`apps/desktop/src/main/releaseReadiness.test.ts`)は偽の取得を注入して、差し替わったPDF・置き忘れた配布物(404)・別の版のRelease・別の置き場へのREADMEの導線・通信の失敗を1つずつ入れると0以外になることを確かめる。
- Releaseに添付するPDFはWeb候補のもの(公開一覧にSHA-256がある)。Windows・Linuxの候補の中のPDFは別のjobで印刷したもので、バイト列が同じとは限らない。

公開後モードの全体(`-Mode PostRelease -Release <名前> -WebUrl https://<公開先>/ -DownloadUrl https://github.com/<所有者>/<リポジトリ>/releases/download/v<版>/`)は、実際のURLから配布物・説明書・Webを取得してhashを公開一覧と照合する入口として、引数の形だけを受け付ける。Webの部分はWeb版の公開時(P13-20のWeb側)に実装する。それまでは「未実装」で終了コード3を返す。
