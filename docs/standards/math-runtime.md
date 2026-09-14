# 数学入力・計算部の採用資料

2026-09-15 00:30追記: 過去に外部へ置いた調査資料は、利用者の指示に従いプロジェクト内のscratchpadへ移した。下の旧パスは当時の経緯であり、現在の保存先指定ではない。追加計算の期限・中止・ブラウザー接続と、無理数成分のrankを渡す本体実装を加えたが、追加分は検証待ち。固定資産と原文・関連ソースをまとめた[導入案](exact-runtime-proposal.md)を提示し、製品への新規バイナリ追加の採否を確認中である。

2026-09-14 23:25追記: 候補の構造化入力37件・出力19件は3環境で確認済み。Firefoxは準備180秒・計算45秒の候補用枠で22:39に成功した。既存の依頼/返信経路と候補Workerをつなぐ実接続も10入力と不正配列3種類で成功した。固定した旧資産は保持し、新しい受渡し処理は外部の調査用資料として内容指紋を記録した。製品用の依存追加・有効化・配布確認は未実施で、未採用を維持する。

2026-09-14 19:43の候補調査: Pyodide 314.0.6・SymPy 1.14.0・mpmath 1.3.0の固定配布物を製品へ導入せず、実配信のCSPとChrome・Firefox・Electron Workerで検証した。初回計算、中止、別Workerでの再計算、固定入力以外の拒否、線形代数・微積分・微分方程式/変換・特殊関数の独立照合を含む17件（前提を含む）が成功。4 runtime＋2 wheelは18,133,822バイト。Firefoxの初期準備中に旧45秒期限を超えた履歴を保持し、調査だけを準備90秒・計算45秒の外側監視へ分けた。一般の利用者入力への接続、未解決結果の扱い、メモリ制限、WASM内の全許諾の照合は残るため、**未採用**であり、以下の製品依存表は変更しない。

2026-09-12。追加の数学入力13件・関数作図14件に関する依存の判断と実装中の配信計測。機能全体の受入やリリース完了の記録とは区別する。

## 版と役割

