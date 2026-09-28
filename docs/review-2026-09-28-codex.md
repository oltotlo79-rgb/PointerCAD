# PointerCAD コード・設計・機能・取扱説明書レビュー

調査日: 2026-09-28（日本時間）  
対象: この作業ツリーの実装・要件・ヘルプ・生成済み説明書  
基準コミット: `33a2c74bae8adfc158f7ba30c2d5e647004e36db`  
評価: **66 / 100 点（静的レビューと限定的な関数実行による暫定評価）**

## 1. 判定

層の分離、共通の日本語文言、幾何処理の Worker 化、保存形式の検証、数式・パラメータ・履歴の連携には、評価できる実装がある。一方、**文書を読み込んでいる間の編集・文書切替を保護しない経路と、3MF の面色が通常の書き出し経路で失われる問題を確認した。**

**「全機能が正常に使え、説明書と完全に一致する」という判定は出せない。** 3MF については説明書の記述に対する具体的な反例がある。さらに説明書の参照画像30枚が存在せず、調査した生成済み説明書は現在の入力ファイルと一致しなかった。これらは現在の作業ツリーの判定であり、過去の配布版に同じ不具合があったと断定するものではない。

本報告はコードの修正を行わないレビューである。別担当が実装中のため、未コミットの変更を含む時点評価として扱う。

## 2. 調査方法と限界

- 2026-09-28 06:11:45 JST にソース等3,189ファイルの SHA-256 を採取。06:30:57 に主要な根拠ファイル45件とヘルプ110章、計155件を再照合し、変更0件だった。最終照合結果も末尾に記載する。
- 開始時点の作業ツリーには既存の変更・未追跡ファイルがあった。HEADだけのレビューではなく、採取したファイル内容を対象とした。
- 製品の `src/` 配下にある TS/TSX/JS/MJS/Python、テストを除く集計は1,509ファイル・253,026行。コメント・空行・型定義を含む。全行を精読したという意味ではない。
- 製品 TS/TSX 1,426ファイルを TypeScript の構文解析器で処理し、構文診断は0件だった。**型検査・lint・テストの合格とは別**である。
- 要件197件とヘルプ110章を実際の目録生成コードで照合した。全章の見出し、画像参照、要件との対応を確認した。詳細は付録A。
- 保存・読込・外部形式の入出力・状態管理を重点的に追跡し、再計算、組立、図面、板金、自動作図、セキュリティの実装を読んだ。重点箇所は本文と付録にファイル・行番号を示す。
- 不具合3件は、実ファイルをメモリ上で TypeScript から変換し、実関数を呼び出して確認した。入出力待ちとストアは注入した模擬実装である。OCCT、実ブラウザー、Electron を通した試験ではない。
- 既存の `node scripts/manual/captureRegistry.mjs check` を実行した。この `check` 分岐は読み取りだけで、結果も `written: false` だった。
- [CLAUDE.md](../CLAUDE.md) の「作業担当は、ブラウザの窓・Electronアプリ・開発サーバーを起動しない」と、[役割規約](../rules/01-役割と委譲.md)の担当用診断・統括用ゲートの区分、および今回の「報告書以外は編集しない」という指定に従い、アプリ起動・全件E2E・品質ゲート・説明書再生成は行っていない。規約にはヘッドレス試験を許す経路もあるが、今回はその実行記録や生成物を作成していない。
- 既存テストの存在を合格と数えず、他担当の報告や別時点の検査結果を現在の全機能成功の証明に転用しない。PDFの全ページ描画、実機の操作性、幾何精度の全ケース、実測性能、配布済みアプリは未検証。

### 採点基準

10点は、調査範囲で設計と実装が明確で、重要な利用経路を同一版の動作証拠で裏づけられる状態。8点は良好な設計があるが改善余地・確認不足がある状態。6点は有用な基盤と具体的な弱点が併存する状態。4点以下は、重要な約束が現状の成果物で満たせていない状態とした。

点数はコードと限定試験を材料にしたレビュー判断であり、テスト通過率や統計的な完成率ではない。特に「性能設計」は実測速度の点数ではない。

| 項目 | 点 / 10 | 配点 | 根拠 |
|---|---:|---:|---|
| コード品質・保守性 | 7.0 | 15 | strict 設定、型と責務の分割はある。操作制御に大きな関数が残る（R07） |
| アーキテクチャ | 8.0 | 15 | パッケージ依存の方向、単一ストア、Worker 境界が明確。境界を越えるデータの欠落がある（R04） |
| 機能の正しさ・データ保護 | 5.0 | 20 | 古い読み込み結果の反映を再現。Desktop終了時の未保存保護もない（R01～R03） |
| 性能設計 | 6.5 | 10 | 幾何処理の分離・再計算キャッシュあり。保存経路は同期圧縮と重複処理を持つ（R06）。実測は未採点 |
| セキュリティ・入力の堅牢性 | 8.0 | 10 | Electron隔離、IPC送信元確認、共有CSP、展開前の資源制限あり。包括的な侵入試験は未実施 |
| 検証基盤 | 7.5 | 10 | 単体・画面・性能・説明書の検査構造あり。低位の色検査だけでは通常経路の欠落を防げていない |
| 操作支援・導入支援の実装 | 6.0 | 5 | 共通コマンド・文言・ヘルプの仕組みあり。未保存保護の版間差と画像欠落がある。実ユーザー評価は未実施 |
| 説明書の完全性・一致 | 4.0 | 10 | 要件と章の目録は一致。機能との不一致、画像欠落、生成物の鮮度不足を確認（R04・R05） |
| 拡張性・強みの基盤 | 8.0 | 5 | 数式・構成・履歴・スクリプトを編集可能な文書につなぐ実装がある |
| **合計** | **加重値65.5 → 66 / 100** | **100** | **リリース可否を置き換える点数ではない** |

## 3. 優先して扱う指摘

P1はデータ保護または配布前の整合に関わり、先に解決すべき事項。P2は機能品質または保守・性能設計の改善事項。工数・発生頻度・速度改善率は測定していないため記載しない。

| ID | 優先度 | 分類 | 確認した問題 |
|---|---|---|---|
| R01 | P1 | 関数実行で再現 | 読込開始後に別文書へ切り替えても、古い文書に対するインポート結果を適用する |
| R02 | P1 | 関数実行で再現＋ストア読解 | アセンブリ読込中の同一セッションの変更を検出せず、文書を置き換える |
| R03 | P1 | コードと説明書が示す既知の制約 | Desktopの終了時に未保存確認がない |
| R04 | P2 | 関数実行で再現・説明書との不一致 | 3MF出力で面ごとの色が失われる |
| R05 | P1 | 既存検査の失敗・ハッシュ照合 | 説明書の画像不足と生成物の鮮度不足 |
| R06 | P2 | 実装構造の確認 | UI側の同期ZIP処理と図面保存の圧縮・展開の繰り返し |
| R07 | P2 | 構文解析・責務の読解 | 一部の操作制御関数に責務が集中している |

### R01: 古いインポート結果が現在の文書へ適用される

**根拠**

- [exchangeActions.ts](../packages/ui/src/file/exchangeActions.ts) 129–155行の `importFile` は、開始時の `store.document / sketch / workPlane` を `runImport` に渡す。待機後は新たに `getState()` するが、開始時の文書・セッション・依頼との一致を確認せず `applyDocument(outcome.document)` または `setSketch(outcome.sketch)` を呼ぶ。
- [exchangeFile.ts](../packages/ui/src/file/exchangeFile.ts) 801–843行の `importPickedBody` は、カーネル処理と単位確認を待った後、**引数で受け取った古い文書**へ形状を追加する。
- [commandDefinitions.ts](../packages/ui/src/commands/commandDefinitions.ts) 95–102行では新規・開くが `enabledBy: 'always'`。[commandRegistry.ts](../packages/ui/src/commands/commandRegistry.ts) 59–77行の実行状態・アクションにも、インポート待ちを文書変更から保護する条件はない。
- 部品を開いている通常の履歴終端では、[timelineMove.ts](../packages/ui/src/shell/timelineMove.ts) 100–112行は渡された文書をそのまま返し、[documentDerived.ts](../packages/ui/src/store/documentDerived.ts) 245–283行がそれを `document: next` として適用する。この経路にも依頼開始時の文書との照合はない。

**再現結果**

実際の `importFile` を呼び、`runImport` の返答を待たせた。部品文書Aから開始し、模擬ストアを別の部品文書Bに切り替えてからAの結果を返した。

~~~json
{"before":{"id":"B","documentId":"B"},"after":{"id":"B","documentId":"A","name":"old document plus imported body"}}
~~~

確認したのは「現在のセッションはB、適用された文書はA」という状態の取り違えである。実ディスク上の上書き事故や実画面での発生率までは測定していない。現行 `applyDocument` は通常Undoへ積むため、この指摘を一律に「回復不能な消失」とは扱わない。

**改善と確認条件**

読み込み依頼に開始時の文書識別・内容のスナップショット・依頼識別子を結び付け、変化した結果を採用しない。文書切替、同じ文書の編集、Undo、連続した2回のインポート、単位確認中の変更を含める。添付形状と本文は、採用できると判定した後にまとめて反映する。

