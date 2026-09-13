# PointerCAD 全体レビュー 2026-09-12 (Claude Fable 5.1)

> 依頼: 「Codex Astra での実装に時間がかかっている。もっと効率よく早く実装できないか。レビューも実施し、コード品質・アーキテクチャ・セキュリティなど各項目を採点し、不備があれば根拠つきの修正案を出す。コードは編集しない。docs/reviews に md で出力する」「予測や予想で回答せず実際のコードを読んで評価すること」。
> 扱い: 本書は読み取りだけで作った。リポジトリ内で変更したのはこのファイルの新規作成 1 件だけである(付録 C)。実装・設定・依存・既存文書・作業ツリー・git には触れていない。

## 1. 要約

**総合評価: 74 / 100 点(加重計算値 73.9)。** 2026-09-09 の実装状態レビュー(66 点)から 8 点の改善。改善の中身は、保存の原子性・ZIP の展開前検査と CRC・CSP と Electron の権限拒否・Firefox / 実 Electron の E2E など、前回の P1 / P2 指摘がほぼ実コードに入ったこと(§9)。一方で、**CI が 9/11 01:14 から両 OS で赤のまま 2 日以上放置されている**こと、巨大ファイルへの変更集中、model パッケージの OCCT テストが Vitest 既定 5 秒の timeout に依存していること、が点を下げている。

**実装が遅い主因は「コードの出来」ではなく「体制と手順」にある。** 実測(§4.1)では、9/9〜9/11 は 1 日 37〜54 件のタスクが main に着地していた。9/11 22:27 の着地以降、数学入力 13 件 + 関数作図 14 件 = 27 件を 1 束として 1 体の Codex セッションが直列に実装しており、本書作成時点(9/12 14:10)で 16 時間経過・未コミット 130 ファイル、Codex 自身の見込みは着地まであと 37〜67 時間である。遅延の構造は次の 6 点に分解できる(§4.2)。

1. **並列度 1**: `codex resume --last --dangerously-bypass-approvals-and-sandbox` の単一対話セッション(PID 21556、9/10 10:05 起動、CPU 時間 13,352 秒)が実装・検査・記録・git・利用者応対を全部直列で行う。委譲もサブエージェントも停止中。
2. **束が大きく、途中成果が検証されない**: 「10 件以上をまとめて main へ」の運用で、27 件束は 16 時間以上未コミットのまま。CI の早期検知が効かず、失敗時の手戻りが束全体に及ぶ。
3. **ゲートの重さと重複**: 文書だけの push にも約 40 分(E2E 179 件 22.6 分を含む)。pre-commit も写し worktree で毎回フルの型検査・全ユニットを回す。
4. **CI が赤のまま放置**: Windows は model の OCCT テスト 4 件が 5 秒 timeout、Linux は品質ゲート自己試験 2 件(ジャンクション)。「CI 補修だけの先行コミットは認めない」「ログをもらってから直す」の 2 規約が組み合わさり、赤が 2 日続いている。
5. **報告のオーバーヘッド**: 報告記録の見出しは 9/9 40 件、9/10 46 件、9/11 51 件、9/12 37 件(14:10 まで)。1 件あたり数百〜1,500 字で、「低確度の見込み」の定型文が 29 回再計算・再掲されている。利用者からの質問応答(12 件)も同じ直列の中で処理される。
6. **受入条件の厳密さが自己設定で研究水準**: 関数作図の計画(Codex 自身が 9/11 に作成)は「厳密な有理数多項式としての認識」「区間微分による未解決領域の被覆証明」「同一枝追従の証明」を求めており、1 タスクの粒度が不均一(Codex 自身が 9/12 13:58 に認めている)。

推奨する対応順は §10。要点は「CI を緑に戻す小さな着地を 1 回だけ許す → ブランチ + 小コミット(main へのマージは 10 件束のまま)→ 委譲の再開で並列度 2〜3 → pre-push の E2E を Chromium に絞り Firefox / Electron は CI へ → 報告の定型化 → 関数作図の受入条件を『検証済み近似 + 明示』へ」の順である。いずれも利用者の決定事項(10 件束・例外なし・サブエージェント禁止)に関わるため、採否は利用者の判断として選択肢で示す。

## 2. 対象・方法・限界

### 2.1 対象の固定

| 項目 | 値 |
|---|---|
| HEAD | `2baa0e6` (2026-09-12 12:57 +0900)、origin/main と一致、未 push 0 件 |
| 作業ツリー | 追跡ファイル 130 件が変更(+1,527 / −384 行)、未追跡を含め `git status --porcelain` 211 行。`pnpm-workspace.yaml` / `pnpm-lock.yaml` に依存 2 件(`@cortex-js/compute-engine` 0.128.6、`mathlive` 0.110.0)の追加を含む |
| 製品コード | 200,351 行 / 1,014 ファイル(packages 8 + apps 2、テストを除く。§付録 A) |
| テスト | ユニット 173,951 行 / 613 ファイル、E2E 12,940 行 / 54 spec。`it` / `test` の静的計数はユニット 10,706 件・E2E 158 件(Codex の報告値は 12,198 件・179 件。`it.each` の展開と project の重複で増える) |
| コミット | 383 件(9/1〜)。Co-Authored-By は Claude 360 件、Codex 23 件 |
| CI | GitHub Actions run 34673998264(2baa0e6)・34609271048(858d68c)・34549852690(7628fd3)がいずれも両 OS で failure。最後の success は b3a41c5(9/10 22:08) |

### 2.2 実施した方法

- `CLAUDE.md`、`rules/` の 7 文書、`docs/requirements.md` §5・§9、`docs/plans/追加-関数作図.md`、`docs/引き継ぎ/2026-09-07-Astra統括.md`、`docs/reviews/` の既存 3 本、`docs/報告記録.md` の 9/12 の全節と 9/11 以前の見出し、`docs/progress.json` を読んだ。
- 実コードは次を全文または主要部を読んだ(付録 B に一覧): Electron 本体 6 ファイルと preload、CSP と Web の配信設定、ZIP 読込 3 ファイル、スクリプト実行器 4 ファイル、形状キャッシュ、OCCT の所有権ヘルパーとブーリアン、kernel Worker の窓口(先頭 260 行と一覧)、kernelBridge の接続寿命(2,649〜2,810 行)、Zustand ストアの合成、Undo、式評価の文脈、compute-engine の起動、保存形式の版管理、図面 SVG の escape、フォント読込、板金テスト、Playwright 設定、check.ps1、CI ワークフロー、ESLint 設定。
- 実測は読み取りコマンドだけで行った: `git log / diff / status / worktree list / stash list`、`find` と `wc` による行数、`grep` による抑止マーカー・危険 API・境界違反の計数、GitHub REST API による CI の結果と job の取得、`.git/ci-job-*.log` の時刻から段ごとの所要、`Get-CimInstance Win32_Process` による稼働中プロセスの起動時刻とコマンドライン、`scratchpad/` の内容。
- **実行していないもの**: `scripts/check.ps1`、Vitest、Playwright、ビルド、アプリの起動、ブラウザ操作。理由は①コード・作業ツリーを一切変えない指示、②Codex セッションが同じ機械で検査を回しており CPU 競合で性能検査を落とす(rules/06 10.3)、の 2 点。性能・fps・UI の挙動は Codex の報告値を「報告値」と明記して引用し、本書の実測とは区別する。
- 20 万行を同じ深さで精読したという意味ではない。境界(入出力・IPC・Worker・保存・サンドボックス)と、規模と変更の集中する場所を優先した。

