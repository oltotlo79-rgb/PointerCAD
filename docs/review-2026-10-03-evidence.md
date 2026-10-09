# PointerCAD 2026-10-03レビューの検証記録

[評価・不具合・修正案・競合比較の本文](review-2026-10-03-pointercad.md)

## 対象と最終照合

- HEAD: `fb44ef2e3521bf792fd551c28d304cf307a064a4`
- ソース棚卸し時刻（UTC）: 2026-10-03T08:47:38.961Z
- ハッシュ再照合時刻（UTC）: 2026-10-03T09:24:19.756Z
- ソース照合: 1529件。内容が変化・消失したファイル: 0件。
- ソース行数: 257,848行（空行・コメントを含む）。テストを除いたpackages/appsのsrcが対象。
- 棚卸ししたテストファイル: 1181件。全件を実行したという意味ではない。
- 構文診断: 0件。型・lintの結果は下表に別記。
- ハッシュの原記録: [source-hashes.json](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/source-hashes.json)、[source-recheck.json](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/source-recheck.json)。
- 開始時から存在するdocs/報告記録.mdの変更は本調査で触っていない。HEADの切替、ステージング、コミットはしていない。
- 提出する2つのMarkdownの最終SHA-256は[final-files.sha256](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/final-files.sha256)に記録した。本文中に自分自身のハッシュを埋め込む循環を避け、別ファイルで管理する。

## 実行した検査

単体: **56ファイル・1,116件成功**。この件数に独立プローブを加算していない。所要時間はdiag.pyの結果記録で、Vitest本体だけの時間とは異なる。

| RUN_ID | 種別 | 成功ファイル / テスト | 終了コード | 秒 |
|---|---|---:|---:|---:|
| [20261003-174825-audit-20261003-help-unit](../scratchpad/claude/runs/20261003-174825-audit-20261003-help-unit/output.log) | vitest:help-content | 6 / 73 | 0 | 2.719 |
| [20261003-175247-audit-20261003-io-unit](../scratchpad/claude/runs/20261003-175247-audit-20261003-io-unit/output.log) | vitest:io | 6 / 137 | 0 | 16.328 |
| [20261003-175247-audit-20261003-ui-unit](../scratchpad/claude/runs/20261003-175247-audit-20261003-ui-unit/output.log) | vitest:ui | 10 / 164 | 0 | 24.89 |
| [20261003-180038-audit-20261003-desktop-unit](../scratchpad/claude/runs/20261003-180038-audit-20261003-desktop-unit/output.log) | vitest:desktop | 8 / 76 | 0 | 3.078 |
| [20261003-180038-audit-20261003-expression-unit](../scratchpad/claude/runs/20261003-180038-audit-20261003-expression-unit/output.log) | vitest:expression | 4 / 127 | 0 | 7.359 |
| [20261003-180038-audit-20261003-model-unit](../scratchpad/claude/runs/20261003-180038-audit-20261003-model-unit/output.log) | vitest:model | 7 / 222 | 0 | 13.516 |
| [20261003-180437-audit-20261003-canvas-unit](../scratchpad/claude/runs/20261003-180437-audit-20261003-canvas-unit/output.log) | vitest:ui | 4 / 74 | 0 | 11.125 |
| [20261003-180437-audit-20261003-drawing-unit](../scratchpad/claude/runs/20261003-180437-audit-20261003-drawing-unit/output.log) | vitest:drawing | 5 / 86 | 0 | 2.406 |
| [20261003-180437-audit-20261003-kernel-unit](../scratchpad/claude/runs/20261003-180437-audit-20261003-kernel-unit/output.log) | vitest:kernel | 6 / 157 | 0 | 32.391 |
| [20261003-181937-audit-20261003-final-static](../scratchpad/claude/runs/20261003-181937-audit-20261003-final-static/output.log) | typecheck, lint | — | 0 | 169.563 |

型・lintは製品と設定の現状確認であり、本文に示した未適用の修正コード案を検査したものではない。OCCTの壊れたSTEP入力を扱う試験では診断文字列がログに出るが、上記の結果はテストランナーの終了コードと成功件数から集計した。

