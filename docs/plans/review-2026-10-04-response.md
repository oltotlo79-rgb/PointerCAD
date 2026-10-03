# 2026-10-03レビューへの対応計画・全提案台帳

作成日: 2026-10-04。調査・計画担当: cx-v103-review-inventory。

目標は、同じ配点・同じ根拠の区別を使う独立した再レビューで **90/100以上**を得ること。これは計画であり、製品の修正完了・再レビュー合格の宣言ではない。全提案を29件に統合し、条件付きの射影補正やOCCT履歴利用も未受入として追跡する。既存の580タスク・543完了・94%には加算しない。

## 1. 調査の固定点と権限

- 開始時HEAD: `fb44ef2e3521bf792fd551c28d304cf307a064a4`。レビューの対象と一致。
- 開始時の読取り結果: 既存の `docs/報告記録.md` に126行追加、未追跡はレビュー本文・検証記録・引継ぎの3文書。stage済み差分は空。これらを編集していない。
- 規約全文を読む間に共有作業ツリーへ別作業のF01・下絵関連の変更が加わった。後で保存した [baseline.json](../../scratchpad/claude/agents/cx-v103-review-inventory/baseline.json) と [baseline-diff.patch](../../scratchpad/claude/agents/cx-v103-review-inventory/baseline-diff.patch) は**その取得時点の中間観測**であり、開始直後の全バイトの控えではない。後者702行を全文読了した。途中実装の正しさや完了は本担当では認定しない。
- [参照照合記録](../../scratchpad/claude/agents/cx-v103-review-inventory/reference-check.json) は各パスの取得時SHA-256・HEAD収録有無・範囲限定rgで得た記号の行を保持する。参照は現存入口を示し、今後の差分で行番号が変わり得る。受入時には統括が候補の同じSHAへ結び直す。
- 今回の書込みは本書と `scratchpad/claude/agents/cx-v103-review-inventory/` のみ。子エージェント0、git書込み0、製品検査・画像・ブラウザー・Electron・開発サーバー起動0。以下の実装・実画面・配布検査は将来の統括工程。

読了: AGENTS.md、CLAUDE.md、common.md、rules/00〜06全7文書（06は全2737行）、レビュー本文全409行、証拠全262行、引継ぎ全404行、要件§5・§6（518〜661行）、報告記録の先頭10節（1〜156行）。文字コード未指定と出力上限による欠落はUTF-8の小分け取得で再読了した。02:57の照合で別作業によるrules/01への10/4追記2項目を検出し、差分全文を再読した。統括のCodex移行と起動方法の追記であり、本担当の禁止事項は維持されている。初回の検査失敗を保存し、読了した追加内容のSHAを別記録へ固定する。

## 2. 元の節との対応と実施順序

原票の区切り方を固定する。レビュー§4のF09件、§6の追加2件、§7の比較5行と具体案4件、§8の3小節、§9の7行と末尾ガイド1件、引継ぎ§6.3の5件、利用者追加1件の計37個の主要出典単位を29提案に統合する。F08の条件付き機能追加やF01の短期/長期は同じ出典内でも別提案とするため、単純な「37−重複数」では数えない。§10は再掲の依存と横断受入として別途照合する。

|出典単位|対応先（重複を残した対応）|
|---|---|
|F01|R01 共通拒否、R17 修復UI、R18 操作履歴|
|F02|R02|
|F03|R03|
|F04|R04|
|F05|R05|
|F06|R06|
|F07|R03 画像分離、R07 残る責務分離|
|F08|R08 文案訂正、R24 四隅射影補正|
|F09|R09|
|§6 stream abort|R10|
|§6 依存監視・SBOM・WASM/Python|R11|
|§7比較1 パラメータ|R12 検索、R13 CSV|
|§7比較2 メッシュ|R14|
|§7比較3 変更履歴|R16|
|§7比較4 参照修復|R17|
|§7比較5 操作履歴による参照維持|R18|
|§7具体案1 座標・数式・名前|R19|
|§7具体案2 ローカル履歴|R16（前提R02/R04）|
|§7具体案3 3Dプリント確認|R15（偏差R14）|
|§7具体案4 再現できる説明例|R20|
|§8.1 許容差の意味|R21|
|§8.2 変換・尺度・Boolean・STEP・Float32|R22|
|§8.3 任意偏差・資源予算|R14|
|§9行1 選択と操作|R05、R29|
|§9行2 参照選び直し|R17|
|§9行3 パラメータ|R12|
|§9行4 入力結果と単位|R19|
|§9行5 保存・復元状態|R06|
|§9行6 下絵状態|R03|
|§9行7 キーと説明|R20、R29|
|§9末尾 初回ガイドと効果測定|R23|
|引継ぎ§6.3項目1 OCCT再コンパイル|R25|
|引継ぎ§6.3項目2 低速実機再現|R26|
|引継ぎ§6.3項目3 Dependabot失敗|R11|
|引継ぎ§6.3項目4 wait連鎖の証拠|R27|
|引継ぎ§6.3項目5 Twin|R28|
|利用者追加 2点接続|R29|

レビュー§1の優先順は下記依存へ、§2は第7節の配点へ、§3の未検証範囲と§5の既存合格は第5節の証拠境界へ、§10は下表へ、§11は本書の作業範囲へ対応する。レビューのコード案は適用済みの仕様や既存関数と混同しない。競合の機能説明はレビューの比較軸として扱い、今回ネット上で再確認した事実とはしない。

|工程（レビュー§10）|今回の順序・前提|段階の終了条件|
|---|---|---|
|正確性|R01〜R04を先頭にR10/R11/R21/R22。R02→R03/R04。F01と資産対策は互いのファイルを共有しない範囲で分離可能|全反例0、一意正常例・既存ファイル・保存再開・Undo/Redo合格。現在は未実施|
|操作|R05/R08/R09/R17/R19/R20/R27/R28/R29。R01→R17、R05→R29→R20|削除・入力・選択の一貫性、未解決から2操作以内、IME保持、説明矛盾0|
|応答性|R06/R07/R25/R26。R04/R10→R06、R03/R29→R07、R20→R26→R25|実入力応答・メモリ・取消と正確性の同時成立。低速未再現は未受入|
|機能改善|R12/R13/R14/R15/R16/R18/R23/R24。R12/R19→R13、R21/R22→R14→R15、R02/R04/R06→R16、R22→R18|代表作業の短縮、保存・精度・検査を維持。条件付き提案を黙って削除しない|

R25の準備調査は早く行えても、配信権限待ちで正確性やDesktop公開を止めない。レビューにあるクラウド共同編集は「別の大きな開発項目」という比較上の境界であり、本計画では新規実装対象にしない。モデルデータ外部送信禁止（NFR-SE-1）を変える要件決定が先に必要。引継ぎ§6.4のWeb公開全体と§6.5の残37原タスク確定も別台帳の作業であり、R25/R11の証拠を再利用できるだけで完了とはしない。


## 3. 統合対応表（29提案）

「未受入」は未実装・途中実装・未検査を含む。この調査では全29件を未受入に固定する。途中で観測した他担当の修正を完了へ進めない。工数は設計実装／個別検証／ヘルプの時間で、共通の公開工程は第6節へ別計上する。以下の担当名は将来のファイル所有区分であり、子エージェントの起動指示ではない。