### 2.3 並行作業の注意

本書の作成中も Codex セッションが作業ツリーを更新している(9/12 14:10 に `docs/報告記録.md`・`rules/06`・`packages/expression/src` が変わった)。本書の行番号は 14:00 前後の作業ツリーのもの。未コミット分の設計を評価対象にした箇所は「作業ツリー」と明記する。

## 3. 採点

採点方法は 2026-09-09 レビューと同じ 10 項目・同じ重みで、比較できるようにした。点数は「確認した実装と検証範囲に基づくレビュー判断」であり、障害率や網羅率の測定値ではない。

| 項目 | 09-09 | **今回** | 重み | 加重点 | 根拠(§で詳述) |
|---|---:|---:|---:|---:|---|
| アーキテクチャ・責務分離 | 80 | **78** | 15% | 11.70 | 層の依存方向は lint で機械施行され違反 0(§5.1)。Worker 境界と接続寿命は堅い(§5.2)。減点は kernelBridge 3,480 行・expression の `./math/*` 副入口 36 本・desktop と ui の契約の写し(§5.3〜5.5) |
| コード品質・保守性 | 70 | **62** | 10% | 6.20 | 抑止マーカー 0・`any` 0 は良い。numericInput 5,712 行(case 295)、resolvePart 5,303 行(case 152)、PropertyPanel 3,371 行にさらに変更が集中。整形器が無く直近コードは 1 行詰め込み(§6) |
| 数値計算・モデルの正確性 | 60 | **74** | 15% | 11.10 | exact な変数と非長さ変数を評価文脈に持つ(evaluate.ts)。OCCT の所有・借用の規律と lint。関数作図は作業ツリーで検証途中。今回、数値を実行して再現していない(§6.7) |
| 保存・復旧・データ保全 | 45 | **78** | 15% | 11.70 | 一時ファイル → rename → 失敗時は backup を保持(pcadDialogs.ts)。保存先の revision 照合。schema 版 14 の明示的移行(schema.ts)。ZIP の展開前検査と CRC(§7.3) |
| セキュリティ・入力境界 | 65 | **84** | 15% | 12.60 | contextIsolation / sandbox / 送信元検証 / 権限全拒否 / CSP / 独自スキームのパス検査 / QuickJS の資源上限 / 動的コード生成 0 / 外部送信 0(§7)。減点は運用(`--dangerously-bypass-approvals-and-sandbox`)と小さな robustness |
| テスト・回帰防止 | 70 | **72** | 10% | 7.20 | 1 万件超のユニット・3 ブラウザ E2E・性能予算・進捗台帳の整合検査。減点は model の OCCT テスト 29 ファイルが既定 5 秒 timeout に依存し CI が赤(§8) |
| 性能・資源管理 | 70 | **76** | 8% | 6.08 | Worker 専有・形状キャッシュの acquire/release・掃引体の許容値の実測根拠。報告値の 50 部品 57.3fps は未検証(§5.2) |
| 操作性・未保存保護 | 65 | **70** | 5% | 3.50 | 前回 R03 の修正が施行表(rules/00)に入っている。UI の実操作は今回未確認 |
| CI・検証の再現性 | 75 | **45** | 5% | 2.25 | main の CI が 9/11 01:14 から両 OS で赤。手元の pre-push が緑でも CI が赤になる OS 差が 2 種類あり、手元ゲートが CI を代表できていない(§8.2) |
| 文書・要件追跡 | 80 | **80** | 2% | 1.60 | 要件 ID・計画・台帳・失敗記録の追跡は維持。報告記録は 955KB・2,440 行で読み手の負担が大きい(§4.2) |
| **合計** | **66** | | **100%** | **73.93** | **四捨五入で 74 点** |

これとは別に、**開発プロセスの効率を 40 / 100** と評価する(§4)。品質点とは別の軸であり、上の合計には含めない。

## 4. 実装が遅い理由(実測)と改善提案

### 4.1 実測値

**(a) 着地の推移**(`git log --shortstat` と `docs/progress.json`)

| 着地日時 | 件名の件数 | ファイル | 追加行 | 直前の着地からの時間 |
|---|---:|---:|---:|---:|
| 09-09 08:40 | 11 | 61 | 4,154 | 2.2 h |
| 09-09 12:10 | 13 | 66 | 4,174 | 3.5 h |
| 09-09 15:18 | 10 | 72 | 3,096 | 3.1 h |
| 09-09 19:41 | 10 | 74 | 4,148 | 4.4 h |
| 09-09 23:19 | 10 | 110 | 4,103 | 3.6 h |
| 09-10 06:57 | 11 | 192 | 8,594 | 7.6 h |
| 09-10 21:18 | 26 | 288 | 12,679 | 14.4 h |
| 09-11 09:27 | 25 | 333 | 19,271(−6,971) | 12.2 h |
| 09-11 22:27 | 29 | 283 | 9,731 | 13.0 h |
| 進行中(27 件: 数学 13 + 関数 14) | 27 | 130+(追跡分) | 1,527(追跡分) | **16 h 経過、Codex の見込みは着地まであと 37〜67 h** |

1 日あたりの着地件数は 9/9 54 件、9/10 37 件、9/11 54 件、9/12 0 件(14:10 時点)。つまり「遅い」のは今の 27 件束に固有で、9/11 までの束は 10〜14 時間で 25〜29 件を着地させていた。

**(b) ゲート 1 回の所要**(CI の Windows job、run 34609271048、時刻はログの記録)

| 段 | 所要 | 備考 |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 14 s | |
| 品質ゲート自己試験(check.selftest.ps1) | 20 s | 毎回実行 |
| typecheck | 49 s | |
| lint(型情報つき ESLint) | 2 min 07 s | 静的検査で最も重い |
| ユニット: test-utils / ui / help-content / io | 3 s / 84 s / 1 s / 18 s | `--workspace-concurrency=1 --reverse` |
| ユニット: model | 3 min 10 s で中断 | 4 件 timeout。kernel / drawing / expression は未到達 |
| build / E2E | 未到達 | |

手元の push(Codex の報告 9/12 13:50): **全体約 40 分、うち E2E 179 件 22.6 分**。厳密モードでは ui と model のユニットも 1 worker 直列(`vitest.config.ts` の `fileParallelism: process.env.POINTERCAD_PERF_STRICT !== '1'`)。文書 304 行だけのコミットにもこの 40 分がかかった。

**(c) 体制**(`Get-CimInstance Win32_Process`、9/12 14:10)

| PID | 起動 | コマンド | CPU 時間 |
|---:|---|---|---:|
| 21556 | 09-10 10:05 | `codex.exe resume --last --dangerously-bypass-approvals-and-sandbox` | 13,352 s |
| 14288 | 09-10 23:29 | `codex.exe app-server`(Codex アプリの補助) | 366 s |

作業担当の並列起動(rules/01 §2 の `codex exec` + worktree)は 9/8 の P7 以降使われていない。`C:/Users/oltot/AppData/Local/Temp/PointerCAD-codex/worktrees` に 9/8〜9/9 の worktree 12 本(710MB)が残っている。

