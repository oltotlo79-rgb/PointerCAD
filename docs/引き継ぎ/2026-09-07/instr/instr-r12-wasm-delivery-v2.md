# 指示書 R-12(第 2 回。読取専用の依存の記載を訂正): Cloudflare Pages の 1 ファイル 25 MiB 制限に対する WASM 配信の先行実証(方式 A: 圧縮・分割。レビュー R8-5、利用者の決定 2026-09-07。工数 M〜L)

## 1. 目的と背景(コードで確認済み)

- `packages/kernel/src/occt/loadOcct.browser.ts:1-2` はグルー `opencascade.full.js` と `opencascade.full.wasm` を `?url` で資産として受け取り、`:47-59` で `import()` したグルーに `locateFile` で wasm の URL を渡す。wasm は **50,305,130 バイト(約 48 MiB)**。
- Cloudflare Pages は**静的資産 1 ファイルあたり 25 MiB(26,214,400 バイト)まで**(公式の制限)。配信時の gzip を有効にしても、アップロードする 50 MB のファイルの制限は解消しない。**いまのままでは本番公開できない。**
- 利用者の決定: **方式 A = Pages の中に圧縮・分割して置く**(R2 等への別置きはしない)。まず実サイズと読み込み時間を実証し、本実装の形を決める。
- `apps/web/vite.config.ts` は `manualChunks` で three / opencascade.js を素通し(名前を付けない)、`apps/web/public/_headers` は COOP / COEP / CORP / nosniff。Web の `build` は `vite build`。Electron(`apps/desktop`)は自前の protocol で配信するので Pages の制限は無い(同じ loader を使うなら**分岐**が要る)。

## 2. やること(実証 → 最小の本実装)

1. **実測(最初に数値を出す)**: Node の `zlib` で wasm を gzip(level 9)と brotli(quality 11)に圧縮したサイズ、圧縮・展開の所要時間。`DecompressionStream('gzip')` がブラウザで広く使える(Chrome / Firefox / Safari 16.4+)一方 brotli は使えないので、**採用候補は gzip**。gzip 後が 25 MiB 未満なら「圧縮 1 ファイル」、未満でなければ「25 MiB 未満の片に分割 + manifest」。どちらになったかを数値で報告してから次へ。
2. **ビルド時の資産生成**: `apps/web/vite.config.ts` に **Vite のプラグイン**(新規 `apps/web/vite/occtAssets.ts` など。root の `scripts/` は触らない)を足し、`vite build` のときに wasm を圧縮(または分割)して `dist/occt/` へ **hash 付きの不変な名前**で出し、`dist/occt/manifest.json`(元の byteLength、SHA-256、片の一覧と順序、圧縮の種類)を出す。**元の 50 MB の `.wasm` は dist に出さない**(`?url` の資産出力を止める。グルー `.js` はそのまま資産でよい)。拡張子は `.bin`(ブラウザや Pages が勝手に展開しない名前)、`_headers` に `Content-Type: application/octet-stream` と `Cache-Control: public, max-age=31536000, immutable` を `/occt/*` に追加(manifest だけは短い max-age)。
3. **loader**: `loadOcct.browser.ts` を、manifest があれば「片を順に fetch → `DecompressionStream('gzip')` で展開 → 連結 → SHA-256 を照合 → Emscripten の `Module` に **`wasmBinary`**(ArrayBuffer)として渡す」経路にし、manifest が無ければ(開発サーバー・Electron)いまの `locateFile` 経路のまま。グルーが `wasmBinary` を受けるかは d.ts と実行で確かめる(受けない場合は `instantiateWasm` を使う。どちらも無理なら止まって報告)。展開・連結の純関数(片の順序・SHA-256・byteLength の照合)は新規 `packages/kernel/src/occt/occtAssetManifest.ts` に置き、単体テストを書く(Node 18+ の `DecompressionStream` で検査できる)。
4. **検証**: `pnpm --filter @pointercad/web run build -- --outDir <報告先>/web-dist`(**repo 直下の `scratchpad/` や `apps/web/dist/` には出さない**)。出力に 26,214,400 バイト以上のファイルが無いこと(`find … -size +25M` が空)。manifest の SHA-256 が元 wasm と一致。Node で manifest → 片 → 展開 → 連結 → SHA-256 照合の所要時間を測る(ブラウザの実測は統括が E2E と目視で行う)。
5. **申し送り**: PWA(P12)の cache 単位(同じ buildId の JS / Worker / WASM / font を一組)、offline 準備との関係、Electron 側の分岐の確認方法を report.md に書く。