[documentSlice.ts](../packages/ui/src/store/documentSlice.ts) 297–298行では通常編集で `documentVersion` が増えない。**その番号を比較するだけの修正では同じ文書の編集を保護できない。** 不変オブジェクトの参照比較または編集を漏れなく数える世代管理が必要になる。

### R02: アセンブリを開く途中の変更を保護できない

**根拠**

- [assemblyFile.ts](../packages/ui/src/file/assemblyFile.ts) 58–80行の `applyPickedAssembly` が待機後に照合するのは `activeDocumentId` だけ。`documentVersion`、組立文書、部品ライブラリーを比較していない。
- 同ファイル83–87行の破棄確認は読込開始前に行う。確認後・読込待機中の追加変更はこの確認の対象にならない。
- [assemblySlice.ts](../packages/ui/src/store/assemblySlice.ts) 255–262行のUndo/Redo適用は、文書IDを変えずに内容と版を変える。295–319行の通常編集もIDを維持する。
- 同ファイル283–293行の `openAssembly` はUndo履歴を作り直し、`canUndo: false` とする。

**再現結果**

実際の `applyPickedAssembly` に遅延する読込を注入し、待機中に同じIDの版を5から6へ、文書名を編集後の値へ変えた。それでも `openAssembly` と `setAssemblyFileState` が呼ばれた。

~~~json
{"before":{"id":"same-session","version":5},"during":{"activeDocumentId":"same-session","version":6,"name":"user edit during read"},"after":{"id":"new-session","version":7,"name":"loaded assembly"},"events":["openAssembly","setAssemblyFileState","clearSaveTarget"]}
~~~

上の状態値とイベントは模擬ストアの出力。実ストアでUndo履歴がリセットされる根拠は、別途読んだ `openAssembly` の実装である。この組み合わせでは、読込開始後の未保存変更を現在の編集履歴から戻せなくなる。

**改善と確認条件**

読み込み後に対象文書・ライブラリー・編集状態の一致を照合する。変化があれば現在の変更を保護したまま開く処理を中止するか、改めて破棄確認を行う。確認を中止した場合、文書、Undo、保存先をすべて維持する。R01と同様、通常編集では版が増えない経路もあるため、版だけを足して完了としない。

### R03: Desktopの未保存終了を防ぐ仕組みがない

**根拠**

- [Webの入口](../apps/web/src/main.tsx) 35行には `attachUnsavedChangesGuard(window)` がある。
- [Desktopの入口](../apps/desktop/src/renderer/main.tsx) 1–29行には同等の取り付けがない。
- [unsavedChangesGuard.ts](../packages/ui/src/file/unsavedChangesGuard.ts) 14–16行は、本体側の確認の用意ができるまでDesktopへ取り付けないことを明記している。
- [main.ts](../apps/desktop/src/main/main.ts) のウィンドウ生成・終了処理にも、未保存状態を問い合わせて終了を止める経路がない。
- [保存・読込の説明](../packages/help-content/docs/ja/save-and-open.md) 59行も「デスクトップ版では、窓を閉じるときに確認は出ません」と明示。69行では自動保存の既定間隔を5分としている。

**評価**

これは説明書との不一致ではなく、**説明済みだが残っているデータ保護上の弱点**である。自動保存は直前の全変更を即時に保存する仕組みではない。今回、実ウィンドウを閉じる試験は行っていない。

**改善と確認条件**

Electron本体の終了処理と未保存判定を接続し、「保存して閉じる・破棄して閉じる・戻る」を一度だけ提示する。保存の取消・失敗では閉じず、成功時だけ終了する。部品・組立・図面と、図面の元部品の未保存変更、×ボタン・終了コマンド・OS終了要求を担当の実機試験で確認する。

### R04: 3MFの面色が通常の出力経路から欠落する

**説明書の約束**

[export.md](../packages/help-content/docs/ja/export.md) 52–58行は、STEP・3MF・OBJ・glTFの「色を含める」で「立体に付けた色、面ごとに付けた色のどちらも、そのまま渡せます」と説明している。

**実装の経路**

1. [partExchanger.ts](../packages/ui/src/file/partExchanger.ts) の `exportBodiesFor` は面色を含む書出要求を作る。
2. [exchangeConversions.ts](../packages/model/src/kernelBridge/exchangeConversions.ts) 112–121行の `toShapeExportOutcome` はメッシュ結果を `name / color / positions / indices` へ詰め替え、面と三角形の対応 `faceRanges` と面色を引き継がない。
3. [exchangeActions.ts](../packages/ui/src/file/exchangeActions.ts) 49–57行の `buildThreeMf` でも同じ4項目だけを渡す。
4. 一方、[writeThreeMf.ts](../packages/io/src/threemf/writeThreeMf.ts) 80–100行、243–258行の低位ライターには `faceColors / faceRanges` を使う処理がある。

**再現結果**

同じ2三角形のメッシュに「立体は赤・1面は青」を指定し、実際のライターへの直接呼出しと、実際のUI用 `createExchangeDeps(...).buildThreeMf` 経由の出力を比較した。生成したZIP内の `3D/3dmodel.model` に書かれた色は次のとおり。

~~~json
{
  "directColors": ["#ff0000ff", "#0000ffff"],
  "uiWrapperColors": ["#ff0000ff"],
  "convertedBodyFields": ["name", "color", "positions", "indices"]
}
~~~

カーネル・実画面を模擬していても、**実際の出力関数から生成されたXMLに青がない**ことは確認できる。STL・STEP・OBJ・glTFにも同じ欠落があるとは判断していない。

**検査の弱点**

[writeThreeMf.test.ts](../packages/io/src/threemf/writeThreeMf.test.ts) 226行以降には面色の低位テストがある。一方、今回読んだ [exchangeActions.test.ts](../packages/ui/src/file/exchangeActions.test.ts) は単位確認の4件であり、通常の3MF経路を検査していない。ライターだけの成功は、UIからそこへ必要な情報が届くことの証明にならない。

**改善と確認条件**

model→UI→ioの契約に面色と面範囲を保ち、選択した面の色が三角形の材質参照まで届くことを確認する。実際の書き出しボタンから、複数ボディ・複数面・同色面・「色を含める」のON/OFFを出力し、ZIP内の色と三角形の参照を照合する。「色を含めない」経路も今回の発見に併せて確認するが、その動作不良は本調査では断定しない。

### R05: 説明書の画像と生成済み版が現在の内容に追従していない

**確認値**

| 検査 | 結果 | 意味 |
|---|---:|---|
| 要件→ヘルプ対応 | 197 / 197 | 要件IDに章が割り当てられている |
| 章の登録・実ファイル・H1 | 110 / 110 | 目録と章の表題が一致 |
| UI文言参照 | 170箇所、143種類、未知キー0 | 参照キーが現在の日本語表にある。画面配置の一致までは証明しない |
| コード内の式を除いた相対文書リンク | 482箇所、対象ファイル欠落0 | 簡易字句走査。アンカー・描画の完全性は別 |
| 本文で参照する画像 | 169種類 | 登録済み画像数と区別する |
| 参照先が存在しない画像 | **30枚 / 18章** | 既存検査も失敗 |
| 存在する参照画像 | 139枚 | 今回の鮮度照合の対象 |
| 調査した生成済みmanifest | 17件、全件で入力ハッシュ差分あり | 現在のソースとの同一性を証明できない |

既存コマンド `node scripts/manual/captureRegistry.mjs check` は**終了コード1**、`failures: ["missingReferencedImages"]`。登録済み140枚の画像ファイルと登録ハッシュの整合は取れていた。問題は本文が参照する追加30枚が存在しない点であり、「登録済み画像140枚がすべて壊れている」という意味ではない。

[HelpMarkdown.tsx](../packages/ui/src/help/HelpMarkdown.tsx) 43–45行では画像の登録がない場合、画像の代わりに代替テキストを表示する。そのため見た目に破損アイコンが出なくても、説明用の画面画像は表示されない。

[scripts/manual/captureRegistry.mjs](../scripts/manual/captureRegistry.mjs) の既存照合関数を読み取りだけで使うと、存在する139枚はいずれも `buildUnknown`、9枚は撮影スクリプトのハッシュも変更されていた。**画像が現画面と視覚的に違うと断定する結果ではなく、現在のアプリから撮影されたことをこの記録では裏づけられないという結果**である。

`dist/*/manifest.json` で見つかった説明書17件について、記録された入力のSHA-256を照合した。例えば `dist/w65b-manual-20260927/manifest.json` は470入力中20件、`dist/w56b-manual-20260927a/manifest.json` は470入力中42件が不一致だった。前者には `numeric-input.md`、`work-plane.md`、`work-plane-custom.md` 等の差分が含まれる。任意の別保存場所や公開サイトの説明書まで探索した結果ではない。

目録の `contentCertified: false` や生成物の `releaseCertified: false` だけを不具合とは扱わない。今回の不合格根拠は、実際の欠落・ハッシュ不一致・R04の内容不一致である。

**改善と確認条件**