### 再実行コマンド

以下はリポジトリのルートで実行する。所定のdiag.pyが終了した結果まで確認する。各RUNのcommand.jsonに実際のargvと環境、result.jsonに終了時刻・結果がある。

```powershell
python -B -X utf8 scratchpad/claude/tools/diag.py unit --owner audit-20261003-help --package help-content src/topics.test.ts src/manualManifest.test.ts src/helpFeatureCoverage.test.ts src/uiReferences.test.ts src/navigation.test.ts src/searchIndex.test.ts
```

```powershell
python -B -X utf8 scratchpad/claude/tools/diag.py unit --owner audit-20261003-io --package io src/pcad/readArchive.test.ts src/pcad/readArchiveAllocation.test.ts src/pcad/zipPasses.test.ts src/threemf/writeThreeMf.test.ts src/threemf/readThreeMf.test.ts src/autoSave.test.ts
```

```powershell
python -B -X utf8 scratchpad/claude/tools/diag.py unit --owner audit-20261003-ui --package ui src/file/saveConcurrency.test.ts src/file/openDocumentGuard.test.ts src/file/desktopCloseGuard.test.ts src/file/fileGateway.test.ts src/store/documentRequest.test.ts src/viewport/cameraMath.test.ts src/viewport/cameraSketchInteraction.test.ts src/viewport/namedCamera.test.ts src/commands/shortcutAssignments.test.ts src/drawing/dimensionCommands.test.ts
```

```powershell
python -B -X utf8 scratchpad/claude/tools/diag.py unit --owner audit-20261003-desktop --package desktop src/main/sessionPermissions.test.ts src/main/pcadIpcSecurity.test.ts src/main/offlineProtocol.test.ts src/main/mainSecurity.test.ts src/main/appSender.test.ts src/main/appProtocol.test.ts src/main/closeGuard.test.ts src/main/closeGuardWiring.test.ts
```

```powershell
python -B -X utf8 scratchpad/claude/tools/diag.py unit --owner audit-20261003-expression --package expression src/lengthUnits.test.ts src/math/mathRequestDeadline.test.ts src/math/mathDistributionDeadline.test.ts src/math/geometryCalculationDeadline.test.ts
```

```powershell
python -B -X utf8 scratchpad/claude/tools/diag.py unit --owner audit-20261003-model --package model src/measure/strengthInputs.test.ts src/measure/strengthCalculation.test.ts src/measure/mathGeometry.test.ts src/drawing/dimensionTarget.test.ts src/drawing/dimensionAngle.test.ts src/units/length.test.ts src/sketch/canvas.test.ts
```

```powershell
python -B -X utf8 scratchpad/claude/tools/diag.py unit --owner audit-20261003-canvas --package ui src/store/canvasSlice.test.ts src/file/canvasFile.test.ts src/viewport/canvasLayer.test.ts src/security/contentSecurityPolicy.test.ts
```

```powershell
python -B -X utf8 scratchpad/claude/tools/diag.py unit --owner audit-20261003-drawing --package drawing src/dimension/format.test.ts src/dimension/tolerance.test.ts src/dimension/arcLengthGeometry.test.ts src/render/toPdf.test.ts src/render/pdfWriter.test.ts
```

```powershell
python -B -X utf8 scratchpad/claude/tools/diag.py unit --owner audit-20261003-kernel --package kernel src/occt/booleanOp.test.ts src/occt/writeStep.test.ts src/occt/readStep.test.ts src/occt/tolerances.test.ts src/occt/matchSubShape.test.ts src/occt/makeProjection.test.ts
```

```powershell
python -B -X utf8 scratchpad/claude/tools/diag.py static --owner audit-20261003-final
node scripts/manual/captureRegistry.mjs check
node scripts/manual/verify.mjs manual-v102-20261001-215403
```

## 独立プローブ

実プロダクトを修正せず、実関数または実ファイルから抽出した処理を呼び出した。模擬化の範囲は本文各項目を参照。UI/E2Eの合格証拠ではない。

