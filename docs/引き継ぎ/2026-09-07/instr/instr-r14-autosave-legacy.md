# 指示書 R-14: 自動保存の旧控え(鍵 `current`、識別子 3 欄なし)の復元・破棄・手動保存での消去を直す(push #19 の事前検査で E2E `solid.spec.ts:812` が落ちた回帰。ui のみ。工数 S〜M)

## 1. 背景(ログとコードで確認済み。憶測ではない)

- push #19 の事前検査(`scripts/check.ps1 -Level Push`)で E2E が 1 件落ちた: `e2e/tests/solid.spec.ts:812` 「前回の作業の控えから復元でき、破棄と手動保存で控えが消える(FR-805、NFR-RE-2)」。`:858` の `treeRow(page, '面1')` が 30 秒待っても出ない。失敗時の画面(Playwright の error-context)は、復元の案内は閉じ、モデルブラウザは「まだ何もありません。」、状態欄は「名称未設定」(`*` なし)。**つまり「復元する」を押すと案内だけ閉じて何も復元されない。**
- E2E は控えを IndexedDB `pointercad` / `autosave` の**鍵 `'current'`** に `{ savedAt, bytes, documentName }` だけ(kind / documentId / sessionId の 3 欄なし)で書く(`solid.spec.ts:502-549`、定数 `:35-37`)。これは 11a-2(HEAD `c8d09da`)より前の版のアプリが書いていた形そのもの = **旧控え**。実利用者の端末(今日の実機確認で使った Web の 127.0.0.1:4174 と Electron の userData)にも同じ形の控えが残り得る。E2E を書き換える対象ではない(E2E は正しい)。
- io 側は旧控えを既に考慮している(`packages/io/src/autoSave.ts`): `DEFAULT_AUTO_SAVE_IDENTITY = { kind: 'part', documentId: 'default', sessionId: 'default' }`(`:35`、`@pointercad/io` の index から export 済み)、`LEGACY_RECORD_KEY = 'current'`(`:295`)。IndexedDB 実装の `read(identity)` は **鍵が既定の識別子の鍵と一致するときだけ** `current` を読みに行き(`:310-323`)、`write` / `clear` も既定の鍵のときだけ `current` を消す(`:326-341`)。注釈に「旧currentは既定の鍵の読み込みと破棄で扱える」とある。`listRecords()` は `getAll` で旧控えも拾う(`recordIdentity(record)` が 3 欄なしを既定の識別子へ写す `:71-75`。これは export されていない)。メモリ実装 `createMemoryAutoSaveStorage` も同じ鍵付け(`:106-116`)なので、単体テストで旧控えを再現できる。
- ui 側の穴(`packages/ui/src/file/attachAutoSave.ts`):
  1. 起動時 `startDocumentAutoSave`(`:395-`)は saver を **`kind: 'part', documentId: <活性文書の ID>, sessionId: WINDOW_SESSION_ID`(`:393` の `crypto.randomUUID()`)** で作り、`storage.listRecords()` の結果から同じ kind の最新の控えを `loadAutoSavePrompt(current, { record })` へ渡す(`:431-437`)。旧控えも拾われるので**案内は出る**(E2E の手順 4 は合格)。`recoveryRecord` にはその旧控え(3 欄なし)が入る(`:243`)。
  2. 「復元する」`restoreAutoSave(saver)`(`:277`)→ `recoveryRecordOf(saver)`(`:329-334`)。record に 3 欄が無いので `saver.readLatest(undefined)` → io の `readLatest` は `identity ?? latestIdentity()`(`:566-568`)→ `latestIdentity()` は `latestDocument` が null でも `options.documentId` があるので **`{ part, <活性文書の ID>, <窓 ID> }`** を返す(`:491-496`)→ `storage.read` の鍵は既定の鍵と一致しないので `current` を読まず **null** → `setRestorePrompt(null)` だけして戻る(`:279-282`)。**これが空振りの正体。**
  3. 「破棄する」`discardAutoSave(saver)`(`:337-343`)も同じ理由で `clear` の鍵が `part:<ID>:<窓>` になり、`current` が残る(E2E 手順 6 でも落ちるはず)。
  4. 手で保存できたときの消去(`packages/ui/src/file/partFile.ts` の保存成功後 `saver.discard()`、`:411-425` の注釈「手で保存できたら自動保存の控えは用済みなので消す(§0.a-0.12)」)も現在の識別子だけを消すので、旧控えが残る(E2E 手順 7 で落ちるはず)。
