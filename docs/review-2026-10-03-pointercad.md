# PointerCAD 品質・機能・説明書・競合比較レビュー

調査日: 2026-10-03 JST  
対象コミット: `fb44ef2e3521bf792fd551c28d304cf307a064a4`  
対象バージョン表記: `1.0.2`（作業ツリーの候補。配布済み製品の認証ではない）  
総合評価: **71 / 100点（加重値70.5、コード調査と限定した実行検証による評価）**

## 1. 判定と優先順位

パッケージの依存方向、幾何計算のWorker化、保存要求の直列化、ファイル入力の検証、数式と設計履歴の連携はよく整備されている。選択して実行した既存テストは**56ファイル・1,116件すべて成功**し、全体の型検査・lintも成功した。現在のヘルプ110章と生成済みHTML説明書の内容、参照画像232枚の整合性も検査できた。

ただし、**曖昧な辺の参照を正常な寸法として採用する問題、下絵を削除・追加してUndoすると画像内容を取り違える問題、文書切替後に前の下絵を使う問題**を確認した。削除済み画像が保存ファイルへ残ることも再現できた。既存テストの成功だけでは、これらの操作の組合せを保証できていない。

現状を「バグなし」「全機能が説明書どおり」とは評価しない。最初にF01〜F04を直し、次に図面操作の一貫性と保存中の応答性を改善するのが適切である。製品コードの修正は本調査では行っていない。以下のコードは**修正方針を具体化した提案であり、適用・型検査・回帰検査済みのパッチではない**。

| ID | 優先度 | 指摘 | 確認方法 |
|---|---|---|---|
| F01 | P1 | 曖昧な辺の再照合を正常な図面寸法として採用する | 実関数で候補の番号により寸法が10/40に変わることを再現 |
| F02 | P1 | 下絵の削除→追加→Undoで元画像の内容が戻らない | 実ストアの操作と画像バイト列の照合 |
| F03 | P2 | 文書を切り替えても同じ画像IDの古い表示キャッシュを使う | 実コードから抽出した同期処理・実ストアで再現 |
| F04 | P2 | 削除済みの下絵が保存ファイルに残る | 実際にZIPへ保存し、実読み手で再読込 |
| F05 | P2 | 図面のDelete/Backspaceが選択した表・風船を対象にしない | 実コマンドで表1件が残ることを再現 |
| F06 | P2 | 保存の圧縮が画面側の実行スレッドを占有する | 実圧縮関数の時間とタイマー遅延を測定 |
| F07 | P2 | 大きな関数に入力・状態・表示資源の責務が集中する | ASTによる集計と該当コードの確認 |
| F08 | P3 | 斜め撮影した下絵を幅・高さだけで補正できると読める説明 | ヘルプと画像変換の式を照合 |
| F09 | P3 | READMEのWeb版公開状況が同じ段落で矛盾する | 文面を確認 |

P1は設計値や編集結果の正しさに関わる問題、P2は機能・データの取扱い・応答性・保守性の問題、P3は説明の修正を中心とする問題。攻撃者の悪用可能性を表すCVSSではない。

## 2. 項目別採点

点数は監査者の判断であり、商用CADとの性能順位や規格認証を表すものではない。90点以上は調査範囲に重要な未解消問題がない状態、70点台は基盤が良好だが改善が必要、50〜60点台は重要な反例がある状態として評価した。未実行の試験を合格に数えていない。

| 評価項目 | 点 / 100 | 配点 | 根拠 |
|---|---:|---:|---|
| コード品質 | 78 | 10 | 型付きの境界・入力検証・純関数が多い。一方、画像IDと添付の所有権に不整合がある |
| アーキテクチャ | 80 | 10 | `apps → ui → model → kernel / expression / drawing` とI/Oの分離、Worker境界が明確。文書と表示資源の寿命の分離が不十分 |
| 可読性・保守性 | 70 | 10 | 日本語の設計理由と責務別ファイルは有効。1,000行規模の関数、過去タスクの説明、圧縮した複文が読解負担になる |
| 幾何・機能の正確性 | 60 | 20 | 実OCCTの体積・STEP・許容差テストは成功。参照が曖昧な場合に正常値を返すF01を重く減点 |
| 編集・保存の信頼性 | 55 | 10 | 保存競合・終了確認の保護は改善済み。下絵のUndoと文書切替、削除後の保存に具体的反例がある |
| 検証基盤 | 83 | 10 | 多数の単体試験、説明書検証、両OSのCI構成あり。資源寿命をまたぐ操作列が既存試験で漏れている |
| パフォーマンス | 65 | 10 | 再計算Worker、キャッシュ、描画要求の集約は良い。同期ZIPで約0.9秒の占有を実測。実画面のFPSは未測定 |
| セキュリティ・入力の堅牢性 | 78 | 10 | Electron隔離、IPC送信元確認、CSP、展開前の制限あり。削除済み画像の同梱が意図しない情報共有につながる |
| 説明書・ヘルプとの整合 | 80 | 5 | 110章・232画像と生成物の整合は良い。下絵の復元・削除効果と実装に不一致 |
| UI・UX | 72 | 5 | 共通コマンド、入力支援、理由の表示、構成切替は有効。選択後の削除と参照修復に改善余地。利用者実験は未実施 |
| **合計** | **70.5 → 71** | **100** | `Σ(各点数 × 配点) / 100` |

