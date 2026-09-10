# 依存関係の更新と脆弱性監視

対応要件: NFR-SE-2、2026-09-09レビューR15。バージョンの正本は`pnpm-workspace.yaml`の完全固定catalogと`pnpm-lock.yaml`。mainへの取り込みは既存レビュー・品質ゲートと利用者が指定した作業のまとめ方に従う。

## 監視設定

- GitHub Dependabot alertsとsecurity updatesを有効にする。脆弱性情報に応じた通知・修正PRの生成と、下記の通常バージョン更新は別の設定として確認する。
- `.github/dependabot.yml`はnpmを平日毎朝7時、GitHub Actionsを月曜7時（Asia/Tokyo）に照会する。npmはルートのpnpm workspace/catalog/lockを対象とする。実行エラーも確認対象とし、設定を置いただけで動作確認済みにしない。
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

型・lint・単体・build・E2Eは`./scripts/check.ps1`を正本として実行し、更新PRだからといって既定性能値や検査対象を緩和しない。未接続のFirefox/Electron通常CIはR12の未完了事項として追跡する。

## 初期設定の記録

2026-09-10 20:31 JST、`oltotlo79-rgb/PointerCAD`へGitHub APIでvulnerability-alertsとautomated-security-fixesを有効化（各204）。再照会でalerts有効204、repositoryのdependabot_security_updates=enabled、未解決アラート一覧200/0件を確認した。監視開始直後の照会であり、依存全体に脆弱性が存在しないという判定ではない。設定ファイルはmainへ反映後にスケジュール動作も確認する。

設定項目の根拠: [GitHub公式Dependabot設定](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)、[リポジトリのセキュリティ修正API](https://docs.github.com/en/rest/repos/repos#enable-automated-security-fixes)。
