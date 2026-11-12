# 依存関係の更新と脆弱性監視

対応要件: NFR-SE-2、2026-09-09レビューR15。バージョンの正本は`pnpm-workspace.yaml`の完全固定catalogと`pnpm-lock.yaml`。mainへの取り込みは既存レビュー・品質ゲートと利用者が指定した作業のまとめ方に従う。

## 監視設定

- GitHub Dependabot alertsとsecurity updatesを有効にする。脆弱性情報に応じた通知・修正PRの生成と、下記の通常バージョン更新は別の設定として確認する。
- `.github/dependabot.yml`はnpmを平日毎朝7時、GitHub Actionsを月曜7時（Asia/Tokyo）に照会する。npmの`directories`はmanifest発見の範囲であり、catalog/importer/lockの整合や間接依存の更新成功は実行ログで別に確認する。security updatesの起動は通常更新の時刻とは別に扱う。
- 開いてよい通常更新PRはnpm10件、Actions5件。開発道具の互換更新はまとめ、Electron・Playwright・OCCT・ZIP・字体は関連回帰を確認できる単位にする。更新除外や自動マージは設定しない。
- 通知の一次対応はプロジェクト保守担当（現在の実装担当Codex）が担い、利用者へ`docs/報告記録.md`で対象・判定・対策・検証結果を報告する。開発中は各作業開始時とリリース判定時に未解決アラートを確認する。

## 判定と期限

脆弱性アラートを受けたら、該当する直接/間接依存、影響範囲、修正版の有無を一次情報とlockfileで照合する。Critical/Highは当日、その他は次の作業開始時に調査を始める。修正のない依存は安全な代替または影響する経路の修正を検討する。**有効な未解消指摘を残してリリースしない。**

誤検出・到達不能などとして対象外にする場合も、アラートID、判定根拠、対象SHA、担当、再確認期限を報告記録へ残す。無期限の抑制はしない。再確認期限は次の関連依存更新または30日後の早い方とし、リリース時には必ず再確認する。「アラート0件」だけを未知の問題がない証明には使わない。

## 更新時の回帰範囲

| 依存 | 必須の関連確認 |
|---|---|
| Electron / Node | sandbox・preload・送信元/権限拒否、実ファイルの保存失敗/復元、起動終了、印刷 |
| fflate / ZIP | 展開確保前のentry/total予算、CRC、破損/偽サイズ/descriptor/ZIP64、pcad/pcada/pcadd/3MF往復 |
| OCCT / WASM / Comlink | Worker起動・取消・復旧、体積/許容差/所有権、STEP等の往復、製作図投影、既定性能条件 |
| opentype / 同梱字体 | 欠字/実字形/実測幅、穴と曲線、PDF/SVG/DXFの一致、ドラッグ性能と保持予算 |
| React / Three / Vite / Playwright | 両アプリのビルド、実操作と表示、CSP/Worker/資産配信、Chromium・Firefox・Electronの通常受入 |
| GitHub Actions | 権限、checkout対象、固定Node/pnpm、通常の同一検査入口、成果物・失敗の記録 |

型・lint・単体・build・E2Eは`./scripts/check.ps1`を正本として実行し、更新PRだからといって既定性能値や検査対象を緩和しない。現CIはWindows/Ubuntuの`front`、`unit-lead`、`e2e`各6 shardと集約`checks`を接続済みとする。公開判定では設定の存在ではなく、完成コードの**同一SHAで両OSの全jobが成功した実行記録**を確認する。Firefox/Electronの実操作とNSIS・portable・AppImageの起動、保存、終了、全同梱物のhash照合も別に確認する。

## 2026-10-04のアラートと実行記録

2026-10-04 04:10:48 JSTにGitHub APIで取得したopen集合は12件（High 3、Medium 6、Low 3）。同時にalerts有効（HTTP 204）、repositoryのsecurity updates有効を確認した。以下のstateは**この取得時点**の値であり、ローカルの依存候補を作った後に閉じたという意味ではない。GitHubのdependency scopeはundiciの10件が`runtime`、brace-expansionとhttp-cache-semanticsが`development`。実lockの到達経路は別に追う。

| ID / GHSA | 深刻度・取得時state | 実lockと経路 | 修正版・対応期限 |
|---|---|---|---|
| #4 [w293-vg96-wgc3](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3) | High / open | undici 7.29.0、@electron/get 5.1.0のoptional依存。TLS設定 | 7.29.1、10/4 12:00 JST |
| #8 [rfgv-xxqx-mfg5](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5) | High / open | 同じundici 7系、WebSocket | 7.29.1、10/4 12:00 JST |
| #1 [3wwx-pv8p-q78v](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v) | Medium / open | 同じundici 7系、WebSocket解凍 | 7.29.1、10/5 07:00 JSTまで |
| #2 [rx4f-c7p8-82vq](https://github.com/nodejs/undici/security/advisories/GHSA-rx4f-c7p8-82vq) | Medium / open | 同じundici 7系、切断 | 7.29.1、同上 |
| #6 [2jfj-6hjv-fm6j](https://github.com/nodejs/undici/security/advisories/GHSA-2jfj-6hjv-fm6j) | Medium / open | 同じundici 7系、共有HTTP cache | 7.29.1、同上 |
| #7 [3xpg-4rpp-hhhm](https://github.com/nodejs/undici/security/advisories/GHSA-3xpg-4rpp-hhhm) | Medium / open | 同じundici 7系、解凍サイズ | 7.29.1、同上 |
| #10 [pmjh-fq2x-6v4x](https://github.com/nodejs/undici/security/advisories/GHSA-pmjh-fq2x-6v4x) | Medium / open | 同じundici 7系、retry | 7.29.1、同上 |
| #3 [8436-99hf-9mmv](https://github.com/nodejs/undici/security/advisories/GHSA-8436-99hf-9mmv) | Low / open | 同じundici 7系、cache再生 | 7.29.1、同上 |
| #5 [2gqq-gqf2-x968](https://github.com/nodejs/undici/security/advisories/GHSA-2gqq-gqf2-x968) | Low / open | 同じundici 7系、過大chunk | 7.29.1、同上 |
| #9 [r53p-7pc4-xj5r](https://github.com/nodejs/undici/security/advisories/GHSA-r53p-7pc4-xj5r) | Low / open | 同じundici 7系、retry後の応答 | 7.29.1、同上 |
| #13 [q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | Medium / open | brace-expansion 5.0.9、minimatch 10.2.6のglob | 5.0.12、同上 |
| #15 [ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) | High / open(取得時点) | http-cache-semantics 4.2.0、electron-builder→@electron/get 3.1.0→gotの配布取得経路 | 修正版なし。**依存の置き換えで解消(2026-10-05 18:00 JST、手元。GitHub側のstateは取り込み後に再GET)**。下記 |

