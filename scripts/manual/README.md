# ヘルプから取扱説明書のHTMLを生成する

`packages/help-content/src/topics.ts`が章の名前と本文を、`manualManifest.ts`が分冊と順序を管理する。アプリ内のF1ヘルプと同じMarkdown描画・翻訳表・日本語検索を使用する。別の説明書本文やボタン名の辞書を作らない。

依存の導入と通常の検査を済ませ、検査・編集が動いていない状態で、リポジトリ直下から実行する。

```powershell
node scripts/manual/generate.mjs manual-preview-20260912
```

引数は新しい出力名1つ。出力先は`dist/<出力名>`に限定し、既存のフォルダーには上書きしない。生成失敗時の途中結果も残して原因を確認し、修正後は新しい名前で生成する。

- `index.html`: 全巻目次と、ネット接続を使わない全文検索。本文だけにある語や、日本語の表記揺れもアプリと同じ検索方式で探せる。
- `chapters/*.html`: 個別の章。前後章・その章を含む巻へ移動できる。
- `volumes/*.html`: 各巻の通し読み。同じ巻の別章へはページ内で移動する。印刷用CSSはA4・余白15mm・本文10.5pt。
- `images/`: 本文が参照した実画像。参照先がない場合は出力を拒否する。
- `fonts/`: アプリでも使用するNoto Sans JP Regularの原文の許諾文書。字体自体は共通の`manual.css`に埋め込み、ローカルで開く際も字体の通信を要求しない。新しい字体の取得は行わない。
- `manifest.json`: 章と巻、本文・翻訳・画像・生成処理・依存固定情報・出力のSHA-256、元コミット、未コミット差分の有無。生成の最後に書き出す。

生成処理は、画像の欠落、章の欠落、内部リンク切れ、見出しIDの重複、元の入力が生成中に変わった場合を拒否する。出力後の`index.html`をローカルで開く場合も検索用の通信は発生しない。公開サーバーに載せる場合も、フォルダー全体の相対配置を保つ。

このHTML生成だけではリリース条件を満たさない。現在は`releaseCertified: false`、画像も`captureCertified: false`を記録する。全機能の対応付け、同じ版からの実画面撮影の証拠、HTMLの実ブラウザー確認、PDFのページ・文字・画像・リンクの確認が別途必要。フラグを手でtrueへ変えて公開判定を代用しない。

生成した説明書を現在のヘルプ本文と照合する場合は、`node scripts/manual/verify.mjs <出力名>`を実行する。現在の章・巻・機能・操作・設定の目録と、アプリと同じ表示処理で作った全HTMLを比較する。画像も現在の本文が参照する内容と照合するため、出力側の指紋だけを更新して古い本文・操作名・画像を通すことはできない。追加された入力部品、本文や翻訳の変更、欠落した章も拒否する。ファイルや認定値は書き換えない。

同じ照合はWeb版・デスクトップ版の配布一式を組む際にも必ず行う。これは現在のヘルプとの一致の確認であり、本文の内容が正しいこと、画像が最新の実画面で撮影されたこと、PDFの全ページの目視確認、全機能の完成や公開の認定は別に必要。

HTMLの閲覧画面を記録する台本は`capture-html.mjs`。生成済みの出力名と新しい撮影出力名を渡す。例: `node scripts/manual/capture-html.mjs manual-preview-20260912 manual-reader-20260912`。既存のChromium/Firefoxでローカルファイルを開き、検索、キーボード移動、全章と全巻の画像・字体、狭い画面を確認してPNGと結果を`dist/<撮影出力名>`へ保存する。本文と出力の指紋を前後で照合し、途中の失敗も保存して過去の結果を上書きしない。この台本で撮るのは説明書を閲覧する画面であり、全機能を操作したアプリ画面の撮影・PDFの目視確認・通常の品質ゲートの代わりにはしない。

受入条件は[ヘルプと仕上げの計画](../../docs/plans/P12-ヘルプと仕上げ.md)を正とする。通常のコミット・push検査を短い生成処理で代用したり、生成のために検査の途中でソースを変えたりしない。

## 同じHTMLからPDFを生成する