前回レビューとは配点と検証範囲が異なるため、点数差をそのまま改善量として扱わない。

## 3. 調査範囲と証拠の読み方

- 製品ソース1,529ファイルを棚卸しし、ハッシュを記録した。ASTの関数規模は空行・コメントを含む。全行を精読したという意味ではない。
- 保存・読込・画像添付・Undo・文書切替・図面寸法・図面削除・部分形状照合・数式の幾何参照・圧縮・Electronの境界を重点的に追跡した。
- 既存テストはリポジトリ所定の`diag.py unit`から実行した。OCCTをNode上で実際に読み込むBoolean、STEP入出力、投影、許容差の試験も含む。
- 独立プローブは実モジュールをViteのmiddleware modeで読み込んだ。待受ポート、開発サーバーのlisten、ブラウザー、Electronは起動していない。F03だけはReact内部の画像管理ブロックを実ファイルから抽出して実行し、画像デコーダーと描画先を模擬化した。
- F01は幾何条件を組み立てて実照合・寸法解決関数へ渡した反例である。画面操作から特定のOCCT編集履歴を作って同じ番号変更を起こす試験ではない。F03も画面のピクセル比較ではなく、表示へ渡すキャッシュと画素寸法の状態を確認したもの。
- [役割規約の2026-09-24追記](../rules/01-役割と委譲.md#L11)には「Codex の担当からの画面検査は道具で全て拒否し、画面検査は Claude の担当と統括の全体検査だけで行う」とある。今回の「サブエージェントは使用しない」という指示も守り、実画面操作・E2E・統括用品質ゲートは実行していない。
- PDF全ページの目視、実プリンター、GPU/DPI差、Linux実機、全交換形式の他社製品での往復、全関数・全拘束・全板金形状の網羅、現在の依存脆弱性アラートの照会は未実施。この範囲について正常・安全とは断定しない。
- 開始時から存在した`docs/報告記録.md`の変更は編集していない。製品コード・規約・テストコード・gitへの書込みはない。

実行コマンド、RUN_ID、全110章の目録、最終ハッシュ照合は[検証記録](review-2026-10-03-evidence.md)に記載する。棚卸しした製品ソース1,529件の最終照合では変更0件だった。以下のリンクの行番号は対象コミットに対する位置である。

## 4. 確認した問題と具体的な修正方法

### F01 — 曖昧な参照を正常な寸法として採用する

**根拠:** [matchSubShape.ts:264](../packages/kernel/src/occt/matchSubShape.ts#L264)の`selectBest`は、閾値を超える候補の最高点を採り、同点なら番号の小さい候補を選ぶ。[subShapeMatching.ts:197](../packages/model/src/kernelBridge/subShapeMatching.ts#L197)の`rematchSubShapeRef`がその参照を返し、[dimensionTarget.ts:146](../packages/model/src/drawing/dimensionTarget.ts#L146)がその辺から寸法を解決する。最高点と次点の差を調べていない。

再現した入力は、元の参照が長さ20、位置`[0,0,0]`、X方向、現在存在しない辺番号99。候補は長さ10・中点`[0,-2,0]`と、長さ40・中点`[0,2,0]`の直線である。位置と長さの照合点が等しくなり、両方とも`0.670381197846483`で閾値を超える。

| 条件 | 解決状態 | 寸法値 |
|---|---|---:|
| 長さ10の辺が番号1、長さ40が番号2 | `resolved` | 10 |
| 幾何条件を変えず、辺番号だけを交換 | `resolved` | 40 |

これは浮動小数点の丸め誤差ではない。**同一性を確定できない参照を確定済みと扱う問題**である。決定的な選択規則はあるが、それだけでは参照先の正しさを保証しない。寸法の未解決表示にも載らない点が危険である。

同じプロジェクトの[mathGeometry.ts:103](../packages/model/src/measure/mathGeometry.ts#L103)では、`scoreSubShapeMatch`で次点との差を調べ、差が`0.05`未満なら`ambiguous-reference`を返している。この保護を図面にも適用できる。

**修正案:** 当面は図面の参照解決前に曖昧さを検査し、既存の未解決経路に戻す。その後、共通の参照解決結果を`matched / missing / ambiguous`へ拡張し、寸法、合致、加工参照、外観で用途に応じた処理を明示する。元の参照は保持し、候補を強調表示して選び直せるようにする。

```ts
// dimensionTarget.ts の instance 確定直後に入れる最小の保護案。
// mathGeometry.ts と同じ実装から import する。
import { scoreSubShapeMatch } from '../kernelBridge/subShapeMatching.js';

const scores = scoreSubShapeMatch(instance.body, target.ref);
if (scores === null) return null;
if (scores.runnerUpScore !== null &&
    scores.score - scores.runnerUpScore < ambiguityMargin) {
  return null; // 現在の未解決表示へ。元の target.ref は書き換えない。
}
const reference = rematchSubShapeRef([instance.body], target.ref);
```

`ambiguityMargin`は上記既存の判定を共通化して渡す。単に閾値を上げたり、番号で選ぶ順を変えたりする修正では不十分。長期的にはOCCTの生成・変更履歴による対応を第一候補とし、指紋による近似照合を補助にする。

**合格条件:** 上の2入力はともに未解決になる。一意な候補は解決される。候補列挙順や番号変更で別の正常値に飛ばない。寸法・合致・面参照の更新とUndoで元参照が保存される。製作図の出力では既存の未解決項目の扱いと整合させる。

### F02 — 下絵を削除・追加してUndoすると画像を取り違える

**根拠:** [canvasFile.ts:329](../packages/ui/src/file/canvasFile.ts#L329)の`newSketchCanvas`は現在の文書にある下絵だけから`canvas-1`等を採番し、`imageId`にも同じ番号を入れる。[canvasSlice.ts:132](../packages/ui/src/store/canvasSlice.ts#L132)の`addCanvas`は同じキーの画像を上書きする。一方、[同:160](../packages/ui/src/store/canvasSlice.ts#L160)の削除はUndoのため画像を保持する。

**再現手順:** 新しい部品でA.pngを追加 → Aを削除 → B.pngを追加 → Undoを2回。実ストアではA.pngという下絵の定義が戻るが、添付バイト列はB.pngと完全一致し、A.pngとは一致しなかった。新旧の`imageId`はいずれも`canvas-1`だった。

**影響:** 表示キャッシュを直すだけでは解決しない。メモリー上で元画像のバイト列が上書きされる。Undo後の文書を保存して再読込する追加確認でも、Aの定義にBの画像が残った。通常の「削除だけ→Undo」試験では見つからない。

**修正案:** 表示用の下絵IDと、変更しない画像資産IDを分ける。画像追加時にUI側でUUIDまたは内容ハッシュを作り、画像IDを再利用しない。モデルの純関数の中で乱数を発生させず、引数で渡す。

```ts
// 呼出側 lookToolActions.ts。新規の画像資産にだけIDを発行する。
const imageId = `canvas-image-${crypto.randomUUID()}`;
const canvas = newSketchCanvas(
  latest.document.canvases, plane, picked.fileName, image, imageId,
);

// newSketchCanvas の第5引数として imageId: string を追加する。
// id は従来の見分け用連番を使い、imageId は受け取った値を保存する。
return { id: nextCanvasId(existing), imageId, /* 既存の名前・位置・寸法 */ };
```

最後の行は変更箇所を示す抜粋であり、既存の必須フィールドを省略して実装してよいという意味ではない。既存ファイルの画像IDは読み続ける。Undo履歴が参照する画像は保持し、履歴からも外れた資産だけを回収する。

**合格条件:** A削除→B追加→Undo×2でAの名前・寸法・画像ハッシュが一致する。Redo、複数下絵、削除した最大連番の再利用、保存再読込でも確認する。

### F03 — 文書切替後も前の下絵がキャッシュされる

**根拠:** [ViewportCanvas.tsx:676](../packages/ui/src/viewport/ViewportCanvas.tsx#L676)の`decodedCanvases`と`decodingCanvases`は画像IDだけをキーにする。`syncCanvases`は新文書に同じIDがあれば古い画像を残す。復号完了時も`detached`だけを確認し、要求時の文書・バイト列と現在のものを照合しない。`useEffect`の依存配列は空で、[AppShell.tsx:203](../packages/ui/src/shell/AppShell.tsx#L203)も部品切替ごとにViewportを再生成しない。

`partFile.ts`の実際の順序どおりに添付を入れ替えて文書Bへ切り替えた結果は次のとおり。

```text
現在の文書の下絵: B.png
復号要求: ["A"]
表示用キャッシュ: A
画素幅: 100（Bの模擬デコーダーが返す幅は200）
閉じられた画像: []
```

Aの復号を遅らせ、文書Bへ切り替えてから完了させる場合も同じ取り違えを確認した。実画像ファイルのバイト列を使い、デコーダーの返答と描画先だけを模擬化した。実画面での見え方は未確認だが、渡す画像の選択が誤っていることはコードと実行の両方で確認できた。

**修正案:** キャッシュの同一性を`activeDocumentId + imageId + 元バイト列`で管理する。文書切替・資産差替え時に閉じる。非同期処理には要求ごとのトークンを付け、古い返答が新しい要求や画素寸法を上書きしないようにする。

```ts
const ticket = { documentId: state.activeDocumentId, bytes };
pending.set(imageId, ticket);
decodeCanvasImage(bytes, checked.format).then(image => {
  const current = useAppStore.getState();
  const currentRequest = pending.get(imageId) === ticket;
  if (currentRequest) pending.delete(imageId);
  if (detached || !currentRequest ||
      current.activeDocumentId !== ticket.documentId ||
      current.canvases.get(imageId) !== ticket.bytes ||
      !current.document.canvases.some(item => item.imageId === imageId)) {
    image.close?.();
    return;
  }
  decodedCanvases.get(imageId)?.close?.();
  decodedCanvases.set(imageId, image);
  current.setCanvasPixelSize(imageId, {
    width: image.width, height: image.height,
  });
  pushCanvases();
}, () => {
  if (pending.get(imageId) === ticket) pending.delete(imageId);
});
```

これは非同期完了側の変更例である。併せて同期側のキャッシュ失効と、`pending`を`Set`からトークンの`Map`へ変更する必要がある。F02の新規ID対策だけでは、従来ファイル同士の同一ID衝突を直せないため両方必要。

**合格条件:** A/B双方が`canvas-1`を持つ既存ファイルでもBが表示される。A→B→A、復号中の削除、同一文書の画像差替え、Viewport破棄後の返答を検査し、不要画像をちょうど1回閉じる。

### F04 — 削除した下絵が保存ファイルから除かれない

**根拠:** [canvasSlice.ts:168](../packages/ui/src/store/canvasSlice.ts#L168)は「保存のときに書き出すのは文書が指している画像だけ」と説明する。しかし[currentPcadAttachments:47](../packages/ui/src/store/attachKernel.ts#L47)は`state.canvases`をそのまま返し、[pcadFile.ts:538](../packages/io/src/pcad/pcadFile.ts#L538)は渡された全画像をZIPへ入れる。I/O側のオプション説明では、参照されるものだけを渡す責任を呼出側に置いている。

**実行結果:** 文書の下絵0件、添付画像1件の状態で保存。生成ZIPは7,924バイト。再読込は成功し、画像添付1件が残り、削除前の画像とSHA-256が一致した。

[ヘルプcanvas.md:65](../packages/help-content/docs/ja/canvas.md#L65)の「要らなくなった下絵は『×』で消しておくと軽くなります」と不一致。容量だけでなく、図面写真などを削除してから他人へ渡したつもりでも、ZIP内には画像が残るという問題がある。自動的な外部送信を確認したという意味ではない。

**修正案:** Undo用の全資産と、保存する文書が参照する資産を区別する。保存時のスナップショットに対して参照を抽出する。I/Oの汎用往復処理で未知の添付を一律削除する変更は避ける。

```ts
function referencedCanvases(
  document: PartDocument,
  images: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, Uint8Array> {
  const used = new Set(document.canvases.map(canvas => canvas.imageId));
  return new Map([...images].filter(([id]) => used.has(id)));
}

// 保存開始時に固定した document と attachments から作る。
const forSave: PcadAttachments = {
  ...attachments,
  canvases: referencedCanvases(document, attachments.canvases),
};
```

自動保存・ひな形・図面へ同梱する部品も同じ資産選別方針にそろえる。履歴中の画像はメモリーに残すため、削除直後のUndoは引き続き可能である。

**合格条件:** 削除後に保存したZIPに対象画像のエントリがない。Undo後に保存すると元画像が復活する。A/B複数画像の一部削除、図面の参照元同梱、復元用保存でも確認する。

### F05 — 図面のDelete/Backspaceで表・風船が削除されない

**根拠:** [commandDefinitions.ts:139](../packages/ui/src/commands/commandDefinitions.ts#L139)は図面のDelete/Backspaceを`drawing.deleteSelection`へ割り当てる。表示名は「図面で選んだものを削除する」。実装先の[dimensionCommands.ts:102](../packages/ui/src/drawing/dimensionCommands.ts#L102)は寸法、注記、データム、公差枠、溶接記号を除くが、表と風船を除かない。

実ストアを`openDrawing`で初期化し、改訂表1件を選択した結果、`deleteSelectedDrawingElements()`は`false`、表は1件残った。一方、[tableCommands.ts:76](../packages/ui/src/drawing/tableCommands.ts#L76)の`deleteDrawingTables()`では0件になった。

**分類上の注意:** [表のヘルプ](../packages/help-content/docs/ja/drawing-table.md)は専用の「選んだ表・風船を削除」ボタンを案内しており、その手順自体は動く。「表を削除する機能全体が使えない」という指摘ではなく、共通ショートカットの表示名と対象範囲の不一致である。

**修正案:** 表と風船も共通削除へ追加し、同じUndo単位で更新する。投影図・レイヤーの削除は依存要素を扱う既存方針があるため、単純な配列削除と混ぜず方針を明示する。

```ts
const tables = drawing.tables.filter(item => !ids.has(item.id));
const balloons = drawing.balloons.filter(item => !ids.has(item.id));
// 既存の「変更がない」判定にも上の2配列を加える。
state.applyDrawing({
  ...drawing, dimensions, annotations, datums, gdtFrames, weldSymbols,
  tables, balloons,
});
state.setDrawingTool('select');
```

**合格条件:** 表だけ、風船だけ、寸法と表の混在選択でDelete/Backspaceが働き、Undo1回で全部戻る。文字入力中のDelete、計算中、空選択の扱いを変えない。

### F06 — 同期ZIPが保存中の応答を止める

**根拠:** [pcadFile.ts:164](../packages/io/src/pcad/pcadFile.ts#L164)の`zipPcadEntries`は`zipSync`を呼ぶ。[partFile.ts:401](../packages/ui/src/file/partFile.ts#L401)の保存要求内で、ファイル書込みの`await`より前に実行される。保存キューは順序を守るが別スレッドには移さない。

圧縮レベル6・再現可能な疑似乱数列を1エントリにした合成データで、実関数を3回ずつ測定した。

| 入力 | 圧縮時間の範囲 | 中央値 | 同じスレッドの0msタイマー遅延 |
|---|---:|---:|---:|
| 8 MiB | 220〜258 ms | 233 ms | 220〜271 ms |
| 32 MiB | 880〜992 ms | 919 ms | 883〜994 ms |

環境: Windows、Node v25.9.0、Snapdragon X 12-core X1E80100。圧縮しにくい合成データであり、代表CADモデルの平均保存時間やブラウザーのFPSではない。ただし、処理中に同じスレッドのタイマーが進まないことは確認できる。既存の重複ZIP往復は削減されており、今回の指摘は同期圧縮そのものに限定する。

**修正案:** 圧縮・重いJSON生成を専用Workerへ移す。保存開始時の文書・添付のスナップショットと保存キューの同一性判定は維持する。UIでは圧縮・書込みの段階と取消しを表示する。

```ts
// UI側の処理の形。archiveWriter は新設するI/O Workerの窓口。
return queueDocumentSave(store, async isCurrent => {
  const bytes = await archiveWriter.write(snapshot, { signal });
  if (!isCurrent() || signal.aborted) return;
  const name = await store.fileGateway.savePcad(suggestedName, bytes, saveAs);
  if (name === null || !isCurrent()) return;
  // 以降は既存の保存状態・復元用控えの処理につなぐ。
});
```

`async`を付けるだけ、`Promise.resolve`で包むだけでは改善しない。転送で現文書・Undoが持つArrayBufferをdetachしないこと。必要なコピーと一時メモリーの上限も設計する。Workerは既存CSPで許される同一配信元の資産として束ねる。

**合格条件:** 同じデータのZIP内容・再読込結果が一致し、途中の文書切替で保存状態を誤更新しない。UI上で32 MiBと128 MiBの保存中に入力応答を計測する。例えば入力応答p95 <100 msを新しい改善目標にし、既存の正確性条件を緩めない。

### F07 — 大きな関数の中で状態と資源の寿命を追いにくい

| 関数 | ファイル | 関数の行数 |
|---|---|---:|
| `attachSketchInteraction` | [attachSketchInteraction.ts:398](../packages/ui/src/viewport/attachSketchInteraction.ts#L398) | 1,610 |
| `FeatureTree` | [FeatureTree.tsx:353](../packages/ui/src/shell/FeatureTree.tsx#L353) | 1,081 |
| `createSolidLayer` | [createSolidLayer.ts:580](../packages/ui/src/viewport/createSolidLayer.ts#L580) | 760 |
| `createViewportScene` | [createViewportScene.ts:487](../packages/ui/src/viewport/createViewportScene.ts#L487) | 744 |
| `ViewportCanvas` | [ViewportCanvas.tsx:583](../packages/ui/src/viewport/ViewportCanvas.tsx#L583) | 565 |

行数はコメント・内側の関数を含むAST上の範囲であり、循環的複雑度ではない。長さだけをバグと判定していない。ただしF03のように、画面の寿命と文書・画像の寿命が同じクロージャーに混在すると、単体で状態遷移を検査しにくい。

**修正案:** 最初に下絵キャッシュを`createCanvasImageCache`等へ抽出し、`sync / clear / dispose`と文書切替時の契約を明示する。スケッチは選択・作図・ドラッグ・取消しの状態ごとに入力処理を分け、イベント登録と解除を薄い関数へ残す。単なる行数合わせのファイル分割や、機能追加と一括で行う全面書換えは不要。

**合格条件:** 同じ操作列で同じストア更新になることを境界で比較できる。登録したイベント・画像・GPU資源が破棄時に残らない。既存のキー操作・IME・ドラッグ取消しの試験を保持する。

### F08 — 斜め撮影の歪み補正の説明が不正確

[canvas.md:32](../packages/help-content/docs/ja/canvas.md#L32)は、斜め撮影で歪んだ場合に幅・高さを別々に打ち直すよう案内する。一方、[canvasLayer.ts:123](../packages/ui/src/viewport/canvasLayer.ts#L123)の配置は、矩形に幅・高さ・回転・平行移動を適用するだけである。

斜め撮影による台形歪みはこの操作では一般に除けない。例えば画像の上辺が100、下辺が80の台形なら、幅を何倍しても比は100:80のままで、両方を同じ実寸に合わせられない。

**修正する文案:** 「幅・高さは画像全体の縦横比を調整します。斜め撮影による台形の歪みは補正できません。正面から撮影した画像を使うか、外部の画像補正で平面を正対させてから読み込んでください。」

機能追加するなら、既知の四隅による平面射影補正を別機能として扱う。2点の縮尺合わせだけで全域の寸法が正確になるとは案内しない。

### F09 — READMEの公開状況が矛盾する

[README.md:7](../README.md#L7)に「Web版とデスクトップ版を無料で公開しています」と「Web版は後日あらためて公開します」が同居している。実際の公開サイトの有無を推定した指摘ではなく、この2文の矛盾を指摘している。

**修正する文案:** 「PointerCADは無料で利用できるCADです（Apache-2.0）。現在はWindows・Linuxのデスクトップ版を公開しています。Web版の公開時期は別途案内します。」公開状況を確認して文面を一つにそろえ、README・導入ヘルプ・リリース案内の3か所で照合する。

## 5. 説明書・ヘルプと実装の照合結果

`node scripts/manual/captureRegistry.mjs check`は画像登録232、参照232、欠落・未登録・ハッシュ不一致0。標準寸法の画像190、記録付きの縦長例外42。例外画像があること自体を不具合とはしていない。

`node scripts/manual/verify.mjs manual-v102-20261001-215403`では、110章・232画像、`contentMatchesCurrentHelp: true`を確認した。`manualBuildId`は`27e35a6dc73e1e1d62361a707cf4a455ab690c87aa615b493141bf8bcfe34c76`。同時に`releaseCertified: false`なので、これをリリース認証済みと読み替えない。

| 領域 | 今回確認したこと | 判定・残る範囲 |
|---|---|---|
| ヘルプ全110章 | 目録・参照文言・画像登録・生成HTMLとの一致 | 構造上の整合を確認。全文の操作を実画面で実施したわけではない |
| 保存・読込・終了 | 要求順序、文書切替、保存先、Desktop終了確認のテスト | 対象試験は成功。下絵資産の保存はF02/F04 |
| 下絵 | 追加・削除・Undo・文書切替・ZIP往復 | F02〜F04。復元・削除効果の説明と不一致 |
| 図面寸法 | 実寸の解決、角度、公差、部分形状照合 | 基本試験は成功。曖昧参照はF01 |
| 図面の表 | 専用削除と共通削除の違い | 専用操作は動く。共通DeleteはF05 |
| 視点・ショートカット | cameraMath、cameraSketchInteraction、namedCamera、割当試験 | ロジック試験は成功。マウス・IME・実際のフォーカス遷移は未実行 |
| STEP・3MF | 実OCCTのSTEP入出力、3MFの面色等の試験 | 指定試験は成功。他社CADでの受入全件は未実施 |
| ZIP・復元用保存 | 展開予算、壊れた入力、CRC等、autoSave試験 | 指定試験は成功。全ブラウザーの容量限界は未検証 |
| 簡易強度計算 | 入力と公式の試験、ヘルプが手入力の簡易計算と明記していること | FEAや選択形状の自動解析がないことをバグとはしない |
| 加工連携 | `cam.md`が外部加工ソフトへの受渡しと明記していること | NC/Gコード生成がないことを説明との不一致とはしない |
| 図面PDF | toPdf/pdfWriterの単体試験 | PDF全ページの目視と実プリンターは未検証 |

### 過去の指摘の再確認

[2026-09-28レビュー](review-2026-09-28-codex.md)の主要な指摘は、そのまま現在の欠陥として再掲していない。

| 過去の指摘 | 現在の根拠 | 今回の扱い |
|---|---|---|
| 古い非同期読込の反映 | `documentRequest.ts`、`documentOpenGuard.ts`、関連する成功テスト | 保護を確認。F03はViewport内部の別経路 |
| アセンブリを開く間の競合 | `openDocumentGuard.test.ts`、保存先確定と文書切替の保護 | 対象試験で対策を確認 |
| Desktop終了時の未保存保護 | `desktopCloseGuard.test.ts`、desktopの`closeGuard`・配線試験 | 対象試験で対策を確認 |
| 3MFの面色欠落 | `exchangeActions.ts`のfaceColors/faceRanges伝達、`writeThreeMf.test.ts` | 現在のコードで対策を確認 |
| 説明書画像欠落・古い生成内容 | 今回の画像登録・生成済み説明書の検証 | 過去と同じ不整合は再現しない |
| ZIPの重複圧縮 | `zipPasses.test.ts`、圧縮前のエントリ結合 | 対策を確認。同期処理の残存はF06 |

## 6. セキュリティと堅牢性

評価できる点は、[main.ts](../apps/desktop/src/main/main.ts)の`contextIsolation: true / nodeIntegration: false / sandbox: true`、IPCの送信元検証、権限拒否、[共有CSP](../packages/ui/src/security/contentSecurityPolicy.ts)、[readArchive.ts](../packages/io/src/pcad/readArchive.ts)の展開前の予算検査である。今回、Desktopの境界を扱う76テストを含めて確認した。ZIP入力の試験も成功した。

CSPの`unsafe-eval`は通常画面全体ではなく、OCCTのembindが必要とするkernel Worker側へ限定されている。文字列だけを検索して「全面的に任意コード実行できる」とは指摘しない。現在の調査から、外部コード実行・認証突破・パストラバーサルの具体的な成立例は確認していない。

優先修正はF04である。利用者が削除したつもりの画像を共有ファイルに残す点は、外部通信の有無とは別のデータ取扱いの問題となる。

追加確認として、[fileGateway.ts:628](../packages/ui/src/file/fileGateway.ts#L628)および`:746`は`write`が失敗すると明示的な`abort`へ進まない。模擬ストリームでは呼出記録が`["write"]`だけになった。ただし、実ブラウザーで永続的にロックが残ることや既存ファイルが壊れることは実証していないため、確定したデータ破損バグには数えない。書込み・close失敗時に元の例外を保ってabortを試みる共通ヘルパーを設け、実ブラウザーで再保存できることを確認するとよい。

依存監視は[監視文書](security/dependency-monitoring.md)とDependabot設定がある。文書には古い「Firefox/Electron通常CI未接続」の記述も残る一方、現在のCI構成は進んでいるため、過去の未完了記述を現在の事実として転記しない。アラート一覧、SBOM、同梱WASM/Python資産まで含めた現時点の脆弱性評価は別途必要で、今回は「脆弱性0件」と判定していない。

## 7. 競合CADとの比較と改善方向

競合については2026-10-03に公式文書を確認した。競合アプリを同一PC・同一モデルでベンチマークした結果ではない。価格、利用権、全機能数での順位付けはしていない。

| 比較対象・軸 | 公式文書で確認した点 | PointerCADの現在の実装と改善方向 |
|---|---|---|
| Autodesk Fusion: パラメータ管理 | ユーザー/モデルパラメータ、参照を伴う改名、絞込み、CSV入出力を持つ。[公式Parameters](https://help.autodesk.com/view/fusion360/ENU/?contextId=SLD-MODIFY-PARAMETERS) | 日本語名・式・改名追従・構成切替は既にある。差はその有無ではなく、多数の寸法を探す・交換する操作。[ParameterPanel](../packages/ui/src/parameters/ParameterPanel.tsx)の全行一覧に検索、未使用/循環/参照元フィルター、CSVの検証付きプレビューを追加する |
| Autodesk Fusion: メッシュ出力 | 3D Printの出力でカスタムの偏差設定を扱う。[公式3D print](https://help.autodesk.com/view/fusion360/ENU/?contextId=MAKE-3D-PRINT-CMD) | PointerCADは粗い/標準/細かいの3段階。[types.ts:98](../packages/model/src/exchange/types.ts#L98)は偏差0.5/0.1/0.02 mm。現在値の表示と任意偏差の詳細設定を加え、精度と三角形数を選べるようにする |
| Onshape: 設計変更の管理 | 名前付きの変更不能な版、分岐、比較、復元がある。[公式Versions and History](https://cad.onshape.com/help/Content/Document/versions_and_history.htm) | PointerCADにも[文書差分](../packages/model/src/diff/compareDocuments.ts)と[形状差分UI](../packages/ui/src/diff/MaterialDiffPanel.tsx)がある。比較機能がないとは言わない。これを使ってローカルの名前付き保存点、保存点一覧、そこからの複製・比較へつなぐ。クラウド共同編集は別の大きな開発項目 |
| Onshape: 参照の修復 | 壊れた参照を図で確認する修復パネルがある。[公式Repairing](https://cad.onshape.com/help/Content/Document/repairing.htm) | F01の検出に続き、元の面/辺と候補、影響する寸法・合致を表示する。誤選択を防ぐだけでなく復旧時間を減らす |
| FreeCAD: 形状参照の維持 | 1.0でトポロジカル命名問題への緩和策と組立機能を導入している。[公式1.0発表](https://blog.freecad.org/2024/11/19/freecad-version-1-0-released/) | 「他製品なら参照切れが絶対ない」とは比較しない。PointerCADも番号と指紋だけでなく操作履歴を利用し、解決不能時は修復可能な状態を残す。既存の組立機能の有無より、変更後の参照品質を改善する |

### 強みを伸ばす具体案

1. **座標・数式・日本語名を同じ操作でつなぐ。** [command-line.md](../packages/help-content/docs/ja/command-line.md)、パラメータ、数式計算、関数曲線・曲面の連携が強みである。既存の入力候補に、計算後の単位・参照元・変更される部品数を添える。候補選択前から「板厚×2 = 6 mm、押し出し1に使用」のように確認できる形にする。数式対応そのものが競合にない、という主張はしない。
2. **ローカルで完結する変更履歴を使いやすくする。** `.pcad`の編集可能な式・参照、既存の差分比較を生かし、「試作A」「発注前」といった保存点から戻る・比較する導線を作る。実装は内容ハッシュ付きのスナップショットと資産参照を使い、F02/F04の資産寿命を先に直す。
3. **3Dプリント向けの精度を見えるようにする。** 出力前に寸法、単位、閉じた立体か、設定偏差、三角形数、既存の点検結果を一つの確認画面にまとめる。既存の点検機能を再実装するのでなく、書出しとの接続を強める。
4. **説明書を再現できる操作例へ進める。** 現状の章・画像・UI文言の整合検査に、最小の操作列と期待する文書状態を結び付ける。下絵なら「削除してUndo」「削除して保存」の両方を教材と回帰試験にする。

## 8. 正確性を増す実装案

### 8.1 許容誤差の意味を分けて表示する

[tolerances.ts](../packages/kernel/src/occt/tolerances.ts)は既に幾何一致`1e-7 mm`、縫合修復の既定`0.01 mm`、近似曲面`1e-6 mm`を分けている。この分離は維持すべきで、全てを小さい値一つに統一しない。OCCT自身も一致と近似などの許容差を区別している。[公式Precision資料](https://occt3d.com/dev/doc/refman/html/class_precision.html)

幾何一致の閾値が`1e-7`であることは、全加工・輸入形状・メッシュ・製造結果がその精度になる保証ではない。UIには必要に応じて「B-repからの測定」「三角形からの近似」「修復で許した隙間」「表示の丸め」を区別して表示する。

### 8.2 精度を落とさず壊れにくくする試験

同じ形を平行移動・回転・単位変換しても長さ・体積が保たれる試験を加える。寸法を小・中・大へ変える試験、ほぼ接するBoolean、細い面・短い辺、STEP往復後の体積・境界箱・面/辺の意味の照合を共通の受入データにする。既存の体積試験は維持し、今回不足した参照先の同一性を別に検査する。

数値比較は用途別の絶対誤差と相対誤差を使う。許容差を広げてテストを通す修正はしない。実際のモデル座標系から離れた巨大座標の表示では、Float32描画用座標とdoubleの設計値を分けた検査も有効である。今回、巨大座標での破綻自体を再現したという主張ではない。

### 8.3 任意の出力偏差

```ts
// 既存の3段階を残し、必要な利用者だけ詳細指定へ進める設計例。
type MeshQualityChoice =
  | { kind: 'preset'; value: ExportQuality }
  | { kind: 'custom'; deviationMm: number; angularDeflectionRad: number };
```

入力は有限で正か、三角形数・時間・メモリー予算に収まるかを検証する。公差0.01 mmの設計なのに出力偏差0.1 mmを選んでいる、といった関係を利用者が判断できる表示にする。ただし、指定値は計算の設定値であり、未検査の最大誤差を「保証値」とは表示しない。

## 9. UI・UXの改善案と受入条件

既存のツールバー・ツリー・ビューポート・プロパティ・ステータスの区画を使い、固定パネルを増やす前提にはしない。以下はコード上の導線からの提案で、利用者テストによる実測結論ではない。

| 改善 | 実装場所・方法 | 受入条件 |
|---|---|---|
| 選択と操作を一致させる | `commandDefinitions`と実コマンドで削除対象を統一。対象が使えない理由は既存のcommandFeedbackへ返す | 表・風船を含む選択で結果が予測でき、Undo1回で戻る。入力欄の文字削除を妨げない |
| 参照の選び直しを短くする | 既存プロパティで元参照・候補・影響先を表示。候補をホバーで強調し、確定時だけ文書更新 | 未解決箇所から2操作以内で候補の確認へ到達し、取り消すと文書は変わらない |
| 多数のパラメータを探せるようにする | `ParameterPanel`に名前/説明検索と未使用・循環・参照元の絞込み。既存のusage計算を再利用 | 100行で対象を検索でき、検索中の改名・Undo・構成切替でフォーカスを失わない |
| 入力中の結果と単位を明確にする | 既存入力プレビューへ次元・参照元・エラー位置を一貫して表示。式を勝手に数へ置換しない | mm/inch/degreeの誤入力で理由が欄の近くに出る。IME変換途中に確定しない |
| 保存・復元を把握しやすくする | 保存中の段階、完了したファイル名、未保存変更、復元用保存の状態を既存ステータスへ集約 | 圧縮中も画面が応答し、文書切替後に前の保存成功を新文書の成功と表示しない |
| 下絵の状態を見分ける | 画像名・画素寸法・実寸・読込中/失敗をプロパティへ表示。文書が違う画像の結果を捨てる | F03の操作列で必ず現文書の内容だけを表示し、誤画像で寸法合わせを始めない |
| キーボードと説明を同じ定義で保つ | 既存のショートカット/ヘルプ生成基盤へ操作列の試験を接続する | Tab、Enter、Esc、Delete、Undoが部品/組立/図面と入力欄で仕様どおり。無効理由を色だけに頼らない |

初回利用者には、小さな部品を「座標入力→厚みをパラメータ化→寸法変更→図面→STEP/STL出力」まで作る一続きのガイドが適している。既存tutorialを出発点にし、独立した説明を増やすより現在のモデルと操作の結果を結び付ける。効果の評価は初回完了率、誤操作から戻る時間、ヘルプ検索回数で行う。

## 10. 修正の順番

| 段階 | 実施内容 | 終了条件 |
|---|---|---|
| 1: 正しさの確保 | F01、F02、F03、F04をそれぞれ小さく修正。対応するヘルプ・回帰試験も更新 | 本報告の全反例が解消し、一意な正常ケース、既存ファイル、Undo/Redo、保存再読込が成功 |
| 2: 一貫した操作と説明 | F05、F08、F09、未解決参照の候補表示 | 専用ボタンとショートカットの対象が整合し、誤解を招く説明がない |
| 3: 応答性と保守性 | F06のWorker化、F07の画像寿命と入力処理の抽出 | 保存中の入力応答とメモリーを実測。ZIP内容・精度・保存競合対策が維持される |
| 4: 競争力の改善 | パラメータ検索/CSV、任意出力偏差、名前付き保存点と既存差分の接続 | 既存区画で目的の作業が短くなったことを代表タスクで測定 |

修正後の実画面試験には、部品A→部品Bの切替、画像の削除・追加・Undo、曖昧な参照の更新、混在選択のDelete、大きい添付の保存、入力欄・IME・ショートカットの競合を必ず含める。今回実施していない画面試験を、単体テストの成功で代替したことにはしない。

## 11. 作業記録

新規の報告書と検証記録を`docs/`へ出力し、実験用スクリプト・結果はプロジェクト内の`scratchpad/tasks/6131650ed8c2-review-20261003-0eokcqi8/`へ保存した。再現手順と主要な実行結果は本書にも記載したため、実験用ディレクトリが配布対象外でも指摘内容を追える。

製品の修正: なし。既存の`docs/報告記録.md`の編集: なし。  
子エージェントの使用: なし。gitへの書込み: なし。