「同上」の期限は次の作業開始が10/5 07:00 JSTより早ければその開始時、関連更新・公開が先ならその直前とする。候補は`@electron/get@5.1.0>undici=7.29.1`と`minimatch@10.2.6>brace-expansion=5.0.12`の2辺だけ。undici 6.28.1、brace-expansion 1.1.21/2.1.7と全親版を維持する。#15はこの2件では解消しない。配布処理では設定を合成した後に、gotへ共有HTTP cacheを渡せる枝を拒否し、ファイル成果物のcache、TLS検証、checksumを維持する。これは把握した配布入口の制限であり、#15のalertをdismissしたり修正版適用済みと呼んだりしない。上流の修正と新しい経路を期限ごとに再確認し、有効な未解消Highの公開判定は統括が別に行う。

Dependabotの**通常更新は実行中だが失敗中**。10/1のsecurity job `110320211909`（brace）と`110320211204`（undici）は固定版更新とfallbackの後、各`security_update_not_possible`、`update_files`終了1。結果欄のlatest possibleはそれぞれ1.1.21と6.28.1で、脆弱な5系/7系の実解決を代表しない。10/1の通常更新job `110119937869`は`pnpm install --lockfile-only`終了1、`dependency_file_not_resolvable` 40件、10/2の`110608291825`は`npm install ... --package-lock-only --dry-run`終了1を含み同種50件で、両方とも`update_files`終了1。通常更新の一部PR created表示をjob全体の成功に読み替えない。初回の固定版pin拒否とfallbackの正確な原因は隔離lockと原ログで追う。pnpm 11.25.0の実jobとGitHubの公表対応表（pnpm v7〜v10）の差も監視する。

#15の解消(2026-10-05 18:00 JST、手元の確認)。`pnpm-workspace.yaml`のoverridesへ`app-builder-lib@26.15.3>@electron/get: 5.1.0`を足し、app-builder-libが使う@electron/getをgot不使用(組込みfetch)の5.1.0へ寄せた。5.1.0は既にElectron本体(electron@44.1.0)が使う版でlock上の新規取得は無く、undici 7.29.1の固定も維持する。lockからhttp-cache-semantics 4.2.0・got 11.8.6・cacheable-request等353行が消え、`pnpm install --frozen-lockfile`が成功し、`pnpm why http-cache-semantics`は空。electronDistで元を取りに行かない案は、app-builder-libが7zip・NSIS・AppImageの道具も@electron/get経由で取るため、lockの辺が残り採らない。確認: 隔離コピーで実際にelectron-builder 26.15.3(5.1.0経由)が7zip道具(checksum検証)とElectron 44.1.0本体を取得・展開しwin-unpackedを作成。desktop単体45ファイル557件合格・型・全lint合格、build-sbom成功(部品87、原文欠け0)。制限: 5.1.0の失敗はHTTPError.response.statusで、app-builder-libの5xx再試行判定(response.statusCode)に当たらず、5xxの自動再試行だけ効かない(接続系のcode再試行は有効)。`sealDesktopBuilderDownloadConfig`の方針(cache・strictSSL・checksum)は維持。別件でfast-uri(Moderate)が`pnpm audit`に出る(本件外)。両OSのCIと配布CIで最終確認する。

配布SBOMは実際に同梱するWeb/Desktopのproduction資産・字体・WASM/Python・許諾を対象とする。開発・ビルド道具のlock全量は別の依存監査範囲であり、配布SBOMにないことを脆弱性不存在とはしない。両方の目録、NOTICE、同梱ファイルhashを同じ候補SHAで照合し、新しい除外例外で指摘を隠さない。default branch反映後は全12 IDのstateをAPIで再GETし、新規alertも確認する。

## 初期設定の記録

2026-09-10 20:31 JST、`oltotlo79-rgb/PointerCAD`へGitHub APIでvulnerability-alertsとautomated-security-fixesを有効化（各204）。再照会でalerts有効204、repositoryのdependabot_security_updates=enabled、未解決アラート一覧200/0件を確認した。監視開始直後の照会であり、依存全体に脆弱性が存在しないという判定ではない。設定ファイルはmainへ反映後にスケジュール動作も確認する。