別担当の編集完了後に不足画像を正規の撮影台本で生成し、同じ内容のアプリ・ヘルプからHTML/PDFを作り直す。画像存在・撮影来歴・入力ハッシュの検査に加え、R04を含む操作手順と出力結果を照合する。PDF全ページの文字欠け・改ページ・画像の判読性も別途確認する。目録の合格だけを内容の完全一致としない。

不足画像の全件と章別の確認状況は付録A・Bに記載する。実装中の追加画像が完成前である可能性はあるが、**存在していないという観測自体は変わらない**。

### R06: 同期ZIP処理が保存・読込のUI側に残り、図面保存で繰り返される

**根拠**

- [partFile.ts](../packages/ui/src/file/partFile.ts) 390–399行で `writePcadFile` を直接呼び、その後に保存ダイアログの非同期処理へ進む。
- [pcadFile.ts](../packages/io/src/pcad/pcadFile.ts) の各保存関数は `zipSync` を使用する。
- [drawingBundle.ts](../packages/io/src/pcad/drawingBundle.ts) 26–43行は、元文書を圧縮してから `archiveEntries` で展開し、図面も圧縮してから展開し、結合後にもう一度 `zipSync` する。部品を参照元にする場合でも、圧縮3回・展開2回の経路になる。
- 同ファイル47–61行の読み手も図面の読込後にアーカイブを再度読み、取り出した元文書を再ZIPしてから `readDocumentBundle` へ渡す。
- [readArchive.ts](../packages/io/src/pcad/readArchive.ts) 58–98行は同期の展開長走査、展開、CRC確認を行う。

**評価の境界**

確認できるのは同期処理の配置と重複する圧縮・展開である。「何秒止まる」「大容量なら必ずフリーズする」「性能基準に違反した」とは、この調査からは断定しない。現状も [limits.ts](../packages/io/src/limits.ts) で圧縮入力256MiB・単一展開512MiB・全展開1GiB等の上限を持ち、無制限入力という指摘ではない。

**改善と確認条件**

文書→ZIPエントリの生成と最終圧縮を分離し、結合するためだけの圧縮・展開を減らす。シリアライズ・圧縮・展開のWorker移行を検討する。変更前後で同じファイル群を使い、保存再開後の文書・式・参照・添付の同一性、破損入力拒否、UIの入力応答、長いタスク、ピークメモリを測る。精度・資源上限・既存の性能判定を緩めない。

### R07: 一部の大きな関数に操作上の責務が集中する

TypeScriptの構文木から関数の開始・終了行を集計した。

| 関数 | 場所 | 行数 |
|---|---|---:|
| `attachSketchInteraction` | [attachSketchInteraction.ts](../packages/ui/src/viewport/attachSketchInteraction.ts) 398–2007行 | 1,610 |
| `FeatureTree` | [FeatureTree.tsx](../packages/ui/src/shell/FeatureTree.tsx) 352–1406行 | 1,055 |
| `createSolidLayer` | [createSolidLayer.ts](../packages/ui/src/viewport/createSolidLayer.ts) 580–1339行 | 760 |
| `createViewportScene` | [createViewportScene.ts](../packages/ui/src/viewport/createViewportScene.ts) 487–1230行 | 744 |
| `createKernelApi` | [kernelApi.ts](../packages/kernel/src/worker/kernelApi.ts) 569–1253行 | 685 |

ファイル単位では [resolvePart.ts](../packages/model/src/part/resolvePart.ts) が4,634行、[numericInput.ts](../packages/ui/src/sketch/numericInput.ts) が4,183行。これらはコメント・空行・内側の関数を含む長さで、循環的複雑度や不具合数ではない。

`attachSketchInteraction` を読むと、同じ関数内に作業平面の決定、スナップ候補の選択、方向追跡、入力の開始、選択の確定、ポインター・キーイベントの登録と解除がある。単に行数が多いことではなく、異なる変更理由を持つ処理が一つのクロージャーに集まる点を改善対象とする。

まず「点の決定」「道具ごとの操作状態」「DOMイベントとの接続」を分離する。ストアを複数作る変更や、大量の無関係な分割を目的にしない。既存の取消・Undo・平面切替・ドラッグ・イベント解放の振る舞いを保持し、現在の並行実装と担当範囲を調整して進める。

## 4. 評価できる設計と実装

| 強み | 実装上の根拠 | 評価できる範囲 |
|---|---|---|
| 層の分離 | 各 `package.json` の内部依存は apps→ui、ui→model/io/expression/drawing/help-content、io→model、model→kernel/expression/drawing。宣言上の循環なし | パッケージの役割は明確。実行時の全依存を認証したという意味ではない |
| 状態の集約 | [useAppStore.ts](../packages/ui/src/store/useAppStore.ts) 46–85行は18個のsliceを1つのZustandストアへ合成 | データ更新の入口を追跡できる。R01・R02の非同期整合性は別途必要 |
| 幾何処理の分離と再利用 | [createKernelWorker.ts](../packages/kernel/src/client/createKernelWorker.ts) 6–10行で専用Workerを作成。[recomputePart.ts](../packages/model/src/part/recomputePart.ts) に世代・中止・投影等のキャッシュがある | 性能を改善する土台がある。FPS・計算時間の達成は未測定 |
| 図面投影の再利用 | [resolveDrawing.ts](../packages/model/src/drawing/resolveDrawing.ts) 239–272行はキー単位のキャッシュと未計算方向の集約を行う | 同じ投影をまとめる実装を確認 |
| 組立の失敗を成功にしない | [resolveConstrainedAssembly.ts](../packages/model/src/assembly/resolveConstrainedAssembly.ts) は参照解決と合致診断を経て、収束・完全性を確認する | 組立の実用例すべての収束を保証するものではない |
| スクリプトの実行境界 | [scriptExecutor.ts](../packages/model/src/scripting/scriptExecutor.ts) 26–65行はソース照合・Worker実行・中止・全体期限・トランザクション準備を持つ | スクリプトから文書へ反映する前に検証する構造がある |
| 外部入力の検証 | [readArchive.ts](../packages/io/src/pcad/readArchive.ts) は宣言サイズだけでなく実際の展開長とCRCを確認し、確保前に上限を判定 | 単純なZIPサイズ偽装への対策を実装している |
| Desktopの隔離 | [main.ts](../apps/desktop/src/main/main.ts) 42–49行、[appSender.ts](../apps/desktop/src/main/appSender.ts) 30–37行 | contextIsolation、sandbox、Node無効化、登録済み主フレームからのIPCかを確認 |
| Web/Desktopの共有CSP | [contentSecurityPolicy.ts](../packages/ui/src/security/contentSecurityPolicy.ts) | 画面は外部接続等を制限し、動的JSの許可を正規kernel Workerへ限定する設計 |
| 説明の単一管理 | [helpFeatureCoverage.ts](../packages/help-content/src/helpFeatureCoverage.ts)、[featureHelpBindings.ts](../packages/help-content/src/featureHelpBindings.ts)、[manualManifest.ts](../packages/help-content/src/manualManifest.ts) | 同じMarkdownを目録・ヘルプ・説明書へつなぐ構造。R05は仕組みの欠如ではなく現在の入力・成果物の不足 |

## 5. 全機能・説明書一致の確認状況

今回の確認は以下の三つに分ける。

1. **全体を機械的に照合した範囲:** 要件197件、ヘルプ110章、見出し、文言参照、画像存在、文書リンク先、発見した説明書manifest17件の入力ハッシュ。
2. **実装を重点的に追跡した範囲:** 文書の保存・読込・外部形式、状態管理、幾何再計算、組立解決、図面投影、板金展開、自動作図、Electron境界。
3. **実際に実行した範囲:** R01・R02・R04の実関数を用いた限定試験と、読み取り専用の説明書検査。全機能の実画面操作ではない。

| 機能領域 | 今回読んだ代表実装 | 確認結果 / 残る確認 |
|---|---|---|
| 起動・Web/Desktop共通化 | 両アプリの `main.tsx`、Desktop `main.ts` | 共通UI利用を確認。全OS・配布版の起動試験は未実施 |
| 座標・スケッチ・スナップ | `numericInput.ts`、`attachSketchInteraction.ts`、`resolveSketch.ts` | 操作と評価の構造を確認。全道具・全拘束を操作してはいない |
| 数学・パラメータ・関数 | `browserMathWorker.ts`、`recomputePart.ts`、`configurations.ts` | Worker期限、構成、再計算との接続を確認。数学全演算の正答性は未判定 |
| 立体・履歴・参照 | `resolvePart.ts`、`recomputePart.ts`、ストア | キャッシュ・中止・履歴反映を確認。全フィーチャーの境界形状試験は未実施 |
| 組立・合致・ジョイント | `resolveConstrainedAssembly.ts`、`constraints/solveMates.ts` の該当処理 | 解決・診断の経路を確認。全合致・運動ケースは未判定。読込はR02 |
| 図面 | `resolveDrawing.ts`、`drawingBundle.ts` | 投影・キャッシュ・保存構造を確認。全寸法・記号・印刷実寸は未判定 |
| 板金 | `recomputeSheetFlat.ts`、板金ヘルプ | 中止・失敗・展開形状の受取処理を確認。曲げ・展開精度の実形状試験は未実施 |
| 保存・読込・復旧 | `partFile.ts`、`assemblyFile.ts`、`pcadFile.ts`、終了ガード | R01～R03・R06。全形式・旧版・破損ファイルの試験は未実施 |
| 交換形式・加工連携 | `exchangeActions.ts`、`exchangeFile.ts`、`partExchanger.ts`、3MFライター | R04を確認。他形式や加工先アプリとの相互運用を一括で合格にはしていない |
| 自動作図 | `scriptExecutor.ts`、関連する既存E2Eの検査項目 | ソース検証・取消・トランザクション構造を確認。実Workerの全API試験は未実施 |
| 測定・強度・外観・設定 | 目録・対応章と関連する再計算・外観の接続箇所 | 全項目の数値・画面動作まで確認したとは扱わない |
| オフライン・ローカルデータ・更新 | Web入口の登録処理、ヘルプ・既存試験の配置 | 通信断・更新競合・容量不足の実機試験は未実施 |
| ヘルプ・HTML/PDF | 目録生成コード、110章、画像台帳、既存manifest | 目録は一致。R04・R05により内容の完全一致は不成立。PDF目視確認は未実施 |

