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

型・lint・単体・build・E2Eは`./scripts/check.ps1`を正本として実行し、更新PRだからといって既定性能値や検査対象を緩和しない。現CIはWindows/Ubuntuの`front`、`unit-lead`、`e2e`各3 shardと集約`checks`を接続済みとする。公開判定では設定の存在ではなく、完成コードの**同一SHAで両OSの全jobが成功した実行記録**を確認する。Firefox/Electronの実操作とNSIS・portable・AppImageの起動、保存、終了、全同梱物のhash照合も別に確認する。

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
