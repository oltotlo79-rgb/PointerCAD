# 指示書: PointerCAD 全体レビュー(着手前の設計・実装・計画の批評)

## 0. 規律(必ず守る。上から順に優先)

1. **子エージェント(Codex のサブエージェント機能・他の AI ツール・他のセッション)を起こさない。** 調査も執筆も自分で前景で行う。
2. **git への書き込み禁止。** 対象リポジトリ `C:/Users/oltot/Documents/git-projects/PointerCAD` は**読むだけ**。`git -C <リポジトリ> log / show / diff / status / blame` の読み取りだけ許可。commit / add / stash / checkout / reset / worktree / push は一切実行しない。リポジトリ内のファイルを 1 バイトも変更しない。
3. **触ってよい場所は、いまの作業ディレクトリ(この指示書の報告先)だけ。** ここに `review.md`(本報告)と `progress.md`(進行の記録)を書く。
4. **起動禁止**: ブラウザ・Electron・開発サーバー・`pnpm` / `npm` / `npx` による build / test / lint。検査結果は下の §2 に統括が与える値を使う。理由: 並行して統括が push 前検査を走らせることがあり、CPU と作業ツリーを乱してはいけない。
5. **進行の記録**: 10 分に 1 回を目安に `progress.md` へ「終えた項目番号・いま読んでいる場所・残り」を追記する(統括が停滞監視に使う。40 分更新が無いと停滞と判定される)。
6. 最終メッセージの末尾に次の 2 行を必ず書く: 「子エージェントの使用: なし」「git への書き込み: なし」。

## 1. あなたの役割と目的

あなたは 3D CAD(B-rep カーネル・パラメトリック履歴・アセンブリ・製図)の設計と実装に強い上級レビュアーです。統括(Claude)はこれから残り 229 タスクの実装を Codex に指示していきます。**その前に、いまの設計・実装・計画・進め方を項目ごとに詳しく点検し、根拠つきの具体策を出してください。** 統括はこの報告を熟読してから作業指示を始めます。抽象的な一般論(「テストを増やすべき」等)は不要で、**どのファイルのどこを、何に、なぜ**変えるかまで書いてください。「変えないでよい」という判定も同じ重さで価値があります。

## 2. 前提(統括が与える事実。再測定しない)

- プロダクト: PointerCAD。日本語 UI の 3D CAD。TypeScript + OpenCASCADE(opencascade.js 2.0.0-beta、WASM、Worker 内) + Three.js + React + Zustand + Electron、Web 版は Cloudflare Pages。pnpm モノレポ。
- 要件の正本: `docs/requirements.md`(v1.15)。§4 機能要件、§5 非機能要件(UX が最重要)、§6 構成、§9 フェーズ計画、§10 リスク、§11 スコープ外、§12 未決。
- 規約: `CLAUDE.md`、`AGENTS.md`、`rules/00〜06`。`rules/06-過去の失敗と対策.md` は 10.1〜10.20 の失敗記録(OCCT の所有権 10.13・10.16、E2E の並列 10.18、待ち行列 10.11・10.20 など)。
- 状態: HEAD `064bfe1`(2026-09-07)。作業ツリーは clean。**タスク 532 個中 303 個完了(57%)**。P0〜P6 は完了。P7(アセンブリ)はタスク 1〜10・12・13 が完了(計画 `docs/plans/P7-アセンブリ.md`、残り 37 = タスク 11・14〜49)。P8 は計画書のみ(`docs/plans/P8-図面と寸法.md`、71 タスク)。P9〜P13 は計画書未作成(要件 §9 の範囲のみ)。P11b は計画書あり(`docs/plans/P11b-補強.md`、6 タスク)。
- 検査の状態(HEAD 相当): typecheck / lint / unit / build すべて緑。E2E は Playwright 17 spec 77 件が 3 回連続緑(`e2e/playwright.config.ts` の `workers: 2`。6 並列だと WASM の初回読み込みが 55〜80 秒かかり 60 秒上限を越えた実測あり)。CI(GitHub Actions、Windows と Ubuntu)は c96b473 で両 OS 緑。性能検査は `POINTERCAD_PERF_STRICT` で厳密化され、`@pointercad/test-utils` の `expectWithinBudget` を使う。
- 規模(テスト除く実装行): ui 66,867 / model 36,004 / kernel 22,690 / io 13,861 / expression 1,690 / help-content 236 / drawing 35 / desktop 1,164 / web 98。
- 既知の残件: `docs/plans/P7-アセンブリ.md` §8(円筒面の全周判定、`themedAppearance` の重複、`packages/ui/src/store/useAppStore.test.ts` 3,206 行が未分割、アセンブリの層に鏡とクリッピングが未配線)。P6 でストア `useAppStore.ts` は 11 スライスへ分割済み。
- 利用者の決定: 版管理・共同編集・標準部品カタログ・エコシステムは対象外(要件 §11)。P11b は CAM 橋渡し・簡易強度計算・DWG 案内・曲面強化の 4 件。
- 検査の道具は統括だけが動かす(`scripts/check.ps1`)。あなたは読むだけ。