設定項目の根拠: [GitHub公式Dependabot設定](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)、[リポジトリのセキュリティ修正API](https://docs.github.com/en/rest/repos/repos#enable-automated-security-fixes)。

## 2026-11-02の依存更新（7件）とminimatchの判定

2026-11-02 05:13〜05:33 JSTにregistry.npmjs.orgとGitHub Advisory APIを認証なしで照会し（原票は作業担当の記録に保存）、次の7件を候補にした。候補の版は、照会の時点でGHSAの該当が0件だった。

| 依存 | 旧版 → 候補 | lockの経路 | 指定 |
|---|---|---|---|
| electron | 44.1.0 → 44.9.1 | apps/desktopの直接依存 | catalog |
| vitest / @vitest/mocker | 4.1.11 → 4.1.12 | 開発道具（vitest 4.1.12がmockerを同じ版で固定） | catalog |
| undici 7系 | 7.29.1 → 7.30.1 | @electron/get 5.1.0のoptional依存 | `@electron/get@5.1.0>undici` |
| undici 6系 | 6.28.1 → 6.29.1 | node-gyp 12.4.0 | `node-gyp@12.4.0>undici`（新設） |
| fast-uri | 3.1.8 → 3.1.9 | ajv 8.20.0 | `ajv@8.20.0>fast-uri` |
| source-map-js | 1.2.1 → 1.2.2 | postcss 8.5.26 | `postcss@8.5.26>source-map-js`（新設） |
| zod | 4.5.4 → 4.6.6 | eslint-plugin-react-hooks 7.1.1 | `eslint-plugin-react-hooks@7.1.1>zod`（新設） |

- 対象のバイト: 変更前は`pnpm-workspace.yaml` 45ff4843…（1,966 B）と`pnpm-lock.yaml` cde5ed4f…（131,546 B）。候補は`pnpm-workspace.yaml` fe465146…（2,094 B）と`pnpm-lock.yaml` 927537b7…（131,663 B。pnpm 11.25.0でlockだけを解決し終了0）。統括の伝達では07:20:47に作業ツリーへ採用した。07:31 JSTに、作業ツリーの2ファイルがこの候補のSHAと一致し、lockに旧版7件とvitest 4.1.11が残っていないことを読み取りで確かめた。2026-11-12時点の`pnpm-lock.yaml`は64452ade13077f0da4de4b1f1fd8fb1b9582628da3d325761e19632a0a47519a（131,851 B、`sha256sum`で取得）で、上の927537b7…とは別の値になっている（変わった内訳は未照合）。`pnpm-workspace.yaml`は2026-11-12時点でもfe465146…（2,094 B）で、上の候補と同じ。
- **未了の境界（2026-11-02の記録時点。2026-11-12時点の現況は下の「2026-11-12時点の現況」）**: この記録の時点で、このlockによる`pnpm install --frozen-lockfile`、型・lint・単体・build・E2E、Electron 44.9.1の回帰（上の「Electron / Node」の行）、配布作成、両OSのCIはまだ実行していない。導入済み・配布済み・Dependabot alertの解消とは扱わない。alertのstateはdefault branchへの反映後にAPIで再GETする。
- 配布SBOMとの関係: 6件（vitest/mocker・undici 2系統・fast-uri・source-map-js・zod）は開発・build・配布作成の道具の依存で、`docs/standards/licenses/runtime-notices.json`の配布npm部品11件に含まれない。ElectronはDesktopの実行環境として同梱される。この記録の時点（2026-11-02）では`scripts/release/sbom.mjs`はElectron本体を部品として集めていなかったが、2026-11-10のcommit fe9a58e4から1部品として集めている（2026-11-12に現物で確認）。名前は`electron`、版は`apps/desktop`が実際に導入した`electron/package.json`の`version`（Desktop候補の`electronVersion`を記録する`assemble-desktop.mjs`と同じ解決。2026-11-12の作業ツリーでは44.9.1）、許諾は導入したpackageの`license`がMITで、同じpackageの`LICENSE`がMITの許諾と免責の文を含む時だけMITとする（`electronComponentFromPackage`）。供給元は`repository`（https://github.com/electron/electron ）、`LICENSE`のSHA-256と、実行ファイルの横に置く原文2件（`LICENSE.electron.txt`・`LICENSES.chromium.html`）の名前も記録する（2件のバイトを固定する記録はリポジトリに無いのでハッシュは付けない）。検査は`apps/desktop/src/main/sbom.test.ts`の「デスクトップ版に入るElectronを…1部品として記録する」と拒否の検査。Electronに組み込まれたChromiumとNode.jsは部品に入れていない。版を取れる確かな記録がリポジトリに無いため（導入した`electron/package.json`に両者の版の項目は無く、`engines.node`は導入道具の条件。実行中の`process.versions`はElectronを起動しないと読めない）。両者の許諾は実行ファイルの横の`LICENSES.chromium.html`が担う。
- FEMの応用ソース書庫の索引（`packages/fem/runtime/evidence/application-source-index.json`）は`pnpm-lock.yaml` cde5ed4f…と`pnpm-workspace.yaml` 45ff4843…を記録していた（2026-11-02時点）。`collectSbomComponents`とFEMのbuildはこの記録と現在のファイルの一致を確かめ（`assertFemApplicationBuildInputs`）、不一致なら止まる。2026-11-02の記録時点では、採用したlock・yamlに合わせて書庫・索引・manifestの固定値を作り直すまで、SBOMの生成とbuildは通らない見込みだった（当時は未実行）。2026-11-12時点の索引は`pnpm-lock.yaml` 64452ade…（131,851 B）と`pnpm-workspace.yaml` fe465146…（2,094 B）を記録しており、どちらも現在のファイルの`sha256sum`と一致している（索引の値と照合）。
- **2026-11-12時点の現況**:
  - SBOM: 配布用の外部検査（GitHub Actions run 43149366809、commit 33e823d289f790eb9865da720f20a98acf8339a9）で、段「SBOM(CycloneDX)を作る」は成功した。出力は`components`268、`unresolvedNotices`0、`unclassifiedLicenses`9、`noLicenseInformation`0。commit 33e823d2はElectronの部品を入れたfe9a58e4の子孫で、33e823d2から4621eafaまで`sbom.mjs`・`sbom.test.ts`に差分は無く、`collectSbomComponents`はElectronの部品を必ず加える（作れなければ段が失敗する）ので、268にはElectron本体の1部品が含まれると読める（手元の作業ツリーで同じ`buildSbom`を流すと268件で`electron` 44.9.1が入る。そのrunの`sbom.json`の部品名は今回取得しておらず、確かめていない）。未分類9件の扱いは下の節「SBOMの未分類9件」。
  - 同じrunの次の段「release-manifestを組み立てる」は失敗した。原因は特定され、commit 4621eafaで直した。`scripts/release/releaseManifest.mjs`が、Web版で圧縮（gzip）して置いた計算部品のファイルを、展開した後の大きさとハッシュの記録と直接比べていた。直しでは、圧縮されたファイルを圧縮の記録と照合し、展開した結果を元の記録と照合する形にした（単体の検査5件を追加）。直しの後に、この段が配布用の外部検査で通ることは、まだ確かめていない（run 43180628085は、その前の「配布物を起動して確かめる」段が検査の側の競合で落ち、この段は実行されなかった）。配布物の一覧（release-manifest）は、この時点ではまだ作れていない。
  - Dependabot: 2026-11-12 18:45 JSTにalertのstateをAPIで取得し（未解決37件・解決済み47件）、10/1〜10/3の失敗10本を原ログで分類した。表と判定・期限は下の節「2026-11-12のDependabot警告と10/1〜10/3の失敗の記録」。

### minimatch GHSA-g3hv-75wg-m249（到達しないので対象外、期限付き）

- 範囲は< 11.0.1、修正版は11.0.1だけ。lockのminimatchは3.1.5・5.1.9・9.0.9・10.2.6の4系列で、候補のlock 927537b7…でも同じ4版（07:31に読み取りで確認）。
- 根拠: 悪用には`optimizationLevel >= 2`でfirstPhasePreProcessを通ることが要る（GHSA本文）。3.1.5と5.1.9にはその処理がない。9.0.9と10.2.6は既定値が1で、2以上の時だけ通る。lock cde5ed4f…上の呼び出し元9つ（eslint 10.9.1、@eslint/config-array 0.23.5、typescript-estree 8.69.0、app-builder-lib 26.15.3、@electron/universal 2.0.3、@electron/asar 3.4.1、dir-compare 4.2.0、filelist 1.0.6、glob 7.2.3）は、どれも`optimizationLevel`を渡さない。patternは開発者の設定と配布の設定から来る。既定を2にするglob v9以降はlockにない。
- 判定: 到達しないので対象外とする。依存が安全だという判定ではない。同じ系列の親の更新に修正を含むものはなく、11を求めるのはメジャー更新のglob 14だけなので、patch更新では解消しない。
- 判定対象: lock cde5ed4f…と、minimatchの現物4ファイル（3.1.5 746849f2…、5.1.9 1339bca8…、9.0.9 a958a415…、10.2.6 d224f71f…。原票`minimatch-callers-20261102-053123.json`）。呼び出し元の版は927537b7…ではまだ照合し直していない。担当: 作業担当（Opus 5.5）が調べ、採否は統括が決める。
- 再確認の期限: 2026-12-02と、次のどれかが起きた時のうち早い方。lockのminimatchか呼び出し元の版が変わった時、glob v9以降が入った時、GHSA-g3hvに10.x以前の修正版が載った時。リリースの判定の時には必ず再確認する。

## 2026-11-12のDependabot警告と10/1〜10/3の失敗の記録

- 取得: 2026-11-12 18:45 JSTに統括がGitHub APIで取得した。対象の版はmainのcommit 4621eafa460b0bf41ae0d042d2817dd169e8dfd4。材料は作業の記録`scratchpad/claude/root-runtime/r11-evidence-1112/`（Gitの管理外）にある: `dependabot-alerts-open.json`（未解決37件）、`dependabot-alerts-all.json`（全84件。未解決37、解決済み47）、`runs-1001-1003.json`（10/1〜10/3の実行21本）、`run-<id>-failed.log`（失敗10本の、失敗した段のログ）。
- 担当: 調べたのは作業担当cl-v103-r11-dependency-evidence-1112（Claude Opus 5.5、2026-11-12）。対象外とする判定の採否と、依存の変更の承認の取得は統括が行う。
- 3つの状態: (1) alert: 上の取得の時点で未解決37件。(2) security updates: 10/1と10/3のsecurity jobの4本は全て`security_update_not_possible`で失敗した（下の表）。今のリポジトリの設定（有効・無効）は今回取得しておらず、確かめていない。(3) 通常の版の更新: 10/1 22:11 UTCのversion jobの1本が`dependency_file_not_resolvable` 50件で失敗し、PRは5件作られた。10/3より後の通常の更新の実行は材料に無く、今も失敗が続くかは確かめていない。
- 解決済み47件は全て`pnpm-lock.yaml`の警告で、`fixed_at`はどれも2026-11-11T15:05Z（mainへ反映した時刻）。

### 未解決の警告37件

内訳は重大1・高5・中23・低8。36件（filelock 17・virtualenv 12・pip 6・certifi 1）は`packages/fem/runtime/sources/native-rebuild/portable/venv-requirements.txt`（GitHubの区分はruntime）、1件（minimatch）は`pnpm-lock.yaml`（区分はdevelopment）。

36件に共通の事実:

- `venv-requirements.txt`は、oofemの計算部品（Pyodide用のwheel）をLinuxで作り直す時のPython環境の版の一覧（1行目「Exact post-repair build venv (CPython 3.13.2)」）。読むのは作り直しの台本`packages/fem/runtime/sources/native-rebuild/portable/rebuild-oofem-pyodide.sh`の`s_venv`（153〜173行。渡された環境の版が一覧と同じことを確かめる。certifi 159行・filelock 160行・pip 163行・virtualenv 167行）。台本は全体としては未実行（4行目「UNEXECUTED as a whole」）、ネットにつながず（2行目「no network」）、自分では何も入れず何も取りに行かない（17行）。
- 配布物には、この一覧の文字のファイル（988 B）だけが、oofemの対応するソースの一部として入る（`packages/fem/runtime/manifest.json` 494行。`scripts/vite/femRuntimeAssets.mjs` 52行で`licenses/fem/sources/native-rebuild/portable/venv-requirements.txt`としてWeb版・デスクトップ版の両方に置かれる）。4つの部品のコードは入らない: FEMの配布ファイル168件と追加計算部（`vendor/exact-math`）の45件の名前に該当は0件、FEMのwheelはnumpy・oofem・netgen_mesherの3つだけ、同梱の`python_stdlib.zip`（FEMは579項目、追加計算部は614項目）にensurepip・pip・certifi・filelock・virtualenv・venvは0件。`packages/fem/runtime/assets/pyodide-lock.json`はcertifi 2026.1.4を一覧に持つが、そのwheelは同梱しない。`.github`・`scripts/release`・`packages/test-utils/src`にこのファイルを読む所は無い。
- 動く場面: PointerCADの起動・計算・保存では動かない。動くのは、開発者、または対応するソースから自分で作り直すことを選んだ利用者が、同梱の手引き（`packages/fem/runtime/evidence/recipient-source-replacement.md` 53行）に従ってLinuxの作り直しの環境を用意した時だけ。その時`s_venv`が版の一致を求めるので、修正版の環境では台本が止まる。
- 判定: 36件とも「開発の時だけ届く」（配布物の中では動かない）。下の期限まで対象外の例外として扱う。再確認の期限は2026-12-12（取得から30日）と、`venv-requirements.txt`・`rebuild-oofem-pyodide.sh`・FEMの計算部品のどれかが変わった時、公開の判定の時のうち早い方。
- 直しの案（依存の変更なので未実施。統括が利用者の承認を取る）: `venv-requirements.txt`と台本の`s_venv`の版を、certifi 2026.10.18・filelock 4.2.1・virtualenv 21.14.9・pip 26.2.0以上へ上げる。変えると、このファイルと台本の固定値（SHA-256）や版を持つ`packages/fem/runtime/`の`manifest.json`・`evidence/source-index.json`と、`sources/native-rebuild/portable/`の`packet-inventory.json`・`replay-environment.json`・`replay_controls.py`・`replay-status.json`の作り直しが要る。この一覧は実際にoofemを作った環境の記録でもあるので、上げる時は「記録した環境」と「推奨する環境」の書き分けも決める。

重大・高の6件（例外の1件ごとの記録）:

| 警告 | GHSA | 部品・今の版 → 修正版 | 届かない根拠（行番号） | 悪用に要る条件 | 担当 | 期限 |
|---|---|---|---|---|---|---|
| #74 重大 | [GHSA-6q48-6c7w-9gw2](https://github.com/advisories/GHSA-6q48-6c7w-9gw2) | certifi 2026.7.22 → 2026.10.18 | `venv-requirements.txt` 8行と台本159行だけが版を持つ。配布物には一覧の文字だけ（`manifest.json` 494行、`femRuntimeAssets.mjs` 52行）、certifiのコードは同梱物に0件。台本はネットにつながない（2行目・17行） | certifiの証明書の束でTLSをつなぐ時に、侵害されたemSignの中間CAの証明書を示す中間者がいる | 調べた: cl-v103-r11-dependency-evidence-1112／採否: 統括 | 2026-12-12 |
| #56 高 | [GHSA-vxj4-q4g9-crj7](https://github.com/advisories/GHSA-vxj4-q4g9-crj7) | virtualenv 21.14.6 → 21.14.7 | `venv-requirements.txt` 43行と台本167行だけ。virtualenvのコードは同梱物に0件 | 逆斜線と`$`を含む環境の名前で、bashの有効化の台本を使う | 同上 | 2026-12-12 |
| #57 高 | [GHSA-c978-59m8-c77v](https://github.com/advisories/GHSA-c978-59m8-c77v) | virtualenv 21.14.6 → 21.14.9 | 同上 | 作成先のパスを攻撃者が決められる時に、POSIXの起動の台本を作る | 同上 | 2026-12-12 |
| #66 高 | [GHSA-6w3r-xr62-4xcp](https://github.com/advisories/GHSA-6w3r-xr62-4xcp) | virtualenv 21.14.6 → 21.14.9 | 同上 | 古い互換モードのbashで、攻撃者が決めた表示の値を使う | 同上 | 2026-12-12 |
| #68 高 | [GHSA-394h-qwmc-48pf](https://github.com/advisories/GHSA-394h-qwmc-48pf) | virtualenv 21.14.6 → 21.14.9 | 同上 | Xonshの有効化の台本を、別の文字の符号で読む | 同上 | 2026-12-12 |
| #61 高 | [GHSA-v4x8-3wr5-3wq8](https://github.com/advisories/GHSA-v4x8-3wr5-3wq8) | filelock 4.1.0 → 4.2.1 | `venv-requirements.txt` 12行と台本160行だけ。filelockのコードは同梱物に0件 | 同じ機械の別の利用者が、錠のデータベースの横にリンクやジャーナルのファイルを置く | 同上 | 2026-12-12 |

全37件（悪用に要る条件は、同じ部品の警告に共通の形で書く。題はGHSAの原文）:

| 警告 | 深刻度 | 部品 | GHSA | 題 | 今の版 → 修正版 | 悪用に要る条件 | 判定 | 再確認の期限 |
|---|---|---|---|---|---|---|---|---|
| #74 | 重大 | certifi | [6q48-6c7w-9gw2](https://github.com/advisories/GHSA-6q48-6c7w-9gw2) | certifi bundles emSign root CAs with compromised intermediate CA keys | 2026.7.22 → 2026.10.18 | certifi の証明書の束で TLS をつなぐ時に、侵害された emSign の中間 CA の証明書を示す中間者がいる | 開発の時だけ届く | 2026-12-12 |
| #56 | 高 | virtualenv | [vxj4-q4g9-crj7](https://github.com/advisories/GHSA-vxj4-q4g9-crj7) | virtualenv bash activate runs commands from an environment name with a backslash before $ | 21.14.6 → 21.14.7 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #57 | 高 | virtualenv | [c978-59m8-c77v](https://github.com/advisories/GHSA-c978-59m8-c77v) | virtualenv: Generated POSIX console launchers interpret destination paths as shell syntax | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #61 | 高 | filelock | [v4x8-3wr5-3wq8](https://github.com/advisories/GHSA-v4x8-3wr5-3wq8) | filelock ReadWriteLock: SQLite reopens the lock database by name, so a planted symlink or journal file makes the lock user's process overwrite or unlink its own files | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #66 | 高 | virtualenv | [6w3r-xr62-4xcp](https://github.com/advisories/GHSA-6w3r-xr62-4xcp) | virtualenv: Bash prompt values can change meaning under older compatibility modes | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #68 | 高 | virtualenv | [394h-qwmc-48pf](https://github.com/advisories/GHSA-394h-qwmc-48pf) | virtualenv: Xonsh activation literals depend on the script decoding codec | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #50 | 中 | pip | [4xh5-x5gv-qwph](https://github.com/advisories/GHSA-4xh5-x5gv-qwph) | pip's fallback tar extraction doesn't check symbolic links point to extraction directory | 24.3.1 → 25.3 | 悪意のある書庫・パッケージ、または悪意のある索引から入れる | 開発の時だけ届く | 2026-12-12 |
| #52 | 中 | pip | [58qw-9mgm-455v](https://github.com/advisories/GHSA-58qw-9mgm-455v) | pip has an interpretation conflict due to handling both concatenated tar and ZIP files as ZIP files | 24.3.1 → 26.1 | 悪意のある書庫・パッケージ、または悪意のある索引から入れる | 開発の時だけ届く | 2026-12-12 |
| #53 | 中 | pip | [jp4c-xjxw-mgf9](https://github.com/advisories/GHSA-jp4c-xjxw-mgf9) | pip Vulnerable to Inclusion of Functionality from Untrusted Control Sphere | 24.3.1 → 26.1 | 悪意のある書庫・パッケージ、または悪意のある索引から入れる | 開発の時だけ届く | 2026-12-12 |
| #54 | 中 | pip | [wf93-45jw-7689](https://github.com/advisories/GHSA-wf93-45jw-7689) | pip: Path traversal in console_scripts/gui_scripts entry point names allows installing scripts outside of target directory | 24.3.1 → 26.1.2 | 悪意のある書庫・パッケージ、または悪意のある索引から入れる | 開発の時だけ届く | 2026-12-12 |
| #55 | 中 | pip | [qwm4-qh6w-59xr](https://github.com/advisories/GHSA-qwm4-qh6w-59xr) | pip would incorrectly handle doubly-encoded package URLs from indexes | 24.3.1 → 26.2.0 | 悪意のある書庫・パッケージ、または悪意のある索引から入れる | 開発の時だけ届く | 2026-12-12 |
| #58 | 中 | virtualenv | [43mp-35q3-x3fq](https://github.com/advisories/GHSA-43mp-35q3-x3fq) | virtualenv: Deletion recovery can change a symlink target's mode | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #59 | 中 | virtualenv | [cw65-gx24-rc82](https://github.com/advisories/GHSA-cw65-gx24-rc82) | virtualenv: Builtin creation follows linked environment directories | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #60 | 中 | virtualenv | [558c-9hv2-4prj](https://github.com/advisories/GHSA-558c-9hv2-4prj) | virtualenv: Generated files can follow existing destination links | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #62 | 中 | filelock | [crv4-6mhj-j5jh](https://github.com/advisories/GHSA-crv4-6mhj-j5jh) | filelock: SoftFileLock stale-break restore follows a swapped-in symbolic link and hard-links a file of the user running the lock into the lock directory | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #63 | 中 | filelock | [2g95-wg33-c5x2](https://github.com/advisories/GHSA-2g95-wg33-c5x2) | filelock: SoftFileLock evicts a fresh lock file whose watched age another local user's pre-dated file passed on through inode reuse | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #64 | 中 | virtualenv | [hhxq-47xx-j5xx](https://github.com/advisories/GHSA-hhxq-47xx-j5xx) | virtualenv: Seed replacement does not contain metadata deletion paths | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #67 | 中 | virtualenv | [fc2g-4w5p-6whm](https://github.com/advisories/GHSA-fc2g-4w5p-6whm) | virtualenv: Seeded files retain permissions from an older cache | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #73 | 中 | filelock | [jqc4-5cvw-7w85](https://github.com/advisories/GHSA-jqc4-5cvw-7w85) | filelock: ReadWriteLock on the hard-link route deletes any directory another user renames onto its .filelock-* link directory name | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #75 | 中 | filelock | [fq56-3cx3-fjxp](https://github.com/advisories/GHSA-fq56-3cx3-fjxp) | filelock: SoftFileLock stale-lock break removes a live lock file on a reused inode number and admits two holders | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #76 | 中 | filelock | [fj95-fr6c-h845](https://github.com/advisories/GHSA-fj95-fr6c-h845) | filelock: SoftReadWriteLock holder refresh writes through a hard link and hangs on a named pipe that another local user renames over its record | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #77 | 中 | filelock | [m462-7rxw-wvpg](https://github.com/advisories/GHSA-m462-7rxw-wvpg) | filelock: StrictSoftFileLock follows a symbolic link swapped in at <path>.filelock and creates claim files in a directory another local user chooses | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #78 | 中 | filelock | [69hj-f68j-2879](https://github.com/advisories/GHSA-69hj-f68j-2879) | filelock: UnixFileLock truncates and chmods any regular file another user renames or hard-links onto the lock path | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #80 | 中 | filelock | [rfpc-qcw5-3pc4](https://github.com/advisories/GHSA-rfpc-qcw5-3pc4) | filelock: SoftFileLock removes a live holder's marker when another user forges the PID in a writable marker | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #81 | 中 | filelock | [cwqr-hh33-gh44](https://github.com/advisories/GHSA-cwqr-hh33-gh44) | filelock ReadWriteLock: a crafted lock database makes every acquire stall or hang regardless of timeout | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #82 | 中 | filelock | [8mx5-7m5m-r77g](https://github.com/advisories/GHSA-8mx5-7m5m-r77g) | filelock: WindowsFileLock ignores mode: a 0o600 lock file and the ReadWriteLock database inherit the directory ACL | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #83 | 中 | filelock | [9c4x-gm8v-wgc4](https://github.com/advisories/GHSA-9c4x-gm8v-wgc4) | filelock: StrictSoftFileLock and SoftReadWriteLock adopt a protocol directory another user created first, losing mutual exclusion | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #84 | 中 | filelock | [6627-m3xw-93mp](https://github.com/advisories/GHSA-6627-m3xw-93mp) | filelock: StrictSoftFileLock creates its claim directories without the lock mode, so another local user with a write bit on them can end a live hold | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #86 | 中 | minimatch | [g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | minimatch has potential denial of service via globparts amplification | 3.1.5・5.1.9・9.0.9・10.2.6 → 11.0.1 | optimizationLevel 2 以上で悪意のある glob を渡す（下の節） | 到達しない（下の節） | 2026-12-02 |
| #51 | 低 | pip | [6vgw-5pg2-w6jp](https://github.com/advisories/GHSA-6vgw-5pg2-w6jp) | pip Path Traversal vulnerability | 24.3.1 → 26.0 | 悪意のある書庫・パッケージ、または悪意のある索引から入れる | 開発の時だけ届く | 2026-12-12 |
| #65 | 低 | virtualenv | [qmx5-4p3x-wvqf](https://github.com/advisories/GHSA-qmx5-4p3x-wvqf) | virtualenv: Venv configuration readback can reinterpret path boundaries | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #69 | 低 | virtualenv | [494p-63j8-28p3](https://github.com/advisories/GHSA-494p-63j8-28p3) | virtualenv: Downloaded wheel selection and caching precede verification | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #70 | 低 | virtualenv | [cx28-75q4-x26q](https://github.com/advisories/GHSA-cx28-75q4-x26q) | virtualenv: Pip seeding with download omits wheel digest verification | 21.14.6 → 21.14.9 | 環境の名前・作成先・表示の文字・控えの中身を攻撃者が決められる時に、環境を作る・有効にする | 開発の時だけ届く | 2026-12-12 |
| #71 | 低 | filelock | [567q-5qvw-pf92](https://github.com/advisories/GHSA-567q-5qvw-pf92) | filelock: On Windows an oplock on a soft lock's marker holds SoftFileLock.acquire() past its timeout and blocks the stale break | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #72 | 低 | filelock | [9vhv-jxww-xfm5](https://github.com/advisories/GHSA-9vhv-jxww-xfm5) | filelock: ReadWriteLock on Windows acts on SQLite side files another local user places beside its database | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #79 | 低 | filelock | [9j6q-wvj5-jgjg](https://github.com/advisories/GHSA-9j6q-wvj5-jgjg) | filelock: Symlink swap during SoftFileLock's writability check leaks whether a path exists and is writable by the lock taker | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |
| #85 | 低 | filelock | [wfhq-q4j2-c37m](https://github.com/advisories/GHSA-wfhq-q4j2-c37m) | filelock: SoftReadWriteLock follows a lock tree swapped in after its first acquire and writes lock records into directories of the user running the lock | 4.1.0 → 4.2.1 | 同じ機械の別の利用者が、錠のフォルダーへリンク・ファイルを置く／名前を差し替える | 開発の時だけ届く | 2026-12-12 |

minimatchの#86（GHSA-g3hv-75wg-m249）は上の節「minimatch GHSA-g3hv-75wg-m249」の判定と期限のまま（この記録では変えていない）。

### 10/1〜10/3の失敗10本

時刻はUTC。原文はログの行をそのまま引いた（長い行は一部）。

| run | 時刻 | workflow（event） | commit | 失敗した段 | 原因の原文 | 区分 | その後 |
|---|---|---|---|---|---|---|---|
| 36818570903 | 10/01 05:11 | 配布CI(手動)（workflow_dispatch） | 3bc7521c | desktop (windows-latest)、単一ポータブルexeの確認（`e2e/release/portableDesktop.spec.ts:16`） | `Error: Portable process is outside this run's NSIS extraction: …nsy3217.tmp…PointerCAD.exe`（`portableLaunch.mjs:72`。当時の照合は`nsi`＋16進の名前だけを認めた） | 検査の前提の誤り（展開フォルダーの名前の決まりを実物と違えて書いていた） | c1f287d2「NSISの展開フォルダーの名前の照合を実際の決まりに合わせる」で直り、f2d49f61の配布CI 36829699097が成功 |
| 36826068076 | 10/01 06:40 | CI（push） | c1f287d2 | e2e (ubuntu-latest, 3)、[firefox] `z-math-input.spec.ts:222` ADD-25 | `TypeError: Cannot read properties of null (reading 'attribution')`、`expect(locator).toBeEnabled() failed … Received: disabled`（「式と条件を保存」、`mathDeclaredSymbolsFlow.ts:23`）。checksは`E2E_RESULT: failure`で失敗 | 検査の不安定と読める（nullになった理由は原文から決められない） | 次のf2d49f61（README・リリースノート・報告記録・ヘルプの文書4ファイルだけの差分）のCI 36829678031が成功 |
| 36826108827 | 10/01 06:41 | 配布CI(手動)（workflow_dispatch） | c1f287d2 | desktop (windows-latest)、配布物の起動の確認（`packagedDesktop.spec.ts:434` (0-3)） | `TimeoutError: electron.launch: Timeout 60000ms exceeded.`（起動の記録は`document-loaded`の544.97 msまで出ている） | 検査の不安定と読める（窓の取得で止まった理由は原文から決められない） | f2d49f61の配布CI 36829699097が成功（起動の処理の変更は無い） |
| 36847245937 | 10/01 10:08 | Dependabot Updates（security、undici） | f2d49f61 | `update_files` | `pnpm update undici@8.11.2 --lockfile-only --no-save -r`が`exit 1`、`pnpm refused to pin undici; retrying the update without a version`、`security_update_not_possible`（`latest-resolvable-version` 6.28.1、`lowest-non-vulnerable-version` 7.29.1、`conflicting-dependencies` []） | Dependabotの側の事情（推移依存の修正版への更新を作れなかった。pnpmの`exit 1`の理由はログに無く決められない） | 手で入れたoverrides（`@electron/get@5.1.0>undici`。今は`pnpm-workspace.yaml` 41行で7.30.1）がmainに入り、#1〜#10は2026-11-11T15:05Zにfixed |
| 36847246136 | 10/01 10:08 | Dependabot Updates（security、brace-expansion） | f2d49f61 | `update_files` | `pnpm update brace-expansion@5.0.12 …`が`exit 1`、`pnpm refused to pin brace-expansion`、`security_update_not_possible`（`latest-resolvable-version` 1.1.21、`lowest-non-vulnerable-version` 5.0.12） | 同上 | overrides `minimatch@10.2.6>brace-expansion: 5.0.12`（`pnpm-workspace.yaml` 43行）がmainに入り、#11〜#13は2026-11-11T15:05Zにfixed |
| 36847481267 | 10/01 10:10 | CI（pull_request） | e3d58b28（DependabotのPR「Bump actions/download-artifact from 4.3.0 to 8.0.1」） | e2e (windows-latest, 2)とe2e (ubuntu-latest, 3) | windows: [functional] `smoke.spec.ts:32` `Expected: "ready" Received: "waiting"`（`THREE.WebGLRenderer: Error creating WebGL context.`、`net::ERR_NO_BUFFER_SPACE`）。ubuntu: [firefox] `z-math-input.spec.ts:89` ADD-21 `expect(locator).toHaveValue(expected) failed … element(s) not found` | 検査の不安定と読める（変えたのはactions/download-artifactで、落ちたのは画面検査の中の2件。更新との関係は原文から示せない） | PRは取り込まれていない（`ci.yml` 224行・`release.yml` 496行は今もv4のd3f86a10…） |
| 36933522653 | 10/01 22:11 | Dependabot Updates（version、npm） | f2d49f61 | `update_files` | `pnpm install --lockfile-only --config.minimumReleaseAge=4320 …`が`exit 1`、`Handled error whilst updating typescript: dependency_file_not_resolvable {message: "Error resolving dependency"}`、結果は`created`5件（typescript-eslint・opencascade.js・globals・typescript・@playwright/test）と`Dependabot encountered '50' error(s)` | Dependabotの側の事情（pnpmの`exit 1`の理由はログに無く決められない） | 10/3より後の通常の更新の実行は材料に無く、確かめていない |
| 36933724928 | 10/01 22:13 | CI（pull_request） | 0968e7ae（DependabotのPR「Bump typescript-eslint from 8.69.0 to 8.71.0」） | front（両OS、品質ゲート自身の自己試験）とe2eの6組（Webサーバーのbuild） | `Error: Unverified mathematics dependency removal`（`runtimeDependencySelection.mjs`）。PRのlockはoverridesの鍵を引用符なしの`mathlive@0.110.0>@cortex-js/compute-engine: '-'`に書き直し、当時の照合は引用符付きだけを認めた | 依存の更新が検査を壊した（Dependabotがlockの書き方を変え、製品の照合が止めた） | 624a5103（2026-10-04）で照合が引用符なしも認めるよう直した。PRは取り込まれていない（`pnpm-workspace.yaml` 30行は8.69.0） |
| 37118935676 | 10/03 11:12 | Dependabot Updates（security、undici） | fb44ef2e | `update_files` | 36847245937と同じ（`pnpm refused to pin undici`、`security_update_not_possible` 6.28.1／7.29.1） | 同上（Dependabotの側の事情） | 36847245937と同じ |
| 37118938562 | 10/03 11:12 | Dependabot Updates（security、brace-expansion） | fb44ef2e | `update_files` | 36847246136と同じ（`pnpm refused to pin brace-expansion`、`security_update_not_possible` 1.1.21／5.0.12） | 同上（Dependabotの側の事情） | 36847246136と同じ |

## SBOMの未分類9件（2026-11-12）

配布用の外部検査run 43149366809の`unclassifiedLicenses`9件を、同梱の原文（`packages/fem/runtime/notices/<SHA-256>.txt`）の現物で確かめた。原文から識別子が確かに決まる3件だけを`scripts/release/sbom.mjs`の`NETGEN_DEPENDENCY_LICENSES`で分類し（原文の組とSHA-256・版が記録どおりの時だけ。検査は`apps/desktop/src/main/sbom.test.ts`）、残る6件は理由を付けて未分類のまま残す。識別子は原文の記録であり、配布の条件を満たしたかの判断（`legalClearance`など）ではない。

| 部品 | 同梱の原文（SHA-256の先頭8桁）と出典 | 原文が示す許諾 | SBOMでの扱い |
|---|---|---|---|
| FEM: Netgen zlib（1.3.1） | 845efc77（`sources/zlib-v1.3.1.tar.gz`の原文。`vendor/exact-math/notices/zlib-1.3.1-LICENSE.txt`〔上流madler/zlib v1.3.1のLICENSE〕と同じバイト） | Gailly・Adlerのzlibの許諾（3つの制限） | `Zlib`に分類（追加計算部の`zlib 1.3.1`と同じ識別子） |
| FEM: Netgen concurrentqueue | a0162084（Netgenのソースの`concurrentqueue.h`の冒頭の注記） | Boost Software License 1.0の全文（許諾・条件・免責）。他の許諾の名前は無い | `BSL-1.0`に分類 |
| FEM: Netgen gzstream | a941f6ab（`gzstream.h`の冒頭）とa190dc9c（LGPL 2.1の全文。oofemの写しと4,372語が一致し、FSFの住所だけが違う） | 「GNU Lesser General Public License … either version 2.1 of the License, or (at your option) any later version」 | `LGPL-2.1-or-later`に分類 |
| FEM: pybind11（oofemに組込み、commit d6ae0e16） | 83965b84（`sources/026-pybind11-d6ae….tar.gz`の`LICENSE`と同じバイト） | BSD 3条項の文に続けて「Please also refer to the file .github/CONTRIBUTING.md, which clarifies licensing of external contributions」。同じ書庫のCONTRIBUTING.mdは、改良（Enhancements）を公開した人が許諾を与える文を持つ | 未分類のまま。原文だけでは`BSD-3-Clause`か、同じ追加の文を持つ`BSD-3-Clause-LBNL`か決められない |
| FEM: Netgen pybind11（commit 98e50b70） | 83965b84（同じ原文） | 同上 | 未分類のまま（同上。Netgen側の書庫のCONTRIBUTING.mdは読んでいない） |
| FEM: oofem（3.1.dev5+g214b161ed） | 20c17d8b・dc626520（LGPL 2.1の全文）、83965b84（pybind11）、bf488b13（NISTの「Software Disclaimer」）。wheelのMETADATAの`License`は「version 2.1 of the License, or (at your option) any later version」 | oofem自身はLGPL 2.1以降。NISTの免責の文が掛かる組込みの部分があり、その部分は別の部品として記録されていない | 未分類のまま。NISTの文に当たるSPDX識別子との全文の照合をしておらず、部品全体の識別子・式を決められない |
| FEM: numpy（2.2.5） | 原文15件（NumPyのBSD 3条項型、NCSA/BSD-3-Clauseの二重、0BSD、Apache-2.0、MIT、zlib、LAPACK・pocketfft・HighwayのBSD、MT19937・PCG64・PHILOX・SFC64の注記ほか）。METADATAは`License-Expression`を持たず、分類子「BSD License」だけ | 複数の許諾の合成 | 未分類のまま。注記の一部はSPDXの標準文と細部が違い、組み込まれた部品の原文が全てそろっていることも証明していない（`sbom.mjs`の既存の判断） |
| FEM: Pyodide（0.29.3 / CPython 3.13.2 / Emscripten 4.0.9） | 原文15件（PyodideのMPL-2.0、PythonのPSF、LLVMのApache-2.0 WITH LLVM-exception、EmscriptenのMIT／NCSA、musl・libffi・expat・stackframeのMIT、zlib、BSDほか） | 複数の許諾の合成 | 未分類のまま。組み込まれた部品の原文が全てそろっていることを証明しておらず、式にすると網羅を主張することになる |
| FEM: netgen-mesher（6.2.2606.post5.dev0） | a190dc9c（LGPL 2.1）、b1d90f09（AUTHORS）、915b533d（mpi4pyのBSD 3条項）。wheelのMETADATAは`License-Expression: LGPL-2.1-only` | Netgen自身はLGPL-2.1-only（METADATAの宣言） | 未分類のまま。wheelには別の許諾の組込みの部分（上のNetgenの4部品とmpi4pyのヘッダー）があり、この部品の識別子をNetgen自身だけに付けるかwheel全体の式にするかは方針の判断が要る |

手元の作業ツリーで同じ`buildSbom`を書き込みなしで流すと、直しの前は`components`268・`unresolvedNotices`0・`unclassifiedLicenses`9・`noLicenseInformation`0（外部検査run 43149366809と同じ数で、`electron` 44.9.1・MITの部品を含む）、直しの後は268・0・6・0になった（部品の数は変わらない。未分類の一覧は`sbom.test.ts`が固定する）。配布用の外部検査の段「SBOM(CycloneDX)を作る」の出力が6件になることは、まだ確かめていない。

### 確かめていないこと（2026-11-12時点）

- run 43149366809の`sbom.json`の部品名（Electronの部品が入っていることはコードからの読み）。
- 分類の後の`unclassifiedLicenses`が配布用の外部検査で6件になること。
- 今のリポジトリのsecurity updatesの設定と、10/3より後のDependabotの通常の更新・security jobの成否。
- Dependabotのjobでpnpmが`exit 1`になった理由（ログに出ていない）。
- 画面検査の2件と配布物の起動の時間切れ1件（36826068076・36826108827・36847481267）の根本の原因。
- 作り直しの台本（`rebuild-oofem-pyodide.sh`）を実際に流した時に、certifi・virtualenv・filelock・pipのどの処理が動くか（台本は全体としては未実行）。