| 部品 | 固定版 | 採用する役割 | 配布物の宣言 |
|---|---|---|---|
| [MathLive](https://github.com/arnog/mathlive/tree/v0.110.0) | 0.110.0 | 分数・根号・上下付き文字などを構造として編集し、LaTeX入力を取得する | MIT |
| [Compute Engine](https://github.com/cortex-js/compute-engine) | 0.128.6 | 専用の計算Worker内で式を読み、厳密値・40桁精度の数値を扱う | MIT |

版は`pnpm-workspace.yaml`のcatalogへ完全固定し、`pnpm-lock.yaml`で推移依存も固定する。数学記号の見た目を編集する役割と、CADへ採用できる値を判断する役割を分ける。既存の短い座標式と日本語の係数名は維持する。分野ごとの対応範囲・未対応の扱い・独立した数値との照合は[数学入力計画](../plans/追加-数学入力.md)を正とする。

MathLiveのpackage.jsonはCompute Engine **0.58.0**も依存として宣言する。これを0.128.6と同一の計算部と扱わない。`loadStructuredMathField`は`MathfieldElement.computeEngine = null`を設定し、計算は明示固定した別Workerへ渡す。入力欄に計算器を取り付けない。Compute Engine 0.128.6自身の直接依存は`@arnog/colors`と`complex-esm`である。ライブラリの一部機能が使えることを、全数学機能の対応済みという根拠にしない。

## 実行と入力の境界

- `createMathBackend`の生成直後に`jit = 'off'`を設定する。画面や独自スキームのCSPへ`unsafe-eval`を追加しない。
- エンジン内部はラジアンへ統一し、新規の利用者入力は度を既定とする。度とラジアンの変換は入力境界で1回行い、保存済みの単位を引き継ぐ。
- エンジンの反復上限1000・再帰上限64と同期処理200msの制限に加え、外側のWorkerの終了期限と取消を使う。同期期限へPromiseを返す処理は型で拒否する。
- 変数はX/Y/Z/T/U/V、係数は文書内IDと表示名、定数はπなどの定義として区別する。見た目の同名だけで異なる役割を合体させない。
- 関数作図はXYZの6端点を必須とし、有限値・大小関係・生成後の範囲を検査する。近似誤差の推定と数学的に保証した上限を区別し、未確認の結果を保証済みのCAD座標へ採用しない。
- 公開入口は`packages/expression/package.json`が正本。数学の内部ファイル35入口を、`math/contracts`（型・入力検証）、`math/client`（画面からの依頼）、`math/worker`（記号計算と依頼の実行）、`math/geometry`（曲線・曲面の評価）の4入口へ整理した。`packageBoundary.test.ts`で利用側の全参照と公開入口を照合し、`mathClientBoundary.test.ts`で画面用の2入口を読み込んでも計算部が実行されないことを検査する。画面本体からWorker用入口の実行時importはlintで拒否する。9/13の型・lint・公開入口検査と3環境の実画面用ビルドで確認した。以下はその後の実配布用フォルダの計測で、リリース済み版の記録ではない。

## ローカル資産と実測サイズ

字体は`mathlive/fonts.css`からビルドに含める。`fontsDirectory`・`soundsDirectory`・効果音を無効にし、外部CDNへの自動取得を使わない。CSSから字体を同梱する方式は[公式の組み込み説明](https://cortexjs.io/mathfield/guides/integration/)に沿う。字体の読込完了と期限も画面側で検査する。

9/13 14:04の実装中Web・Desktopビルドを実ファイルから計測した値。以下の数学資産は両版で内容・サイズが一致した。gzipは同じファイルを標準gzipで圧縮した比較値であり、サーバーの実際の転送方式や全機能の総増分を示すものではない。

| ビルド資産 | バイト数 | gzipバイト数 |
|---|---:|---:|
| `mathlive.min-Bkp5CN7-.js` | 800,600 | 215,706 |
| `math.worker-Dx8L4b_a.js`（製品の数学・作図処理を含む） | 3,712,164 | 1,028,363 |
| `math-input-YClINmHB.js`（数学入力の説明） | 17,310 | 6,646 |

数学WorkerのSHA-256は`9c8cacadfb76e2f39c7ee3e8a5e30686bad538c9671670efb81d22a0f9cd13b2`、MathLiveチャンクは`2e7720b349af764e99d16f705a6dfc3dc2a15ecaec5adc7be103f7e62668e29a`。字体20ファイルの各サイズ・SHA-256、両ビルドの許諾9ファイルの記録は開発証拠`.git/codex-math-build-assets-20260913-140416-243616.json`に保存した。取得したpackage.jsonの値と初回の配布調査は`math-distribution-evidence.json`に残す。最終インストーラー・公開するWeb成果物の全資産一覧はP13で改めて固定する。

## 許諾原文と残る確認

配布パッケージ内の原文を改変せず、[Compute EngineのMIT本文](licenses/compute-engine.txt)と[MathLiveのMIT本文](licenses/mathlive.txt)へ保存する。原文のSHA-256は、それぞれ`f9270498fcb583f1a8aa4664e1986910d005303ff9c5cbab432bb4d1f292f225`と`3caebd18611959ca725ab976a004d408017eb1d7093d6c9b9b09c5a4790eaff8`。この記録の作成では依存の版やvendorを変更していない。

字体の許諾はJavaScript本体のMITとは別に確認した。MathLive v0.110.0の字体20ファイルをGitの同じタグの内容と照合し、すべて一致した。実際のWOFF2に埋め込まれたnameテーブルの著作権・許諾表示を[字体別の原文](licenses/mathlive-fonts.txt)へ保存した。Design Science、Khan Academyの表示と各Reserved Font Nameを保持する。字体は変更せず、[SIL Open Font License 1.1本文](licenses/ofl-1.1.txt)を同梱する。本文は[公式の原文](https://openfontlicense.org/documents/OFL.txt)の区切り線以降をそのまま保存し、冒頭の記入例を実際の権利者表示として転用しない。

[固定版・原文・字体のSHA-256一覧](licenses/math-notices.json)を、WebとElectronの同じビルド処理が読む。依存の版、インストールされた許諾原文、字体の一覧・内容が記録と異なる場合は組み立てを失敗させる。実際に出力した字体にも欠落・差し替え・重複の検査を行う。原文は両版の`licenses/`へ出力し、`licenses/index.html`から参照できる。9/13 14:04の実ビルドで両版の9ファイルが一致することを確認した。最終インストーラー内の確認と、次段の未解決原文は残る。

推移依存ではCompute Engine 0.58.0、complex-esm 2.1.1-esm1、decimal.js 10.6.0の配布原文も保存した。**`@arnog/colors` 0.7.0/0.5.0は未解決**である。package.jsonのMIT宣言は確認できたが、配布物に独立した著作権・許諾原文がなく、記載されたソースリポジトリは404だった。これを別のライブラリの著作権表示で補わず、上記一覧の`unresolved`へ残した。実際の配信物に含まれる範囲と原文の取得を解決するまで、F13・許諾の確認を完了扱いにしない。