**(d) 報告の量**(`docs/報告記録.md`)

| 日 | 見出し数 |
|---|---:|
| 09-09 | 40 |
| 09-10 | 46 |
| 09-11 | 51 |
| 09-12(14:10 まで) | 37 |

「低確度」の見込み文は 29 回、「利用者への回答」の節は 12 回。9/12 の各節は「完成度・見込み」の段落を毎回再計算して再掲している。

**(e) 作業の道具**(`scratchpad/p8-next-implementation`)

1,098 ファイル。`apply_*.py` は「`.next` ファイルを用意 → python で存在を assert → コピー」という手順で製品ファイルを差し替え(例 `apply_hole_e2e.py`、`apply_flat_source.py`)、`append_timed_report.py` は報告記録の見出し時刻と「あと N〜M 分」を機械生成している。編集 1 回に「下書き + 適用スクリプト + 証跡の複製(`shutil.copytree(root / 'test-results', evidence)`)」の 3 段取りがある。

### 4.2 遅さの構造(根拠つき)

| # | 要因 | 根拠 | 影響 |
|---|---|---|---|
| 1 | **並列度 1** | (c)。rules/01 §「現在の利用者指示」に「単独実装へ変更…サブエージェントは禁止」 | 実装・検査・記録・応答が全部直列。40 分のゲート中も次の実装を進める工夫(報告に「待機中に下書き」)はあるが、同一セッション内の切替であり並列ではない |
| 2 | **束の大きさ** | (a)。rules/03 §6「実装コミットは 10 件以上」、rules/01「CI 補修だけの先行コミットも例外にしない」 | 27 件束が 16 時間以上未コミット。作業ツリーのバックアップ zip を `.git/` に 12 個(0.5〜1.35MB)積む運用になっている。束の途中で CI の検証を受けられない |
| 3 | **ゲートの重複と重さ** | (b)。rules/03 §7.1 は pre-commit 4 段(写し worktree でフル typecheck)+ pre-push 5 段 + CI 両 OS。`e2e/playwright.config.ts` は firefox project が functional と同じ spec を再実行 | 文書だけの push に 40 分。E2E の 22.6 分は Chromium 機能 + Firefox 再実行 + 実 Electron + 性能 project の直列依存(`dependencies: ['viewport-performance']`)で決まる |
| 4 | **CI が赤のまま** | §8.2。Windows は `closedRelief.test.ts` 3 件・`lineBendKernel.test.ts` 1 件が `Test timed out in 5000ms`、Linux は `check.selftest.ps1` のシナリオ 8・11 | 9/11 01:14 以降、CI は製品テストを 1 件も Linux で走らせていない(自己試験で step 0 が止まる)。「同じ SHA の両 OS CI 成功」を完了条件にしているため、完成度が上がらない状態が続く |
| 5 | **報告と応答のコスト** | (d)。rules/01「状況や見込みを尋ねられたときは作業中の報告として回答」 | 見込みの再計算・再掲が実装時間を食い、読み手も 955KB の記録から状態を読み取れない |
| 6 | **受入条件の厳密さ** | `docs/plans/追加-関数作図.md` §1.3・§2(Codex 作成)。報告記録 9/12 10:36〜13:58「区間微分による空領域の証明」「厳密な有理数多項式として認識」「同一枝追従…証明できない点は再選択を要求」 | ADD-7/8/12/13 が研究水準の受入になり、1 項目の大きさが不均一(Codex 自身が 13:58 に「見積もりの不備」と記載)。計画 §1.3 自身は「任意関数に数学的な厳密誤差保証があると偽らない」と言っており、証明を必須にする根拠は計画にも要件にも無い |
| 7 | **変更が巨大ファイルに集中** | §6.1。`numericInput.ts` 5,712 行・`resolvePart.ts` 5,303 行・`kernelBridge.ts` 3,480 行・`PropertyPanel.tsx` 3,371 行は今回の作業ツリー差分にも全部含まれる | 1 機能ごとに同じ巨大ファイルを触るため、lint(2 分)・型検査・差分読みが毎回全体に及ぶ |
| 8 | **編集の段取り** | (e) | 直接編集(apply_patch)に比べ、下書き・適用スクリプト・証跡複製の 3 段が毎回入る。証跡の目的は分かるが、git のブランチと小コミットで代替できる |

### 4.3 改善提案(優先順)

効果の見積もりは §4.1 の実測から導いた目安で、保証値ではない。規約変更が要るものは「要決定」と明記する(利用者の決定事項: 10 件束、例外なし、サブエージェント禁止、CI はログを待つ)。

| 順 | 提案 | 具体策 | 期待効果 | 要決定 |
|---|---|---|---|---|
| 1 | **CI を緑に戻す小さな着地を 1 回だけ許す** | 作業ツリーに既にある 2 修正(model の板金テストの独立ケース化、`scripts/lib/directoryLinks.ps1` のリンク処理)だけを、実装 27 件と切り離して main へ。加えて §8.3 の `testTimeout` を model の OCCT テストに明示 | CI の早期検知が復活。以後の束が「同一 SHA 両 OS 緑」で確定できる。1〜2 時間 | **要決定**(「CI 補修だけの先行コミットを認めない」の例外) |
| 2 | **ブランチ + 小コミット、main へのマージは 10 件束のまま** | `feature/add-math-function` 等のブランチで 1 タスク 1 コミット。`ci.yml` は `pull_request` でも走るので PR を開けば束の途中でも両 OS CI が回る。main へは squash か merge で 10 件以上を一括 | 未コミット 130 ファイル・zip 12 個の運用が消える。失敗の切り分け単位が 1 タスクになり手戻りが減る | **要決定**(rules/03 §6 の「main へ直接」の読み替え) |
| 3 | **委譲の再開で並列度 2〜3** | rules/01 §2 の仕組みと `docs/引き継ぎ/2026-09-07/tools` は現存。Astra を統括 + レビューに戻し、sol / terra を別 worktree・別ファイル所有で起動。関数作図の依存(ADD-3→4→5→{6,7}→8→9、10→11、12→13→14、15、16)では (6,7)・(10 と 8/9)・(11 と 12)・(13 と 14 の前半) が同時に進められる | 27 件束の残りで 1.5〜2 倍。以後の束(P12 ヘルプ 30 件・P13 公開 15 件)は文書と検査が中心で並列に向く | **要決定**(「サブエージェント禁止」は Claude の Agent ツールへの決定。Codex 同士の並列は rules/01 §2 に規定済み。再開の明示が要る) |
| 4 | **pre-push の E2E を Chromium に絞り、Firefox / 実 Electron は CI と夜間へ** | `playwright.config.ts` の firefox / electron project を環境変数で切替。手元の pre-push は `viewport-performance` + `functional`、CI と夜間は全 project | E2E 22.6 分 → 10 分前後(firefox が functional と同じ spec を再実行しているため)。push 40 分 → 25 分前後 | **要決定**(rules/03 §7.1 R12「Firefox と実 Electron も通常の E2E へ含める」) |
| 5 | **pre-commit を変更パッケージ + 下流に限定** | `pnpm --filter "...[origin/main]" run test` 相当を写し worktree の中で実行。全パッケージは pre-push と CI で維持 | 4 段のうち typecheck(49 s)は据え置き、ユニット(5 分超)が半減以下。lint は `eslint --cache --cache-location` を手元だけで使う | 要決定(rules/03 §7「変えたパッケージのテストだけで合格としない」。pre-push と CI で全体を保つなら趣旨は守れる) |
| 6 | **報告の定型化** | 着地時と 2 時間ごとに 8 行以内の定型(完成度・着地 SHA・進行中 ID・次の検査・阻害要因)。「あと N〜M 分」の再計算をやめ、見込みは 1 日 1 回。利用者の質問には短く答えて実装へ戻る(rules/06 10.57 の趣旨) | 報告 1 日 40〜50 件 → 10 件前後。読み手が状態を把握できる | 統括の運用。規約変更は不要 |
| 7 | **関数作図の受入条件を「検証済み近似 + 明示」へ** | ADD-7/8/12/13 の「証明」を「代表例での数値検証 + 精度と未解決の明示表示」に。ADD-12 を 12a(直接式で一意に決まる点)と 12b(多解・追従)に分割し、12b を将来 115 件側へ | 27 件束の残りを数日から 1 日規模へ。計画 §1.3「厳密誤差保証があると偽らない」と整合 | **要決定**(利用者の 9/11 追加指示の範囲) |
| 8 | **作業場の掃除** | `git worktree remove` で 9/8〜9/9 の 12 本(710MB)、`stash@{0}`(9/9)の要否確認、`.git/*.zip` の外出し、`scratchpad/p8-next-implementation` 1,098 ファイルの整理 | `git status` と各ゲートの前後比較が軽くなる。誤って古い worktree を検査する事故の予防 | 統括の運用 |
| 9 | **編集手順の簡素化** | `apply_*.py` + `.next` の差し替えをやめ apply_patch で直接編集。証跡はブランチのコミットで残す | 1 編集あたりの段取りが 3 → 1 | 統括の運用 |
| 10 | **`--dangerously-bypass-approvals-and-sandbox` をやめる** | `-s workspace-write` + 承認方針を戻す。少なくとも作業用 worktree に閉じる | 安全性(§7.6)。速度への影響は小さい | 利用者の運用 |