通常の検査が終了し、入力が固定された状態で実行する。

```powershell
node scripts/manual/generate-pdf.mjs manual-preview-20260912 manual-pdf-preview-20260915
```

第1引数は生成済みHTMLの出力名、第2引数は新しいPDFの出力名。`dist/<第2引数>`へ各巻のPDFと字体の許諾原文、生成結果の`pdf-manifest.json`を保存する。各PDFには巻内の目次・章内移動・全巻索引・ページ番号を含める。別の巻への参照は巻名と章名を本文へ記し、元のパソコンのファイル位置に依存させない。

本文はHTMLと同じものを使う。日本語字体の読み込み、画像の欠落、章の順序、移動先、生成前後の入力を確認してから出力する。途中で失敗した記録は残し、既存の出力は上書きしない。

この生成は未認定の出力を作る。配布前に全ページの文字・画像・表・改頁・リンクを実物で確認し、本文や撮影元と照合する。`releaseCertified`などの値を手で変更して確認の代用にはしない。

## 機能と操作の説明先

生成時に要件の正本と`FEATURE_HELP_BINDINGS`を照合し、全要件の説明先を`feature-coverage.json`と`manifest.json`へ記録する。要件・操作・章の重複、要件の割当忘れ、存在しない説明先は生成を止める。操作一覧はアプリが実際に使う`COMMAND_DEFINITIONS`を参照し、別の一覧を手で維持しない。

公開・オフライン起動など、説明の未作成を明示した項目は`pending`に残し、確認用の説明書では不足を読めるようにする。公開の判定では`assertDocumentedFeatureCoverage`が未作成の項目を拒否する。この対応情報だけで本文や撮影の確認が完了したとは扱わず、`contentCertified`と`releaseCertified`はfalseを保持する。最終公開の確認への接続はP13で実施する。

設定と書き出し形式も`feature-coverage.json`の`supplementary`と`manifest.json`の`supplementaryCoverage`へ記録する。端末設定の型、実際の保存形式表、座標・板金・図面の既定値入力欄から名称・説明を取得する。未対応のDWGは出力形式に含めない。設定の追加、形式の追加、説明先の削除を検出する。これは目録の確認であり、各操作・本文・実画面・印刷結果の完成証拠は別に必要。

### 入力欄とボタンの説明の棚卸し

`manifest.json` の `nativeControlCoverage` と `feature-coverage.json` の `nativeControls` は、実際のUIのTSXからinput/select/textarea/buttonを列挙する。名前だけ、空のtitle、無関係な外枠のtitleは説明に数えない。明示された非表示欄だけを除外し、動的な説明・後から値を重ねる記述には実画面の確認を残す。読み取ったTSXの内容も入力の照合対象に含める。

これはnative JSXの説明の入口を調べるもので、全画面・全状態・独自の入力部品の表示確認や本文の正確さを認証しない。未確認・不足を一覧に残し、`contentCertified` と `releaseCertified` はfalseのまま。P12-5では残る実入力の棚卸しとマウス・キーボードの確認を閉じ、P12-20で公開用の全条件を照合する。

## 撮影の登録簿

`packages/help-content/docs/ja/images/capture-manifest.json`(形式`pointercad-capture-registry/1`)は、`images/`フォルダーにある**全画像**の登録簿であり、一部だけを載せた一覧ではない。各画像について、SHA-256・撮影した画面の大きさ(`viewport`)とその区分(`viewportClass`。`standard`=1440×900、`tall-exception`=1440×1100、`needs-recapture`=それ以外で撮り直しが要る)に加え、撮影に使った台本・fixtureのSHA-256・撮影日時(`capturedAt`)・アプリの版の識別子(`applicationBuildId`。`captureRegistry.mjs`の`applicationInputDigest(root)`が返すSHA-256で、Gitのコミットではない。理由は次の手順の1を参照)を記録する。値が分からない項目は理由なしに`null`にはできず、`captureRegistry.mjs`の`CAPTURE_UNKNOWN_REASONS`にある既知の理由のどれか1つを必ず`unknown`へ添える。画面の大きさの区分や由来のフィールドなど、判定基準は`scripts/manual/captureRegistry.mjs`だけを正本とし、値をこのREADMEや他のファイルへ複製しない。

