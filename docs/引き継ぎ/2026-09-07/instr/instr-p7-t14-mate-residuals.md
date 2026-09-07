# 指示書 P7 タスク14: 合致の残差とヤコビアン(6 種)(model の純関数。レビュー R6-2〜R6-4 の訂正 = P7 §0.a-0.66〜0.68 を取り込む。工数 L)

## 1. 目的と背景(コードで確認済み)

- P7 計画の「タスク14」の節(`docs/plans/P7-アセンブリ.md`。`### タスク14:` で検索)と §2.5.2(残差の表)、および **2026-09-07 の訂正**(§0.a-0.66〜0.68 と §2.5 末尾の「2026-09-07 の訂正」の小節)が正本。手本は P4b の `packages/model/src/sketch/constraints/residuals.ts`(`ResidualRow` の形・疎な `gradient`・縮退の断り方。**1 行も変えない**)。
- 既存: `packages/model/src/assembly/constraints/mateTargets.ts`(タスク12。`resolveMateTarget` が指紋から平面・軸・点・円筒を**世界座標**で返す)、`mateVariables.ts`(タスク13。`columnOf(componentId, axis)`、6 自由度の表、`MAX_ASSEMBLY_VARIABLES = 600`)、`packages/model/src/assembly/placementMath.ts`(`RigidPlacement`、`normalizeQuaternion`、`composePlacement`、`exponentialMap`)。
- **訂正(必ず守る)**: ①**四元数の再パラメータ化を残差関数の中で行わない**(0.66)。残差とヤコビアンは「受理済みの基準姿勢 (t, q) に対する増分 (Δt, Δω)」の関数として**純粋に**計算し、基準姿勢の更新は呼び手(タスク15 の受理/棄却つき LM)が行う。零点での方向微分 `δp = δω × (p − c)` は基準点 c(部品の配置の並進)に対して。②**t / s(平行・同心の補助軸)は相手部品の局所座標で固定し、trial 姿勢で一緒に回す**(0.67。世界座標で固定しない)。③**円筒-平面の接線は 2 本**: `dot(axis, n) = 0` と `dot(c − p, n) − σ r = 0`(σ = 選んだ側、初期姿勢で決めて追跡)。④**平行の向きの分岐**(n₁ = ±n₂)は初期姿勢または明示の反転から決めて追跡する。⑤**解析幾何の軸の原点 `axisOrigin`**(円筒の Location、円錐の頂点/軸上の点)は入力の面情報に持たせる(kernel 側の配線は別タスク 14b。ここでは入力型に `axisOrigin` を定義し、テストでは手で与える)。⑥**尺度**(0.68): 長さ L₀(文書の代表寸法。既定 100 mm)を受け取り、長さの残差を L₀ で割った無次元の行と、方向の内積の行を同じ尺度で並べる(`scale` の欄を行に持たせ、呼び手が重み付けに使える形)。

## 2. 変更の設計

- 新規 `packages/model/src/assembly/constraints/mateResiduals.ts`: `buildMateResiduals(input): readonly MateResidualRow[]`。入力 = 合致の一覧、各合致の対象(世界座標 + 局所座標での t / s・axisOrigin)、変数の表(タスク13)、基準姿勢の表、尺度 L₀。出力の行は P4b の `LinearizedRow` / `ResidualRow` の流儀(残差の値、疎な gradient(列番号 → 偏微分)、`scale`、由来の mateId)。固定された部品の列は gradient に現れない。1 行の非ゼロ項は最大 12(2 部品 × 6 変数)。
- 6 種: 平行(2 本)、一致(面と面 3 本 / 点と点 3 本 / 点と面 1 本)、同心(4 本)、距離(1 本)、角度(1 本)、接線(**2 本**。訂正 ③)。固定は式を出さない。
- **偏微分はすべて手で導出**し、**中心差分との突き合わせ**(h は 1e-7 固定だけでなく尺度に応じた h と、絶対 / 相対誤差の併用。訂正 R6-2)を検査に入れる。
- 断り(§2.12): 角度 0.5° 未満は断る(文言は計画の §2.12 の表)、距離 −1 は断る、退化(法線がゼロ、軸が定義できない)は理由つきで断る。
- **`packages/model/src/index.ts` は編集しない**(他担当 11a-1 が編集中)。export の 1 行を report.md に書き、統括が統合する。

## 3. 編集所有ファイル / 読取専用