|ID・提案|元の指摘・節|工程・依存|将来担当|時間 h（設計実装/個別検証/ヘルプ）|状態|
|---|---|---|---|---|---|
|R01 曖昧参照の拒否と共通の解決結果|F01; §4 F01; §10段階1; 引継ぎ§6.2|正確性：前提なし|参照・モデル|2 / 2 / 0.5 = 4.5|未受入|
|R02 下絵の資産IDとUndo資産の寿命|F02; §7具体案2の前提; §10段階1; 引継ぎ§6.2|正確性：前提なし|下絵・資産|1.5 / 1 / 0.5 = 3|未受入|
|R03 下絵キャッシュ失効と状態表示|F03; F07画像抽出; §9下絵の状態; §10段階1; 引継ぎ§6.2|正確性：R02|下絵・資産|1.5 / 1 / 0.5 = 3|未受入|
|R04 保存する文書だけが参照する画像の選別|F04; §6データ取扱い; §7具体案2の前提; §10段階1; 引継ぎ§6.2|正確性：R02|保存・資産|2 / 1.5 / 0.5 = 4|未受入|
|R05 図面の選択と削除対象を統一|F05; §9選択と操作; §10段階2|操作：R01|図面・操作|1 / 0.75 / 0.25 = 2|未受入|
|R06 保存Workerと保存・復元状態の表示|F06; §9保存・復元; §10段階3|応答性：R02, R03, R04, R10|保存・応答|4 / 2 / 1 = 7|未受入|
|R07 寿命と入力状態の責務分離|F07; §10段階3|応答性：R03, R05, R29|構造・共通UI|5 / 3 / 1 = 9|未受入|
|R08 下絵の縦横比と台形歪みの説明訂正|F08; §4 F08の文案; §10段階2|操作：R03|説明|0.1 / 0.15 / 0.25 = 0.5|未受入|
|R09 公開状況の説明を統一|F09; §10段階2|操作：前提なし|公開・説明|0.1 / 0.15 / 0.25 = 0.5|未受入|
|R10 保存ストリーム例外後のabort|§6書込み・close失敗時abort|正確性：前提なし|保存・応答|1 / 0.75 / 0.25 = 2|未受入|
|R11 依存監視の現状確認と失敗原因の切分け|§6依存監視; 引継ぎ§6.3項目3|正確性：前提なし|統括・監視|0.75 / 1 / 0.25 = 2|未受入|
|R12 パラメータ検索と参照フィルター|§7 Fusionパラメータ; §9多数のパラメータ; §10段階4|機能改善：R05, R07|パラメータ|1.5 / 1 / 0.5 = 3|未受入|
|R13 パラメータCSV入出力と適用前プレビュー|§7 Fusionパラメータ; §10段階4|機能改善：R12, R19|パラメータ|2.5 / 2 / 0.5 = 5|未受入|
|R14 任意のメッシュ出力偏差|§7 Fusionメッシュ; §8.3; §10段階4|機能改善：R21, R22|交換・精度|2 / 1.5 / 0.5 = 4|未受入|
|R15 3Dプリント書出し前の確認を集約|§7具体案3|機能改善：R14|交換・精度|1.5 / 1 / 0.5 = 3|未受入|
|R16 ローカルの名前付き保存点・複製・比較・復元|§7 Onshape履歴; §7具体案2; §10段階4|機能改善：R02, R04, R06, R07|保存・履歴|4 / 2 / 1 = 7|未受入|
|R17 未解決参照の候補・影響先・再選択|F01後続; §7 Onshape修復; §9参照選び直し; §10段階2|操作：R01|参照・UI|2.5 / 1.5 / 1 = 5|未受入|
|R18 OCCT操作履歴を使う参照維持|F01長期案; §7 FreeCAD参照維持|機能改善：R01, R17, R22|参照・カーネル|7 / 4 / 1 = 12|未受入|
|R19 数式候補に単位・参照元・影響数・エラー位置|§7具体案1; §9入力中結果|操作：R01|入力・数式|2 / 1.5 / 0.5 = 4|未受入|
|R20 再現できる説明例とキーボード回帰|§7具体案4; §9キーボードと説明; §10実画面必須系列|操作：R02, R03, R04, R05, R08, R29|説明・受入|1.5 / 1.5 / 1 = 4|未受入|
|R21 測定と許容差の意味を分けて表示|§8.1|正確性：R01|交換・精度|1 / 0.75 / 0.25 = 2|未受入|
|R22 幾何の変換・尺度・交換・表示の受入データ|§8.2|正確性：R01|カーネル・精度|2 / 3.5 / 0.5 = 6|未受入|
|R23 一続きの初回ガイドと利用者評価|§9末尾の初回ガイド|機能改善：R12, R14, R15, R19, R20|操作・ガイド|1.5 / 1.5 / 1 = 4|未受入|
|R24 四隅指定による下絵の平面射影補正|F08条件付き機能追加案|機能改善：R02, R03, R08|下絵・幾何|3 / 2 / 1 = 6|未受入|
|R25 OCCT再開時のコンパイル再利用|引継ぎ§6.3項目1・§2.1|応答性：R03, R11, R26|カーネル・配信|4 / 3 / 1 = 8|未受入|
|R26 遅い機械での画面受入の再現|引継ぎ§6.3項目2|応答性：R20|統括・検証|1 / 1.5 / 0.5 = 3|未受入|
|R27 diag wait重複の実コマンド証拠を照合|引継ぎ§6.3項目4|操作：前提なし|統括・道具|0.25 / 0.5 / 0.25 = 1|未受入|
|R28 portable_realcheck -Twinの実機確認|引継ぎ§6.3項目5・§5.5|操作：前提なし|統括・公開|0.25 / 0.5 / 0.25 = 1|未受入|
|R29 Shift/Ctrlで選んだ既存2点を右クリックから接続|利用者追加機能; §9選択一貫性・キーボードの具体的拡張|操作：R01, R05|スケッチ・操作|2 / 1.5 / 0.5 = 4|未受入|

## 4. 項目別の実在参照・受入・検査・担当範囲

パスはこの調査の読取り時点で存在し、記載記号はそのファイルへ限定した `rg -n -F` で照合した。既存テストの存在を確認したもので、既存試験が新しい条件をすでに満たすという意味ではない。新しい反例は以下の既存試験へ追加するか、その隣へ統括が明示的に新規割当する。各担当は挙げた入口とその項目の検査・ヘルプ・対応する日本語文言だけを割当候補とし、共有ファイルは統括が一人に所有させる。未列挙の利用先は着手時に列挙・範囲確定してから触る。

### R01 曖昧参照の拒否と共通の解決結果

**対象と記号:** [packages/kernel/src/occt/matchSubShape.ts](../../packages/kernel/src/occt/matchSubShape.ts) の `selectBest`、[packages/model/src/kernelBridge/subShapeMatching.ts](../../packages/model/src/kernelBridge/subShapeMatching.ts) の `rematchSubShapeRef`、[packages/model/src/drawing/dimensionTarget.ts](../../packages/model/src/drawing/dimensionTarget.ts) の `resolveDimensionTarget`、[packages/model/src/measure/mathGeometry.ts](../../packages/model/src/measure/mathGeometry.ts) の `subShape`。

**数値化した受入:** レビューの10/40mm・番号交換2例とも未解決、誤った正常値0。一意な候補は解決。既存0.05差の境界直下/一致/直上3条件と候補順2通りを固定。寸法・合致・加工面・外観の4用途で missing/ambiguous を明示し元参照を保持、Undo/Redo各1回と保存往復で不変。未解決の製作図出力は既存方針と一致。