## 3. 読むもの(実在を確認済み)

必読: `docs/requirements.md`、`docs/plans/P7-アセンブリ.md`(特に §2.5 合致の解き方・§2.6 ジョイント・§2.7 干渉・§2.8 規格部品・§2.9 分解図・§2.15 STEP・§8 残件)、`docs/plans/P8-図面と寸法.md`(特に §2.2 HLR・§2.5 自動縮尺・§2.7 寸法線・§2.10 PDF・§2.11 字体)、`docs/plans/P11b-補強.md`、`docs/plans/P6-入出力.md` と `docs/plans/P5-高度なソリッド・外観と測定.md` の §2(技術方式)、`rules/04-設計の規律.md`、`rules/06-過去の失敗と対策.md`、`rules/03-品質ゲート.md`。

コード: `packages/kernel/src`(`occt/`・`worker/`・`client/`)、`packages/model/src`(`kernelBridge.ts`、`history/`、`geometry/`、`sketch/`、`assembly/`、`exchange/`、`measure/`、`parameters/`、`units/`、`thread/`)、`packages/ui/src`(`store/`、`viewport/`、`shell/`、`sketch/`、`solid/`、`file/`、`i18n/`)、`packages/io/src`(`pcad/`、`dxf/`、`threemf/`、`autoSave.ts`)、`packages/expression/src`、`packages/drawing/src`、`apps/desktop`、`apps/web`、`e2e/`、`scripts/check.ps1`、`.github/workflows/ci.yml`、`eslint.config.js`、`tsconfig.base.json`。

参考: `docs/報告記録.md`(決定の経緯を拾う程度でよい)、`docs/standards/`(JIS の表)。

大きい repo なので、全ファイルを精読する必要はありません。**各項目の判定に必要な箇所を選んで読み、根拠として引いたファイルと行を書いてください。**

## 4. 点検項目(R1〜R13。すべて必ず扱う。該当なしなら「問題なし」と根拠を書く)

- **R1 構成と依存方向**: パッケージの境界(kernel ↔ model ↔ ui ↔ io ↔ drawing)、Worker 境界と `kernelBridge`、再計算とキャッシュ(NFR-PF-3)、決定性(`determinism.test.ts`)、`raceWithBroken` の設計。循環・漏れ・重複。
- **R2 OCCT の使い方**: embind の所有権(`delete` の責任、10.13・10.16 の再発余地)、許容誤差(`Precision`、`BRepBuilderAPI_Sewing` 等)、ブーリアン・フィレットの失敗時の扱い(要件 FR-504、NFR-RE-1)、メッシュ化の品質(`DISPLAY_MESH_QUALITY`、`BRepMesh_IncrementalMesh` の引数)、変換(`gp_Trsf`・`TopLoc_Location`)、WASM のメモリ(〜4GB)・読み込み時間。**OCCT にもっと良い API がある箇所を具体的に名指しする。**
- **R3 モデル層**: 履歴(フィーチャー木・再計算・抑制・Undo)、式エンジンと単位、スケッチ拘束ソルバの数値安定性と収束、3D スケッチ、ねじ・規格データの持ち方。
- **R4 UI**: Zustand の 11 スライス構成、`viewport/` の Three.js の層(`createSolidLayer.ts`・`createAssemblyLayer.ts`)、ピック・選択(`SelectionMember` 4 種)、i18n(`packages/ui/src/i18n/ja/*.json`)、NFR-UX の守られ方、再描画の負荷。
- **R5 入出力**: `.pcad` / `.pcada` の版管理(schema v8、`PART_SCHEMA_VERSION`)と前方互換、STEP / STL / 3MF / OBJ / glTF / DXF の往復の落とし穴(単位・色・法線・トポロジ)、自動保存。
- **R6 P7 の残りの設計批評(最重要)**: §2.5 の合致ソルバ(6 自由度の変数・四元数の指数写像・ニュートン法・変数上限 600・連結成分)、§2.6 ジョイントと可動範囲、§2.7 干渉チェック(三角形の格子 + 重なりの体積。`BRepAlgoAPI_Common` / `BRepExtrema_DistShapeShape` / `BOPAlgo_CheckerSI` 等との比較)、§2.8 規格部品(JIS の表の持ち方)、§2.9 分解図と連番 PNG、§2.10 部品表、§2.15 STEP のアセンブリ構造(`STEPCAFControl` が使えるか否かを含む)。**タスク 11・14〜49 の並びと粒度**も批評する(依存・並列可能性・危ない順序)。
- **R7 P8 の設計批評**: HLR(`HLRBRep_Algo` と `HLRBRep_PolyAlgo` の選択、精度と時間)、第三角法の配置と自動縮尺、寸法の幾何と JIS スタイル、断面とハッチング、中間表現と 4 出口(画面・PDF・DXF・JPEG)、自前 PDF 書き出し、字体と文字輪郭(FR-319)。71 タスクの粒度と並び。
- **R8 P9〜P13 の技術リスク(計画未作成)**: 幾何公差の記号と枠(P9)、板金の曲げ・展開の OCCT での実現法(P10。`BRepOffsetAPI` 系・展開の数学・K ファクター)、スクリプト API の隔離と安全(P11)、ヘルプ生成・PWA・性能仕上げ(P12)、electron-builder・署名・自動更新・Cloudflare Pages の配信(COOP/COEP、WASM の圧縮、キャッシュ)・GitHub リリース(P13)。**各フェーズの計画書を書くときに先に決めるべき事項**を列挙する。
- **R9 P11b**: スプライン断面のロフト・案内線つきスイープ・G1/G2 指定(`BRepOffsetAPI_ThruSections` / `BRepOffsetAPI_MakePipeShell` の限界)、簡易強度計算の式と材料表の設計、CAM 橋渡しの現実性。
- **R10 検査と CI**: `scripts/check.ps1` の段階(Commit / Push)と隔離ワークツリー、E2E の壊れやすさ(WASM 読み込み・`waitForRecompute`)、性能検査の共有ランナー問題(10.12・10.14)、テストの穴(何が検査されていないか)、`useAppStore.test.ts` 3,206 行の扱い。
- **R11 性能と規模**: NFR-PF の上限と実装の整合、再計算の重い箇所、アセンブリ 50 部品・図面 A3 での見込み、メモリの解放。
- **R12 セキュリティと配布**: Electron(`contextIsolation`・`nodeIntegration`・preload・ファイル権限)、ファイル読み込みの入力検証(STEP / DXF / 3MF の悪意ある入力)、Web 版のヘッダ、依存の供給網。
- **R13 進め方**: タスクの粒度と並列性(共有ファイルの取り合い: `useAppStore.test.ts`、`i18n/ja/*.json`、`shell/` の目録)、計画書の作り漏れが出やすい箇所、残り 229 タスクを減らす/まとめる余地、手戻りを防ぐ順序。**Codex(gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra)へ渡すのに向く粒度**の助言。

