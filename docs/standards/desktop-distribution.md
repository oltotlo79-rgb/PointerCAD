# Windows・Linuxの配布作成

2026-09-16、利用者の承認によりelectron-builder 26.15.3を開発用に固定採用した。Windows x64のNSISインストーラーとポータブル版、Linux x64のAppImageを作る。アプリ本体へelectron-builderや開発用node_modulesを同梱しない。初回Windowsは未署名、自動公開と自動更新は行わない。

本体・全巻説明書・許諾原文の同梱と内容照合は、次の5処理で行う。通常検査や他の生成処理が終了し、入力を変更しない状態で順に実行する。次の名前は例であり、毎回dist直下の新しい名前を使う。

```powershell
node scripts/release/build-desktop-output.mjs desktop-source-20260916
node scripts/manual/generate.mjs manual-desktop-20260916
node scripts/manual/generate-pdf.mjs manual-desktop-20260916 manual-desktop-pdf-20260916
node scripts/release/assemble-desktop.mjs desktop-source-20260916 manual-desktop-20260916 manual-desktop-pdf-20260916 desktop-candidate-20260916
node scripts/release/package-desktop.mjs desktop-candidate-20260916
```

Windows上ではWindows版、Linux上ではLinux版だけを作る。本体の入力が途中で変わった場合、説明書と本体の版が違う場合、計算部・字体・原文・PDF巻が欠けた場合、開発用の参照が残る場合には停止する。梱包後にも実際の全ファイルと内容を照合する。配布作成用の取得物と一時ファイルはPointerCAD内へ置く。

Windowsでは署名を自動検索せず、終了後に自動起動しない。更新・削除時に起動中のPointerCADを見つけたら、保存して終了するよう案内して止める。削除対象は配布時に列挙した実ファイルだけとし、未知の文書や設定の保存先を丸ごと削除しない。移動できないファイルがあれば戻して中断する。この仕組みの実機での確認は配布前に行う。

candidate.jsonに生成物の名前・大きさ・内容指紋、配布形式ごとのファイル一覧と、未署名・未導入確認・未認定を記録する。作成できたことだけで公開可能としない。実際の導入、更新、削除、文書の保存再開、両OS、公開先、説明書と許諾の最終確認を別途行う。原文が未取得の部品を他部品の原文で代用しない。

採用の根拠は固定した[26.15.3の公式ソース](https://github.com/electron-userland/electron-builder/tree/electron-builder%4026.15.3)と取得した主要5部品の原文・実装。主要5部品の取得容量1,469,958バイトは全間接依存や配布作成用実行ファイルの総容量ではない。具体的な許諾と不足はdocs/standards/licenses/runtime-notices.json、数学と字体の一覧、vendor/exact-mathの一覧に残す。

導入はpnpm 11のallowBuildsを使い、Electronの準備処理だけを許可する。別形式のSquirrel用electron-winstallerは使わないためfalseと明示する。依存の版はcatalogと固定一覧で管理し、既存の数学・形状計算部をこの追加のために更新しない。

## Windowsポータブル版

2026-09-22の利用者指示は[rules/05 §11.5](../../rules/05-リリース.md#115-ポータブル版のファイル数2026-09-22利用者指示)を正とする。配布名は`PointerCAD-<版>-windows-x64-portable.exe`とし、インストーラーの`PointerCAD-<版>-windows-x64-setup.exe`と区別する。利用者がポータブル版を動かすために受け取るのは1つの.exeとし、説明書と計算部も内部へ含める。Linuxは従来どおり1つのAppImageとする。

採用済みelectron-builder 26.15.3のportable方式は、起動時に一時フォルダーへ本体を取り出して起動し、終了後に展開物を片付ける。管理者権限は要求しない。固定版の実装では`unpackDirName: true`が起動ごとの`$PLUGINSDIR`を使用するため、この指定で同時起動の展開先共有を避ける。設定や利用者が保存した文書まで削除する方式ではない。今回の変更で設定の保存先を勝手に変えない。

作成処理はWindowsで両形式を明示して作る。ポータブル版の欠落、別の版、重複した名前、予定外の追加成果物、空ファイルは候補記録の作成前に拒否する。候補記録の`packages`は各形式の配布ファイル一覧を示し、生成時点では`launchVerified: false`を保つ。これは生成物の形の確認であり、自己展開・起動が成功した証明ではない。

配布前は、ポータブル版1ファイルだけを空の検証用フォルダーへ置き、開発用ファイルやネットワークに頼らず起動できることを確認する。通常終了・再起動、同時起動、形状と数学の計算、文書の保存と再開、全巻説明書、許諾表示、展開先の片付けを確認する。検証用の保存先・設定・一時フォルダーはPointerCADの作業フォルダー内に限定する。実生成・実起動は未確認であり、設定の追加だけで配布完成にはしない。