| スクリプト | 結果 | 用途 |
|---|---|---|
| [probe.mjs](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/probe.mjs) | [probe-results.json](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/probe-results.json) | F01/F05、保存ストリーム例外の観察 |
| [canvas-probe.mjs](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/canvas-probe.mjs) | [canvas-probe-results.json](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/canvas-probe-results.json) | F02/F03/F04 |
| [performance-probe.mjs](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/performance-probe.mjs) | [performance-probe-results.json](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/performance-probe-results.json) | F06。合成データの同期圧縮 |

```powershell
node scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/probe.mjs
node scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/canvas-probe.mjs
node scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/performance-probe.mjs
```

### 実験の手戻り

最初の図面削除プローブはdrawingだけをsetStateし、Undoスタックを初期化していなかった。その結果、専用削除ボタン経路も文書更新できない不適切な前提になった。これは製品の不具合として採用していない。実際のopenDrawingと正しい表データで初期化して再実行し、共通Deleteは削除されず、専用削除は成功することを確定した。
初回結果は[probe-initial-invalid-drawing-fixture.json](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/probe-initial-invalid-drawing-fixture.json)として残した。その他、探索で実在しないファイル名やPowerShellで展開されないパスglobに当たったものは、実ファイル一覧から読み直し、検索失敗を機能不存在の根拠には使っていない。

再発防止の下書き: 「起きたこと: 検査用文書の初期化不足／原因: ストアの文書フィールドだけを直接代入／対策: 実操作のopenDrawingを使う／確認: 専用削除の対照ケースが成功し、削除後の要素数が0になることを先に確認」。製品規約・共有の失敗記録には今回書き込んでいない。

## ヘルプ・生成済み説明書

実行結果: [manual-verification.json](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/manual-verification.json)、[capture-check-final.json](../scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/capture-check-final.json)。

```json
{
  "manualBuildId": "27e35a6dc73e1e1d62361a707cf4a455ab690c87aa615b493141bf8bcfe34c76",
  "chapters": 110,
  "images": 232,
  "contentMatchesCurrentHelp": true,
  "releaseCertified": false
}
```

下表の「構造一致」は、現在の目録・章内容・登録画像と生成済みHTMLを機械照合した意味である。リンク先の全手順を実画面で成功させたという意味ではない。「個別の重点確認なし」の章も、機能が正常という認定ではない。