既存の画面テストには、組立50部品、図面の保存・Undo、構成切替、板金100段、自動作図中の描画などを扱うファイルが存在する。これらを今回実行したとは記載しない。

[要件 §5.2](requirements.md) では、元の改善目標と現行リリースの実用上限を区別している。例えば30/60fpsの目標に対して一部の実描画試験は最低10fps、通常の典型形状500msの目標に対して対応する時間試験は2,500ms境界となる。**古い目標だけで失格としたり、上限の設定を実測合格と読んだりしていない。** 同じ入力・精度・試験経路の実測が別途必要である。

## 6. 改善案

以下は将来の設計提案であり、実装済みの機能や測定済みの効果ではない。既存機能を新機能として数えないよう、土台となる実装と、追加する利用体験を分けた。

### 6.1 弱点を底上げする

| 優先順 | 提案 | 根拠・追加する内容 | 完了を確かめる条件 |
|---|---|---|---|
| 1 | 非同期の文書操作に共通の採用判定を設ける | R01・R02。文書IDだけでなく内容・依頼の順序・添付を一つの処理単位として扱う。保存のキュー等、既存の正しい経路に合わせる | 遅延・順序逆転・文書切替・同一文書編集・Undoで、古い結果が本文・添付・保存先を変更しない |
| 2 | Desktopの終了時保護 | R03。現在ある未保存判定を本体側の終了要求と接続する | 保存取消・失敗は編集を維持。成功後だけ終了。確認を重複表示しない |
| 3 | 外部形式を出力ファイルまで通して検査する | R04。ライター単体に加え、UI→model→kernel結果→io→保存結果をつなぐ | 3MFの面色、各形式の寸法・単位・三角形数・名称・選択範囲を、実際の出力バイトで検査 |
| 4 | 説明書と操作シナリオの対応を記録する | R05。要件ID→章に加え、章の代表手順→画面試験→出力→撮影版の対応を持たせる | 代表手順の結果と画像に同じ入力ハッシュを付ける。未確認は未確認と表示し、機械的な目録一致と分ける |
| 5 | ZIPエントリ生成を分け、保存処理をWorkerへ移す | R06。同じ情報を包み直す圧縮・展開を削減する | データの往復一致と拒否条件を保持し、同じ入力で応答時間とピークメモリを比較する |
| 6 | 操作制御を責務ごとに小さくする | R07。点の決定、道具の状態遷移、イベント接続を分離する | 取消・Undo・ショートカット・平面切替・リスナー解放が同じ。別担当の編集中ファイルを一括分割しない |

### 6.2 強みを伸ばし、できることを増やす

| 提案 | 現在の土台 | 追加する機能・利用場面 | 最初に確認する条件 |
|---|---|---|---|
| **構成から部品群をまとめて作る** | [configurations.ts](../packages/model/src/part/configurations.ts) は構成ごとに式を保存・切替できる。[parameters.md](../packages/help-content/docs/ja/parameters.md) 104–117行で既に操作を説明 | 既存の構成切替に、CSV等の寸法表から複数構成を作成し、各構成を再計算してSTEP/3MF・図面・数量表へまとめて出す流れを追加。寸法違いのブラケット等に使う | 例えば10構成で、式・単位・構成名・寸法・出力名を照合。失敗した構成を成功扱いせず、元の編集文書を変更しない |
| **数式・形状の変更予告と原因表示** | [recomputePart.ts](../packages/model/src/part/recomputePart.ts) は数学量・パラメータ・履歴依存を扱い、[timelineOrder.ts](../packages/model/src/part/timelineOrder.ts) に依存処理がある | パラメータを変える前に影響するスケッチ・立体・測定量を表示し、失敗時には元の式と依存経路へ戻れる説明を提供。既存のエラー表示や版差分を一つの確認手順へまとめる | 枝分かれと循環を含む文書で、影響しない部分を誤って列挙しない。中止後や古い世代の結果を表示しない |
| **組立・図面にも自動作図を拡張する** | [scriptExecutor.ts](../packages/model/src/scripting/scriptExecutor.ts) のトランザクション準備。[scripts.md](../packages/help-content/docs/ja/scripts.md) 23行は現在「組立文書・図面文書への直接作図APIはありません」と明記 | まず部品配置・数量指定・投影図配置・寸法注記など限定した命令を追加。繰り返し作る治具一式や定型図面を自動生成する | 部品文書向けと同様に、実行前検証、1回のUndo、全体取消、期限、参照切れ拒否を備える。途中だけ確定しない |
| **加工条件を保存して設計を点検する** | 既存の3Dプリント点検、[板金条件](../packages/help-content/docs/ja/sheet-metal.md)、[recomputeSheetFlat.ts](../packages/model/src/sheetMetal/recomputeSheetFlat.ts) | 加工先が指定する最小穴径・穴と曲げの距離・許容内半径・K係数表等を名前付き条件として保存し、該当箇所を表示する。既存のメッシュ点検を再実装する提案ではない | 条件の出所と単位を保持し、境界値・適用できない形状・条件変更での再点検を確認。幾何上の合格と加工先条件への適合を分ける |
| **関数作図を再利用できる教材・設計例として配布する** | [function-curve.md](../packages/help-content/docs/ja/function-curve.md)、[function-surface.md](../packages/help-content/docs/ja/function-surface.md)、日本語パラメータ、保存される元の式 | 波形・螺旋・格子等の式、有限範囲、係数、期待形状、操作手順を一組にした例をヘルプから開けるようにする。式の編集から実体化・保存までつなぐ | 説明中の値で再生成でき、係数編集・Undo・保存再開でも元の式を保つ。各例の画像をその実行結果から撮影する |

進める順序は、データ保護と既存の約束の回復（R01～R05）、同じ結果を保つ性能・保守改善（R06・R07）、追加機能とする。新機能の追加で現在の不一致を埋め合わせた扱いにはしない。

### 6.3 検査の待ち時間を減らす設計案

[ci.yml](../.github/workflows/ci.yml) 33–57行は2OS×3分割で同じ `scripts/check.ps1` を呼ぶ。[check.ps1](../scripts/check.ps1) 508–524行では型・lint・単体・ビルドを行った後、E2Eに分割引数を付ける。したがって宣言上、各OSで前段の検査・ビルドも3回行う構成である。

前段をOSごとにまとめ、その入力ハッシュと生成物を同じOSのE2Eへ渡す設計は検討できる。ただし現在のゲートが入力の同一性・改変検出・実行環境を確認しているため、単純にジョブを削除する変更では済まない。**検査件数・OS・精度・時間判定を減らさず、同じ内容に対する証拠を維持できることが前提**。実行時間や費用の削減率は今回測定していない。

## 7. 追加検証で埋めるべき項目

この表は今回の合格結果ではなく、統括・実装担当が現在の変更をまとめた後に実施する確認項目である。

| 対象 | 確認する一連の操作 | 必要な証拠 |
|---|---|---|
| 全要件 | 197件を実際の検査ケースに対応付け、未確認・対象外を明示 | 同一内容のWeb Chromium/Firefox・Desktop、規約対象OSの結果。IDの対応だけでは合格にしない |
| 各編集機能 | 作成→パラメータ変更→Undo/Redo→保存→再開→再編集 | 元の式・単位・参照・幾何量・描画結果の一致 |
| 非同期操作 | 処理中の文書切替・編集・Undo・取消・再依頼 | 文書・添付・保存先・選択・エラー表示の一貫性 |
| 外部形式 | 読込・書出・再読込と色/単位/形状の比較 | 実出力バイトの検査と、必要な相手側ソフトでの確認 |
| 例外系 | 不正入力、破損ファイル、容量不足、Worker失敗、保存失敗 | 元文書の保持、期限内停止、再試行可能性、資源解放 |
| 性能 | 要件の200フィーチャー・50部品等と既存の負荷ケース | 元の目標、実測、実用上限の達否を併記。同じ形状・精度を維持 |
| 説明書 | 各章の手順を同じ版で実行→撮影→HTML/PDF生成→照合 | 欠落0、入力ハッシュ一致、本文・画面名・結果の一致、全PDFページの視覚確認 |