**既存検査と追加方法:** [packages/kernel/src/occt/matchSubShape.test.ts](../../packages/kernel/src/occt/matchSubShape.test.ts)、[packages/model/src/drawing/dimensionTarget.test.ts](../../packages/model/src/drawing/dimensionTarget.test.ts)、[packages/model/src/measure/mathGeometry.test.ts](../../packages/model/src/measure/mathGeometry.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [dimension.md](../../packages/help-content/docs/ja/dimension.md)、[mate.md](../../packages/help-content/docs/ja/mate.md)、[select-subshape.md](../../packages/help-content/docs/ja/select-subshape.md)。

**担当範囲・根拠:** 参照・モデル。採点境界・図面2入口・合致/加工/外観の利用先の列挙と用途別適用。直接番号の一致だけでは同一性を認定しない。 設計実装2h + 個別検証2h + ヘルプ0.5h = 4.5h。

### R02 下絵の資産IDとUndo資産の寿命

**対象と記号:** [packages/ui/src/file/canvasFile.ts](../../packages/ui/src/file/canvasFile.ts) の `newSketchCanvas`、[packages/ui/src/store/canvasSlice.ts](../../packages/ui/src/store/canvasSlice.ts) の `addCanvas`、[packages/ui/src/shell/menus/lookToolActions.ts](../../packages/ui/src/shell/menus/lookToolActions.ts) の `addCanvasFromFile`。

**数値化した受入:** A追加→削除→B追加→Undo2回でAの名前/寸法/全画像SHA-256一致、Redo2回でB一致。複数画像・最大番号再利用・旧canvas-1・保存再開の4条件で衝突0。100回追加削除後、履歴を捨てた資産の保持0、履歴内の消失0。既存ID互換を維持。

**既存検査と追加方法:** [packages/ui/src/file/canvasFile.test.ts](../../packages/ui/src/file/canvasFile.test.ts)、[packages/ui/src/store/canvasSlice.test.ts](../../packages/ui/src/store/canvasSlice.test.ts)、[packages/ui/src/shell/menus/lookToolActions.test.ts](../../packages/ui/src/shell/menus/lookToolActions.test.ts)、[e2e/tests/canvas.spec.ts](../../e2e/tests/canvas.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [canvas.md](../../packages/help-content/docs/ja/canvas.md)。

**担当範囲・根拠:** 下絵・資産。表示IDと資産IDを分離し、UIで発行したIDを純関数へ渡す。現在文書/Undo/Redoの参照集合を調べて回収する設計まで含む。 設計実装1.5h + 個別検証1h + ヘルプ0.5h = 3h。

### R03 下絵キャッシュ失効と状態表示

**対象と記号:** [packages/ui/src/viewport/ViewportCanvas.tsx](../../packages/ui/src/viewport/ViewportCanvas.tsx) の `ViewportCanvas`、[packages/ui/src/sketch/CanvasSection.tsx](../../packages/ui/src/sketch/CanvasSection.tsx) の `CanvasSection`、[packages/ui/src/file/canvasFile.ts](../../packages/ui/src/file/canvasFile.ts) の `decodeCanvasImage`。

**数値化した受入:** 同IDのA/B、A→B→A、復号中削除、同文書差替え、破棄後完了の5系列で古い画像/寸法の反映0、不要bitmapのclose各1回。読込中/失敗/成功の3状態で画像名・画素・実寸を表示し、成功前の寸法合わせ0。遅着の失敗が新要求を消す件数0。実画面でも現画像を確認。

**既存検査と追加方法:** [packages/ui/src/viewport/canvasLayer.test.ts](../../packages/ui/src/viewport/canvasLayer.test.ts)、[packages/ui/src/store/canvasSlice.test.ts](../../packages/ui/src/store/canvasSlice.test.ts)、[e2e/tests/canvas.spec.ts](../../e2e/tests/canvas.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [canvas.md](../../packages/help-content/docs/ja/canvas.md)。

**担当範囲・根拠:** 下絵・資産。Viewport内部キャッシュを文書ID/画像ID/バイト同一性と要求トークンで分離。画素寸法・失敗状態も同じ所有者にする。 設計実装1.5h + 個別検証1h + ヘルプ0.5h = 3h。

### R04 保存する文書だけが参照する画像の選別

**対象と記号:** [packages/ui/src/store/attachKernel.ts](../../packages/ui/src/store/attachKernel.ts) の `currentPcadAttachments`、[packages/io/src/pcad/pcadFile.ts](../../packages/io/src/pcad/pcadFile.ts) の `writePcadFile`、[packages/ui/src/file/partFile.ts](../../packages/ui/src/file/partFile.ts) の `savePart`。

**数値化した受入:** 4保存経路×削除/Undo/複数一部削除の12条件。削除画像ZIPエントリ0、Undo後は元SHA-256一致。保存開始後の編集でもその保存対象の参照と添付が一致。メモリのUndo資産を誤削除0、独立の読み手で再読込成功。

**既存検査と追加方法:** [packages/ui/src/file/partFile.test.ts](../../packages/ui/src/file/partFile.test.ts)、[packages/ui/src/file/attachAutoSave.test.ts](../../packages/ui/src/file/attachAutoSave.test.ts)、[packages/ui/src/file/templateFile.test.ts](../../packages/ui/src/file/templateFile.test.ts)、[packages/ui/src/file/drawingFile.test.ts](../../packages/ui/src/file/drawingFile.test.ts)、[packages/io/src/pcad/zipPasses.test.ts](../../packages/io/src/pcad/zipPasses.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [canvas.md](../../packages/help-content/docs/ja/canvas.md)、[save-and-open.md](../../packages/help-content/docs/ja/save-and-open.md)、[template.md](../../packages/help-content/docs/ja/template.md)。

**担当範囲・根拠:** 保存・資産。手動/自動/ひな形/図面同梱の4経路を固定スナップショットへ統一。汎用IOの未知添付保持契約は維持。 設計実装2h + 個別検証1.5h + ヘルプ0.5h = 4h。

### R05 図面の選択と削除対象を統一

**対象と記号:** [packages/ui/src/drawing/dimensionCommands.ts](../../packages/ui/src/drawing/dimensionCommands.ts) の `deleteSelectedDrawingElements`、[packages/ui/src/drawing/tableCommands.ts](../../packages/ui/src/drawing/tableCommands.ts) の `deleteDrawingTables`、[packages/ui/src/commands/commandDefinitions.ts](../../packages/ui/src/commands/commandDefinitions.ts) の `drawing.deleteSelection`。

**数値化した受入:** 表/風船/寸法+表の3選択×Delete/Backspaceの2キーで対象削除。Undo1回/Redo1回で全対象復元/再削除。入力中/計算中/空選択3条件は文書変更0。投影図/レイヤーの対象外時は日本語の理由1件を出し、専用ボタンと意味一致。

**既存検査と追加方法:** [packages/ui/src/drawing/dimensionCommands.test.ts](../../packages/ui/src/drawing/dimensionCommands.test.ts)、[packages/ui/src/drawing/tableCommands.test.ts](../../packages/ui/src/drawing/tableCommands.test.ts)、[e2e/tests/p8-drawing.spec.ts](../../e2e/tests/p8-drawing.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [drawing-table.md](../../packages/help-content/docs/ja/drawing-table.md)、[drawing-bom.md](../../packages/help-content/docs/ja/drawing-bom.md)、[shortcuts.md](../../packages/help-content/docs/ja/shortcuts.md)。

**担当範囲・根拠:** 図面・操作。既存共通削除に表/風船を統合、投影図とレイヤーは依存削除契約を明示。 設計実装1h + 個別検証0.75h + ヘルプ0.25h = 2h。

### R06 保存Workerと保存・復元状態の表示

**対象と記号:** [packages/io/src/pcad/pcadFile.ts](../../packages/io/src/pcad/pcadFile.ts) の `zipPcadEntries`、[packages/ui/src/file/partFile.ts](../../packages/ui/src/file/partFile.ts) の `savePart`、[packages/ui/src/shell/StatusBar.tsx](../../packages/ui/src/shell/StatusBar.tsx) の `StatusBar`。

**数値化した受入:** 32/128MiB各3回・各100入力で応答p95<100msを改善受入値として実測。同一入力の展開エントリ名/全バイト/再読込文書一致。文書切替/連打/取消/close失敗で誤成功0。現文書/Undoのbuffer detach0。取消表示<=1秒、余分な作業メモリ上限案512MiBを起動前/転送中/解放後で検証。段階/完了ファイル名/未保存/復元状態4表示を現世代だけに反映。

**既存検査と追加方法:** [packages/io/src/pcad/zipPasses.test.ts](../../packages/io/src/pcad/zipPasses.test.ts)、[packages/ui/src/file/saveConcurrency.test.ts](../../packages/ui/src/file/saveConcurrency.test.ts)、[packages/ui/src/file/saveFailure.test.ts](../../packages/ui/src/file/saveFailure.test.ts)、[packages/ui/src/file/attachAutoSave.test.ts](../../packages/ui/src/file/attachAutoSave.test.ts)、[packages/ui/src/security/contentSecurityPolicy.test.ts](../../packages/ui/src/security/contentSecurityPolicy.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [save-and-open.md](../../packages/help-content/docs/ja/save-and-open.md)、[local-data.md](../../packages/help-content/docs/ja/local-data.md)。

**担当範囲・根拠:** 保存・応答。ZIPと重いJSON、通信/取消/転送所有権、3文書種の保存キュー、段階表示を実装。専用Worker入口は新設設計であり既存APIとは記載しない。 設計実装4h + 個別検証2h + ヘルプ1h = 7h。

### R07 寿命と入力状態の責務分離

**対象と記号:** [packages/ui/src/viewport/attachSketchInteraction.ts](../../packages/ui/src/viewport/attachSketchInteraction.ts) の `attachSketchInteraction`、[packages/ui/src/shell/FeatureTree.tsx](../../packages/ui/src/shell/FeatureTree.tsx) の `FeatureTree`、[packages/ui/src/viewport/createSolidLayer.ts](../../packages/ui/src/viewport/createSolidLayer.ts) の `createSolidLayer`、[packages/ui/src/viewport/createViewportScene.ts](../../packages/ui/src/viewport/createViewportScene.ts) の `createViewportScene`、[packages/ui/src/viewport/ViewportCanvas.tsx](../../packages/ui/src/viewport/ViewportCanvas.tsx) の `ViewportCanvas`。

**数値化した受入:** 既存5大関数の責務表5/5、選択/作図/ドラッグ/取消4系列の境界前後ストア更新一致。100回装着破棄でイベント/画像/GPU所有資源の差0、キャンセル後の確定0。キー/IME/ドラッグ取消の既存条件を維持。行数だけを完了基準にせず不要なタスク履歴コメントを責務説明へ整理。利用者動作不変ならヘルプ変更不要を差分で記録。

**既存検査と追加方法:** [packages/ui/src/viewport/attachSketchInteraction.test.ts](../../packages/ui/src/viewport/attachSketchInteraction.test.ts)、[packages/ui/src/viewport/cameraSketchInteraction.test.ts](../../packages/ui/src/viewport/cameraSketchInteraction.test.ts)、[packages/ui/src/viewport/createSolidLayer.test.ts](../../packages/ui/src/viewport/createSolidLayer.test.ts)、[packages/ui/src/shell/FeatureTree.test.tsx](../../packages/ui/src/shell/FeatureTree.test.tsx)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [edit-sketch.md](../../packages/help-content/docs/ja/edit-sketch.md)、[viewport.md](../../packages/help-content/docs/ja/viewport.md)。

**担当範囲・根拠:** 構造・共通UI。画像はR03で費用計上済み。残る選択/作図/ドラッグ/取消とFeatureTree・SolidLayer・Sceneの所有境界を順に分離し、全体書換えを避ける。 設計実装5h + 個別検証3h + ヘルプ1h = 9h。

### R08 下絵の縦横比と台形歪みの説明訂正

**対象と記号:** [packages/ui/src/viewport/canvasLayer.ts](../../packages/ui/src/viewport/canvasLayer.ts) の `buildCanvasPlanePositions`。

**数値化した受入:** 上辺100/下辺80の例で縦横比調整後も比100:80。台形補正できるとの断定0、正面撮影/外部補正の代替2件、2点縮尺を全域精度保証とする説明0。ヘルプ/生成HTMLの不一致0。

**既存検査と追加方法:** [packages/ui/src/viewport/canvasLayer.test.ts](../../packages/ui/src/viewport/canvasLayer.test.ts)、[packages/help-content/src/uiReferences.test.ts](../../packages/help-content/src/uiReferences.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [canvas.md](../../packages/help-content/docs/ja/canvas.md)。

**担当範囲・根拠:** 説明。既存の配置式と説明1章を照合。射影補正追加はR24として分離。 設計実装0.1h + 個別検証0.15h + ヘルプ0.25h = 0.5h。

### R09 公開状況の説明を統一

**対象と記号:** [README.md](../../README.md) の `PointerCAD`、[docs/releases/v1.0.2.md](../../docs/releases/v1.0.2.md) の `1.0.2`。

**数値化した受入:** 3か所の公開対象/版/URL矛盾0。引継ぎの未公開記録だけを現在確認済みとはしない。統括が取得日時と配布SHAを記録して文面を確定。公開しない段階では将来公開の案内に統一し架空URL0。

**既存検査と追加方法:** [packages/help-content/src/uiReferences.test.ts](../../packages/help-content/src/uiReferences.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [web-version.md](../../packages/help-content/docs/ja/web-version.md)、[desktop-install.md](../../packages/help-content/docs/ja/desktop-install.md)。

**担当範囲・根拠:** 公開・説明。README・導入ヘルプ・リリース案内の3か所を統括の公開証拠に照合。 設計実装0.1h + 個別検証0.15h + ヘルプ0.25h = 0.5h。

### R10 保存ストリーム例外後のabort

**対象と記号:** [packages/ui/src/file/fileGateway.ts](../../packages/ui/src/file/fileGateway.ts) の `saveFileAsInBrowser`、[packages/ui/src/file/fileGateway.ts](../../packages/ui/src/file/fileGateway.ts) の `createBrowserFileGateway`。

**数値化した受入:** 2入口×write失敗/close失敗/abortも失敗の6条件で元の例外を保持、abort試行各1回。正常時abort0。API利用可能な実ブラウザーで失敗後再保存1回成功、既存ファイル保持も確認。Firefoxのダウンロード代替も成功。未実証のロック/破損を確定バグと記載しない。

**既存検査と追加方法:** [packages/ui/src/file/fileGateway.test.ts](../../packages/ui/src/file/fileGateway.test.ts)、[packages/ui/src/file/saveFailure.test.ts](../../packages/ui/src/file/saveFailure.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [save-and-open.md](../../packages/help-content/docs/ja/save-and-open.md)。

**担当範囲・根拠:** 保存・応答。保存2入口のwrite/close/abort契約を共通化。元例外優先と再保存を確認。 設計実装1h + 個別検証0.75h + ヘルプ0.25h = 2h。

### R11 依存監視の現状確認と失敗原因の切分け

**対象と記号:** [docs/security/dependency-monitoring.md](../../docs/security/dependency-monitoring.md) の `未接続`、[.github/dependabot.yml](../../.github/dependabot.yml) の `updates`、[.github/workflows/ci.yml](../../.github/workflows/ci.yml) の `jobs`、[scripts/release/sbom.mjs](../../scripts/release/sbom.mjs) の `collectSbomComponents`。

**数値化した受入:** 10/1・10/3の失敗run各1件以上をID/SHA/段階/原文で分類し、未取得を0件アラートへ変換しない。alerts/security-updates/通常更新3状態確認、SBOM対lock/同梱資産の未対応0。有効未解消指摘0を公開条件とし、例外はID/根拠/担当/期限（<=30日）必須。古いFirefox/Electron未接続説明の残存0。

**既存検査と追加方法:** [apps/desktop/src/main/sbom.test.ts](../../apps/desktop/src/main/sbom.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [component-licenses.md](../../packages/help-content/docs/ja/component-licenses.md)。

**担当範囲・根拠:** 統括・監視。設定/CI/現行lock/SBOM/同梱WASM・Pythonを照合、update_filesの実ログ2日分を取得する調査工数。修正版依存への交換工数は含めない。 設計実装0.75h + 個別検証1h + ヘルプ0.25h = 2h。

### R12 パラメータ検索と参照フィルター

**対象と記号:** [packages/ui/src/parameters/ParameterPanel.tsx](../../packages/ui/src/parameters/ParameterPanel.tsx) の `ParameterPanel`、[packages/ui/src/parameters/parameterCommands.ts](../../packages/ui/src/parameters/parameterCommands.ts) の `parameterUsageCounts`、[packages/ui/src/parameters/parameterCommands.ts](../../packages/ui/src/parameters/parameterCommands.ts) の `parameterRowsOf`、[packages/model/src/parameters/parameterTable.ts](../../packages/model/src/parameters/parameterTable.ts) の `analyzeParameters`。

**数値化した受入:** 100行で名前/説明検索と3フィルターの期待ID集合が完全一致。改名/Undo/構成切替3操作で検索語と操作対象の焦点消失0。10検索各100ms未満をUI改善目標として記録。0件も理由表示、フィルター中の削除対象取り違え0。

**既存検査と追加方法:** [packages/ui/src/parameters/parameterCommands.test.ts](../../packages/ui/src/parameters/parameterCommands.test.ts)、[packages/ui/src/parameters/parameterStore.test.ts](../../packages/ui/src/parameters/parameterStore.test.ts)、[e2e/tests/p4b-parameters.spec.ts](../../e2e/tests/p4b-parameters.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [parameters.md](../../packages/help-content/docs/ja/parameters.md)。

**担当範囲・根拠:** パラメータ。既存usage/循環解析を使い名前・説明検索と未使用/循環/参照元を追加。 設計実装1.5h + 個別検証1h + ヘルプ0.5h = 3h。

### R13 パラメータCSV入出力と適用前プレビュー

**対象と記号:** [packages/ui/src/parameters/parameterCommands.ts](../../packages/ui/src/parameters/parameterCommands.ts) の `commitReplaceParameter`、[packages/model/src/parameters/parameterTable.ts](../../packages/model/src/parameters/parameterTable.ts) の `analyzeParameters`、[packages/ui/src/file/fileGateway.ts](../../packages/ui/src/file/fileGateway.ts) の `saveFileAsThrough`。

**数値化した受入:** 100行の日本語名/式/説明/単位を往復し意味・原式一致100%。引用符/カンマ/改行/BOM/重複名/循環/不正単位の7分類を検査。プレビュー取消は文書/Undo差0、全行検証後1回のUndo単位で適用。暫定上限1000行/1MiB、境界+1拒否。式はアプリの安全な式解析へ渡し外部表計算の命令として実行しない。

**既存検査と追加方法:** [packages/ui/src/parameters/parameterCommands.test.ts](../../packages/ui/src/parameters/parameterCommands.test.ts)、[packages/model/src/parameters/parameterTable.test.ts](../../packages/model/src/parameters/parameterTable.test.ts)、[packages/ui/src/file/fileGateway.test.ts](../../packages/ui/src/file/fileGateway.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [parameters.md](../../packages/help-content/docs/ja/parameters.md)。

**担当範囲・根拠:** パラメータ。既存パラメータ確定を再利用しCSV読取/出力/差分プレビューを新規接続。解析器追加依存は無断採用しない。 設計実装2.5h + 個別検証2h + ヘルプ0.5h = 5h。

### R14 任意のメッシュ出力偏差

**対象と記号:** [packages/model/src/exchange/types.ts](../../packages/model/src/exchange/types.ts) の `EXPORT_MESH_QUALITY`、[packages/model/src/exchange/exportPart.ts](../../packages/model/src/exchange/exportPart.ts) の `exportMeshQuality`、[packages/ui/src/file/ExchangePanel.tsx](../../packages/ui/src/file/ExchangePanel.tsx) の `ExchangePanel`。

**数値化した受入:** 既存3値0.5/0.1/0.02mmと角度偏差を維持。任意値0.005/0.05/0.5mmが実カーネルへ一致して渡る。0/負/NaN/Infinity拒否4分類。暫定予算100万三角形/25秒/作業512MiB、超過時部分ファイル採用0・取消可。設定公差0.01対偏差0.1を可視化。測っていない最大誤差の保証表示0。

**既存検査と追加方法:** [packages/model/src/exchange/exportPart.test.ts](../../packages/model/src/exchange/exportPart.test.ts)、[packages/kernel/src/occt/exportMesh.test.ts](../../packages/kernel/src/occt/exportMesh.test.ts)、[packages/ui/src/file/ExchangePanel.test.ts](../../packages/ui/src/file/ExchangePanel.test.ts)、[e2e/tests/export.spec.ts](../../e2e/tests/export.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [export.md](../../packages/help-content/docs/ja/export.md)。

**担当範囲・根拠:** 交換・精度。3段階保持+詳細値、型/Worker/出力/表示の全利用先へ転送し予算を制限。 設計実装2h + 個別検証1.5h + ヘルプ0.5h = 4h。

### R15 3Dプリント書出し前の確認を集約

**対象と記号:** [packages/ui/src/solid/printCheckCommands.ts](../../packages/ui/src/solid/printCheckCommands.ts) の `runPrintCheck`、[packages/ui/src/file/ExportHandoffPanel.tsx](../../packages/ui/src/file/ExportHandoffPanel.tsx) の `ExportHandoffPanel`。

**数値化した受入:** 寸法/単位/閉立体/設定偏差/三角形数/点検結果の6項目を出力前に提示。閉立体/開面/不正形状3例で元点検と一致、文書変更後の古い結果採用0。確認から出力まで2操作以内。mm/inch双方で実ファイルの寸法一致。

**既存検査と追加方法:** [packages/ui/src/solid/printCheckCommands.test.ts](../../packages/ui/src/solid/printCheckCommands.test.ts)、[packages/ui/src/store/exportHandoff.test.ts](../../packages/ui/src/store/exportHandoff.test.ts)、[e2e/tests/export.spec.ts](../../e2e/tests/export.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [print-check.md](../../packages/help-content/docs/ja/print-check.md)、[export.md](../../packages/help-content/docs/ja/export.md)。

**担当範囲・根拠:** 交換・精度。既存PrintCheckと書出しの状態を一画面へ結ぶ。点検を再実装しない。 設計実装1.5h + 個別検証1h + ヘルプ0.5h = 3h。

### R16 ローカルの名前付き保存点・複製・比較・復元

**対象と記号:** [packages/model/src/diff/compareDocuments.ts](../../packages/model/src/diff/compareDocuments.ts) の `compareDocuments`、[packages/ui/src/diff/MaterialDiffPanel.tsx](../../packages/ui/src/diff/MaterialDiffPanel.tsx) の `MaterialDiffPanel`、[packages/ui/src/diff/materialDiffSession.ts](../../packages/ui/src/diff/materialDiffSession.ts) の `createMaterialDiffSession`。

**数値化した受入:** 試作A/発注前の2保存点から一覧/複製/比較/復元4操作を検証。元点SHA不変、復元の取消とUndo1回で旧文書/添付復元。重複画像は内容で共有、未参照削除と保存点参照保持を両立。暫定100点/総512MiBで超過を理由付き拒否、無断削除0。端末外送信0。

**既存検査と追加方法:** [packages/model/src/diff/compareDocuments.test.ts](../../packages/model/src/diff/compareDocuments.test.ts)、[packages/ui/src/diff/runMaterialDiff.test.ts](../../packages/ui/src/diff/runMaterialDiff.test.ts)、[e2e/tests/document-diff.spec.ts](../../e2e/tests/document-diff.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [document-diff.md](../../packages/help-content/docs/ja/document-diff.md)、[history-notes.md](../../packages/help-content/docs/ja/history-notes.md)、[save-and-open.md](../../packages/help-content/docs/ja/save-and-open.md)。

**担当範囲・根拠:** 保存・履歴。内容ハッシュ付き不変スナップショットと既存差分UI、資産参照、容量管理を接続。通常Undoと保存点を別契約にする。 設計実装4h + 個別検証2h + ヘルプ1h = 7h。

### R17 未解決参照の候補・影響先・再選択

**対象と記号:** [packages/ui/src/shell/PropertyPanel.tsx](../../packages/ui/src/shell/PropertyPanel.tsx) の `PropertyPanel`、[packages/ui/src/solid/referenceSummary.ts](../../packages/ui/src/solid/referenceSummary.ts) の `summarizeReference`、[packages/model/src/kernelBridge/subShapeMatching.ts](../../packages/model/src/kernelBridge/subShapeMatching.ts) の `scoreSubShapeMatch`。

**数値化した受入:** 未解決箇所から2操作以内で元参照/候補/影響寸法・合致を確認。ホバー・取消で文書とUndo差0、確定だけ1履歴。消失/曖昧/一意の3状態、文書切替/再計算後の古い候補採用0。番号交換時も候補の意味を表示し全影響先を再検査。

**既存検査と追加方法:** [packages/ui/src/shell/PropertyPanel.test.ts](../../packages/ui/src/shell/PropertyPanel.test.ts)、[packages/model/src/drawing/dimensionTarget.test.ts](../../packages/model/src/drawing/dimensionTarget.test.ts)、[packages/ui/src/viewport/createSolidLayer.test.ts](../../packages/ui/src/viewport/createSolidLayer.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [dimension.md](../../packages/help-content/docs/ja/dimension.md)、[select-subshape.md](../../packages/help-content/docs/ja/select-subshape.md)、[mate.md](../../packages/help-content/docs/ja/mate.md)。

**担当範囲・根拠:** 参照・UI。既存プロパティ内に候補表示/ホバー/確定/取消を接続。参照解決と保存変更を分ける。 設計実装2.5h + 個別検証1.5h + ヘルプ1h = 5h。

### R18 OCCT操作履歴を使う参照維持

**対象と記号:** [packages/kernel/src/occt/booleanOp.ts](../../packages/kernel/src/occt/booleanOp.ts) の `booleanOp`、[packages/kernel/src/occt/matchSubShape.ts](../../packages/kernel/src/occt/matchSubShape.ts) の `matchEdge`、[packages/model/src/kernelBridge/subShapeMatching.ts](../../packages/model/src/kernelBridge/subShapeMatching.ts) の `rematchSubShapeRef`。

**数値化した受入:** Boolean3演算とフィレット/面取りの計5操作で生成・変更・削除の対応を独立照合。保存再開/Undo/順序変更で誤対応0、同一性を証明不能なら未解決。履歴のない輸入形状は指紋補助+曖昧拒否へ戻す。OCCT公開バインディング不足時は不採用理由と残件を記録し未実装を完了としない。

**既存検査と追加方法:** [packages/kernel/src/occt/booleanOp.test.ts](../../packages/kernel/src/occt/booleanOp.test.ts)、[packages/kernel/src/occt/matchSubShape.test.ts](../../packages/kernel/src/occt/matchSubShape.test.ts)、[packages/model/src/drawing/dimensionTarget.test.ts](../../packages/model/src/drawing/dimensionTarget.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [select-subshape.md](../../packages/help-content/docs/ja/select-subshape.md)、[dimension.md](../../packages/help-content/docs/ja/dimension.md)。

**担当範囲・根拠:** 参照・カーネル。生成/変更/削除履歴を橋渡しする実現性調査2hを含む。操作間の履歴合成と既存指紋補助、保存後再計算を実証。 設計実装7h + 個別検証4h + ヘルプ1h = 12h。

### R19 数式候補に単位・参照元・影響数・エラー位置

**対象と記号:** [packages/ui/src/sketch/numericInputEvaluation.ts](../../packages/ui/src/sketch/numericInputEvaluation.ts) の `evaluateNumericInput`、[packages/ui/src/sketch/numericInputPresentation.ts](../../packages/ui/src/sketch/numericInputPresentation.ts) の `fieldUnitLabelKey`、[packages/ui/src/parameters/parameterCommands.ts](../../packages/ui/src/parameters/parameterCommands.ts) の `referencingFeatureNames`。

**数値化した受入:** mm/inch/degreeの3単位で値/次元/参照元/影響部品数を独立期待値と一致。板厚×2=6mmと使用先1件の例を候補選択前に表示。誤単位3例は欄近傍に理由と位置。IME変換中Enterで確定0、表示切替で原式改変0、取消/Undo後の旧候補採用0。

**既存検査と追加方法:** [packages/ui/src/sketch/numericInput.test.ts](../../packages/ui/src/sketch/numericInput.test.ts)、[packages/ui/src/sketch/numericMathValues.test.ts](../../packages/ui/src/sketch/numericMathValues.test.ts)、[packages/ui/src/math/mathEditorKeyboard.test.ts](../../packages/ui/src/math/mathEditorKeyboard.test.ts)、[e2e/tests/math-keyboard.spec.ts](../../e2e/tests/math-keyboard.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [numeric-input.md](../../packages/help-content/docs/ja/numeric-input.md)、[command-line.md](../../packages/help-content/docs/ja/command-line.md)、[parameters.md](../../packages/help-content/docs/ja/parameters.md)。

**担当範囲・根拠:** 入力・数式。既存プレビュー/usage/診断へ情報を追加し原式の保存を維持。計算済みでない結果を断定しない。 設計実装2h + 個別検証1.5h + ヘルプ0.5h = 4h。

### R20 再現できる説明例とキーボード回帰

**対象と記号:** [packages/ui/src/commands/commandDefinitions.ts](../../packages/ui/src/commands/commandDefinitions.ts) の `commandDefinition`、[packages/ui/src/help/helpLibrary.ts](../../packages/ui/src/help/helpLibrary.ts) の `createHelpLibrary`、[packages/help-content/src/topics.ts](../../packages/help-content/src/topics.ts) の `HELP_TOPICS`。

**数値化した受入:** Tab/Enter/Esc/Delete/Undoの5キー×部品/組立/図面の3モードで15組、各入力欄の文字編集も保持。IME確定誤作動0。下絵「削除Undo」「削除保存」2例の文書/ZIPと本文一致。無効理由は全入口で文字表示、色だけ0。新操作も目録/章/UI名/撮影証拠の不整合0。

**既存検査と追加方法:** [packages/ui/src/commands/shortcutAssignments.test.ts](../../packages/ui/src/commands/shortcutAssignments.test.ts)、[packages/help-content/src/helpFeatureCoverage.test.ts](../../packages/help-content/src/helpFeatureCoverage.test.ts)、[packages/help-content/src/uiReferences.test.ts](../../packages/help-content/src/uiReferences.test.ts)、[e2e/tests/math-keyboard.spec.ts](../../e2e/tests/math-keyboard.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [shortcuts.md](../../packages/help-content/docs/ja/shortcuts.md)、[canvas.md](../../packages/help-content/docs/ja/canvas.md)、[sketch-tools.md](../../packages/help-content/docs/ja/sketch-tools.md)。

**担当範囲・根拠:** 説明・受入。既存ショートカット正本とヘルプ生成に最小操作列/期待保存文書を接続。下絵の復元と削除保存を別教材にする。 設計実装1.5h + 個別検証1.5h + ヘルプ1h = 4h。

### R21 測定と許容差の意味を分けて表示

**対象と記号:** [packages/kernel/src/occt/tolerances.ts](../../packages/kernel/src/occt/tolerances.ts) の `GEOMETRIC_CONFUSION_MM`、[packages/ui/src/solid/measureFormatting.ts](../../packages/ui/src/solid/measureFormatting.ts) の `formatVolume`、[packages/ui/src/solid/MeasurementSections.tsx](../../packages/ui/src/solid/MeasurementSections.tsx) の `MeasureSection`。

**数値化した受入:** 幾何1e-7mm/修復0.01mm/近似1e-6mmの3値不変。B-rep測定/三角形近似/修復隙間/表示丸めの4出所を取り違え0。mm/inch表示で設計値改変0。幾何一致値を製造や輸入全体の保証精度とする表現0。

**既存検査と追加方法:** [packages/kernel/src/occt/tolerances.test.ts](../../packages/kernel/src/occt/tolerances.test.ts)、[packages/ui/src/solid/MeasurementSections.test.ts](../../packages/ui/src/solid/MeasurementSections.test.ts)、[packages/ui/src/solid/measure.test.ts](../../packages/ui/src/solid/measure.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [measure.md](../../packages/help-content/docs/ja/measure.md)、[export.md](../../packages/help-content/docs/ja/export.md)、[import.md](../../packages/help-content/docs/ja/import.md)。

**担当範囲・根拠:** 交換・精度。既存3許容差を保持し測定・修復・表示の出所ラベルを追加。 設計実装1h + 個別検証0.75h + ヘルプ0.25h = 2h。

### R22 幾何の変換・尺度・交換・表示の受入データ

**対象と記号:** [packages/kernel/src/occt/tolerances.ts](../../packages/kernel/src/occt/tolerances.ts) の `GEOMETRIC_CONFUSION_MM`、[packages/kernel/src/occt/booleanOp.ts](../../packages/kernel/src/occt/booleanOp.ts) の `booleanOp`、[packages/model/src/exchange/exportPart.ts](../../packages/model/src/exchange/exportPart.ts) の `exportMeshQuality`、[packages/ui/src/viewport/buildSolidGeometry.ts](../../packages/ui/src/viewport/buildSolidGeometry.ts) の `buildSolidGeometry`。

**数値化した受入:** 箱/球/円柱3形×尺度1e-3/1/1e3×平行移動/回転/単位往復3変換=27条件。ほぼ接触Boolean3演算、薄面/短辺2例、STEP後体積/境界箱/面辺同一性を照合。適用する既存絶対・相対誤差を入力ごとに先に固定し緩和0。大座標0/1e6/1e9mmでdouble設計値とFloat32表示を別測定、画素誤差<=1pxを改善条件とし未達を隠さない。

**既存検査と追加方法:** [packages/kernel/src/occt/booleanOp.test.ts](../../packages/kernel/src/occt/booleanOp.test.ts)、[packages/kernel/src/occt/writeStep.test.ts](../../packages/kernel/src/occt/writeStep.test.ts)、[packages/kernel/src/occt/readStep.test.ts](../../packages/kernel/src/occt/readStep.test.ts)、[packages/ui/src/viewport/buildSolidGeometry.test.ts](../../packages/ui/src/viewport/buildSolidGeometry.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [measure.md](../../packages/help-content/docs/ja/measure.md)、[import.md](../../packages/help-content/docs/ja/import.md)、[export.md](../../packages/help-content/docs/ja/export.md)。

**担当範囲・根拠:** カーネル・精度。独立した幾何期待値と入力資料、実OCCT/STEP/描画境界を共通化。 設計実装2h + 個別検証3.5h + ヘルプ0.5h = 6h。

### R23 一続きの初回ガイドと利用者評価

**対象と記号:** [packages/ui/src/tutorial/tutorialActions.ts](../../packages/ui/src/tutorial/tutorialActions.ts) の `advanceTutorial`、[packages/ui/src/tutorial/TutorialPanel.tsx](../../packages/ui/src/tutorial/TutorialPanel.tsx) の `TutorialPanel`。

**数値化した受入:** 座標入力→厚みのパラメータ化→寸法変更→図面→STEP/STLの5段で保存文書と出力一致。中断再開で入力喪失0。初回利用者5人中4人以上が20分以内に完了、誤操作復帰中央値<=60秒、ヘルプ検索中央値<=3回を仮の評価目標にする。未実施をE2E成功で代替しない。端末外テレメトリ0。

**既存検査と追加方法:** [packages/ui/src/tutorial/tutorialActions.test.ts](../../packages/ui/src/tutorial/tutorialActions.test.ts)、[packages/ui/src/tutorial/tutorialProgress.test.ts](../../packages/ui/src/tutorial/tutorialProgress.test.ts)、[e2e/tests/tutorial.spec.ts](../../e2e/tests/tutorial.spec.ts)、[e2e/tests/electron-tutorial.spec.ts](../../e2e/tests/electron-tutorial.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [tutorial.md](../../packages/help-content/docs/ja/tutorial.md)。

**担当範囲・根拠:** 操作・ガイド。既存tutorialを5段の代表作業へ接続し、同意した初回利用者5人の観察枠を含む。参加調整待ちは別。 設計実装1.5h + 個別検証1.5h + ヘルプ1h = 4h。

### R24 四隅指定による下絵の平面射影補正

**対象と記号:** [packages/ui/src/viewport/canvasLayer.ts](../../packages/ui/src/viewport/canvasLayer.ts) の `canvasPixelPointOf`、[packages/model/src/sketch/canvas.ts](../../packages/model/src/sketch/canvas.ts) の `scaleFromTwoPoints`、[packages/ui/src/sketch/CanvasSection.tsx](../../packages/ui/src/sketch/CanvasSection.tsx) の `CanvasSection`。

**数値化した受入:** 独立した格子画像3例で四隅の誤差<=1px、内部9点の既知射影と一致。重複/3点共線/自己交差/非有限の4種を拒否。Undo/Redo/保存再開で元画像と補正条件一致。元画像は上書き0。実現不能時はR08の正面撮影/外部補正を提供して本項は未受入のまま残す。

**既存検査と追加方法:** [packages/ui/src/viewport/canvasLayer.test.ts](../../packages/ui/src/viewport/canvasLayer.test.ts)、[packages/model/src/sketch/canvas.test.ts](../../packages/model/src/sketch/canvas.test.ts)、[e2e/tests/canvas.spec.ts](../../e2e/tests/canvas.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [canvas.md](../../packages/help-content/docs/ja/canvas.md)。

**担当範囲・根拠:** 下絵・幾何。文案修正と別機能。既知4隅の射影、退化拒否、資産/Undo/再編集まで実装する場合の工数。 設計実装3h + 個別検証2h + ヘルプ1h = 6h。

### R25 OCCT再開時のコンパイル再利用

**対象と記号:** [packages/kernel/src/occt/loadOcct.browser.ts](../../packages/kernel/src/occt/loadOcct.browser.ts) の `loadOcctForBrowser`、[apps/web/src/pwa/offlineInventory.ts](../../apps/web/src/pwa/offlineInventory.ts) の `fetchOfflineInventory`、[apps/web/src/pwa/offlineServing.ts](../../apps/web/src/pwa/offlineServing.ts) の `loadPreparedOfflineResponder`、[wrangler.jsonc](../../wrangler.jsonc) の `assets`。

**数値化した受入:** 依存追加0を第一案。圧縮13,859,568bytes/展開50,305,130bytesの現設計値を再計測しSHA一致、HTTP MIME/Encoding/同一配信元CSP検査。Chrome/Firefox/Electron×オンライン/オフライン/再開5回で段階時間を採取、warm中央値cold比20%以上減を採用目標。Worker2本のメモリ/CPU、総資産<=1000・各<=25MiBを確認。ADD-23/半球/ADD-17で結果・既存期限維持。

**既存検査と追加方法:** [packages/kernel/src/occt/loadOcct.node.test.ts](../../packages/kernel/src/occt/loadOcct.node.test.ts)、[apps/web/src/pwa/offlineInventory.test.ts](../../apps/web/src/pwa/offlineInventory.test.ts)、[apps/web/src/pwa/offlineServing.test.ts](../../apps/web/src/pwa/offlineServing.test.ts)、[e2e/tests/function-plot.spec.ts](../../e2e/tests/function-plot.spec.ts)、[e2e/tests/electron-function-plot.spec.ts](../../e2e/tests/electron-function-plot.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [startup-checks.md](../../packages/help-content/docs/ja/startup-checks.md)、[offline-use.md](../../packages/help-content/docs/ja/offline-use.md)、[web-version.md](../../packages/help-content/docs/ja/web-version.md)。

**担当範囲・根拠:** カーネル・配信。既存設計の実HTTP採用試験2h、glue接続/配信・オフライン形式/メモリ/3環境の比較6h。権限待ちは別。 設計実装4h + 個別検証3h + ヘルプ1h = 8h。

### R26 遅い機械での画面受入の再現

**対象と記号:** [packages/ui/src/math/browserMathWorker.ts](../../packages/ui/src/math/browserMathWorker.ts) の `createBrowserMathWorker`、[packages/test-utils/src/releasePerformance.ts](../../packages/test-utils/src/releasePerformance.ts) の `reportDuration`、[e2e/tests/function-plot.spec.ts](../../e2e/tests/function-plot.spec.ts) の `test`。

**数値化した受入:** 通常/低速の2条件×3環境で各1回以上、元入力・答え・保存・取消一致。要求の倍率1/中間/4と範囲外2例の単体境界維持、準備/計算/待機を分けて計測。意図した低速実行でも既存の150秒再計算待機・各シナリオ期限を勝手に延長0。実機低速が用意できなければ再現未確認と残す。

**既存検査と追加方法:** [packages/ui/src/math/browserMathWorker.test.ts](../../packages/ui/src/math/browserMathWorker.test.ts)、[packages/test-utils/src/releasePerformance.test.ts](../../packages/test-utils/src/releasePerformance.test.ts)、[e2e/tests/function-plot.spec.ts](../../e2e/tests/function-plot.spec.ts)、[e2e/tests/math-keyboard.spec.ts](../../e2e/tests/math-keyboard.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [startup-checks.md](../../packages/help-content/docs/ja/startup-checks.md)。

**担当範囲・根拠:** 統括・検証。実処理・段階時間・機械速度倍率の観測を3環境へ接続。CPU絞りを通常試験へ戻す設計にしない。 設計実装1h + 個別検証1.5h + ヘルプ0.5h = 3h。

### R27 diag wait重複の実コマンド証拠を照合

**対象と記号:** [.claude/hooks/chained_diag_wait_guard.py](../../.claude/hooks/chained_diag_wait_guard.py) の `count_diag_wait_segments`、[scratchpad/claude/tools/diag.py](../../scratchpad/claude/tools/diag.py) の `wait`。

**数値化した受入:** 2026-10-01 cl-v102-calc-deadlineの実argv/時刻/実行環境/終了値の4点を照合。1待機許可・連鎖2待機拒否の対照を統括が確認。証拠未発見なら件数0と未解明を保持し新guard追加0。CodexでClaude hookが自動適用されるとの断定0。

**既存検査と追加方法:** [.claude/hooks/chained_diag_wait_guard.selftest.py](../../.claude/hooks/chained_diag_wait_guard.selftest.py)、[scratchpad/claude/tools/diag.selftest.py](../../scratchpad/claude/tools/diag.selftest.py)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** 利用者操作の変更なし。道具の報告と運用説明だけを統括が更新する。

**担当範囲・根拠:** 統括・道具。旧失敗の記録検索、現hook登録と実argv照合。証拠未発見のまま新仕組みを作る費用は含めない。 設計実装0.25h + 個別検証0.5h + ヘルプ0.25h = 1h。

### R28 portable_realcheck -Twinの実機確認

**対象と記号:** [scratchpad/claude/tools/portable_realcheck.ps1](../../scratchpad/claude/tools/portable_realcheck.ps1) の `Twin`、[apps/desktop/src/main/portableExtraction.mjs](../../apps/desktop/src/main/portableExtraction.mjs) の `nsisExtractionDirectory`。

**数値化した受入:** 2窓同時、片方終了時に他方生存、各展開先だけ30秒以内消失。PID/絶対パス対応2/2、取り違え0、EncodedCommand0、Defender対象検出0。実候補SHA/実機ログ/終了コードを保存。過去の単体61成功を実機成功と読み替えない。

**既存検査と追加方法:** [apps/desktop/src/main/noEncodedPowerShell.test.ts](../../apps/desktop/src/main/noEncodedPowerShell.test.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [desktop-install.md](../../packages/help-content/docs/ja/desktop-install.md)。

**担当範囲・根拠:** 統括・公開。次候補の本物のportable2窓を実行しPID/展開先/終了順の取り違えを検証。公開工程と重複計上しない。 設計実装0.25h + 個別検証0.5h + ヘルプ0.25h = 1h。

### R29 Shift/Ctrlで選んだ既存2点を右クリックから接続

**対象と記号:** [packages/model/src/sketch/types.ts](../../packages/model/src/sketch/types.ts) の `PointReference`、[packages/ui/src/sketch/sketchCommands.ts](../../packages/ui/src/sketch/sketchCommands.ts) の `commitSketchInput`、[packages/ui/src/viewport/attachSketchInteraction.ts](../../packages/ui/src/viewport/attachSketchInteraction.ts) の `pickInto`、[packages/ui/src/store/selectionSlice.ts](../../packages/ui/src/store/selectionSlice.ts) の `toggleSelection`、[packages/ui/src/commands/radialCommandItems.ts](../../packages/ui/src/commands/radialCommandItems.ts) の `radialCommandIds`、[packages/ui/src/commands/attachRadialMenuGesture.ts](../../packages/ui/src/commands/attachRadialMenuGesture.ts) の `attachRadialMenuGesture`。

**数値化した受入:** Shift/Ctrl各々で異なる既存点2個を選び「2点をつなげる」1回でline+1、point+0、Undo履歴+1。両端はpointId参照+相対0で保存、点移動→線追従、保存再開/Undo1/Redo1一致。0/1/3点・点以外混在・同一点・同座標・未解決点の7無効分類で変更0。右静止クリックだけメニュー、右ドラッグ100移動でpan可・誤作成0。IME/文字入力/通常選択/取消・文書切替で旧選択実行0。既存の選択点数と無効理由を表示。

**既存検査と追加方法:** [packages/ui/src/sketch/sketchCommands.test.ts](../../packages/ui/src/sketch/sketchCommands.test.ts)、[packages/ui/src/store/selectionSlice.test.ts](../../packages/ui/src/store/selectionSlice.test.ts)、[packages/ui/src/viewport/attachSketchInteraction.test.ts](../../packages/ui/src/viewport/attachSketchInteraction.test.ts)、[packages/ui/src/viewport/cameraSketchInteraction.test.ts](../../packages/ui/src/viewport/cameraSketchInteraction.test.ts)、[packages/ui/src/commands/attachRadialMenuGesture.test.ts](../../packages/ui/src/commands/attachRadialMenuGesture.test.ts)、[packages/ui/src/commands/radialCommandItems.test.ts](../../packages/ui/src/commands/radialCommandItems.test.ts)、[e2e/tests/sketch-intersections.spec.ts](../../e2e/tests/sketch-intersections.spec.ts)、[e2e/tests/radial-menu.spec.ts](../../e2e/tests/radial-menu.spec.ts)。本項の反例・境界を追加し、変更前に失敗する対照と修正後成功を残す。UIに関わる項目は統括がChromium・Firefox・実Electronで確認する。

**ヘルプ:** [sketch-tools.md](../../packages/help-content/docs/ja/sketch-tools.md)、[selection.md](../../packages/help-content/docs/ja/selection.md)、[radial-menu.md](../../packages/help-content/docs/ja/radial-menu.md)、[shortcuts.md](../../packages/help-content/docs/ja/shortcuts.md)。

**担当範囲・根拠:** スケッチ・操作。既存PointReferenceとlineを使い選択・右ボタン・コマンド・保存/Undoを接続。小さな便利機能は選択点数と無効理由の表示を含む。 設計実装2h + 個別検証1.5h + ヘルプ0.5h = 4h。

## 5. 追加機能の実装契約と検査の共通条件

R29では、選択モードの左押下で `shiftKey || ctrlKey` を追加/解除の意図として扱い、そのとき既存点のドラッグを開始しない。現在の `attachSketchInteraction` の `beginDragAt` 前と `pickInto` の両方を揃える。右クリックで選択を単一の点へ置き換えない。修飾キーを離して右クリックする通常経路を必須にし、押し続けた場合も2点接続の操作だけは使用できるように入力所有権を定める。既存のAlt/中ボタン/右ドラッグは保持する。

実行時に現在文書・選択した2ID・解決済み点を再検証し、両端とも既存の `PointReference` の `kind: 'point', pointId` を持つ相対座標（dx/dy/dz=0）として `line` を追加する。新しい座標点は作らない。2点が同一平面ならその平面、異なる平面なら既存の自由作図面契約を使用し、世界座標を点の複製として保存しない。操作結果は一度だけ `applyDocument` 相当の既存履歴経路へ渡す。コマンド名「2点をつなげる」は日本語文言正本に登録し、コマンドの有効判定と実行時判定を共用する。既存の右クリック8方向の既定割当は保持し、2点選択時の文脈操作を既存メニュー内に追加する。固定パネルは増やさない。

便利機能は、選択した点数（2/2）、使えない理由、候補参照の強調、パラメータ検索、保存段階、出力前の精度確認、保存点比較、初回ガイドとしてR03/R06/R12/R15/R16/R17/R19/R23/R29に含めた。別名の空の項目を増やして完成件数を水増ししない。

検査は次の順で統括が実施する。本担当は製品検査を実行していない。

1. 対象の存在・公開API・全利用先・文言・入力資料を先に照合。反例を既存テストへ固定し、修正前の失敗を残す。全型/lintを通してから変更パッケージの全単体と必要な下流パッケージへ進む。
2. 実UIの受入はChromium/Firefox/実Electronで、A→B文書切替、下絵削除追加Undo、曖昧参照更新、混在Delete、大容量保存、IME/焦点/キー競合、R29点接続を全て含む。実行前世代を控え、最新世代の成功で待機を終える。模擬decoderや実関数だけでは画面の成功にしない。
3. 基準は要件§5.2を保持する。描画最低10fps（改善30/60fps）、典型処理2,500ms（目標500ms）、100段/図面25秒（目標5秒）、寸法移動100ms（目標16ms）、中止表示1秒（目標200ms）、再計算待機150秒。個別の数学・自動作図の有限期限を一般の待機枠へ置き換えない。新規提案のp95等は新しい改善受入であり、既存要件の緩和ではない。
4. UI・製品の凍結後に全画像を撮り直す。現行232枚は基準数であり、新規操作の画像が増えれば正本の実数で照合する。現行110章・7巻も同様。全画像の登録・参照・ハッシュ・凍結一致、HTML/PDF生成と変更ページ目視を必要とする。本担当が画像を開いたとは記録しない。
5. 統括の正規入口で `gate --scope local`、同じSHAのWindows/Ubuntu全CI、同じ候補の配布CI（通常CIと同時開始可）、実配布物・実機・公開後確認、main統合後CIを確認する。成功した旧SHA・旧版・試行途中・模擬自己試験は代用不可。失敗を同条件反復で消さず、失敗原因と変更後の再確認を残す。古い `--scope full` 反復を前提に見積もらない。

レビューの1,116単体成功・型/lint・110章/232画像整合は過去の対象内容の証拠であり、今回の改善の合格数ではない。PDF全ページ・実プリンター・GPU/DPI差・Linux実機・全交換形式の他社往復などの未検証範囲も残す。全形式の認証や「バグなし」は目標90点とは別の主張になる。

## 6. 工数の積上げと24時間/30時間との差

単位は時間。単一の担当が順に進める計画上の占有時間（設計・実装・検査・結果確認を含む）であり、実測納期や自動的な完了時刻ではない。29項目の原票は設計実装・個別検証・ヘルプの3欄を別集計し、共通ゲートは下で1回だけ加算した。Cloudflare/GitHub権限・利用者評価の参加調整・未知の依存交換・利用枠停止の待ち時間はゼロと仮定せず **外部待ちW** として別加算する。

|工程|1回成功|主要検証が1回失敗|根拠と増分|
|---|---:|---:|---|
|受付・対象確定・入力資料固定|1|1|今回の台帳を候補差分へ照合し所有者/入力を固定|
|正確性8項目|26.5|26.5|R01/R02/R03/R04/R10/R11/R21/R22の積上げ|
|操作9項目|22|22|R05/R08/R09/R17/R19/R20/R27/R28/R29|
|応答性4項目|27|27|R06/R07/R25/R26、転送・寿命・配信の別境界を含む|
|機能改善8項目|44|44|R12/R13/R14/R15/R16/R18/R23/R24|
|統合差分・全利用先・証拠レビュー|1.5|1.5|原票29行と候補内容の全件照合|
|版・README・案内の整合|0.5|0.5|引継ぎ§6.6の実績目安|
|全画像撮り直し・説明書生成・目視|2|4|引継ぎ§5.4/§6.6の目安2h。製品修正後の再凍結で+2h|
|軽いlocalゲート|1.5|3|準備含む1.5h、修正後の再実行+1.5h|
|同SHA両OS CI＋配布CI|1.5|3|同時進行する両系統の長い方。再送後+1.5h|
|配布物/実機/公開前後確認|0.5|0.5|R28のTwin試験費用をここへ二重計上しない|
|main再確認・統合・CI|2.5|2.5|引継ぎ§6.6。未実施の工程を「やり直し」に数えない|
|独立再レビュー|2|2|同配点の根拠・反例・実UI結果を別担当者が評価する枠|
|失敗ログ解析・原因修正|0|2|主要CIで実装不備1件が判明した想定。未知の全面設計変更を含めない|
|修正範囲のstatic/回帰確認|0|1|修正前反例＋変更パッケージ/下流を再確認|
|最終記録|0.5|0.5|受入/残件/見込み/指紋|
|**合計**|**133 + W**|**141 + W**|1回の主要失敗は+8h。29項目の小計119.5h、共通工程13.5h|

統括の暫定24h/30hとの差は、直列比較で **+109h/+111h**。単に安全率をかけたものではない。24h側で共通公開工程13.5hを同じく確保すると実装・個別検証に残るのは10.5hで、原票119.5hとの差109hがある。主要失敗も、製品変更後の全画像再撮影2hと再ゲート1.5h・再CI1.5h、原因修正2h・局所確認1hの計8hを要し、暫定の追加6hより2h多い。

もし統括が別途3名で同時実装する体制を選ぶ場合も、原票119.5人時÷3=39.83h、共通工程13.5hを足す**理想下限は53.33h + W**。これは待ちを独立作業へ完全に隠せる楽観下限で、R02→R04→R06→R16、R01→R17→R18、R20→R26→R25、R12/R19→R13などの依存、共有ファイルの占有、画面検査・撮影の排他を加える前の数値。したがって24hを全提案完了の約束にしない。本担当は子を起こさず、将来の並列実行を承認したことにもならない。

先行Desktop版を切る場合は、受入が済んだ正確性と必須操作だけを候補に固定し、残りのIDを次版へ明示的に残す。全提案を終えた／90点を達成したとは言わない。R18/R24の採用見送りやR25の権限未取得は工数を黙って0へする理由にならず、残件として再見積もる。

## 7. 90/100の判定方法

レビューと同じ10項目、同じ配点で評価する。下の各90点は必要な証拠を整えるための目安であり予測点でも今回の自己採点でもない。

|評価項目|元点|配点|再評価で主に見る証拠|計画上の目安|
|---|---:|---:|---|---:|
|コード品質|78|10|R02/R07/R10の所有権・失敗経路・型境界|90|
|アーキテクチャ|80|10|R03/R06/R07の寿命とWorkerの分離・逆依存0|90|
|可読性・保守性|70|10|5大関数の責務・境界比較・不要なタスク説明整理|90|
|幾何・機能の正確性|60|20|R01/R18/R21/R22/R29の独立した実幾何と参照同一性|90|
|編集・保存の信頼性|55|10|R02〜R04/R06/R10/R16の操作列・実ファイル|90|
|検証基盤|83|10|新反例の修正前失敗、負の対照、3環境・同SHA両OS|90|
|パフォーマンス|65|10|R06/R07/R25/R26の実入力・メモリ・全標本|90|
|セキュリティ・入力の堅牢性|78|10|画像残存0、abort、現時点監視/SBOM/同梱資産、CSP保持|90|
|説明書・ヘルプとの整合|80|5|R08/R09/R20・全章/画像の凍結整合と実操作|90|
|UI・UX|72|5|R05/R12/R17/R19/R23/R29、初回利用者の評価|90|
|加重目安|70.5|100|Σ(点×配点)/100。丸め前の値で>=90を確認|90|

統括は根拠一式を候補SHAへ固定し、実装担当の自己採点とは独立した再レビューを依頼する。今回の「子エージェントを起こさない」は本担当に適用し、この調査内で別評価者を起こさない。再評価者が不足や反例を見つければ項目を未受入へ戻す。レビューの37主要出典単位の対応漏れ0、実在しない参照0、根拠のない完了宣言0を出発条件にし、点だけを満たすための除外・閾値変更・未実施を成功化する処理は禁止する。

## 8. 依存・Cloudflare・証拠待ちの採用条件と代替

|対象|採用の前に具体的に示すもの|成立しない場合の代替・残件|
|---|---|---|
|新しいCSV/射影/保存ライブラリ|既存依存と標準APIで不足する機能、固定版/ライセンス/SBOM/配布増分/Worker・CSP互換、全入力境界と往復、依存変更範囲。必要性を説明して利用者の依存変更許可を得る。今回の担当には変更権限なし|現行fflate等と既存の式・行列機能/標準APIを使う。足りなければR13/R24の具体的仕様を保留し文書と安全な既存経路を提供。lock/vendorは触らない|
|R25 compileStreaming|既存設計のHTTP応答で圧縮14MB級資産を正しいContent-Encoding/MIMEで配信し、**展開後の内容ハッシュ確認を終えるまで実体化・利用しない**。オフライン応答とapp://を含む3環境のcold/warm、Worker2本のメモリ、既存glueのinstantiateWasm接続を実証|ModuleのIndexedDB保存は既存調査のDataCloneErrorにより不採用。現行gzip展開+ハッシュ+wasmBinaryへ戻し同一ページ再利用を保持。ブラウザー実装依存のコードキャッシュを永続保証しない|
|Cloudflare権限・Web公開|統括がWorkers編集権限を安全な秘密管理へ設定。秘密は報告/argv/ログに出さない。実サービスpointercad・ヘッダー・各25MiB/1000件・COOP/COEP/CSP・オフライン版の整合を実測。Pages表記とWorkers設定は統括が要件/案内に一貫して反映|権限なしではローカル契約検査だけを準備し実配信未検証と残す。Desktopは現行ローダーで進める。Webの公開後検査の未実装・終了コード3を成功に読み替えない。Web公開全体は別工程|
|R11 Dependabot失敗・アラート|統括がGitHubから失敗runとalertsを読取り取得し、update_filesの入力/失敗理由/設定を照合。依存更新案なら上の採用証拠と許可が必要|GitHub権限がない場合は静的設定照合に限定し「未取得」を保持。更新を自動マージしない。現時点の脆弱性0を宣言しない|
|R18 OCCT履歴API|固定版で生成・変更・削除履歴の実取得と5操作の参照同一性。バインディング追加や再ビルドが必要なら配布・許諾・ABI・既存形状の結果・検査時間を示して判断|R01の曖昧拒否とR17の修復を維持。本格履歴追跡は未受入で残す|
|R27/R28|waitは当時の実コマンド証拠、Twinは次候補の本物の2窓とPID/実展開先の記録|waitは証拠前に新しいguardを作らない。Twinは既存修正済みとの報告だけで閉じない|

新しい数値上限（R06/R13/R14/R16/R23/R24/R25）は本計画の提案値。実装時に境界の理由と使用環境を確認して統括が要件へ反映する。既存の正確性や時間条件を下げる承認ではない。

## 9. 全失敗見出しの照合と新旧規約

[全件照合表](../../scratchpad/claude/agents/cx-v103-review-inventory/failure-crosswalk.md)に379見出し（番号1〜375、重複見出し4件）を省略なく載せた。構造見出し・記入テンプレートは事例件数に入れない。資源寿命・保存・非同期、選択・焦点・右ボタン、独立数値期待値、型/公開境界、性能計測、説明の実体、git/配布の隔離、検証の完全性、担当範囲の9分類で機械対策へ対応する。これは過去の全不具合を今回再検証したという意味ではない。

|競合する記述|今回の判断・根拠|
|---|---|
|旧「統括Claude」・調査は委譲／commonの部分読了|最新の個別指示で本担当は全規約読了・単独調査。統括がCodexへ移っても、本担当に統括権限は付与されない。子起動0|
|報告記録やrules/06へ直接追記する一般手順|個別の編集許可2か所が優先。進捗/失敗/指紋は担当dirへ、製品/shared規約/gitへ書かない|
|旧ローカルFull・全E2E反復|9/27〜10/1の利用者指示と引継ぎにより統括のlocal＋同SHA両OS全CI。今回の明示禁止により本担当はそれ自体も起動しない|
|旧16ms/500ms/30fpsや5秒単体を即不合格とする事例|要件§5.2の現行実用上限と元の改善目標を併記。精度や入力制限は保持。§10.162〜164/208/313等の変更経緯を現行値へ読み替える|
|古い.gitやプロジェクト外へ補助ファイルを置く対策|後の§10.173と個別許可を優先し担当dirのみ。gitの自己試験も今回は起動しない（§10.151/210の事故）|
|「推奨通り進める」包括指示と依存更新・Cloudflare操作|今回の「独断で依存を変えない」「製品・依存・git変更禁止」が担当には優先。統括は必要な実権限・具体的採用証拠を確認し、未取得を承認扱いしない|
|遅い機械・時間切れなら再実行という引継ぎ要約|遅さは観測して分類する。§10.316/177/208等に従い、timeoutだけで環境原因と断定せず原ログと段階を確認。再成功だけを原因解消にしない|

本調査中の手戻りも残す。初回の文字コード指定不足、広い見出し検索の出力過大、推測した入力部品ディレクトリの不存在、文書生成の前提ファイル未作成、行全体に一致しないパッチの適用拒否を検出した。製品を変更せず、UTF-8小分け再読・実ファイル一覧・全参照の起動前照合・生成順序の固定でやり直した。参照チェックの失敗を製品失敗や製品合格に数えない。

進捗記録には02:28→02:46の18分間隔が1回あり、個別指示の15分以内を満たせなかった。遡及した時刻で補記せず、検証記録へ違反を残す。台帳の対応漏れ0と、今回の作業規律の全条件成立は区別する。補助の読取り・生成の入口へ12分で停止する進捗確認を接続し、以後の追記漏れを検出する。ただしツールが呼ばれない間の自動追記や会話継続を保証するものではない。

完了の認定は、台帳ID・具体的差分・反例/正常例・同SHAの検査・実UI・ヘルプ・独立採点がそろってから統括が行う。この提出で完了するのは調査台帳と照合記録だけである。