- 単体テストが見逃した理由: `attachAutoSave.test.ts` の `createTestSaver`(`:200-207`)は `documentId` / `sessionId` を渡さないため `latestIdentity()` が undefined → 既定の鍵 → 旧控えが読める。**本番の saver の作り方(3 欄あり)と違う**。

## 2. 変更の設計(統括の決定。理由つき)

1. **控えの識別子を 1 か所で決める補助関数**を `attachAutoSave.ts` に足す: `identityOfRecord(record: AutoSaveRecord): AutoSaveIdentity` = 3 欄がそろっていればその 3 欄、そろっていなければ `DEFAULT_AUTO_SAVE_IDENTITY`(`@pointercad/io` から import)。`recoveryRecordOf` と `discardAutoSave` の「3 欄がそろっていれば…」の条件式 2 か所をこの関数へ置き換え、**record が null でないかぎり必ず識別子を渡す**(undefined を渡す経路を無くす)。これで `read` / `clear` が既定の鍵になり、io の旧控えの読み込みと破棄が働く。
2. **手で保存できたときの消去**(`partFile.ts` の保存成功後): 現在の識別子の `saver.discard()` に加えて、**part の保存では `saver.discard(DEFAULT_AUTO_SAVE_IDENTITY)` も行う**(旧控えの枠を消す。順に 2 回呼ぶ。どちらの失敗も保存の成功は変えない、いまの try/catch の流儀のまま)。理由: 旧控えは 11a-2 より前の「窓に 1 枠」の控えで、当時の契約は「手で保存できたら控えは用済み(§0.a-0.12)」= 保存で消える、だった。新しい版でもその枠に書き込む者はいないので、消して困る所有者がいない。io の `write` が既定の鍵のとき `current` を消しているのも同じ意図。**assemblyFile.ts は触らない**(旧控えは part の枠なので)。
3. 復元(part)のあと `recoveryRecord` を null に戻す(assembly の枝 `:293` と同じ扱いにそろえる。`:317` の `setRestorePrompt(null)` の直後)。案内を閉じた後に古い record を持ち続けない。
4. **申し送り(実装しない。report に書く)**: 別の窓(sessionId 違い)の控えを復元して手で保存した場合、その控え(`part:<ID>:<別の窓>`)は残り、次の起動で案内が再び出る。§0.a-0.12 の「手で保存できたら用済み」を別窓の控えにも適用するかは設計判断が要るので、今回は変えず report の「統括への申し送り」に現状と案(復元元の識別子を覚えて保存成功時に消す)を書く。

## 3. 編集所有ファイル / 読取専用

- 編集所有: `packages/ui/src/file/attachAutoSave.ts`、`packages/ui/src/file/attachAutoSave.test.ts`、`packages/ui/src/file/partFile.ts`(保存成功後の消去の 1 か所だけ)、`packages/ui/src/file/partFile.test.ts`(あれば。手動保存で旧控えも消えるテストの追加だけ)。
- 読取専用: `packages/io/src/autoSave.ts`(旧控えの扱いの正本。**変えない**。足りない export があれば止まって報告)、`packages/io/src/index.ts`、`packages/ui/src/file/assemblyFile.ts`、`packages/ui/src/store/assemblySlice.ts`(`recoveryRecord` の型 `:65`)、`e2e/tests/solid.spec.ts:502-549, 812-890`(E2E の期待。**変えない**)、失敗ログ `C:/Users/oltot/AppData/Local/Temp/claude/C--Users-oltot-Documents-git-projects-PointerCAD/97bbbc31-8178-49a4-b3da-7d4a3d793e68/scratchpad/push-19.log` の末尾と `test-results/solid-前回の作業の控えから復元でき…/error-context.md`。
- 触らない: `e2e/`、`packages/io/*`、`packages/model/*`、`apps/desktop/*`、`assemblyFile.ts`、`package.json`、`pnpm-lock.yaml`。