## 付録A. 全110章と要件の対応

各行の「目録一致」は、登録・ファイル・H1・要件対応の機械的な一致であり、操作成功を意味しない。**全行について、説明書の全手順を今回実画面で完走したわけではない。** 要件が複数の章に現れるため、章別の要件数を単純合計して197件と比較しない。

| 巻 | 章数 | 巻内の要件ID種類数 | 不足画像数 |
|---|---:|---:|---:|
| 導入・画面操作・ファイル | 16 | 37 | 0 |
| スケッチ・座標・関数 | 28 | 53 | 30 |
| 立体・外観・測定 | 20 | 48 | 0 |
| アセンブリ・部品表 | 9 | 19 | 0 |
| 図面・寸法・製図記号 | 18 | 38 | 0 |
| 板金・自動作図・加工連携 | 8 | 3 | 0 |
| 設定・履歴・表示 | 11 | 19 | 0 |

### 導入・画面操作・ファイル

| # | 章 | 対応する要件 | 今回の判定 |
|---:|---|---|---|
| 1 | [Web版をブラウザーで使う](../packages/help-content/docs/ja/web-version.md) | FR-1001 | 目録一致・動作未確認 |
| 2 | [ヘルプを探す・説明の続きを読んで戻る](../packages/help-content/docs/ja/help-reader.md) | FR-901、FR-902、FR-903、FR-904、FR-905、FR-910 | 目録一致・動作未確認 |
| 3 | [通信なしで使う準備と更新](../packages/help-content/docs/ja/offline-use.md) | FR-1004 | 目録一致・動作未確認 |
| 4 | [作図したデータの保存場所と通信](../packages/help-content/docs/ja/local-data.md) | FR-1002 | 目録一致・動作未確認 |
| 5 | [起動しない・3D表示が出ないとき](../packages/help-content/docs/ja/startup-checks.md) | FR-1003 | 目録一致・動作未確認 |
| 6 | [デスクトップ版の導入・更新・削除](../packages/help-content/docs/ja/desktop-install.md) | 個別要件の補足 | 目録一致・動作未確認 |
| 7 | [初めての作図](../packages/help-content/docs/ja/tutorial.md) | FR-906 | 目録一致・動作未確認 |
| 8 | [ショートカット一覧](../packages/help-content/docs/ja/shortcuts.md) | FR-907、FR-1104 | 目録一致・動作未確認 |
| 9 | [画面を回す・動かす・拡大する](../packages/help-content/docs/ja/viewport.md) | FR-101、FR-102、FR-103、FR-104、FR-105、FR-108 | 目録一致・動作未確認 |
| 10 | [単位を変える(ミリメートルとインチ)](../packages/help-content/docs/ja/units.md) | FR-205、FR-811、FR-814 | 目録一致・動作未確認 |
| 11 | [保存する・開く](../packages/help-content/docs/ja/save-and-open.md) | FR-801、FR-805、FR-806、FR-807、FR-1104 | 目録一致・R02あり・R03の制約記述は一致 |
| 12 | [ひな形を使う](../packages/help-content/docs/ja/template.md) | FR-725、FR-814、FR-1104 | 目録一致・動作未確認 |
| 13 | [読み込む(ほかのソフトの形を取り込む)](../packages/help-content/docs/ja/import.md) | FR-802、FR-808、FR-809、FR-813 | 目録一致・R01を関数で再現 |
| 14 | [書き出す(ほかのソフトへ渡す)](../packages/help-content/docs/ja/export.md) | FR-427、FR-803、FR-804 | 目録一致・3MFの説明にR04の反例 |
| 15 | [DXF を読み書きする](../packages/help-content/docs/ja/dxf.md) | FR-808、FR-809、FR-813、FR-817 | 目録一致・動作未確認 |
| 16 | [印刷する・別名で保存する](../packages/help-content/docs/ja/print-save-as.md) | FR-810、FR-812 | 目録一致・動作未確認 |

### スケッチ・座標・関数

| # | 章 | 対応する要件 | 今回の判定 |
|---:|---|---|---|
| 17 | [数値と式の入れ方](../packages/help-content/docs/ja/numeric-input.md) | FR-201、FR-202、FR-203、FR-204、FR-205、FR-301、FR-302、FR-303、FR-304、FR-305、FR-306、FR-307、FR-308、FR-904、FR-905 | 目録一致・動作未確認・画像2枚不足（R05） |
| 18 | [構造化した数式と係数を入力する](../packages/help-content/docs/ja/math-input.md) | FR-201、FR-202、FR-203、FR-204、FR-205、FR-210、FR-211 | 目録一致・動作未確認 |
| 19 | [数学記号と演算の一覧](../packages/help-content/docs/ja/math-symbols.md) | 個別要件の補足 | 目録一致・動作未確認 |
| 20 | [名前を付けた数値(パラメータ)](../packages/help-content/docs/ja/parameters.md) | FR-206、FR-207、FR-209 | 目録一致・動作未確認 |
| 21 | [作図面を選ぶ](../packages/help-content/docs/ja/work-plane.md) | FR-330 | 目録一致・動作未確認・画像1枚不足（R05） |
| 22 | [好きな向きの作業平面を作る](../packages/help-content/docs/ja/work-plane-custom.md) | FR-328 | 目録一致・動作未確認・画像2枚不足（R05） |
| 23 | [基準の軸・点・座標系を作る](../packages/help-content/docs/ja/reference-geometry.md) | FR-329 | 目録一致・動作未確認・画像2枚不足（R05） |
| 24 | [原点を置き直す](../packages/help-content/docs/ja/origin.md) | FR-331 | 目録一致・動作未確認・画像2枚不足（R05） |
| 25 | [点・線・円弧をかく](../packages/help-content/docs/ja/sketch-tools.md) | FR-301、FR-302、FR-303、FR-304、FR-305、FR-306、FR-307、FR-308、FR-320、FR-330、FR-904、FR-905 | 目録一致・動作未確認・画像2枚不足（R05） |
| 26 | [交点で線をつなぐ・曲げる・区間を消す](../packages/help-content/docs/ja/sketch-intersections.md) | FR-336 | 目録一致・動作未確認 |
| 27 | [四角・多角形・長穴・円をかく](../packages/help-content/docs/ja/shapes.md) | FR-314、FR-315、FR-316、FR-326、FR-327 | 目録一致・動作未確認・画像2枚不足（R05） |
| 28 | [楕円をかく](../packages/help-content/docs/ja/ellipse.md) | FR-318 | 目録一致・動作未確認・画像2枚不足（R05） |
| 29 | [なめらかな曲線をかく(スプライン)](../packages/help-content/docs/ja/spline.md) | FR-317 | 目録一致・動作未確認・画像2枚不足（R05） |
| 30 | [文字をスケッチの輪郭にする](../packages/help-content/docs/ja/text-sketch.md) | FR-319 | 目録一致・動作未確認 |
| 31 | [関数とXYZの範囲から曲線を作る](../packages/help-content/docs/ja/function-curve.md) | FR-210、FR-211、FR-334 | 目録一致・動作未確認 |
| 32 | [関数とXYZの範囲から曲面を作る](../packages/help-content/docs/ja/function-surface.md) | FR-210、FR-211、FR-436 | 目録一致・動作未確認 |
| 33 | [関数上に座標を指定して点を作る](../packages/help-content/docs/ja/function-point.md) | FR-210、FR-211、FR-335 | 目録一致・動作未確認 |
| 34 | [点にぴったり合わせる(吸着)](../packages/help-content/docs/ja/snap.md) | FR-107 | 目録一致・動作未確認・画像1枚不足（R05） |
| 35 | [向きをそろえる(直交・角度・延長線)](../packages/help-content/docs/ja/tracking.md) | FR-110 | 目録一致・動作未確認・画像1枚不足（R05） |
| 36 | [キーボードだけでかく(コマンドの欄)](../packages/help-content/docs/ja/command-line.md) | FR-208 | 目録一致・動作未確認・画像2枚不足（R05） |
| 37 | [面を張る・色を変える](../packages/help-content/docs/ja/face-and-color.md) | FR-309、FR-310、FR-312 | 目録一致・動作未確認・画像1枚不足（R05） |
| 38 | [かいたものを直す](../packages/help-content/docs/ja/edit-sketch.md) | FR-311、FR-730 | 目録一致・動作未確認・画像1枚不足（R05） |
| 39 | [オフセット・トリム・延長](../packages/help-content/docs/ja/edit-curves.md) | FR-321、FR-322 | 目録一致・動作未確認・画像1枚不足（R05） |
| 40 | [形を条件で決める(拘束)](../packages/help-content/docs/ja/constraints.md) | FR-313、FR-333 | 目録一致・動作未確認・画像2枚不足（R05） |
| 41 | [線の角を丸める・面取りする](../packages/help-content/docs/ja/sketch-fillet.md) | FR-323 | 目録一致・動作未確認 |
| 42 | [ミラー・複写・並べる](../packages/help-content/docs/ja/copy-array.md) | FR-324 | 目録一致・動作未確認・画像2枚不足（R05） |
| 43 | [立体から線を取り込む(投影・断面)](../packages/help-content/docs/ja/project-intersect.md) | FR-325 | 目録一致・動作未確認 |
| 44 | [下絵を敷く](../packages/help-content/docs/ja/canvas.md) | FR-332 | 目録一致・動作未確認・画像2枚不足（R05） |

