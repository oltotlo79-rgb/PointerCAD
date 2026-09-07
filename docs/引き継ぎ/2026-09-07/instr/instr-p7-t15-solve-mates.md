# 指示書 P7 タスク15: 合致の解き方(受理 / 棄却つきの LM ドライバ・連結成分・尺度・上限・性能検査)(model。レビュー R6-2・R6-4 = §0.a-0.66・0.68 を反映。工数 L)

## 1. 目的と背景(コードで確認済み)

- タスク14(コミット待ち行列 1475)が `packages/model/src/assembly/constraints/mateResiduals.ts` と `mateFrames.ts` を作った。契約(タスク14 の report より): `prepareMateResiduals({ mates, targets, placements, parameters? })` → `{ mates, skipped }`(初期の世界座標ターゲットを局所座標へ移し、t / s を**初期の局所法線から 1 度だけ**作る)。`buildMateResiduals({ mates: prepared.mates, variableSet, placements, increments?, characteristicLength? })` → `readonly MateResidualRow[]`(`LinearizedRow` + `mateId` + `scale`。**行の尺度(方向 1、長さ 1/L₀)は value と gradient に適用済み**)。`buildMateResidualReport` は同じ行と `skipped`・`branchViolations` を返す。変数は Δt(mm)/ Δω(rad)、`placements` は**受理済みの基準姿勢**(固定部品も含む)、`increments` 省略時はゼロ。非ゼロの候補 Δ に対する gradient もその Δ での正しい微分。
- タスク14 のタスク15 への申し送り: ①prepare は初期姿勢で 1 度だけ呼び、計算中に選び直さない。②受理済み基準の増分 0 で report を取って線形化し、同じ基準を保って各候補 Δ を `increments` へ渡す。③棄却なら基準に触れず次の候補、**受理だけ** `t_next = t_base + Δt`、`q_next = multiplyQuaternion(exponentialMap(Δω), q_base)`(`composePlacement(delta, base)` は base の並進まで回すので**この更新には使わない**)、次の増分を 0 へ戻す。④report の `skipped` と `branchViolations` も確認する。平行 2 行は ± の両方で 0 なので、**分岐違反が残った点を収束とみなさない**。⑤固定同士の定数行を診断から落とさない。Δt/L₀ による列尺度、長さ / 角度の許容、受理 / 棄却、連結成分・gauge・上限はタスク15 / 16 側。
- 既存: `packages/model/src/sketch/constraints/solve.ts`(P4b の LM `solveLevenbergMarquardt`。候補を何回も評価して改善時だけ採用。密な正規方程式、QR と最小二乗も同ファイル :242-416)。§0.a-0.12 で **`solve.ts` の本体は変えない**(export の追加だけは可: 線形解法・QR を再利用するため)。`mateVariables.ts`(タスク13: `columnOf`、`MAX_ASSEMBLY_VARIABLES = 600`、`countMateDegreesOfFreedom`、`mateComponentGroups` = union-find の連結成分)。`placementMath.ts`(`exponentialMap`、`multiplyQuaternion`、`normalizeQuaternion`)。
- 訂正(§0.a-0.66・0.68、レビュー R6-2・R6-4): **受理 / 棄却を持つ LM ドライバを新規 `solveRigid.ts` に置き**、受理済み (t, q) を不変に保ち trial を増分から純粋に計算、改善時だけ基準を更新して次反復の増分を 0 に、λ と停止理由を反復をまたいで保持。**尺度**: 長さ L₀ と長さ / 角度の許容を明示し、列(Δt を L₀ で割る)を尺度化、悪条件時は既存 QR で `[WJ; sqrt(λ)D] Δ = [−Wr; 0]` を解く経路。**gauge** は成分ごとに固定・原点拘束・driver の有無で決め、rank は尺度化した Jacobian で評価(文書全体で 6 を一度引く式にしない)。**診断**は `converged / iterationLimit / stalled / provenConstantConflict / suspectedConflict` を分け、未収束を矛盾と断定しない。**上限**は全体 600 と成分別の両方、超過時も表示・保存を続ける(解かずに理由を返す)。
- タスク14 の指摘: `mateVariables.ts` の式数表は接線 1 本のまま → **接線 2 本に整合**させる(タスク13 の既存テストの期待値はこの仕様変更に伴い更新してよい。共通規律 6 の例外。report に列挙)。

## 2. 変更の設計

1. 新規 `packages/model/src/assembly/constraints/solveRigid.ts`: 受理 / 棄却つきの LM ドライバ。入力 = 行を作る関数(基準 + 増分 → 行)、初期基準、尺度(L₀、長さ / 角度の許容)、上限(反復数、時間)。出力 = 最終基準、反復数、残差ノルム、停止理由、各反復の λ の履歴(検査用)。線形解法は `solve.ts` の既存を再利用(export が無ければ **export を足すだけ**)。
2. 新規 `packages/model/src/assembly/constraints/solveMates.ts`: `solveMates(assembly, targets, placements, options)` → `{ placements: Map, converged, iterations, residualNorm, diagnosis, skipped, branchViolations }`。`mateComponentGroups` で連結成分に分け、成分ごとに gauge(固定部品があれば固定、無ければ最初の部品を基準に固定する規則を一意に)を決め、`solveRigid` を呼ぶ。上限(全体 600・成分別)を超えた成分は解かずに理由を返す。四元数は毎反復正規化、`w >= 0`。決定性(同じ入力 → 同じ配置)。
3. `mateVariables.ts`: 接線の式数を 2 に(+ テスト更新)。
4. 新規 `packages/model/src/assembly/assemblyPerformance.test.ts`: §2.13-1(1 反復 50 部品・150 拘束 ≤ 20 ms)、§2.13-2(解き直し全体 ≤ 300 ms)、§1.5-11(25×2 の成分に分けると 50 の一括より 2 倍以上速い。下回ったら数値を報告)。`@pointercad/test-utils` の `expectWithinBudget` に乗せる。
5. `packages/model/src/index.ts` は編集しない(他担当 11a-1)。export の行(mateResiduals・solveRigid・solveMates)を report に書く。