## 5. アーキテクチャ

### 5.1 維持できているもの

- **層の依存方向は機械施行され、違反 0。** `eslint.config.js` の `layerRules` が expression / help-content / kernel の逆依存、model → ui/io、drawing → kernel/model/ui/io、ui/apps → kernel/opencascade.js を禁止。`grep` で `packages/ui/src` と `apps` からの `@pointercad/kernel` import は 0、`packages/model/src` からの `@pointercad/io` import は 0。
- **状態は Zustand 1 本。** `packages/ui/src/store/useAppStore.ts` は 17 スライスを `STORE_SLICE_CREATORS` に登録し、`storeSlices.test.ts` が所有欄の重複を検査する(rules/00)。Undo は不変スナップショットの `undoStack.ts`(上限 200、800ms の集約)で、文書型に依存しない。
- **幾何は Worker の中。** `packages/model/src/kernelBridge.ts` 2,676〜2,806 行の接続は、`waiters: Set<() => void>` で RPC ごとに通知を登録し `finally` で外す(前回 R1-4 の指摘どおり)。Worker の `error` / `messageerror` で全 RPC を `workerBroken` に決着させ、`closeKernelConnection` は releaseProxy の失敗を握りつぶして必ず `terminate()` へ進む。
- **保存形式の版管理。** `packages/io/src/pcad/schema.ts` は版 1〜14 の各移行の理由を注釈で残し、任意欄の追加では版を上げない方針(前方互換)を明文化。
- **OCCT の所有権。** `allocations.ts` の逆順解放と例外時の投げ直し、`booleanOp.ts` の `SetNonDestructive(true)`・入力リストの即時解放・`hasResultSolid` の走査中解放、`borrowHandle` の型から `delete` を除く設計と `keep(handle.get())` の lint 拒否(rules/00)。

### 5.2 Worker と資源

- `shapeCache.ts` は LRU に `acquire / release`(参照カウント、`retired` の遅延解放、保護対象だけで予算超過したときの診断)を足しており、前回 R1-3 の設計に沿う。
- 軽微: `trim()` は `while` の各周回で `Array.from(retired.values()).reduce(...)` を再計算する(`shapeCache.ts` 約 140 行)。容量 256 では問題にならないが、退避件数のカウンタを持てば O(1) になる。
- `recomputeSolids.ts` の掃引体だけ粗いテッセレーションを当てる判断(0.15mm / 0.7rad)は、実測表つきで根拠が残っている。良い。

### 5.3 kernelBridge.ts が 3,480 行(要改善)

「model から幾何カーネルへの唯一の接点」という設計は正しいが、1 ファイルに①型変換(`toSolidStepSpec` 1,695〜1,966 行など)、②接続寿命、③アセンブリ干渉・図面・関数の橋、④公開型 60 種以上、が同居している。`createKernelBridge`(2,984〜3,304 行)だけで 320 行。

**修正案**: 公開窓口 `kernelBridge.ts` は型と `createKernelBridge` のみ残し、`packages/model/src/kernel/convert/{sketch,solid,measure,exchange,printability,interference}.ts` と `kernel/connection.ts` に分ける。既存の import 先(`from './kernelBridge.js'`)は変えない(re-export)。前回 R1-1 で「必要な機能を追加する時だけ」とした方針のとおり、関数作図の橋(`FunctionKernelBridge`)を足した今が切り出しの時期。

### 5.4 expression の公開入口が `./math/*` 36 本(要改善)

`packages/expression/package.json` の `exports` に `./math/mathInputContract` から `./math/legacyMathLatex` まで 36 の副入口がある(作業ツリー)。内部モジュールを 1 つずつ公開している状態で、`packageBoundary.test.ts` で「実 import の公開入口を解決する」検査を足したのは症状への対処。

**修正案**: `./math`(1 本)に barrel を置き、Worker 実行用と UI 用で分けるなら `./math/worker` と `./math/client` の 2 本に限定する。副入口を増やすたびに package.json・dist 型・検査の 3 か所が増える。

### 5.5 desktop と ui の契約の写し(要改善)

`apps/desktop/src/main/pcadDialogs.ts` は `KIND_FILTERS`、`PCAD_FILE_FILTER` の文言、`MAX_COMPRESSED_INPUT_BYTES`(= io の `IO_LIMITS.archiveCompressedBytes`)を「写し」と注釈して持つ(「片方を直したらもう片方も直す」)。一方 `@pointercad/ui/open-with`・`/print-settings`・`/save-errors`・`/security-policy` は副入口で共有できている。

**修正案**: 同じ方式で `@pointercad/ui/file-kinds`(種類・拡張子・表示名)と `@pointercad/ui/io-limits`(io の上限の再 export)を副入口に足し、desktop はそれを import する。React を含まない純データなので main プロセスの束にも入れられる(open-with と同じ)。写しの注釈と「揃えるテスト」が不要になる。

### 5.6 ui パッケージの肥大(中期)

ui は 84,673 行で製品コードの 42%。`numericInput.ts`(道具ごとの入力状態機械)、`solidSummary.ts`(3,599 行)、`solidCommands.ts` などは「画面」ではなく道具の定義とコマンドであり、model と ui の中間層に相当する。層を増やすのは rules/04 の変更になるため今は提案に留めるが、§6.1 の分割を進めるときに `packages/ui/src/tools/<tool>/` の単位で切ると、将来の層分離が容易になる。