## 3. 編集所有ファイル / 読取専用

- 編集所有: `apps/web/vite.config.ts`、新規 `apps/web/vite/occtAssets.ts`(名前は既存の慣習に合わせてよい)、`apps/web/public/_headers`、`packages/kernel/src/occt/loadOcct.browser.ts`、新規 `packages/kernel/src/occt/occtAssetManifest.ts`、新規 `packages/kernel/src/occt/occtAssetManifest.test.ts`、`apps/web/package.json`(**依存は足さない**。scripts の変更が要れば報告してから)。
- 読取専用: `packages/kernel/node_modules/opencascade.js/dist/opencascade.full.js`(`wasmBinary` / `instantiateWasm` の扱いの確認)、`packages/kernel/src/occt/loadOcct.node.ts`(Node 側の loader)、`packages/kernel/src/worker/kernel.worker.ts`(`loadOcct.browser.ts` を直接 import する。共通の振り分けファイルは**無い**ので新設しない)、`apps/desktop/src/main/appProtocol.ts`(Electron の配信。**編集しない**。分岐が要るなら報告)、`e2e/playwright.config.ts`(webServer の起動方法の確認だけ)、`docs/plans/P9-P13-計画前の決定事項.md` §5。
- 触らない: `scripts/`、`.github/`、`e2e/`、`packages/kernel/src/worker/*`(他担当)、`package.json`(root)、`pnpm-lock.yaml`。

## 4. 手順と中間報告(各段階の終わりに `progress.md` へ追記)

§2 の 1 → 2 → 3 → 4 の順。**段階 1 の数値を書いてから段階 2 へ進む。** グルーが `wasmBinary` を受けない等の前提違いは編集前に止まって報告。

## 5. 合格条件(数値)

- 段階 1 の表(gzip / brotli のサイズと時間)が report.md にある。
- ビルド出力に 26,214,400 バイト以上のファイルが 0 個。manifest の SHA-256 が元 wasm の SHA-256 と一致。
- `occtAssetManifest.test.ts` が全緑(順序違い・欠けた片・SHA 不一致・byteLength 不一致を拒む 4 件以上)。kernel のテストが全緑で件数が減っていない。
- typecheck 0(所有ファイル起因)、lint 0。開発サーバーの経路(manifest なし)が従来どおり動く(ビルド出力ではなく単体テストか型で保証し、実機は統括が確認)。
- E2E は実行しない(統括が `check.ps1 -Level Push` の E2E 77 件で確認)。

## 6. 変更・緩和してはいけないもの

COOP / COEP / CORP、`manualChunks` の方針(three / opencascade.js を素通し)、依存の追加、WASM の版、`KERNEL_TIMEOUT_MS`、`e2e/`、Electron の配信。

## 7. 関係する過去の失敗(rules/06)

10.18(初回のカーネル読み込み時間が E2E の上限に近い → 展開の時間を必ず測り、増えるなら数値で報告。上限は変えない)、10.10(担当が起動した preview の止め忘れ → **preview / dev サーバーを起動しない**)。

## 8. 使える道具

`node`(zlib・crypto・stream/web)、`rg`、`sed -n`、`pnpm --filter @pointercad/web run build -- --outDir <報告先>/web-dist`、`pnpm --filter @pointercad/kernel exec vitest run occtAssetManifest`、`pnpm --filter @pointercad/kernel run test`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`。

## 9. 成果物

`__OUT__/report.md`(実測の表、採った方式(1 ファイル / 分割)、出力の一覧とサイズ、loader の経路、Electron・PWA への申し送り、統括への依頼(E2E と目視))、`__OUT__/progress.md`、`__OUT__/web-dist/`(ビルド出力)。最終メッセージは要約 5 行 + 規律の 2 行。

## 10. 第 1 回からの申し送り(統括の回答)

第 1 回の担当は「`loadOcct.ts`(振り分け)が存在しない」と見つけて編集前に停止した(正しい対応。統括の指示書の誤り)。訂正済み(§3): 実在するのは `loadOcct.browser.ts`・`loadOcct.node.ts`・`kernel.worker.ts`(browser 版を直接 import)。**共通の振り分けファイルは新設せず、現行の直接 import を維持**して作業を続けてよい。開発サーバー / Electron の分岐は `loadOcct.browser.ts` の中で「manifest が取得できるか」で判定する(manifest の URL は `import.meta.env.BASE_URL` 起点の固定名か、Vite プラグインが差し込む定数。採った方法を報告)。段階 1 から始めてよい。