## 3. 編集所有ファイル / 読取専用

- 編集所有: 新規 `solveRigid.ts` / `.test.ts`、新規 `solveMates.ts` / `.test.ts`、新規 `packages/model/src/assembly/assemblyPerformance.test.ts`、`packages/model/src/assembly/constraints/mateVariables.ts` / `.test.ts`(接線 2 本の整合だけ)、`packages/model/src/sketch/constraints/solve.ts`(**export の追加だけ**。本体は 1 行も変えない)。
- 読取専用: `mateResiduals.ts` / `mateFrames.ts`(タスク14 の成果。変えない。契約に足りないものがあれば止まって報告)、`mateTargets.ts`、`placementMath.ts`、`resolveAssembly.ts`・`types.ts`、`packages/model/src/sketch/constraints/solveSketch.ts`(`DRAG_PIN_WEIGHT` の使い方)、`packages/test-utils/src/*`、`docs/plans/P7-アセンブリ.md` §2.5・§2.13・§0.a-0.66〜0.68・「タスク15」、`docs/reviews/2026-09-07-全体レビュー(gpt-6-astra).md` R3-3・R6-2・R6-4。
- 触らない: `packages/model/src/index.ts`、`packages/model/src/part/*`・`kernelBridge.ts`(他担当 11a-1)、kernel、ui、io。

## 4. 手順と中間報告(各段階の終わりに `progress.md` へ追記)

1. **現在値**: `solveLevenbergMarquardt` の引数・戻り値、`solve.ts` の線形解法 / QR の関数名と export の有無、`mateComponentGroups` / `columnOf` / `countMateDegreesOfFreedom` の形、`expectWithinBudget` の置き場を 15 行以内で報告。`pnpm --filter @pointercad/model exec vitest run constraints` の件数(タスク14 で 2,509 件のはず)。
2. **solveRigid**(受理 / 棄却、λ の保持、尺度化、QR 経路、停止理由)+ 単体テスト(1 変数・2 変数の解析解で収束、棄却で基準が動かない、λ の履歴、`iterationLimit` / `stalled` の区別)。
3. **solveMates**(連結成分、gauge、上限、診断、正規化、決定性)+ 計画の検証表のテスト(下記)。
4. **mateVariables** の接線 2 本。
5. **性能検査**(§2.13-1・2、§1.5-11)。**非厳密モードで 2 回測って報告**(他担当が並行して検査を走らせている)。厳密モードは統括が静かな窓で実行する。
6. **検査**: `pnpm --filter @pointercad/model run test`(全緑。件数。24 件以上増える)、`pnpm -w run typecheck`、`pnpm exec eslint <編集・新規ファイル>`。

## 5. 合格条件(数値)

- 計画の検証表: 固定した箱の上面と別の箱の下面の面合致で Z = 20(20³ の箱)、オフセット 5 で 25、裏返しで向きが逆、円柱と穴の同心で軸一致(1e-9)かつ回転と軸方向は自由、収束時 ‖f‖∞ < 1e-9、反復 1〜8、決定性(2 回で完全一致)、合致 0 本で 1 mm も動かない、矛盾(距離 10 と 12)で `converged === false` かつ投げない、連結成分 2 つが独立、四元数の長さ 1(1e-12)と w ≥ 0 — **全部**テストで緑。
- 診断 5 種と上限(全体 / 成分別)のテストが緑。分岐違反が残る点を収束にしないテストが緑。
- 性能: 1 反復 ≤ 20 ms、解き直し ≤ 300 ms、成分分割で 2 倍以上(非厳密 2 回の数値を表で報告。予算は変えない)。
- model のテストが全緑で件数が減っていない。typecheck 0(所有ファイル起因)、lint 0。`solve.ts` の diff が export の追加だけ。`index.ts` に差分なし。

## 6. 変更・緩和してはいけないもの

`solve.ts` の本体、`mateResiduals.ts` / `mateFrames.ts`、性能予算、`MAX_ASSEMBLY_VARIABLES = 600`、`index.ts`、他担当のファイル、計画の検証表の期待値(実測が違えば数値を報告)。

## 7. 関係する過去の失敗(rules/06)

10.3(性能検査は CPU 競合で落ちやすい → 2 回測る、厳密は統括)、P4b タスク6・8(解き方の手本)、10.19(未収束と矛盾を言い分ける)、10.11(共有ファイル: `index.ts`・`part/*`・`kernelBridge.ts` は他担当)。

## 8. 使える道具

`rg`、`sed -n`、`pnpm --filter @pointercad/model exec vitest run <名前>`、`pnpm --filter @pointercad/model run test`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`。

## 9. 成果物

`__OUT__/report.md`(API の形、検証表の結果、性能の表(2 回)、`index.ts` に足す export の行、タスク16(診断の表示)・17(UI)への申し送り)、`__OUT__/progress.md`。最終メッセージは要約 5 行 + 規律の 2 行。
