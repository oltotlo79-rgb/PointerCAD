# PointerCAD

座標・数値・数式で形を作り、操作履歴から寸法を変更できる3D CADです。ブラウザで動くWeb版と、Electronによるデスクトップ版を同じコードから開発しています。

点・線・面からのスケッチ、押し出しや穴などの加工、部品の組み立て、STEP・STL・DXFの読み書きを備えています。現在は開発中で、図面・寸法機能（P8）を実装しています。利用できる機能と今後の範囲は[要件定義書](docs/requirements.md)と[フェーズ別計画](docs/plans/)を参照してください。

## 開発環境

- Git
- Node.js **22.12.0以上**（CIでは22系を使用）
- pnpm **11.25.0**（`package.json`の`packageManager`で固定）
- Windows PowerShell 5.1、またはPowerShell 7以降（`pwsh`）

以下はPowerShellでの例です。コマンドはリポジトリのルートから実行します。

## セットアップ

```powershell
git clone https://github.com/oltotlo79-rgb/PointerCAD.git
Set-Location PointerCAD
corepack enable
./scripts/install-hooks.ps1
./scripts/check.ps1 -Install
```

`corepack enable`はCorepackを同梱したNode.js環境で使います。Corepackがない環境では、先に上記の固定版pnpmを利用できるようにしてください。

`check.ps1 -Install`はロックファイルに従って依存関係を導入し、型検査・lint・ユニットテスト・ビルド・E2Eを順に実行します。初回は幾何計算用のWebAssemblyやPlaywrightのブラウザを取得するため、ネットワーク接続が必要です。`install-hooks.ps1`はコミット・プッシュ時の検査を有効にします。

## 起動

### Web版

セットアップ時のビルド結果を表示します。

```powershell
Push-Location apps/web
try {
    node node_modules/vite/bin/vite.js preview --port 4174 --strictPort --host 127.0.0.1
} finally {
    Pop-Location
}
```

ブラウザで <http://127.0.0.1:4174/> を開きます。終了はターミナルで`Ctrl+C`です。4174番ポートを使用中の場合は、空いているポートへ変更してください。

ソースの変更を反映しながら開発するときは、同じ`apps/web`ディレクトリで次を実行します。

```powershell
node node_modules/vite/bin/vite.js --port 5173 --strictPort --host 127.0.0.1
```

開発用のURLは <http://127.0.0.1:5173/> です。Viteの設定で幾何計算に必要な配信ヘッダーを付けるため、HTMLファイルを直接開くのではなくサーバー経由で使用します。

### デスクトップ版（Windows）

ビルド後、リポジトリのルートで実行します。

```powershell
./apps/desktop/node_modules/electron/dist/electron.exe apps/desktop
```

ソースを変更した後は、下記の全体検査でビルドを更新してから起動します。

## 検査

```powershell
./scripts/check.ps1
```

手動検査・Gitフック・CIの入口は共通の[`scripts/check.ps1`](scripts/check.ps1)です。通常の手動検査は引数なしで全5段を実行します。コミット時はE2Eを除く4段、プッシュ時はE2Eを含む5段を自動実行します。CIはWindowsとUbuntuで実行します。

対象を絞った診断の使い方や合格条件は[品質ゲート](rules/03-品質ゲート.md)を参照してください。診断の成功だけを全体検査の合格として扱わないでください。

## リポジトリ構成

| 場所 | 役割 |
|---|---|
| `apps/web` | Web版の起動・ビルド |
| `apps/desktop` | Electronのメイン処理・プリロード・画面 |
| `packages/ui` | 共通画面、操作、状態管理 |
| `packages/model` | 文書、履歴、部品・アセンブリ・図面の計算接続 |
| `packages/kernel` | OpenCascadeによる形状計算とWorker |
| `packages/expression` | 数式・単位の評価 |
| `packages/drawing` | 図面の2D幾何・用紙・寸法・配置 |
| `packages/io` | 文書の保存形式と読み書き |
| `packages/help-content` | ヘルプの内容 |
| `packages/test-utils` | 共通の検査用処理 |
| `e2e` | Playwrightによる実アプリの操作検査 |
| `scripts` | 品質ゲートとGitフック |

## 仕様・進捗・作業規約

- [要件定義書](docs/requirements.md)：プロジェクト全体で実現する機能と品質条件
- [フェーズ別計画](docs/plans/)：実装タスクと完了条件
- [進捗台帳](docs/progress.json)：完了したタスクIDと全体件数。将来フェーズの見積もりも分母に含めます
- [報告記録](docs/報告記録.md)：変更内容、検査結果、判断の根拠、残件
- [AGENTS.md](AGENTS.md)：コーディングエージェント向けの入口
- [CLAUDE.md](CLAUDE.md)・[rules](rules/)：作業規約の正本。作業開始前に全文を確認してください
- [引き継ぎ資料](docs/引き継ぎ/)・[Claude用フック](.claude/hooks/)：過去の判断と規約を機械的に守る仕組み

進捗や規約の詳細は上記の正本で管理します。READMEに完了件数を重複記載しないことで、実装の進行との食い違いを防ぎます。