### 立体・外観・測定

| # | 章 | 対応する要件 | 今回の判定 |
|---:|---|---|---|
| 45 | [厚みをつける・回す](../packages/help-content/docs/ja/solid-basics.md) | FR-401、FR-402、FR-403、FR-415、FR-416、FR-427 | 目録一致・動作未確認 |
| 46 | [立体をつなぐ・組み合わせる](../packages/help-content/docs/ja/solid-combine.md) | FR-404 | 目録一致・動作未確認 |
| 47 | [面・辺・頂点を選ぶ](../packages/help-content/docs/ja/select-subshape.md) | FR-106、FR-112 | 目録一致・動作未確認 |
| 48 | [球・箱・円柱・円錐・トーラスを置く](../packages/help-content/docs/ja/primitive.md) | FR-429 | 目録一致・動作未確認 |
| 49 | [穴をあける](../packages/help-content/docs/ja/hole.md) | FR-405、FR-422 | 目録一致・動作未確認 |
| 50 | [ねじ穴をあける](../packages/help-content/docs/ja/thread.md) | FR-406、FR-423 | 目録一致・動作未確認 |
| 51 | [角を丸める・面を取る](../packages/help-content/docs/ja/fillet-chamfer.md) | FR-407、FR-408、FR-426 | 目録一致・動作未確認 |
| 52 | [同じ加工を並べる](../packages/help-content/docs/ja/pattern.md) | FR-411、FR-412、FR-425 | 目録一致・動作未確認 |
| 53 | [ばねを作る](../packages/help-content/docs/ja/spring.md) | FR-414 | 目録一致・動作未確認 |
| 54 | [球の表面に点を置く](../packages/help-content/docs/ja/sphere-grid.md) | FR-431 | 目録一致・動作未確認 |
| 55 | [面と面をつなぐ・ロフト](../packages/help-content/docs/ja/ruled-loft.md) | FR-410、FR-430、FR-435 | 目録一致・動作未確認 |
| 56 | [立体の形を変える・並べる](../packages/help-content/docs/ja/shape-edit.md) | FR-312、FR-409、FR-413、FR-417、FR-418、FR-419、FR-420、FR-421、FR-424、FR-428、FR-433、FR-435 | 目録一致・動作未確認 |
| 57 | [平面で切る](../packages/help-content/docs/ja/cut.md) | FR-432 | 目録一致・動作未確認 |
| 58 | [色と材質を選ぶ](../packages/help-content/docs/ja/appearance-color.md) | FR-605、FR-1103、FR-1106、FR-1107、FR-1109、FR-1110 | 目録一致・動作未確認 |
| 59 | [柄を選ぶ](../packages/help-content/docs/ja/appearance-pattern.md) | FR-1103、FR-1107、FR-1108、FR-1109 | 目録一致・動作未確認 |
| 60 | [ガラス・鏡と映り込み](../packages/help-content/docs/ja/appearance-glass.md) | FR-1103、FR-1107、FR-1109 | 目録一致・動作未確認 |
| 61 | [長さ・角度・面積を測る](../packages/help-content/docs/ja/measure.md) | FR-1102 | 目録一致・動作未確認 |
| 62 | [材料と重さを調べる](../packages/help-content/docs/ja/mass-properties.md) | FR-1101 | 目録一致・動作未確認 |
| 63 | [梁・軸・ボルトの簡易強度計算](../packages/help-content/docs/ja/strength.md) | FR-1112 | 目録一致・動作未確認 |
| 64 | [3D プリントの前に点検する](../packages/help-content/docs/ja/print-check.md) | FR-815 | 目録一致・動作未確認 |

### アセンブリ・部品表

| # | 章 | 対応する要件 | 今回の判定 |
|---:|---|---|---|
| 65 | [部品を置いて組み立てる](../packages/help-content/docs/ja/assembly.md) | FR-601、FR-605、FR-1105 | 目録一致・読込にR02 |
| 66 | [部品を配置する](../packages/help-content/docs/ja/assembly-place.md) | FR-601、FR-602、FR-606 | 目録一致・動作未確認 |
| 67 | [規格部品を置く](../packages/help-content/docs/ja/standard-parts.md) | FR-612、FR-616 | 目録一致・動作未確認 |
| 68 | [部品どうしを合わせる](../packages/help-content/docs/ja/mate.md) | FR-603、FR-604、FR-609 | 目録一致・動作未確認 |
| 69 | [ジョイントで動きを残す](../packages/help-content/docs/ja/joint.md) | FR-608、FR-618 | 目録一致・動作未確認 |
| 70 | [部品の干渉を調べる](../packages/help-content/docs/ja/interference.md) | FR-607、FR-615 | 目録一致・動作未確認 |
| 71 | [部品を差し替える・組を置く](../packages/help-content/docs/ja/replace-subassembly.md) | FR-613、FR-614 | 目録一致・動作未確認 |
| 72 | [分解した見せ方を作る](../packages/help-content/docs/ja/explode.md) | FR-610、FR-617 | 目録一致・動作未確認 |
| 73 | [部品表を確認する](../packages/help-content/docs/ja/bom.md) | FR-611 | 目録一致・動作未確認 |

### 図面・寸法・製図記号

| # | 章 | 対応する要件 | 今回の判定 |
|---:|---|---|---|
| 74 | [部品から図面を作る・注記する・書き出す](../packages/help-content/docs/ja/drawing.md) | FR-710 | 目録一致・動作未確認 |
| 75 | [用紙サイズ・縮尺・用紙位置](../packages/help-content/docs/ja/drawing-scale.md) | FR-701、FR-703、FR-723 | 目録一致・動作未確認 |
| 76 | [図を追加する・詳細図・補助投影図・部分図・破断図](../packages/help-content/docs/ja/drawing-views.md) | FR-113、FR-702、FR-704、FR-708、FR-712、FR-714、FR-715 | 目録一致・動作未確認 |
| 77 | [断面図で部品の内部を示す](../packages/help-content/docs/ja/drawing-section.md) | FR-712、FR-713 | 目録一致・動作未確認 |
| 78 | [図面に寸法を記入する](../packages/help-content/docs/ja/dimension.md) | FR-706、FR-707、FR-716、FR-717、FR-718、FR-722、FR-724 | 目録一致・動作未確認 |
| 79 | [自動寸法を記入する](../packages/help-content/docs/ja/dimension-auto.md) | FR-705 | 目録一致・動作未確認 |
| 80 | [直列・並列・座標・累進の寸法をまとめて記入する](../packages/help-content/docs/ja/dimension-series.md) | FR-716 | 目録一致・動作未確認 |
| 81 | [寸法線をまとめて整列する](../packages/help-content/docs/ja/dimension-arrange.md) | FR-724 | 目録一致・動作未確認 |
| 82 | [寸法の公差・はめあいを指定する](../packages/help-content/docs/ja/dimension-tolerance.md) | FR-719、FR-723 | 目録一致・動作未確認 |
| 83 | [幾何公差とデータムを記入する](../packages/help-content/docs/ja/gdt.md) | FR-720 | 目録一致・動作未確認 |
| 84 | [表面性状と加工注記を付ける](../packages/help-content/docs/ja/surface-finish.md) | FR-718、FR-721 | 目録一致・動作未確認 |
| 85 | [溶接記号で施工する側・寸法・方法を伝える](../packages/help-content/docs/ja/welding.md) | FR-727 | 目録一致・動作未確認 |
| 86 | [文字注記と引出線](../packages/help-content/docs/ja/drawing-note.md) | FR-711 | 目録一致・動作未確認 |
| 87 | [図面に部品表と部品番号を置く](../packages/help-content/docs/ja/drawing-bom.md) | FR-611、FR-726、FR-728 | 目録一致・動作未確認 |
| 88 | [図面の穴表・改訂欄・表題欄を記入する](../packages/help-content/docs/ja/drawing-table.md) | FR-725、FR-729 | 目録一致・動作未確認 |
| 89 | [レイヤーで色・線・表示・印刷を管理する](../packages/help-content/docs/ja/drawing-layer.md) | FR-730 | 目録一致・動作未確認 |
| 90 | [文字を輪郭にする・文字を含む図面を渡す](../packages/help-content/docs/ja/text-outline.md) | FR-319 | 目録一致・動作未確認 |
| 91 | [図面を保存・書き出し・印刷する](../packages/help-content/docs/ja/drawing-export.md) | FR-709、FR-808、FR-809、FR-810、FR-812、FR-813 | 目録一致・動作未確認 |

### 板金・自動作図・加工連携