## 6. コード品質・保守性

### 6.1 巨大ファイルと巨大 switch(最優先の保守性課題)

| ファイル | 行数 | 関数数 | `case '` の数 | 今回の作業ツリー差分 |
|---|---:|---:|---:|---|
| `packages/ui/src/sketch/numericInput.ts` | 5,712 | 133 | 295 | +46 |
| `packages/model/src/part/resolvePart.ts` | 5,303 | 98 | 152 | +30 |
| `packages/ui/src/solid/solidSummary.ts` | 3,599 | | | +34 |
| `packages/model/src/kernelBridge.ts` | 3,480 | | | +37 |
| `packages/ui/src/shell/PropertyPanel.tsx` | 3,371 | 41(節ごとの関数、`useAppStore(` 53 回) | | +82 |
| `packages/ui/src/shell/FeatureTree.tsx` | 1,326 | `FeatureTree` 1 関数が 336〜1,326 行 | | |

前回 R14 と同じ指摘だが、io の codec は分割された(`documentJson.ts` 6,856 → 655 行 + codec 26 個、`eslint.config.js` で `max-lines` 700 / `max-lines-per-function` 200 を io の codec にだけ適用)一方、ui / model の 4 本は据え置きで、今回の 27 件束でも全部に変更が入っている。

**修正案(根拠: io で既に成功した方式の横展開)**:
1. `eslint.config.js` の `max-lines` / `max-lines-per-function` を ui / model にも適用する。ただし現状値で落ちないよう**ラチェット**にする: 各巨大ファイルに現在の行数を上限として `overrides` を書き、新規ファイルは 700 / 200。増えたら lint が落ち、減らした分だけ上限を下げる。
2. `numericInput.ts` は「道具 ID → 入力欄の定義・既定値・確定処理」の表(`Record<NumericInputToolId, ToolDefinition>`)に変え、道具ごとに `packages/ui/src/sketch/tools/<tool>.ts` へ。295 個の `case` の大半は道具別の分岐なので機械的に移せる。
3. `resolvePart.ts` は `plan*` 関数(planExtrude 1,219 行〜、planHole、planFillet…)が 1 フィーチャー 1 関数で既に切れているので、`part/plans/<feature>.ts` に移し、`resolvePart.ts` は順序制御と参照解決だけにする。
4. `PropertyPanel.tsx` は節ごとの関数(`SolidProperties` 858〜1,174 行、`AppearanceSection` 2,099〜2,421 行など)が独立しているため、ファイル分割だけで済む(挙動変更なし)。`FeatureTree` は 990 行の単一関数で、メニュー・ドラッグ・描画の 3 つに分けられる。

### 6.2 書式の不統一(整形器が無い)

リポジトリに Prettier 等の整形器が無く、ESLint も書式規則を持たない。初期のコード(例 `pcadDialogs.ts`、`shapeCache.ts`)は 1 文 1 行だが、直近の Codex のコードは 1 行詰め込みが多い。

- `packages/expression/src/math/createMathBackend.ts`: `import {CancellationError,ComputeEngine} from ...`、`engine.jit='off';engine.angularUnit='rad';engine.iterationLimit=1000;engine.recursionLimit=64;` のように空白を省いた 1 行。
- `apps/desktop/src/main/exportHandoffIpc.ts` 40 行: `try { await shell.openExternal(CAM_TOOL_URLS[args[0]]); return true; } catch { return false; }` を 1 行。
- `packages/model/src/sheetMetal/closedRelief.test.ts`: `const input = fixture(...), before = JSON.stringify(input.body);` のような複数宣言 + `if (!result.ok) throw ...` の 1 行化。

**修正案**: Prettier(既定設定 + `printWidth 120`)を devDependencies に追加(依存追加なので統括承認が要る)し、`pnpm run lint` の前に `prettier --check` を置く。既存コードは 1 回だけ一括整形のコミットを作り、以後は差分が読みやすくなる。整形器を入れない場合でも、`max-statements-per-line: 1` と `max-len 140` を ESLint に足せば詰め込みは止まる。

### 6.3 良い点(維持)

- 抑止マーカー 0: `eslint-disable` / `@ts-ignore` / `@ts-expect-error` / `: any` / `as any` はいずれも製品コードに無い。`as unknown as` はテスト 2 か所のみ(`overlapGrid.test.ts` 27 行、`quadControls.test.ts` 26 行。前回 R14 が指摘したもの)。TODO / FIXME 0。
- `tsconfig.base.json` は `strict` + `noUnusedLocals` + `noImplicitReturns` + `noFallthroughCasesInSwitch` + `verbatimModuleSyntax`。ESLint は `recommendedTypeChecked`。
- `console.*` は製品コードに無い(該当 7 件はスクリプト例の文字列と test-utils)。
- UI 文字列は `packages/ui/src/i18n/ja/*.json` 16 ファイルに分離され、直書きは `i18n.test.ts` が検出する(rules/00)。
- 注釈に判断の日付と実測値が残っており(例 `recomputeSolids.ts` の許容値の表、`schema.ts` の版の履歴)、追跡性が高い。行数を押し上げてはいるが、削るより `docs/` へ移して 1 行の参照にするのが良い。

### 6.4 Undo・状態管理

`undoStack.ts` は純関数で `next === present` の重複積みを避け、`coalesceKey` と時刻で集約する。`useState` は ui 全体で 152 か所あり、rules/04「表示専用の一時状態だけ」を全件は確認していない(件数の記録のみ)。

### 6.5 `appProtocol.ts` の小さな robustness

`handleAppScheme` は `decodeURIComponent(relativePath)` を try なしで呼ぶ(約 45 行)。`%E0%A4%A` のような不正な符号化は `URIError` になり、`protocol.handle` の Promise が reject して Electron 側のエラー応答になる。セキュリティ上の穴ではない(root の外へは出ない)が、400 を返す方が意図が明確。

### 6.6 依存の追加

作業ツリーの `pnpm-workspace.yaml` に `@cortex-js/compute-engine` 0.128.6 と `mathlive` 0.110.0 が加わり `pnpm-lock.yaml` が 55 行増えている(未コミット)。`docs/plans/追加-数学入力.md` 98〜99 行は両ライブラリの公式資料を参照しているが、統括による採否の記録(rules/02「差分案を統括へ提出し、統括が差分を読んで採否を決める」)は本書で確認できなかった。9/11 の利用者追加指示に伴うものと思われるので、着地前に報告記録へ「採用理由・版・ライセンス・同梱物の大きさ」を 1 節残すことを勧める。`compute-engine` は `engine.jit='off'`、`withTimeLimit 200ms`、`precision 40` で使われており(createMathBackend.ts)、実行は「使い捨ての計算 Worker の中」と注釈されている。

### 6.7 数値と精度(読み取りの範囲)

`evaluate.ts` は `Decimal.clone`(精度 40、ROUND_HALF_EVEN)を式評価専用に持ち、`EvaluateContext` に `exactVariables`(丸めない十進表記)と `nonLengthVariables` を持つ。前回 R04 / R05 の「依存解析と文書反映で評価文脈が違う」問題に対応する構造になっている。今回、式を実行して値を再現していないため、R04/R05/R08 の解消は「構造で確認」に留める。