| # | 巻 | 章 | 全章共通の照合 | 個別の重点確認 |
|---:|---|---|---|---|
| 1 | getting-started | [デスクトップ版の導入・更新・削除](../packages/help-content/docs/ja/desktop-install.md) | 構造一致 | 個別の重点確認なし |
| 2 | getting-started | [Web版をブラウザーで使う](../packages/help-content/docs/ja/web-version.md) | 構造一致 | 個別の重点確認なし |
| 3 | getting-started | [起動しない・3D表示が出ないとき](../packages/help-content/docs/ja/startup-checks.md) | 構造一致 | 個別の重点確認なし |
| 4 | getting-started | [初めての作図](../packages/help-content/docs/ja/tutorial.md) | 構造一致 | 個別の重点確認なし |
| 5 | getting-started | [画面を回す・動かす・拡大する](../packages/help-content/docs/ja/viewport.md) | 構造一致 | 視点ロジックの対象試験。実画面は未検証 |
| 6 | getting-started | [ヘルプを探す・説明の続きを読んで戻る](../packages/help-content/docs/ja/help-reader.md) | 構造一致 | 個別の重点確認なし |
| 7 | getting-started | [ショートカット一覧](../packages/help-content/docs/ja/shortcuts.md) | 構造一致 | 割当の対象試験。実IME/フォーカスは未検証 |
| 8 | getting-started | [単位を変える(ミリメートルとインチ)](../packages/help-content/docs/ja/units.md) | 構造一致 | 長さ単位の対象試験 |
| 9 | getting-started | [保存する・開く](../packages/help-content/docs/ja/save-and-open.md) | 構造一致 | 保存/競合の実関数・単体試験 |
| 10 | getting-started | [ひな形を使う](../packages/help-content/docs/ja/template.md) | 構造一致 | 個別の重点確認なし |
| 11 | getting-started | [読み込む(ほかのソフトの形を取り込む)](../packages/help-content/docs/ja/import.md) | 構造一致 | 個別の重点確認なし |
| 12 | getting-started | [書き出す(ほかのソフトへ渡す)](../packages/help-content/docs/ja/export.md) | 構造一致 | STEP/3MF・保存経路の対象試験 |
| 13 | getting-started | [DXF を読み書きする](../packages/help-content/docs/ja/dxf.md) | 構造一致 | 個別の重点確認なし |
| 14 | getting-started | [印刷する・別名で保存する](../packages/help-content/docs/ja/print-save-as.md) | 構造一致 | 個別の重点確認なし |
| 15 | getting-started | [通信なしで使う準備と更新](../packages/help-content/docs/ja/offline-use.md) | 構造一致 | 個別の重点確認なし |
| 16 | getting-started | [作図したデータの保存場所と通信](../packages/help-content/docs/ja/local-data.md) | 構造一致 | 個別の重点確認なし |
| 17 | sketch-and-functions | [数値と式の入れ方](../packages/help-content/docs/ja/numeric-input.md) | 構造一致 | 個別の重点確認なし |
| 18 | sketch-and-functions | [構造化した数式と係数を入力する](../packages/help-content/docs/ja/math-input.md) | 構造一致 | 個別の重点確認なし |
| 19 | sketch-and-functions | [数学記号と演算の一覧](../packages/help-content/docs/ja/math-symbols.md) | 構造一致 | 個別の重点確認なし |
| 20 | sketch-and-functions | [名前を付けた数値(パラメータ)](../packages/help-content/docs/ja/parameters.md) | 構造一致 | 一覧・構成・改名関連コードを確認。画面試験なし |
| 21 | sketch-and-functions | [作図面を選ぶ](../packages/help-content/docs/ja/work-plane.md) | 構造一致 | 個別の重点確認なし |
| 22 | sketch-and-functions | [好きな向きの作業平面を作る](../packages/help-content/docs/ja/work-plane-custom.md) | 構造一致 | 個別の重点確認なし |
| 23 | sketch-and-functions | [基準の軸・点・座標系を作る](../packages/help-content/docs/ja/reference-geometry.md) | 構造一致 | 個別の重点確認なし |
| 24 | sketch-and-functions | [原点を置き直す](../packages/help-content/docs/ja/origin.md) | 構造一致 | 個別の重点確認なし |
| 25 | sketch-and-functions | [点・線・円弧をかく](../packages/help-content/docs/ja/sketch-tools.md) | 構造一致 | 個別の重点確認なし |
| 26 | sketch-and-functions | [交点で線をつなぐ・曲げる・区間を消す](../packages/help-content/docs/ja/sketch-intersections.md) | 構造一致 | 個別の重点確認なし |
| 27 | sketch-and-functions | [四角・多角形・長穴・円をかく](../packages/help-content/docs/ja/shapes.md) | 構造一致 | 個別の重点確認なし |
| 28 | sketch-and-functions | [楕円をかく](../packages/help-content/docs/ja/ellipse.md) | 構造一致 | 個別の重点確認なし |
| 29 | sketch-and-functions | [なめらかな曲線をかく(スプライン)](../packages/help-content/docs/ja/spline.md) | 構造一致 | 個別の重点確認なし |
| 30 | sketch-and-functions | [文字をスケッチの輪郭にする](../packages/help-content/docs/ja/text-sketch.md) | 構造一致 | 個別の重点確認なし |
| 31 | sketch-and-functions | [関数とXYZの範囲から曲線を作る](../packages/help-content/docs/ja/function-curve.md) | 構造一致 | 個別の重点確認なし |
| 32 | sketch-and-functions | [関数とXYZの範囲から曲面を作る](../packages/help-content/docs/ja/function-surface.md) | 構造一致 | 個別の重点確認なし |
| 33 | sketch-and-functions | [関数上に座標を指定して点を作る](../packages/help-content/docs/ja/function-point.md) | 構造一致 | 個別の重点確認なし |
| 34 | sketch-and-functions | [点にぴったり合わせる(吸着)](../packages/help-content/docs/ja/snap.md) | 構造一致 | 個別の重点確認なし |
| 35 | sketch-and-functions | [向きをそろえる(直交・角度・延長線)](../packages/help-content/docs/ja/tracking.md) | 構造一致 | 個別の重点確認なし |
| 36 | sketch-and-functions | [キーボードだけでかく(コマンドの欄)](../packages/help-content/docs/ja/command-line.md) | 構造一致 | 個別の重点確認なし |
| 37 | sketch-and-functions | [面を張る・色を変える](../packages/help-content/docs/ja/face-and-color.md) | 構造一致 | 個別の重点確認なし |
| 38 | sketch-and-functions | [かいたものを直す](../packages/help-content/docs/ja/edit-sketch.md) | 構造一致 | 個別の重点確認なし |
| 39 | sketch-and-functions | [オフセット・トリム・延長](../packages/help-content/docs/ja/edit-curves.md) | 構造一致 | 個別の重点確認なし |
| 40 | sketch-and-functions | [形を条件で決める(拘束)](../packages/help-content/docs/ja/constraints.md) | 構造一致 | 個別の重点確認なし |
| 41 | sketch-and-functions | [線の角を丸める・面取りする](../packages/help-content/docs/ja/sketch-fillet.md) | 構造一致 | 個別の重点確認なし |
| 42 | sketch-and-functions | [ミラー・複写・並べる](../packages/help-content/docs/ja/copy-array.md) | 構造一致 | 個別の重点確認なし |
| 43 | sketch-and-functions | [立体から線を取り込む(投影・断面)](../packages/help-content/docs/ja/project-intersect.md) | 構造一致 | 個別の重点確認なし |
| 44 | sketch-and-functions | [下絵を敷く](../packages/help-content/docs/ja/canvas.md) | 構造一致 | F02/F03/F04/F08。実ストア・資産・同期コード・説明を照合 |
| 45 | solid-and-measurement | [厚みをつける・回す](../packages/help-content/docs/ja/solid-basics.md) | 構造一致 | 個別の重点確認なし |
| 46 | solid-and-measurement | [立体をつなぐ・組み合わせる](../packages/help-content/docs/ja/solid-combine.md) | 構造一致 | 個別の重点確認なし |
| 47 | solid-and-measurement | [面・辺・頂点を選ぶ](../packages/help-content/docs/ja/select-subshape.md) | 構造一致 | 個別の重点確認なし |
| 48 | solid-and-measurement | [球・箱・円柱・円錐・トーラスを置く](../packages/help-content/docs/ja/primitive.md) | 構造一致 | 個別の重点確認なし |
| 49 | solid-and-measurement | [穴をあける](../packages/help-content/docs/ja/hole.md) | 構造一致 | 個別の重点確認なし |
| 50 | solid-and-measurement | [ねじ穴をあける](../packages/help-content/docs/ja/thread.md) | 構造一致 | 個別の重点確認なし |
| 51 | solid-and-measurement | [角を丸める・面を取る](../packages/help-content/docs/ja/fillet-chamfer.md) | 構造一致 | 個別の重点確認なし |
| 52 | solid-and-measurement | [同じ加工を並べる](../packages/help-content/docs/ja/pattern.md) | 構造一致 | 個別の重点確認なし |
| 53 | solid-and-measurement | [ばねを作る](../packages/help-content/docs/ja/spring.md) | 構造一致 | 個別の重点確認なし |
| 54 | solid-and-measurement | [球の表面に点を置く](../packages/help-content/docs/ja/sphere-grid.md) | 構造一致 | 個別の重点確認なし |
| 55 | solid-and-measurement | [面と面をつなぐ・ロフト](../packages/help-content/docs/ja/ruled-loft.md) | 構造一致 | 個別の重点確認なし |
| 56 | solid-and-measurement | [立体の形を変える・並べる](../packages/help-content/docs/ja/shape-edit.md) | 構造一致 | 個別の重点確認なし |
| 57 | solid-and-measurement | [平面で切る](../packages/help-content/docs/ja/cut.md) | 構造一致 | 個別の重点確認なし |
| 58 | solid-and-measurement | [色と材質を選ぶ](../packages/help-content/docs/ja/appearance-color.md) | 構造一致 | 個別の重点確認なし |
| 59 | solid-and-measurement | [柄を選ぶ](../packages/help-content/docs/ja/appearance-pattern.md) | 構造一致 | 個別の重点確認なし |
| 60 | solid-and-measurement | [ガラス・鏡と映り込み](../packages/help-content/docs/ja/appearance-glass.md) | 構造一致 | 個別の重点確認なし |
| 61 | solid-and-measurement | [長さ・角度・面積を測る](../packages/help-content/docs/ja/measure.md) | 構造一致 | 個別の重点確認なし |
| 62 | solid-and-measurement | [材料と重さを調べる](../packages/help-content/docs/ja/mass-properties.md) | 構造一致 | 個別の重点確認なし |
| 63 | solid-and-measurement | [梁・軸・ボルトの簡易強度計算](../packages/help-content/docs/ja/strength.md) | 構造一致 | 入力・計算の単体試験。説明の範囲を確認 |
| 64 | solid-and-measurement | [3D プリントの前に点検する](../packages/help-content/docs/ja/print-check.md) | 構造一致 | 個別の重点確認なし |
| 65 | assembly | [部品を置いて組み立てる](../packages/help-content/docs/ja/assembly.md) | 構造一致 | 個別の重点確認なし |
| 66 | assembly | [部品を配置する](../packages/help-content/docs/ja/assembly-place.md) | 構造一致 | 個別の重点確認なし |
| 67 | assembly | [規格部品を置く](../packages/help-content/docs/ja/standard-parts.md) | 構造一致 | 個別の重点確認なし |
| 68 | assembly | [部品どうしを合わせる](../packages/help-content/docs/ja/mate.md) | 構造一致 | 個別の重点確認なし |
| 69 | assembly | [ジョイントで動きを残す](../packages/help-content/docs/ja/joint.md) | 構造一致 | 個別の重点確認なし |
| 70 | assembly | [部品の干渉を調べる](../packages/help-content/docs/ja/interference.md) | 構造一致 | 個別の重点確認なし |
| 71 | assembly | [部品を差し替える・組を置く](../packages/help-content/docs/ja/replace-subassembly.md) | 構造一致 | 個別の重点確認なし |
| 72 | assembly | [分解した見せ方を作る](../packages/help-content/docs/ja/explode.md) | 構造一致 | 個別の重点確認なし |
| 73 | assembly | [部品表を確認する](../packages/help-content/docs/ja/bom.md) | 構造一致 | 個別の重点確認なし |
| 74 | drawing | [部品から図面を作る・注記する・書き出す](../packages/help-content/docs/ja/drawing.md) | 構造一致 | F01/F05。寸法と選択削除 |
| 75 | drawing | [用紙サイズ・縮尺・用紙位置](../packages/help-content/docs/ja/drawing-scale.md) | 構造一致 | 個別の重点確認なし |
| 76 | drawing | [図を追加する・詳細図・補助投影図・部分図・破断図](../packages/help-content/docs/ja/drawing-views.md) | 構造一致 | 個別の重点確認なし |
| 77 | drawing | [断面図で部品の内部を示す](../packages/help-content/docs/ja/drawing-section.md) | 構造一致 | 個別の重点確認なし |
| 78 | drawing | [図面に寸法を記入する](../packages/help-content/docs/ja/dimension.md) | 構造一致 | F01。実照合/解決関数・単体試験 |
| 79 | drawing | [自動寸法を記入する](../packages/help-content/docs/ja/dimension-auto.md) | 構造一致 | 個別の重点確認なし |
| 80 | drawing | [直列・並列・座標・累進の寸法をまとめて記入する](../packages/help-content/docs/ja/dimension-series.md) | 構造一致 | 個別の重点確認なし |
| 81 | drawing | [寸法線をまとめて整列する](../packages/help-content/docs/ja/dimension-arrange.md) | 構造一致 | 個別の重点確認なし |
| 82 | drawing | [寸法の公差・はめあいを指定する](../packages/help-content/docs/ja/dimension-tolerance.md) | 構造一致 | 個別の重点確認なし |
| 83 | drawing | [幾何公差とデータムを記入する](../packages/help-content/docs/ja/gdt.md) | 構造一致 | 個別の重点確認なし |
| 84 | drawing | [表面性状と加工注記を付ける](../packages/help-content/docs/ja/surface-finish.md) | 構造一致 | 個別の重点確認なし |
| 85 | drawing | [溶接記号で施工する側・寸法・方法を伝える](../packages/help-content/docs/ja/welding.md) | 構造一致 | 個別の重点確認なし |
| 86 | drawing | [文字注記と引出線](../packages/help-content/docs/ja/drawing-note.md) | 構造一致 | 個別の重点確認なし |
| 87 | drawing | [図面に部品表と部品番号を置く](../packages/help-content/docs/ja/drawing-bom.md) | 構造一致 | 個別の重点確認なし |
| 88 | drawing | [図面の穴表・改訂欄・表題欄を記入する](../packages/help-content/docs/ja/drawing-table.md) | 構造一致 | F05。専用削除と共通削除を照合 |
| 89 | drawing | [レイヤーで色・線・表示・印刷を管理する](../packages/help-content/docs/ja/drawing-layer.md) | 構造一致 | 個別の重点確認なし |
| 90 | drawing | [文字を輪郭にする・文字を含む図面を渡す](../packages/help-content/docs/ja/text-outline.md) | 構造一致 | 個別の重点確認なし |
| 91 | drawing | [図面を保存・書き出し・印刷する](../packages/help-content/docs/ja/drawing-export.md) | 構造一致 | PDF生成の対象試験。全頁目視なし |
| 92 | sheet-and-scripting | [板金の基板と曲げ条件を作る](../packages/help-content/docs/ja/sheet-metal.md) | 構造一致 | 個別の重点確認なし |
| 93 | sheet-and-scripting | [板金の縁からフランジを作る](../packages/help-content/docs/ja/sheet-metal-flange.md) | 構造一致 | 個別の重点確認なし |
| 94 | sheet-and-scripting | [指定線で板を曲げる・曲げリリーフを作る](../packages/help-content/docs/ja/sheet-metal-bend-relief.md) | 構造一致 | 個別の重点確認なし |
| 95 | sheet-and-scripting | [板金を展開し、穴表・図面・加工用ファイルを作る](../packages/help-content/docs/ja/sheet-metal-flat.md) | 構造一致 | 個別の重点確認なし |
| 96 | sheet-and-scripting | [JavaScriptで自動作図する](../packages/help-content/docs/ja/scripts.md) | 構造一致 | 個別の重点確認なし |
| 97 | sheet-and-scripting | [自動作図APIリファレンス](../packages/help-content/docs/ja/script-api.md) | 構造一致 | 個別の重点確認なし |
| 98 | sheet-and-scripting | [処理を保存し、道具として登録する](../packages/help-content/docs/ja/script-tools.md) | 構造一致 | 個別の重点確認なし |
| 99 | sheet-and-scripting | [作った形を加工ソフトへ渡す](../packages/help-content/docs/ja/cam.md) | 構造一致 | 外部加工ソフトへの受渡しという説明を確認 |
| 100 | settings-and-history | [作ったものの一覧と、やり直し](../packages/help-content/docs/ja/feature-tree.md) | 構造一致 | 個別の重点確認なし |
| 101 | settings-and-history | [履歴へ設計メモを残す](../packages/help-content/docs/ja/history-notes.md) | 構造一致 | 個別の重点確認なし |
| 102 | settings-and-history | [2つの保存ファイルの変更を比較する](../packages/help-content/docs/ja/document-diff.md) | 構造一致 | 個別の重点確認なし |
| 103 | settings-and-history | [途中まで戻して確かめる(タイムライン)](../packages/help-content/docs/ja/timeline.md) | 構造一致 | 個別の重点確認なし |
| 104 | settings-and-history | [画面の見た目を変える](../packages/help-content/docs/ja/display-settings.md) | 構造一致 | 個別の重点確認なし |
| 105 | settings-and-history | [右クリックで道具を選ぶ](../packages/help-content/docs/ja/radial-menu.md) | 構造一致 | 個別の重点確認なし |
| 106 | settings-and-history | [選ぶものを絞る・選んだ組に名前を付ける](../packages/help-content/docs/ja/selection.md) | 構造一致 | 個別の重点確認なし |
| 107 | settings-and-history | [視点に名前を付けて保存する・4分割で見る](../packages/help-content/docs/ja/named-view.md) | 構造一致 | 個別の重点確認なし |
| 108 | settings-and-history | [切って中を見る](../packages/help-content/docs/ja/section-view.md) | 構造一致 | 個別の重点確認なし |
| 109 | settings-and-history | [字体と解析ライブラリのライセンス](../packages/help-content/docs/ja/font-licenses.md) | 構造一致 | 個別の重点確認なし |
| 110 | settings-and-history | [使っている部品と許諾](../packages/help-content/docs/ja/component-licenses.md) | 構造一致 | 個別の重点確認なし |