| # | 章 | 対応する要件 | 今回の判定 |
|---:|---|---|---|
| 92 | [板金の基板と曲げ条件を作る](../packages/help-content/docs/ja/sheet-metal.md) | FR-434 | 目録一致・動作未確認 |
| 93 | [板金の縁からフランジを作る](../packages/help-content/docs/ja/sheet-metal-flange.md) | FR-434 | 目録一致・動作未確認 |
| 94 | [指定線で板を曲げる・曲げリリーフを作る](../packages/help-content/docs/ja/sheet-metal-bend-relief.md) | FR-434 | 目録一致・動作未確認 |
| 95 | [板金を展開し、穴表・図面・加工用ファイルを作る](../packages/help-content/docs/ja/sheet-metal-flat.md) | FR-434 | 目録一致・動作未確認 |
| 96 | [JavaScriptで自動作図する](../packages/help-content/docs/ja/scripts.md) | FR-1111 | 目録一致・動作未確認 |
| 97 | [自動作図APIリファレンス](../packages/help-content/docs/ja/script-api.md) | FR-1111 | 目録一致・動作未確認 |
| 98 | [処理を保存し、道具として登録する](../packages/help-content/docs/ja/script-tools.md) | FR-1111 | 目録一致・動作未確認 |
| 99 | [作った形を加工ソフトへ渡す](../packages/help-content/docs/ja/cam.md) | FR-816 | 目録一致・動作未確認 |

### 設定・履歴・表示

| # | 章 | 対応する要件 | 今回の判定 |
|---:|---|---|---|
| 100 | [作ったものの一覧と、やり直し](../packages/help-content/docs/ja/feature-tree.md) | FR-501、FR-502、FR-503、FR-504、FR-505、FR-1105 | 目録一致・動作未確認 |
| 101 | [履歴へ設計メモを残す](../packages/help-content/docs/ja/history-notes.md) | FR-508 | 目録一致・動作未確認 |
| 102 | [2つの保存ファイルの変更を比較する](../packages/help-content/docs/ja/document-diff.md) | FR-509 | 目録一致・動作未確認 |
| 103 | [途中まで戻して確かめる(タイムライン)](../packages/help-content/docs/ja/timeline.md) | FR-506、FR-507 | 目録一致・動作未確認 |
| 104 | [画面の見た目を変える](../packages/help-content/docs/ja/display-settings.md) | FR-908、FR-909、FR-1104 | 目録一致・動作未確認 |
| 105 | [右クリックで道具を選ぶ](../packages/help-content/docs/ja/radial-menu.md) | FR-911 | 目録一致・動作未確認 |
| 106 | [選ぶものを絞る・選んだ組に名前を付ける](../packages/help-content/docs/ja/selection.md) | FR-106、FR-112 | 目録一致・動作未確認 |
| 107 | [視点に名前を付けて保存する・4分割で見る](../packages/help-content/docs/ja/named-view.md) | FR-113 | 目録一致・動作未確認 |
| 108 | [切って中を見る](../packages/help-content/docs/ja/section-view.md) | FR-109、FR-111 | 目録一致・動作未確認 |
| 109 | [字体と解析ライブラリのライセンス](../packages/help-content/docs/ja/font-licenses.md) | 個別要件の補足 | 目録一致・動作未確認 |
| 110 | [使っている部品と許諾](../packages/help-content/docs/ja/component-licenses.md) | 個別要件の補足 | 目録一致・動作未確認 |

## 付録B. 説明書の不足・鮮度の記録

不足ファイルの基点は `packages/help-content/docs/ja/images/`。30枚・18章。

| 章 | 不足する画像ファイル |
|---|---|
| [numeric-input](../packages/help-content/docs/ja/numeric-input.md) | `numeric-input-expression-detail.png`、`numeric-input-error-detail.png` |
| [work-plane](../packages/help-content/docs/ja/work-plane.md) | `work-plane-menu-detail.png` |
| [work-plane-custom](../packages/help-content/docs/ja/work-plane-custom.md) | `work-plane-custom-three-point-detail.png`、`work-plane-custom-offset-detail.png` |
| [reference-geometry](../packages/help-content/docs/ja/reference-geometry.md) | `reference-geometry-axis-detail.png`、`reference-geometry-tree-detail.png` |
| [origin](../packages/help-content/docs/ja/origin.md) | `origin-property-detail.png`、`origin-moved-detail.png` |
| [sketch-tools](../packages/help-content/docs/ja/sketch-tools.md) | `sketch-tools-menu-detail.png`、`sketch-tools-point-series-detail.png` |
| [shapes](../packages/help-content/docs/ja/shapes.md) | `shapes-circle-detail.png`、`shapes-polygon-detail.png` |
| [ellipse](../packages/help-content/docs/ja/ellipse.md) | `ellipse-basic-detail.png`、`ellipse-arc-detail.png` |
| [spline](../packages/help-content/docs/ja/spline.md) | `spline-points-detail.png`、`spline-finish-detail.png` |
| [snap](../packages/help-content/docs/ja/snap.md) | `snap-kinds-menu-detail.png` |
| [tracking](../packages/help-content/docs/ja/tracking.md) | `tracking-angle-step-detail.png` |
| [command-line](../packages/help-content/docs/ja/command-line.md) | `command-line-suggestions-detail.png`、`command-line-relative-detail.png` |
| [face-and-color](../packages/help-content/docs/ja/face-and-color.md) | `face-and-color-swatches-detail.png` |
| [edit-sketch](../packages/help-content/docs/ja/edit-sketch.md) | `edit-sketch-property-detail.png` |
| [edit-curves](../packages/help-content/docs/ja/edit-curves.md) | `edit-curves-offset-detail.png` |
| [constraints](../packages/help-content/docs/ja/constraints.md) | `constraints-value-detail.png`、`constraints-list-detail.png` |
| [copy-array](../packages/help-content/docs/ja/copy-array.md) | `copy-array-mirror-detail.png`、`copy-array-linear-count-detail.png` |
| [canvas](../packages/help-content/docs/ja/canvas.md) | `canvas-placed-detail.png`、`canvas-scale-length-detail.png` |

撮影スクリプトのハッシュ変更を検出した9枚は、次のとおり。これは画面差分を目視で確認した一覧ではない。

- `math-declared-symbols-detail.png`
- `math-derivative-at-detail.png`
- `math-error-functions-detail.png`
- `math-fourier-series-detail.png`
- `math-infinite-range-detail.png`
- `math-line-integrals-detail.png`
- `math-region-integrals-detail.png`
- `math-sequence-value-detail.png`
- `math-vector-calculus-at-detail.png`

鮮度照合時のアプリ入力digestは `1699631cb7417f9bcf6f3974dd32a2bd2c5ac27b9f4ef2b770327a7c1ea800e4`。照合の前後で同じだった。

調査した生成済み説明書の入力ハッシュ照合結果:

| manifestの場所 | 章数 | 入力数 | 現在と異なる入力数 |
|---|---:|---:|---:|
| `dist/manual-20260915-024132/manifest.json` | 98 | 210 | 80 |
| `dist/manual-20260915-030100/manifest.json` | 98 | 211 | 80 |
| `dist/manual-20260915-043627/manifest.json` | 99 | 214 | 79 |
| `dist/manual-20260915-062232/manifest.json` | 100 | 217 | 81 |
| `dist/manual-20260915-082143/manifest.json` | 100 | 220 | 78 |
| `dist/manual-20260916-054354/manifest.json` | 106 | 411 | 89 |
| `dist/manual-consistency-20260916-1912/manifest.json` | 107 | 420 | 86 |
| `dist/manual-desktop-20260916-085542/manifest.json` | 106 | 411 | 86 |
| `dist/manual-p12-20260915-193006/manifest.json` | 103 | 399 | 93 |
| `dist/manual-p12-current-20260916-1145/manifest.json` | 107 | 413 | 86 |
| `dist/manual-p12-final-20260916-1151/manifest.json` | 107 | 413 | 86 |
| `dist/manual-preview-20260912-213946/manifest.json` | 98 | 202 | 84 |
| `dist/manual-preview-20260912-215300/manifest.json` | 98 | 202 | 84 |
| `dist/offline-manual-20260915-230820/manifest.json` | 103 | 400 | 93 |
| `dist/offline-manual-20260916-032012/manifest.json` | 104 | 404 | 90 |
| `dist/w56b-manual-20260927a/manifest.json` | 110 | 470 | 42 |
| `dist/w65b-manual-20260927/manifest.json` | 110 | 470 | 20 |

## 付録C. 限定試験の再実行方法

以下はこのレビューで再実行して正常終了したNode.jsのプログラム。リポジトリ直下で、内容を標準入力から `node` へ渡す。ソースを読み込み、メモリ上で変換・評価し、結果だけを標準出力へ書く。ファイルの保存・アプリ起動・ネットワーク接続は行わない。依存パッケージは既に導入されたものを使用する。