## 7. セキュリティ

### 7.1 総評

境界の設計は堅く、前回 R11 / R12-2 / R12-3 の指摘が実コードに入っている。**製品コードに `eval` / `new Function` / `innerHTML` / `document.write` は 0**(`new Function` の grep 32 件はすべて `new FunctionCurveWorkerClient(...)` 等のクラス名で、`Function\s*\(` の厳密検索では `formatMathText.ts` の文字列出力 1 件のみ)。**外部送信は 0**: 製品コードの `fetch` は OCCT 資産の manifest と圧縮 WASM(同一 origin)、同梱フォント(`fonts/NotoSansJP-Regular.otf`、`apps/web/public/fonts` に実体 4,533,028 バイト、`fontAsset.ts` の `source` は出典の記録)だけ。NFR-SE-1 を満たす。

### 7.2 Electron(apps/desktop)

| 項目 | 確認した実装 | 評価 |
|---|---|---|
| レンダラの隔離 | `main.ts` 44〜46 行と 90〜92 行: `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。印刷用の隠し窓には preload を渡さない | 良 |
| IPC の送信元 | `appSender.ts` `validateAppSender`: 登録済み WebContents(WeakSet)+ mainFrame 一致 + `app://pointercad` または明示の開発サーバー origin | 良 |
| ナビゲーションと新窓 | `will-navigate` で許可 origin 以外を拒否、`setWindowOpenHandler` は完全一致の CAM URL 表(`openWith.ts` `isAllowedCamUrl`)だけ `shell.openExternal` し、常に `deny` | 良 |
| ブラウザ権限 | `sessionPermissions.ts`: request / check / device / displayMedia を全部拒否 | 良 |
| 独自スキーム | `appProtocol.ts`: host 検査、`normalize(join(root, decodeURIComponent(path)))` が `root + sep` で始まることを要求、CSP / X-Frame-Options / Referrer-Policy / COOP / COEP / CORP を応答に付与 | 良(§6.5 の URIError のみ) |
| ファイル IO | `pcadDialogs.ts` `readBytesFrom`: `stat` でサイズ上限(256MiB、`.pcadscript` は 6MiB + 64KiB)→ 読後に `byteLength === size` を再確認。`writeBytesTo`: 一時ファイル `wx` → `rename`、失敗時は `.backup-` を `COPYFILE_EXCL` で作ってから上書き、復元不能なら backup を残す(前回 R01) | 良 |
| 保存先の寿命 | `targetRevisions` を sender ごとに持ち、古い保存完了が新しい文書の保存先を上書きしない(前回 R02) | 良 |
| CAM 受け渡し | `exportHandoffIpc.ts`: `isCamFormat` / `isCamTool` で列挙を検査してから `CAM_TOOL_URLS[...]`、`openPath` は registry の token を解決 | 良 |
| 印刷 | `drawingPrintDocument.ts`: SVG を base64 の `data:` 画像で埋め、文書側に `default-src 'none'; img-src data:; style-src 'unsafe-inline'` の meta CSP。`readDrawingPrintOptions`(`printSettings.ts`)は `pageSize` を `drawingPrintOptions` の表で解決し `widthMm/heightMm` の一致まで検査するため、CSS への補間は列挙値と数値だけ | 良 |

### 7.3 入力境界(io)

- **ZIP**: `readArchive.ts` は中央目録(`zipDirectory.ts`、ZIP64・重複 extra・件数上限)→ `deflateExpandedSize.ts`(RFC 1951 を自前で走査し、出力を生成せず展開長を数え、予算超過で `expandedLimit`)→ 実長と宣言長の一致 → 固定長 `out` へ `inflateSync` → CRC-32 照合、の順で、**出力を確保するのは実長と予算が一致してから**。前回 R06 / R10 は解消している。自前の DEFLATE 走査は誤りがあれば `invalidDeflate` で fail-closed になる設計。
- **上限の正本**: `limits.ts`(圧縮 256MiB、エントリ 4,096、1 エントリ展開 512MiB、累積 1GiB、メッシュ 512MiB、DXF 64M 文字)。desktop 側の写し(§5.5)を除き 1 か所。
- **Web の読込前サイズ**: `fileGateway.ts` 397 行で `File.size` を検査する分岐がある(前回 R07)。全経路が共通入口を通るかは今回未確認。

### 7.4 CSP と Web 配信

`packages/ui/src/security/contentSecurityPolicy.ts`: 画面は `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`。embind が要る `'unsafe-eval'` は `/assets/kernel.worker-*.js` にだけ与える(`isKernelWorkerAsset`)。`apps/web/build/securityPolicy.ts` が build / preview で同じ文字列を meta・応答ヘッダ・Cloudflare の `_headers` に配り、`_headers` に CSP を手書きすると例外にする(`appendCloudflareSecurityHeaders`)。単一正本の設計として良い。`style-src 'unsafe-inline'` は React の style 属性のため実務上妥当で、減点しない。

### 7.5 スクリプト実行(QuickJS)

`runtimeAdapter.ts`: `QuickJS.create` に `memoryLimit 64MiB`、`maxStackSize 128KiB`、固定時刻の WASI clock、`interruptHandler` で 5 秒の期限とネイティブ資源上限、`moduleLoader` は同梱モジュールだけ、未処理 rejection 32 件で失敗。`runtimeBindings.ts` がゲストへ渡す口は `__pointercadCommand` / `__pointercadConsole` / `__pointercadLimit` / snapshot / prefix / seed の 6 つで、コマンドは 1,000 件・8MiB、console は 1,000 行・1MiB を計数し、JSON を型検査してから受ける。`script.worker.ts` は専用 Worker で 1 メッセージだけ受け、WASM は同梱 URL からしか読まない。設計として十分で、rules/00 の runtimeAdapter.test.ts が境界を固定している。

### 7.6 運用上のリスク(要対応)

`codex.exe resume --last --dangerously-bypass-approvals-and-sandbox` が 9/10 10:05 から利用者の作業機で稼働している(§4.1 (c))。承認とサンドボックスを外した状態で、リポジトリ内の任意ファイル(依存の README、取り込んだ STEP / DXF、規格資料の写し)を読むエージェントは、プロンプトインジェクションや誤操作の影響範囲が機械全体になる。実際の被害は確認していないが、rules/01 §2 が `-s workspace-write` を前提にしているのに対し運用が外れている。**`-s workspace-write` と承認方針に戻す**か、少なくとも作業用の worktree と専用ユーザーに閉じることを勧める(§4.3 提案 10)。

### 7.7 依存の監視

`.github/dependabot.yml` が存在し(前回 R15)、Dependabot の run(`npm_and_yarn in / for eslint`)が 9/11 に success。`pnpm-workspace.yaml` は catalog で版を完全固定し、`minimumReleaseAgeStrict: true` を作業ツリーで追加している。

## 8. テストと CI

### 8.1 テストの構成

