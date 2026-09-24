# Web版の公開先

2026-09-16、利用者がCloudflare Pagesの無料枠と、完成した配布一式を直接アップロードする方式を選択した。既存のCloudflareアカウントを使う。名前は`pointercad`、使用済みなら`pointercad-app`を候補とする。名前の確保と実際の公開URLは未確認。

アカウントのログイン情報や操作用の秘密情報は、ソース、報告記録、生成物、実行ログへ記載しない。現時点ではこの会話から操作できるブラウザー接続がなく、ログイン状態や所有するアカウントを取得していない。アカウントがあることと、こちらから操作できることを区別する。

## 公開する一式

`scripts/release/README.md`の手順で作った同じ版のWeb本体・計算部・字体・説明書全巻を使う。開発用の`apps/web/dist`だけを公開しない。`_headers`などの配信設定を含め、構成と全ファイルの内容が照合済みの一式を使う。モデルや利用者の保存ファイル、検査用の入力、認証情報は含めない。

公式の[直接アップロード手順](https://developers.cloudflare.com/pages/get-started/direct-upload/)では、管理画面からフォルダーまたはZIPを渡せる。管理画面経由は1,000ファイル、1ファイル25MiBまで。公開候補の実際のファイル数と最大サイズを先に数え、超過した資産を黙って除外しない。別のアップロード用部品を採用する場合は必要性を整理する。直接アップロードのプロジェクトを後からGit連携へ切り替えるには新しいプロジェクトが必要だが、今回は承認済みの直接アップロードを使う。

## 公開方法を取り違えた場合

2026-09-16に受領したログでは、本体の組立ては成功した後、`npx wrangler deploy`がリポジトリ直下で公開対象を自動判定できず停止した。大きなJavaScriptファイルの警告や組立て時間の表示は、この停止の原因ではない。

`wrangler deploy`は[Workers向けの公開命令](https://developers.cloudflare.com/workers/wrangler/commands/workers/)であり、今回は採用していない。作業フォルダーだけを`apps/web`へ変えて再試行すると、承認済みのPagesとは別の公開先を作る可能性がある。

完成した一式を渡す際は、上記の公式手順に従い、管理画面の「Workers & Pages」→「Create application」→「Get started」→「Drag and drop your files」からPagesの直接アップロードを選ぶ。この方式には本体を組み立てる命令や`npx wrangler deploy`の設定は不要。渡すのは、同じ版の本体・全巻の説明書・許諾原文を照合した出力フォルダーまたはZIPであり、リポジトリ全体ではない。

既存のWorkersやGit連携の設定を勝手に削除しない。今回の失敗ログだけでは、公開先の名前が確保できたことやPagesが作成済みであることは判断しない。将来WranglerでPagesへ送る場合の命令は`wrangler pages deploy <配布一式のフォルダー>`だが、今回の直接アップロードに新しい部品の導入は必要ない。

## 公開前後に確認すること

公開前に、原文未取得の許諾、未完了の機能・説明書、同じ版のWindows・Linux検査、配布物の照合を閉じる。候補が生成できたことを正式公開の条件成立と扱わない。完成前の本体を名前の確保だけのために公開しない。

公開後は、実際に割り当てられたURLで起動・作図・保存・全説明書・通信なし利用を確認する。必要な配信設定、取得したファイルの内容、以前開いていた版と新版の分離を検査する。確認した実URLだけをREADMEと配布案内へ記載する。無料枠の範囲と現在の制限は[Cloudflare公式の制限](https://developers.cloudflare.com/pages/platform/limits/)を参照する。

## 公開先候補の名前の確認(読み取りのみ、2026-09-24)

`pointercad.pages.dev`と`pointercad-app.pages.dev`の2候補へ、読み取りだけの接続を試みた(何も作成・申込みしていない)。2つの独立した経路で確認した。

| 候補 | 確認方法 | 結果 |
|---|---|---|
| `pointercad.pages.dev` | WebFetchツールでのHTTP接続 | DNS解決失敗(`ENOTFOUND`、応答取得できず) |
| `pointercad.pages.dev` | 開発機の`nslookup`(ローカルDNS) | `Non-existent domain`(NXDOMAIN) |
| `pointercad-app.pages.dev` | WebFetchツールでのHTTP接続 | DNS解決失敗(`ENOTFOUND`、応答取得できず) |
| `pointercad-app.pages.dev` | 開発機の`nslookup`(ローカルDNS) | `Non-existent domain`(NXDOMAIN) |

確認日: 2026-09-24。

健全性確認として、Cloudflareが保有する親ドメイン`https://pages.dev`を同じ2経路で取得したところ、WebFetchは`301 Moved Permanently`で`https://pages.cloudflare.com/`へ、`nslookup`はCloudflareのAnycast IP(`104.18.20.135`等)へ、どちらも正常に解決した。接続経路自体(WebFetchのサーバー側DNSと開発機のローカルDNS)が機能していることを確認した上で、2候補だけがどちらの経路でも不存在(NXDOMAIN/ENOTFOUND)という結果になった。

**記録する応答区分: 2候補とも「未使用」と推定する。** ただし、これは外部からのDNS解決の結果であり、Cloudflareのダッシュボードへログインして初めて確定する「実際に取得できるか」の判定ではない(名前の予約・商標上の理由でダッシュボード側だけが拒否する可能性は、この確認では排除できない)。実際の取得可否は、公開作業当日に統括がログイン済みブラウザーでプロジェクト作成画面を開いて確認する(下記の手順・P13-2)。

## Cloudflare Pages 直接アップロードの制限(公式資料で確認、2026-09-24)

公式資料2件を2026-09-24に確認した。

| 資料 | URL | ページの更新日表示 |
|---|---|---|
| Pagesの制限(Limits) | [developers.cloudflare.com/pages/platform/limits](https://developers.cloudflare.com/pages/platform/limits/) | Last updated Sep 5, 2026 |
| 直接アップロード手順(Direct Upload) | [developers.cloudflare.com/pages/get-started/direct-upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) | Last updated Apr 21, 2026 |

確認した数値:

| 項目 | 値 | 出典 |
|---|---|---|
| 1ファイルの最大サイズ | 25 MiB(= 26,214,400バイト) | 両資料共通。Limitsページ原文: "The maximum file size for a single Cloudflare Pages site asset is 25 MiB." |
| ダッシュボードのドラッグ&ドロップ(フォルダーまたはZIP)の1回あたり最大ファイル数 | 1,000ファイル | Direct Uploadページ |
| Wrangler CLI(`wrangler pages deploy`、フォルダーのみ・ZIP不可)の1回あたり最大ファイル数 | 20,000ファイル | Direct Uploadページ |
| プロジェクト全体の資産ファイル数上限 | 無料プラン20,000ファイル/プロジェクト、有料プランは環境変数設定で最大100,000 | Limitsページ原文: "Cloudflare Pages sites can contain up to 20,000 files on the Free plan...(paid plans)...up to 100,000 files per site." |
| アップロード合計サイズの上限 | 明記なし(両資料とも合計バイト数の上限記載は確認できなかった) | ― |

今回の公開方法は`docs/requirements.md` §1.4(37行)の決定どおり「利用者がログインした状態のブラウザーで統括が操作する」直接アップロードであり、Wrangler CLIではなくダッシュボードのドラッグ&ドロップを使う。したがって適用される上限は**1,000ファイル・1ファイル25 MiB(26,214,400バイト)**であり、Wrangler側の20,000ファイルは今回の方式には適用されない。

実装側もこの区別を踏まえて上記の値を既に定数化している。

- `scripts/release/releaseReadiness.mjs`(37〜39行): `PAGES_MAX_FILES = 1_000`、`PAGES_MAX_FILE_BYTES = OFFLINE_MAX_FILE_BYTES`。37行のコメント: "Cloudflare Pages direct upload from the dashboard: 1,000 files and 25 MiB per file (docs/standards/cloudflare-pages.md)."(本書を出典として明記している)。
- `scripts/vite/offlineProtocol.mjs`(6行): `export const OFFLINE_MAX_FILE_BYTES = 26_214_400;`。
- `scripts/release/README.md`(87行)の公開前検査一覧に、Web候補の各ファイルが26,214,400バイト以下・ファイル数1,000以下であることを`scripts/check-release-ready.ps1`が検査する旨の記載がある(検査項目`asset-size`・`asset-count`、`scripts/release/releaseReadiness.mjs`53〜54行)。

候補の見込みとの比較:

| 項目 | 前回の記録(2026-09-16) | 公式の上限(ダッシュボード) | 余裕 |
|---|---|---|---|
| ファイル数 | 507ファイル(`docs/報告記録.md`「## 2026-09-16 03:35」見出し付近、12343行) | 1,000ファイル | 493ファイル(49.3%)の余裕。ただし以後の機能追加で増えている可能性がある |
| 合計バイト数 | 181,613,547バイト(同上) | 公式の合計上限は無し(上表のとおり) | 比較対象なし |
| 1ファイルの上限 | 26,214,400バイト(実装の`OFFLINE_MAX_FILE_BYTES`と一致) | 25 MiB = 26,214,400バイト | 完全一致(実装が公式上限をそのまま採用) |

現在(2026-09-24)の実際のファイル数・合計バイト数は本タスクの範囲外であり、統括が別途測定する(指示書に明記)。この節では未測定として扱い、数値を書かない。

## 配信CSPの `'unsafe-eval'` 例外(形状計算Workerの経路だけに限定)

配信CSPは3種類あり、いずれも`packages/ui/src/security/contentSecurityPolicy.ts`が定義し、Web(`_headers`・previewサーバー・PWAオフラインキャッシュ)とDesktop(Electronの独自スキーム)の両方が同じ関数を通して共用している(Web/Desktopで機能差を作らない、rules/04)。

| 定数 | 適用対象 | `script-src` | 備考 |
|---|---|---|---|
| `APP_CONTENT_SECURITY_POLICY`(4〜16行) | 通常画面全部(既定) | `'self' 'wasm-unsafe-eval'` | WASMのコンパイル/実体化だけを許可し、JSのeval/Functionは許可しない |
| `KERNEL_CONTENT_SECURITY_POLICY`(18〜20行) | 形状計算Workerのスクリプトだけ | `'self' 'unsafe-eval'` | 今回の確認対象の例外 |
| `MANUAL_CONTENT_SECURITY_POLICY`(23〜27行) | `/manual`以下(取扱説明書) | `'self'`(unsafe-*無し) | テスト(`contentSecurityPolicy.test.ts`38行)で`unsafe-`を含まないことを検査 |

**目的(実装コメントより引用、1〜3行):** 「画面は文字列からのJavaScript生成を許可しない。現OCCTのembindだけが必要とする動的生成の許可は、正規kernel Workerのレスポンスへ限定する。」

形状計算部が使うOCCT(`opencascade.js`)は、EmscriptenのembindによるC++⇄JSバインディングのグルーコード(`opencascade.js/dist/opencascade.full.js`、PointerCAD自身のソースではなくベンダーの生成物)を、Workerの中で実行時`import()`によって読み込む(`packages/kernel/src/occt/loadOcct.browser.ts`の`importOcctGlue()`94〜97行、`loadOcctForBrowser()`109〜143行)。この読み込みを呼ぶのは`packages/kernel/src/worker/kernel.worker.ts`(3行でimport、7行の`Comlink.expose(createKernelApi(loadOcctForBrowser))`)だけであり、これがビルド後に`isKernelWorkerAsset()`の判定対象となる`kernel.worker-*.js`という名前の資産になる。つまり例外が要る動的コード生成は、形状計算Workerのこのスクリプト1つの中でしか実行されない。独自コード側(PointerCAD自身のTS)に`eval`/`new Function`が無いことは、`docs/reviews/2026-09-12-全体レビュー(Claude Fable 5.1).md`252行のレビューで確認済みと記録されている。

**範囲:** `isKernelWorkerAsset()`(`contentSecurityPolicy.ts`30〜32行)が`/^\/assets\/kernel\.worker-[A-Za-z0-9_-]+\.js$/u`という固定のファイル名パターンに一致するパスだけを判定し、`contentSecurityPolicyFor()`(34〜37行)がこの判定の場合だけ`KERNEL_CONTENT_SECURITY_POLICY`を返す(`/manual`配下はそちらを優先、それ以外は既定の`APP_CONTENT_SECURITY_POLICY`)。この1つの関数を配信経路の全部が共有している。

- Web本番配信の`_headers`: `appendCloudflareSecurityHeaders()`(48〜64行)が`/assets/kernel.worker-*.js`という1行(62行)にだけ`KERNEL_CONTENT_SECURITY_POLICY`を書き出す。呼び出し元は`apps/web/build/securityPolicy.ts`の`generateBundle()`(35〜39行)。
- Web devサーバー/preview: `apps/web/build/securityPolicy.ts`の`configurePreviewServer()`(25〜34行)がリクエストのpathごとに`contentSecurityPolicyFor(path)`を呼ぶ。
- PWAのオフラインキャッシュ検証: `apps/web/src/pwa/offlineTransfer.ts`(21行・24行)が、キャッシュする応答のCSPヘッダーが`contentSecurityPolicyFor(pathname)`と一致しない場合に拒否する。
- Electron(Desktop)の独自スキーム: `apps/desktop/src/main/appProtocol.ts`(58行)が同じ`contentSecurityPolicyFor(url.pathname)`を呼ぶ。`apps/desktop/src/main/appProtocol.test.ts`(50行)は、形状計算Worker以外の通常資産の応答に`'unsafe-eval'`が含まれないことを検査している。

**広げない歯止め:** `contentSecurityPolicy.test.ts`(54〜58行)は、既定のWorkerファイル名にだけ例外が適用され、`/manual/assets/kernel.worker-*.js`のような説明書配下の同名ファイルには適用されない(説明書側が優先される)ことを検査している。計画側にも一般化を禁じる記述がある: `docs/plans/P11-拡張.md`(354行)「本体CSPにunsafe-evalを追加して通さない」、`docs/plans/P13-公開.md`(179行)「一般unsafe-evalで回避しない」。この例外はレビュー指摘R11の解消項目の1つとして`docs/reviews/2026-09-12-全体レビュー(Claude Fable 5.1).md`(336行)に記録されている。

## 統括がブラウザーで公開する手順(P13-2・P13-4)

`docs/requirements.md` §1.4(37行)の決定「Web版のCloudflare Pagesへの公開は、利用者がログインした状態のブラウザーで統括が操作する。アップロードの直前に内容を示して利用者の確認をとる。」を、次の手順に具体化する。

### 1. ログイン(利用者)

- ログインは利用者が行う。統括はログイン情報・トークン・Cookieなど秘密の値を見ず、入力もしない(本書冒頭の原則のとおり)。統括が確認するのは、ログイン後の画面に表示されるアカウント名・プロジェクト一覧など、秘密でない状態表示だけ。
- 統括は、利用者がログインした状態のブラウザーで「Workers & Pages」ダッシュボードを開き、対象アカウントであることを利用者に確認してもらう。

### 2. アップロード直前の内容確認(利用者の明示の承認が必須)

- 統括は、公開しようとしているフォルダー(`scripts/release/README.md`の手順で作った照合済みの一式。開発用の`apps/web/dist`は使わない)について、フォルダー名・総ファイル数・合計バイト数・`release-manifest.json`の`web.files`一覧(または同等の要約)・3つの`package.json`のversionを利用者へ示す。
- 上記「Cloudflare Pages 直接アップロードの制限」節の上限(1,000ファイル・1ファイル26,214,400バイト)を超えていないことを、`scripts/check-release-ready.ps1`(P12-20・P13-15)の`asset-size`・`asset-count`項目の合格を根拠として示す。
- 利用者の明示の確認(進めてよいという返答)を得てから、ダッシュボードの「Create application」→「Pages」→「Upload assets」(または既存プロジェクトへの新規デプロイ)でフォルダーをドラッグ&ドロップする。ZIPでもよい(ダッシュボードは両対応)が、フォルダー内の相対パス構造(`_headers`・`assets/`等)が壊れないことを事前に統括が確認する。

### 3. アップロードする中身とhashの照合

- アップロード前に、公開用フォルダーの全ファイルについて`read_bytes()`のSHA-256(共通規律§2の方式)を取り、`release-manifest.json`の`web.files`のhashと一致することを、アップロード操作の直前に確認する(取り違えたフォルダーを渡さないため)。
- Cloudflareのデプロイ完了後、実際に割り当てられたURL(`https://<プロジェクト名>.pages.dev/`)から主要ファイル(`index.html`・`_headers`・`assets/kernel.worker-*.js`・`manual/index.html`等)を取得し直し、取得したバイト列のSHA-256を、アップロード前に記録したhashおよび`release-manifest.json`の記録と突き合わせる。一致しないファイルがあれば、そのファイル名と差分を報告し、その回は公開完了と扱わない。
- この往復照合は、`scripts/release/README.md`が記す「公開後モード」(`-Mode PostRelease`)がURL・hashの突き合わせとして将来自動化する予定(P13-20で実装。現在は引数の形だけを受け付ける未実装で終了コード3)。それまでは統括が手動でSHA-256を突き合わせる。

### 4. 公開後に確認する項目

既存の「公開前後に確認すること」節の内容(起動・作図・保存・全説明書・通信なし利用、以前の版との分離)に加えて、次を確認する。

- 実URLでの起動時、ブラウザーの開発者ツールでCSPヘッダーが上記3種のとおり配信されていること(既定は`APP_CONTENT_SECURITY_POLICY`、`/manual`配下は`MANUAL_CONTENT_SECURITY_POLICY`、`/assets/kernel.worker-*.js`だけ`KERNEL_CONTENT_SECURITY_POLICY`)。特に通常画面の応答に`'unsafe-eval'`が含まれないこと。
- `crossOriginIsolated`が`true`であること(COOP/COEPの実配信確認。`docs/plans/P13-公開.md`179行)。
- 形状計算(立体の作成・フィレット等、Workerを使う操作)が実URL上で実際に成功すること(embind例外の対象経路が生きて動くことの確認)。
- READMEの導線(`scripts/release/README.md`92〜97行の規約)が指す実際のURLが取得できること。

### 5. 統括が`gh`で確かめる項目

- **リポジトリの公開範囲:** `gh repo view --json visibility -q .visibility`(リポジトリルートで実行、リモートを自動判定)。READMEの配布物リンクは`https://github.com/<所有者>/<リポジトリ>/releases/download/v<版>/<配布物名>`の形を取る(`scripts/release/README.md`95行)。この直リンクはリポジトリが`PUBLIC`でない限り未ログインの利用者には機能しないため、Web版・説明書を一般公開する前に`PUBLIC`であることを確認する。
- **Releaseを作る権限:** `gh auth status`で現在認証中のアカウントとトークンのscopeを確認し、`gh api repos/{owner}/{repo} --jq .permissions`で`push`(または`maintain`・`admin`)が`true`であることを確認する。Releaseの作成(`gh release create`)にはリポジトリへの書き込み権限が必要なため、公開作業の前に確認する。
- どちらも読み取りだけの確認であり、GitHub操作にあたるため統括が行う(作業担当は行わない。`CLAUDE.md`の役割分担「統括は…git/GitHub操作…だけを担当し」)。