実際に使う製品関数は `writeThreeMf`、`createExchangeDeps` 内の3MF出力、`toShapeExportOutcome`、`importFile`、`applyPickedAssembly`。ストア・非同期待機・使わない依存は注入している。したがって、本試験は対象関数の反例を確認するもので、型検査・全E2E・実カーネル試験の代用ではない。ライターへ注入する固定日時はZIPエントリ用で、色の計算は製品実装を使う。

~~~javascript
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const ts = require('typescript');

function loadTs(name, injected = {}) {
  const file = path.resolve(name);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  const localRequire = createRequire(file);
  function get(specifier) {
    if (Object.hasOwn(injected, specifier)) return injected[specifier];
    if (specifier.startsWith('.')) {
      return loadTs(path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')), injected);
    }
    return localRequire(specifier);
  }
  vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename: file })
    (get, mod, mod.exports);
  return mod.exports;
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
(async () => {
  const writer = loadTs('packages/io/src/threemf/writeThreeMf.ts', {
    '../pcad/pcadFile.js': { FIXED_ENTRY_MTIME: new Date(1980, 0, 1) },
  });
  const { unzipSync, strFromU8 } = createRequire(path.resolve('packages/io/package.json'))('fflate');
  let state = { fileGateway: {}, exchangeKernel: null };
  const imported = deferred();
  const exchange = loadTs('packages/ui/src/file/exchangeActions.ts', {
    '@pointercad/io': writer,
    '../store/useAppStore.js': { useAppStore: { getState: () => state } },
    '../i18n/t.js': { t: key => key },
    './exchangeFile.js': { runImport: () => imported.promise },
  });
  const mesh = {
    name: 'two-triangles', color: [1, 0, 0],
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    indices: [0, 1, 2, 0, 2, 3],
    faceColors: new Map([[1, [0, 0, 1]]]),
    faceRanges: [{ triangleOffset: 0, triangleCount: 1 }, { triangleOffset: 1, triangleCount: 1 }],
  };
  const colors = bytes => [...strFromU8(unzipSync(bytes)[writer.THREE_MF_MODEL_ENTRY])
    .matchAll(/displaycolor="([^"]+)"/g)].map(m => m[1].toLowerCase());
  const direct = colors(writer.writeThreeMf([mesh]));
  const throughUi = colors(exchange.createExchangeDeps('review').buildThreeMf({ meshes: [mesh] }).bytes);
  const conversion = loadTs('packages/model/src/kernelBridge/exchangeConversions.ts', {
    '../exchange/types.js': { EXPORT_MESH_QUALITY: {} }, '../part/types.js': {},
  });
  const converted = conversion.toShapeExportOutcome(
    { format: 'mesh', bodies: [{ triangles: mesh }] },
    { bodies: [mesh] });
  assert(direct.includes('#0000ffff'));
  assert(!throughUi.includes('#0000ffff'));
  assert(!Object.hasOwn(converted.bodies[0], 'faceRanges'));
  console.log(JSON.stringify({ probe: '3mf', direct, throughUi, convertedFields: Object.keys(converted.bodies[0]) }));

  function partState(id) {
    return { activeDocumentId: id, document: { id }, sketch: {}, workPlane: {}, fileGateway: {},
      addImportedAttachments() {}, applyDocument(document) { state = { ...state, document }; },
      setError() {} };
  }
  state = partState('A');
  const importing = exchange.importFile('step');
  state = partState('B');
  imported.resolve({ ok: true, kind: 'body', document: { id: 'A', name: 'old A plus import' },
    shapes: new Map(), meshes: new Map(), notices: [] });
  await importing;
  assert.equal(state.activeDocumentId, 'B');
  assert.equal(state.document.id, 'A');
  console.log(JSON.stringify({ probe: 'import', session: state.activeDocumentId, documentId: state.document.id }));

  const read = deferred();
  const events = [];
  const assembly = loadTs('packages/ui/src/file/assemblyFile.ts', {
    '@pointercad/io': { readDocumentBundle: () => read.promise },
    '@pointercad/model': { partLibraryOfBundle: bundle => bundle.library },
    '../store/documentKind.js': {},
    '../store/useAppStore.js': { useAppStore: { getState: () => state } },
    '../i18n/t.js': { t: key => key },
    './fileGateway.js': {}, './partFile.js': {},
    './recentFiles.js': { recordRecentFile() {} },
    './saveFailure.js': {}, './documentSaveQueue.js': {},
  });
  state = { activeDocumentId: 'same-session', documentVersion: 5, assembly: { name: 'original' },
    fileGateway: { clearSaveTarget() {} },
    openAssembly(document) { events.push('openAssembly'); state = { ...state, activeDocumentId: 'opened', assembly: document }; },
    setAssemblyFileState() { events.push('setAssemblyFileState'); },
  };
  const opening = assembly.applyPickedAssembly({ bytes: new Uint8Array(), name: 'loaded.pcada', saveTargetToken: null }, {});
  state = { ...state, documentVersion: 6, assembly: { name: 'edited while reading' } };
  read.resolve({ ok: true, bundle: { kind: 'assembly', document: { name: 'loaded' }, library: {} } });
  await opening;
  assert.equal(state.assembly.name, 'loaded');
  console.log(JSON.stringify({ probe: 'assembly', after: state.assembly.name, events }));
})().catch(error => { console.error(error); process.exitCode = 1; });
~~~

再実行の標準出力（終了コード0）:

~~~json
{"probe":"3mf","direct":["#ff0000ff","#0000ffff"],"throughUi":["#ff0000ff"],"convertedFields":["name","color","positions","indices"]}
{"probe":"import","session":"B","documentId":"A"}
{"probe":"assembly","after":"loaded","events":["openAssembly","setAssemblyFileState"]}
~~~

`assert` は現状の不具合が再現したことを確かめる。修正後には成功条件を反転させ、公開入口からの恒久的な回帰試験へ移す必要がある。

## 付録D. 作業範囲

- 本レビューが作成したファイル: `docs/review-2026-09-28-codex.md` のみ。
- アプリ・テスト・要件・規約・他担当の作業ファイルは編集していない。
- 品質ゲート、説明書生成、アプリ、開発サーバーは起動していない。
- 他担当のプロセスは終了・変更していない。
- `git status` と `git rev-parse` は `--no-optional-locks` 付きの読み取りだけを使用した。commit・checkout・reset・add等は行っていない。
- 子エージェントの使用: なし
- git への書き込み: なし

### 最終照合

2026-09-28 06:41:45 JST の再照合でも、主要根拠45ファイル＋ヘルプ110章の155件に変更はなかった。追って確認した `timelineMove.ts` と `documentDerived.ts` の2件も開始時のハッシュと一致した。HEADも冒頭のSHAから変わっていない。

画像の既存検査を最終確認でも再実行し、参照169種類・不足30枚・終了コード1・`written: false` を確認した。報告書自身はUTF-8、Markdownのコード囲みと191件の相対リンクを検査し、欠落リンク・文字化けの置換文字は0件だった。

主要な根拠のSHA-256を以下に残す。行番号はこの内容に対するもの。別担当の後続変更後は、同じ指摘がまだ成立するか再確認が必要になる。

| ファイル | SHA-256 |
|---|---|
| `packages/ui/src/file/exchangeActions.ts` | `d54e58bd4df67bfa054d3d495c704509fc8ca30ad75f4274ee2b3a3bbf9897a7` |
| `packages/ui/src/file/assemblyFile.ts` | `6299e8ce5aa45d7a10ccc019c6c6cb4d0c1db32ecd679add94ea5f92d4d6a5a5` |
| `packages/ui/src/store/assemblySlice.ts` | `93a17b237dbcaf542edac25af3867a25a3cff12dd3cd244694d505277cfe1439` |
| `packages/ui/src/store/documentSlice.ts` | `bb50e8b9f0087d4e6bce8c8c43044af8ab9fd516ed66935cccac2366549b2c60` |
| `packages/model/src/kernelBridge/exchangeConversions.ts` | `45b3704f69f3cde4c1edee1b898e28e230690798132959a3f988f40667eed1df` |
| `packages/io/src/threemf/writeThreeMf.ts` | `af4f8ccd4bf59001c0dabb648a78a2a7a861a648f600e9176f6ff8ea44c8ae60` |
| `packages/io/src/pcad/drawingBundle.ts` | `3934a186a35d4f3ba04758f285c28aaeda43b93b6b07a0ff96dc45ba259a29f8` |
| `apps/desktop/src/renderer/main.tsx` | `948e93b2f0f40486a6753393c6b31011104a215ca50769a4d7fa755275461aaf` |
| `packages/help-content/docs/ja/export.md` | `30b05c09a41dfc95cf3ad9971810d9ceafb6abe99a6f1c48eeb67d8cab370bb5` |
| `packages/help-content/docs/ja/save-and-open.md` | `65fecae1a2e9d12f50fb600865e683e87ebb6a7bd4337b055fe64d3adc986067` |
| `scripts/manual/captureRegistry.mjs` | `594eae499465b3b2612e27421e238149c8c0dcdd358358fabd661689884ca52d` |
| `packages/ui/src/viewport/attachSketchInteraction.ts` | `12f27ec19609a964dd7ebbe6f48dd875d616d06e1ffb9c0862f84218de578d70` |