| 種類 | 件数(静的計数) | 備考 |
|---|---:|---|
| ユニット drawing / expression / io / kernel / model / ui / desktop | 493 / 364 / 941 / 1,492 / 3,389 / 3,962 / 34 | 合計 10,706 件以上(`it.each` は 1 件に数えている) |
| E2E | 158 件 / 54 spec | project は viewport-performance → functional / firefox / electron。retries なし |
| 施行としてのテスト | rules/00 の表 | 進捗台帳の整合、ストア所有欄、i18n 直書き、依存方向、OCCT 借用、性能予算 |

テストの量と「規約を検査に落とす」姿勢は高水準。`qualityGateOrder.test.ts` がルートの `--workspace-concurrency=1 --reverse` と各 vitest 設定の接続を固定しているのも良い。

### 8.2 CI が両 OS で赤(重大)

GitHub Actions の直近 3 run(7628fd3、858d68c、2baa0e6)は Windows / Linux とも `一括検査 (scripts/check.ps1)` step で failure。原因は `.git/ci-job-*.log`(利用者が取得した実ログ)で確認した。

- **Windows**: `packages/model/src/sheetMetal/closedRelief.test.ts` 3 件と `lineBendKernel.test.ts` 1 件が `Error: Test timed out in 5000ms`(model 4,271 件中 4 件失敗)。`packages/model/vitest.config.ts` には `testTimeout` が無く Vitest 既定の 5 秒。一方 `packages/kernel/vitest.config.ts` は `testTimeout: 120_000`、`hookTimeout: 180_000` を「50MB 超の WASM のコンパイルに時間がかかる」理由で明示している。model には実 OCCT を読む `loadOcctForNode` のテストファイルが **30 本**あり、`timeout` を書いているのは 1 本だけ。共有ランナーでは 1 件の OCCT 演算が 5 秒を超え得る。
- **Linux**: `scripts/check.selftest.ps1` の「シナリオ 8 前提: ジャンクション越しに実体が見える」「シナリオ 11: 写しの中に workspace 内リンクが用意される」が失敗し、**step 0 で止まるため製品テストが 1 件も走っていない**。作業ツリーの `scripts/lib/directoryLinks.ps1`・`gitTreeGuard.ps1` に修正があるが未着地。

手元の pre-push(Windows、基準機、厳密モード)は緑で push できているため、「手元ゲート = CI」という前提(rules/03 §7.2「検査の単一正本」)が OS 差で崩れている。CI の赤を「ログをもらってから直す」規約は正しいが、ログは 9/11 10:20 と 9/12 08:48 に取得済み(`.git/ci-job-*.log`)で、直す材料は揃っている。

### 8.3 修正案(根拠つき)

1. **model の OCCT テストに明示の timeout を与える。** `packages/model/vitest.config.ts` に kernel と同じ `testTimeout: 120_000, hookTimeout: 180_000` を書くか、OCCT を読む 30 ファイルに `describe(..., { timeout: 120_000 })` を付ける。これは rules/02 が禁じる「性能上限の緩和」ではない: 性能予算は `expectWithinBudget`(test-utils)で別に判定しており、Vitest の既定 timeout は「テストが終わるまでの待ち」でしかない。kernel が既に同じ判断をしている。
2. **Linux の自己試験を着地させる。** 作業ツリーの修正(報告記録 9/12 08:51「Linux は自己試験のリンク」)を実装 27 件から切り離して先に main へ(§4.3 提案 1)。
3. **CI の失敗を「段」で見えるようにする。** `check.ps1` は段の見出しを出すが所要時間を出さない。各 `Invoke-Check` の前後で `Get-Date` を出せば、§4.1 (b) のような表を毎回ログから得られる(前回 §7.4 の提案と同じ。今も未実装)。
4. **E2E の retries は 0 のまま、失敗時の診断を増やす。** 引き継ぎ文書 §7.7 の「早期失敗時に console・DOM・trace を出す診断だけを足す」は妥当。

### 8.4 テストコードの書式

`closedRelief.test.ts` のように、1 テストに折り畳み・展開・輪郭の 3 段階を詰めた結果 5 秒を超え、作業ツリーで `it.each(flatCases)` へ分割している(rules/06 10.71 と `eslint.config.js` の `no-restricted-syntax` で再発防止)。分割自体は正しいが、根本は §8.3 の 1 で、分割は「1 件の検査を意味のある単位に保つ」目的に限るべきである。

## 9. 前回レビュー(2026-09-09)の指摘の反映確認

「対応状況」文書(2026-09-09-レビュー対応状況.md、9/10 22:25)は多くを「main 未反映」としていた。本書で実コードを読んで確認した現状は次のとおり。

| 指摘 | 確認結果 | 根拠 |
|---|---|---|
| R01 復元失敗時に控えを消す | **解消** | `pcadDialogs.ts` `writeBytesTo`: `backupMayBeRemoved` が立つのは上書き成功または復元成功のときだけ。復元不能時は `SAVE_RECOVERY_COPY_MARKER` つきの AggregateError で控えの場所を伝える |
| R02 遅れた保存が別文書を変更 | **本体側は解消**、ui 側は施行表で確認 | `pcadDialogs.ts` `targetRevisions`(sender ごとの revision オブジェクト照合)。ui 側は rules/00 の `saveConcurrency.test.ts` / `desktopFileGateway.test.ts` / `pcadIpcTargets.test.ts` を確認、本体は未読 |
| R03 部品へ戻ると図面破棄 | 施行表で確認 | rules/00「`closeDrawing.test.ts` と `p8-drawing.spec.ts` が破棄の拒否時の図面・Undo 保持を検査」。本体は未読 |
| R04 / R05 / R08 評価文脈と有限値 | **構造で確認** | `evaluate.ts` の `EvaluateContext` に `exactVariables` と `nonLengthVariables`。数値の再現は未実施(§6.7) |
| R06 ZIP 確保前の上限 | **解消** | `readArchive.ts` + `deflateExpandedSize.ts`(§7.3) |
| R07 Web 読込前サイズ | 部分確認 | `fileGateway.ts` 397 行に `size` 検査。全経路は未確認 |
| R09 図面 JSON の非有限値 | 未確認 | 今回は読んでいない |
| R10 ZIP CRC | **解消** | `readArchive.ts` 90 行付近 `zipCrc32(output) !== entry.crc32` |
| R11 CSP / Electron 権限 | **解消** | `contentSecurityPolicy.ts`、`securityPolicy.ts`、`appProtocol.ts`、`sessionPermissions.ts`(§7.2、§7.4) |
| R12 Desktop / Firefox の自動検査 | **解消** | `playwright.config.ts` の firefox / electron project、`apps/desktop/src/main/*.test.ts` 6 本 |
| R13 検査中の再書換の検出 | **解消(CI ログで確認)** | run 34609271048 の自己試験 R13a〜R13j が Windows で全て `[OK]`。Linux は §8.2 の別問題で未到達 |
| R14 責務の集中 | **io のみ解消、ui / model は据え置き** | §6.1 |
| R15 依存監視 | **解消** | `.github/dependabot.yml`、Dependabot run success |

## 10. 推奨する対応順