画像を新しく足す、または撮り直すときの手順:

1. `captureManualDetail`(`e2e/tests/captureManualDetail.ts`)を使う画面検査の台本、または同等の撮影の記録(`*-capture-details.json` / `*-image-sources.json`)を書く台本を実行する。`captureManualDetail`は撮影の記録へ台本・fixtureのSHA-256、撮影日時、アプリの版の識別子(`applicationBuildId`)を自動で書き、1440×900・1440×1100以外の画面の大きさでは撮影そのものを失敗させる。版の識別子はGitのコミットではなく、`captureRegistry.mjs`の`applicationInputDigest(root)`が返す値(Webの組立ての入力ファイル群のSHA-256一覧〔`scripts/vite/webBuildSources.mjs`の`captureWebBuildSources`と同じ集合〕から作る1つのdigest。`packages/help-content/docs/`配下の説明書の章・画像は含まない)を使う。Gitのコミットを使わない理由: 撮影した画像とその記録をコミットするとcommitが変わり、コミットのたびに全ての既存画像が「古い版」と判定されてしまうため(2026-09-24 統括の決定)。
2. 採用する画像(PNG)を、その撮影の記録と一緒に`packages/help-content/docs/ja/images/`へ置く(既存の画像はこの記録が無いままなので、撮り直すまで`capturedAt`・`applicationBuildId`は`null`のまま残る)。
3. `node scripts/manual/captureRegistry.mjs register`を実行する。実際の画像・撮影の記録・章のMarkdownから登録簿を組み立て直し、`capture-manifest.json`を上書きする(改行の形は既存ファイルのものを保つ)。新しく登録された画像名は結果の`added`に出る。

書き込まずに現状だけ確かめたいときは`node scripts/manual/captureRegistry.mjs check`を使う。実際の画像・撮影の記録・章と保存済みの`capture-manifest.json`を比較するだけで、ファイルは変更しない。

`register`・`check`はどちらも結果をJSONで標準出力へ書き、次のいずれかがあれば終了コードを0以外にして拒否する。

- 保存済みの登録簿が実際の内容と一致しない(`check`のときの`registryOutdated`)。
- 未登録の画像がある、または登録簿の項目に対応する画像がフォルダーに無い。
- 画像のSHA-256が登録簿の値と食い違う、または画素数が`viewport`と矛盾する(`viewportSource`が`png-size`のときは完全一致、それ以外は画素数が`viewport`を超えないことを求める)。
- 章のMarkdownが参照する画像がフォルダーに無い。
- フォルダー内に想定外のファイルがある、撮影の記録が壊れている・形式が違う、同じ画像を2つ以上の記録が指す、記録が指す画像のSHA-256が実物と違う、登録済みの画像が新しい記録なしにバイト列だけ変わったなど、登録簿を組み立て直せない不整合がある(この場合は`CaptureRegistryError`で処理そのものが止まる)。

`register`は書き込み直前にも`capture-manifest.json`の実ファイルを読み直し、処理開始時に読んだ内容と変わっていれば「もう一度実行してください」という趣旨のエラーで止まる(並行編集による上書き事故の防止)。

`packages/help-content/src/captureRegistry.test.ts`は、実際の`packages/help-content/docs/ja/images/`フォルダーと章のMarkdownに対して`captureRegistry.mjs`の関数群(`readCaptureFolder`・`buildCaptureRegistry`・`auditCaptureRegistry`・`assessCaptureImages`・`applicationInputDigest`等)を動かす単体テストであり、`register`・`check`と同じ検査を通常の品質ゲート(`pnpm run test`のhelp-content検査)でも常に行う。未解決の既知の問題(どの章からも参照されない画像、標準の画面の大きさから外れた画像、撮影の記録が無い画像)は理由付きの一覧としてテストの中に書かれており、一覧に無い新しい問題が実物に増えると失敗する。一覧の項目を直して減らすのはよいが、理由を確かめずに一覧へ項目を足して赤を消さない。