## 4. 手順と中間報告(各段階の終わりに `__OUT__/progress.md` へ追記)

1. **現在値**: §1 の行番号と名前の一致を確かめる(行はずれていてよい。名前が違えば止まって報告)。`pnpm --filter @pointercad/ui exec vitest run attachAutoSave partFile` の件数。
2. **再現する単体テストを先に書く**(赤になることを確かめてから直す): `createAutoSaver({ storage: createUnsavedOnlyStorage(memory), documentId: 'doc-1', sessionId: 'win-1', now, setTimeout, clearTimeout })` のように**本番と同じ 3 欄つき**の saver を作る補助(`createTestSaver` に省略可能な `identity` 引数を足す形でよい)。メモリ保管庫に **3 欄なしの旧控え**(`recordOf(document)` のまま。`kind` を付けない)を 1 件置く。テスト: (a) `loadAutoSavePrompt` → 案内が出る → `restoreAutoSave` → `state.document` が控えの部品、`fileName` null、`savedDocument` null、`restorePrompt` null、`recoveryRecord` null、控えはまだ残っている(`storage.listRecords()` が 1 件)。(b) `loadAutoSavePrompt` → `discardAutoSave` → `storage.listRecords()` が 0 件、`restorePrompt` null。(c) 3 欄つきの自分の控えと旧控えの両方があるとき、`discardAutoSave` は案内に出した方(最新)だけを消す。(d) part の手動保存の成功後に、自分の識別子の控えと旧控えの**両方**が消える(`partFile` の保存経路のテストの流儀に合わせる。既存の「保存で控えが消える」テストがあればそれを手本にして 1 件足す)。
3. **修正**(§2 の 1〜3)。
4. **検査**: `pnpm --filter @pointercad/ui run test`(全緑。件数が 3,076 から減らない。増分を報告)、`pnpm -w run typecheck`(0)、`pnpm exec eslint packages/ui/src/file/attachAutoSave.ts packages/ui/src/file/attachAutoSave.test.ts packages/ui/src/file/partFile.ts`(0)。
5. **E2E の当該 1 件をヘッドレスで実行**(規約 `rules/02` で Playwright の headless は可。Playwright の webServer が Web 版をビルドして 127.0.0.1 の preview を起動し、終了時に自分で止める。**1 回だけ**実行し、終わったら `Get-Process node` 相当で preview が残っていないことを確かめて report に書く): `pnpm run test:e2e -- e2e/tests/solid.spec.ts -g "前回の作業の控え"`。合格が条件。落ちたら原因を report に書き、§2 の設計で足りない点を止まって報告する(勝手に E2E を変えない)。

## 5. 合格条件(数値)

- 新規テスト 4 件以上が、修正前は赤・修正後は緑(progress.md に赤の証拠の 1 行を残す)。
- ui のテスト全緑、件数 ≥ 3,076 + 4。typecheck 0、lint 0。
- E2E `solid.spec.ts:812` の 1 件が緑(実行時間も報告)。
- `git status` の変更が §3 の編集所有ファイルだけ。`e2e/` と `packages/io/` に差分なし。

## 6. 変更・緩和してはいけないもの

E2E の期待、io の旧控えの扱い、既存テストの期待値、`assemblyFile.ts`、性能予算、`package.json`。`as` / `any` / `@ts-ignore` / `eslint-disable` を使わない。

## 7. 関係する過去の失敗(rules/06)

10.17(文書の切替と消去の順序)、10.19(復元できない・無い・失敗を言い分ける: 旧控えを「無い」と誤らない)、10.10(起動したものを止め忘れない: E2E の後に preview の残留を確かめる)。

## 8. 使える道具

`rg`、`sed -n`、`pnpm --filter @pointercad/ui exec vitest run <名前>`、`pnpm --filter @pointercad/ui run test`、`pnpm -w run typecheck`、`pnpm exec eslint <ファイル>`、`pnpm run test:e2e -- <spec> -g <名前>`(1 回)。

## 9. 成果物

`__OUT__/report.md`(原因の確認、変更ファイルと差分の要旨、テスト件数の前後、E2E の結果と所要、§2-4 の申し送り、実機で統括が見る点)、`__OUT__/progress.md`。最終メッセージは要約 5 行 + 規律の 2 行。