| 順 | 対応 | 種別 | 目安 |
|---|---|---|---|
| 1 | CI を緑に戻す小さな着地(板金テストの独立化 + Linux リンク修正 + model の `testTimeout`)。利用者が例外を認めるかの判断が要る | 決定 + 1〜2 時間 | §4.3-1、§8.3 |
| 2 | 27 件束をブランチへ移し、1 タスク 1 コミット・PR で両 OS CI。main へは 10 件以上でマージ | 決定 + 運用 | §4.3-2 |
| 3 | 関数作図 ADD-7/8/12/13 の受入条件を「検証済み近似 + 明示」へ、ADD-12 を 12a/12b に分割 | 決定 | §4.3-7 |
| 4 | 委譲の再開(Astra 統括 + sol / terra を worktree 並列、ファイル所有を分ける) | 決定 + 半日の準備 | §4.3-3 |
| 5 | pre-push の E2E を Chromium に絞り、Firefox / Electron は CI と夜間へ | 決定 + 1 時間 | §4.3-4 |
| 6 | 報告の定型化(8 行、着地時と 2 時間ごと)、見込みの再計算をやめる | 運用 | §4.3-6 |
| 7 | 作業場の掃除(worktree 12 本、stash、.git の zip、scratchpad) | 運用 + 30 分 | §4.3-8 |
| 8 | `--dangerously-bypass-approvals-and-sandbox` をやめる | 運用 | §7.6 |
| 9 | ラチェット式の `max-lines` を ui / model に適用し、numericInput / resolvePart / PropertyPanel / kernelBridge を触る機能の周辺から分割 | 実装(各 M) | §6.1、§5.3 |
| 10 | desktop の写しを ui 副入口へ、expression の副入口を 1〜2 本へ、Prettier 導入 | 実装(各 S〜M、依存追加は承認) | §5.4、§5.5、§6.2 |

修正後の再評価では、①同じ SHA の両 OS CI 緑、②束の着地間隔と 1 日の着地件数、③push 1 回の所要(段別)、④巨大ファイルの行数、の 4 つを実測で示すことを完了条件にする。

## 付録 A: 実測データ

**A.1 行数**(`find` + `wc -l`、node_modules / dist 除外、テストは `.test.` / `.spec.` を含むファイル)

| パッケージ | 製品コード 行 / ファイル | テスト 行 / ファイル |
|---|---:|---:|
| packages/ui | 84,673 / 368 | 58,341 / 201 |
| packages/model | 52,468 / 246 | 54,972 / 166 |
| packages/kernel | 28,920 / 111 | 37,103 / 91 |
| packages/io | 17,963 / 63 | 15,395 / 45 |
| packages/expression | 9,149 / 125 | 4,093 / 48 |
| packages/drawing | 4,897 / 63 | 3,118 / 49 |
| packages/help-content | 287 / 2 | 185 / 1 |
| packages/test-utils | 121 / 4 | 258 / 4 |
| apps/desktop | 1,670 / 28 | 486 / 8 |
| apps/web | 203 / 4 | 0 |
| e2e(補助 / spec) | 2,498 / 37 | 12,940 / 54 |

**A.2 コミット数の推移**: 9/1 3、9/2 42、9/3 56、9/4 83、9/5 65、9/6 85、9/7 26、9/8 10、9/9 8、9/10 2、9/11 2、9/12 1(9/7 までは Claude 統括 + 並列担当の小コミット、9/9 以降は 10 件束)。

**A.3 CI の結果**(GitHub REST API、9/12 14:11 取得)

| SHA | 作成 | 結果 |
|---|---|---|
| 2baa0e6 | 09-12 04:49Z | failure(windows / ubuntu) |
| 858d68c | 09-11 14:17Z | failure(windows / ubuntu)。Dependabot の run は success |
| 7628fd3 | 09-11 01:14Z | failure |
| b3a41c5 | 09-10 22:08Z | success |

**A.4 残作業**(`docs/progress.json`): 総数 580、完了 503(うち追跡前 305)、将来見積 115。ADD は 28 件中 1 件完了(残 27)。P7 53 / P8 71 / P9 20 / P10 25 / P11 20 / P11b 8 は全件完了。未着手は P12(30 見積)と P13(15 見積)と ADD の 27 件。

**A.5 作業場**: git worktree 12 本(9/8〜9/9、710MB)+ pre-commit の写し 1 本(9/9)、`stash@{0}`(9/9)、`.git/` 323MB(バックアップ zip 12 個・CI ログ 4 本を含む)、`scratchpad/p8-next-implementation` 1,098 ファイル。

## 付録 B: 読んだ主なファイル

`CLAUDE.md`、`AGENTS.md`、`rules/00〜06`(06 は見出し全件と 10.6 / 10.15 / 10.21 / 10.57 / 10.93 / 10.94)、`docs/requirements.md`(§5、§9)、`docs/plans/追加-関数作図.md`、`docs/引き継ぎ/2026-09-07-Astra統括.md`、`docs/reviews/*`、`docs/報告記録.md`(9/12 全節)、`docs/progress.json`、`package.json`、`pnpm-workspace.yaml`、`tsconfig*.json`、`eslint.config.js`、`.github/workflows/ci.yml`、`scripts/check.ps1`、`e2e/playwright.config.ts`、各 `package.json` と `vitest.config.ts`、`apps/desktop/src/main/{main,appSender,appProtocol,pcadDialogs,exportHandoffIpc,sessionPermissions,drawingPrintDocument}.ts`、`apps/desktop/src/preload/preload.ts`、`apps/desktop/src/renderer/desktopFileGateway.ts`(構造)、`apps/web/{index.html,vite.config.ts,public/_headers,build/securityPolicy.ts}`、`packages/ui/src/security/contentSecurityPolicy.ts`、`packages/ui/src/file/{openWith,drawingPrintSettings}.ts`、`packages/ui/src/store/useAppStore.ts`、`packages/ui/src/app/PointerCadApp.tsx`(E2E 口)、`packages/ui/src/drawing/DrawingCanvas.tsx`(SVG 挿入)、`packages/ui/src/shell/PropertyPanel.tsx`(構造)、`packages/ui/src/sketch/numericInput.ts`(構造)、`packages/io/src/{limits.ts,pcad/readArchive.ts,pcad/deflateExpandedSize.ts,pcad/zipDirectory.ts,pcad/schema.ts}`、`packages/kernel/src/worker/{kernelApi,shapeCache,recomputeSolids}.ts`、`packages/kernel/src/occt/{allocations,booleanOp,loadOcct.browser}.ts`、`packages/model/src/kernelBridge.ts`(構造と 2,649〜2,810 行)、`packages/model/src/part/{recomputePart,resolvePart}.ts`(構造)、`packages/model/src/history/undoStack.ts`、`packages/model/src/scripting/{runtimeAdapter,runtimeBindings,script.worker,scriptTypes}.ts`、`packages/model/src/sheetMetal/closedRelief.test.ts`、`packages/expression/src/{evaluate.ts,math/createMathBackend.ts}`、`packages/drawing/src/{render/toSvg.ts,text/fontAsset.ts,text/fontStore.ts,paper/printSettings.ts}`、`.git/ci-job-*.log` 4 本、`scratchpad/p8-next-implementation/{apply_flat_source,apply_hole_e2e,append_timed_report}.py`。

## 付録 C: このレビューが行った変更

新規作成: `docs/reviews/2026-09-12-全体レビュー(Claude Fable 5.1).md` のみ。実装・設定・依存・既存文書の変更、テストやビルドの実行、アプリの起動、git への書き込み(commit / stash / worktree / checkout)は行っていない。

子エージェントの使用: なし

git への書き込み: なし