## 主要根拠ファイルのSHA-256

本文の指摘に直接関係するファイル。原記録の全ソースと再照合した値を抜粋する。

```text
packages/kernel/src/occt/matchSubShape.ts 8472425cfa7c870b067b0b812cd3e1b5f0de4feb3692e02d2c67ef023cbbb8c1
packages/model/src/kernelBridge/subShapeMatching.ts 75d0604607fe7bcd68d9304e4ff8ca15b52220ca329d81b8ae5b6797dbd82650
packages/model/src/drawing/dimensionTarget.ts 5d4e52e69d5ddd289dddf8b4ea7a8a85f3e4a07875c164f7bdf44a6a4b7e9ed6
packages/model/src/measure/mathGeometry.ts 26f4a0808fcb5d89b3cb475ebbf89875765cc08b230db1355e706fd26a67fc7a
packages/ui/src/file/canvasFile.ts 468c46008ad0422dfb772dffb62cfd53f9805a9bb05664e742907e6f9c722828
packages/ui/src/store/canvasSlice.ts d72968db41ebb1ab6b8a15a837ee50d849a0cade637251d0ce466b8c65635336
packages/ui/src/viewport/ViewportCanvas.tsx f8bf28fb1d300ccf9c82f48b98eff6f7e2d1324bb65e29af4dadc6a3c39279ac
packages/ui/src/store/attachKernel.ts fc3c7628ae44bd17ed7b91ff6cbe4448b97e835277abc7186dff762433849cf5
packages/io/src/pcad/pcadFile.ts 4412d2183f0ccbde83cf84d797bdafc752d0ecfb078f32cba4ef7520b436ba93
packages/ui/src/drawing/dimensionCommands.ts a67861c78296053db43b2ad43fc3ee6bf92e0374edcc806a0cb318ec4749b5ba
packages/ui/src/drawing/tableCommands.ts c51886eefd0ec91359723a05d77d104cabb953faa359ae82e30cda81da5bb88b
packages/ui/src/file/partFile.ts 5d25fe80c13da76c561f6f2403aa29870795dc8943e31f172b43cb8dee5f0a28
```

## 報告記録用の要約

- コード・説明書・実関数の実行結果を調べ、総合71点と評価した。
- 図面寸法の曖昧な参照、下絵のUndo・文書切替・保存の問題を再現した。
- 説明書110章・画像232枚は生成物と整合し、指定単体1,116件は成功した。
- 競合の公式資料を踏まえ、参照修復・パラメータ管理・出力精度・UIの改善とコード案を示した。
- 製品コードは変更していない。実画面/E2Eは役割規約により未実施で、修正後の確認項目を記載した。

子エージェントの使用: なし。gitへの書込み: なし。