- 編集所有: 新規 `packages/model/src/assembly/constraints/mateResiduals.ts`、新規 `packages/model/src/assembly/constraints/mateResiduals.test.ts`、新規 `packages/model/src/assembly/constraints/mateFrames.ts`(t / s の作り方と局所→世界の回し方を 1 か所に切り出す場合。名前は既存の流儀に合わせてよい)+ その test。
- 読取専用: `packages/model/src/sketch/constraints/residuals.ts`(手本。変えない)、`packages/model/src/sketch/constraints/solve.ts`(変えない)、`mateTargets.ts`・`mateVariables.ts`・`placementMath.ts`(型と関数を使うだけ。変更が要るなら止まって報告)、`packages/model/src/index.ts`(他担当)、`packages/model/src/kernelBridge.ts`(他担当)、`docs/plans/P7-アセンブリ.md` §2.5・§2.12・§0.a-0.66〜0.68、`docs/reviews/2026-09-07-全体レビュー(gpt-6-astra).md` R6-2〜R6-4。
- 触らない: kernel、ui、io、`packages/model/src/index.ts`、`packages/model/src/part/*`。

## 4. 手順と中間報告(各段階の終わりに `progress.md` へ追記)

1. **現在値**: `residuals.ts` の `ResidualRow` の形・gradient の作り方・縮退の断り方を 10 行以内で報告。`mateTargets.ts` / `mateVariables.ts` / `placementMath.ts` の使う関数と型を列挙。`pnpm --filter @pointercad/model exec vitest run constraints` の件数。
2. **フレーム**(t / s の作り方: 絶対値が最小の軸との外積。局所座標で固定し、trial 姿勢で回す)+ テスト(`n₂ = (0,0,1)` と `(1,1,1)/√3` で長さ 1・直交、回した後も直交)。
3. **平行(2 本)・一致(3 種)** + テスト(計画の検証表の値: 面が 5 mm 離れていれば 3 本目が 5、オフセット 5 で 0、90° 違えば 1 と 0)。
4. **同心(4 本)・距離・角度・接線(2 本)** + テスト(角度 60° で 0、90° のとき −0.5、接線で円筒が平面へ傾いていると 1 本目が非ゼロ)。
5. **中心差分の突き合わせ**: 6 種すべて、乱数でない固定の 5 通りの配置(回転を含む)で相対誤差 1e-6 以下(絶対誤差の併用)。
6. **断り**と尺度のテスト。**検査**: `pnpm --filter @pointercad/model run test`(全緑。件数。36 件以上増える)、`pnpm -w run typecheck`、`pnpm exec eslint <新規ファイル>`。

## 5. 合格条件(数値)

- 計画の検証表(式の数 2/3/4/1/1/2/0、t・s の直交と長さ、面の一致・5 mm・オフセット・90°、角度 60°/90°、中心差分 1e-6、非ゼロ 12 以下、固定の列が無い、角度 0.5° と距離 −1 の断り)が**全部**テストにあり緑。新規 36 件以上。model のテストが全緑で件数が減っていない。
- typecheck 0(所有ファイル起因)、lint 0。`index.ts` に差分が無い(export の 1 行は report に)。

## 6. 変更・緩和してはいけないもの

`residuals.ts` / `solve.ts`(P4b の既存)、`mateTargets.ts` / `mateVariables.ts` / `placementMath.ts`(必要なら報告)、`index.ts`、計画の検証表の期待値(実測が違えば値を書き換えず報告)。

## 7. 関係する過去の失敗(rules/06)

P4b タスク5(残差とヤコビアンの手本。中心差分との突き合わせを必ず入れる)、「計画書の期待値が誤っていた」例(実測が違ったら値を書き換えず報告)、10.11(共有ファイル: `index.ts` は他担当)。

## 8. 使える道具

`rg`、`sed -n`、`pnpm --filter @pointercad/model exec vitest run <名前>`、`pnpm --filter @pointercad/model run test`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`。

## 9. 成果物

`__OUT__/report.md`(行の型、6 種の式と偏微分の要点、中心差分の結果表、テスト件数の前後、`index.ts` に足す export の 1 行、14b(kernel の axisOrigin 配線)への申し送り、タスク15 への申し送り(受理/棄却で基準姿勢を更新する呼び方))、`__OUT__/progress.md`。最終メッセージは要約 5 行 + 規律の 2 行。