## 5. 報告の書き方(`review.md`。日本語)

各項目 R1〜R13 について、見つけた点ごとに次の表の列を埋める(箇条書きでもよいが列は全部):

| 列 | 内容 |
|---|---|
| 現状 | 何がどうなっているか。**根拠 = ファイルパスと行(例 `packages/model/src/kernelBridge.ts:120-140`)、または計画書の節** |
| 問題・リスク | 何が起きうるか。重大度 **高 / 中 / 低** |
| 具体策 | 何を、どのファイル(または新規ファイル)へ、どう変えるか。OCCT の API 名・数式・データ構造まで |
| 根拠 | なぜその策が良いか(OCCT の仕様・数学・既知の実測・他 CAD の慣行) |
| 工数 | S(2 時間未満)/ M(2〜8 時間)/ L(8 時間超) |
| 置き場 | どのフェーズのどのタスクの前・後に入れるか、または新タスクとして追加か |

末尾に次の 4 節を置く:

1. **優先順位つきの上位 10 件**(重大度 × 工数 × 手戻り防止の効果で並べ、1 行ずつ理由)。
2. **変えないでよいもの**(見直したが妥当と判定した設計。根拠つき)。
3. **利用者(発注者。CAD の初心者)に決めてもらうべき事項**: 各事項に選択肢 2〜3 個と、それぞれの利点・欠点・工数を平易な言葉で。
4. **統括への申し送り**: 指示書を書くときに毎回書き添えるべき注意(OCCT の落とし穴・共有ファイル・検査の癖)。

長さの上限は設けない。ただし一般論・言い換え・水増しは禁止。**根拠(ファイル・行・API 名)の無い指摘は書かない。**

## 6. 過去の失敗で関係するもの(`rules/06`)

10.13(OCCT の所有権の誤り)、10.16(キャッシュ上の立体から借りた面を builder に渡して壊した)、10.18(E2E の並列本数)、10.12・10.14(共有ランナーの性能検査)、10.11・10.20(待ち行列とファイルの取り合い)。これらの**再発余地**を R2・R10・R13 で必ず点検する。

## 7. 使える道具

- ファイルの閲覧・検索(`rg`、`grep`、`cat`、`sed -n`、`wc`)。
- `git -C C:/Users/oltot/Documents/git-projects/PointerCAD log --oneline -50`、`git ... show <hash> --stat`、`git ... blame <file>`(読み取りのみ)。
- 禁止: 上記 §0 の 2・4。

## 8. 成果物

- `review.md`(本報告)と `progress.md`(進行記録)を作業ディレクトリ(= いまのカレントディレクトリ)に書く。
- 最終メッセージ: `review.md` の上位 10 件の見出しだけを 10 行で示し、§0-6 の 2 行で締める。
