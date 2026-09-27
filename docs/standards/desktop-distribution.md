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

## 実機確認の手順（統括用）

この節は、統括がWindows 11 Homeの開発機でポータブル版・導入版を実機確認する手順を定める(利用者の決定、`docs/requirements.md` §1.4)。Linuxの確認はCIのUbuntuと画面の無い環境(xvfb)で行う方針であり、その追加案は`scratchpad/claude/agents/w31d-t10-device-check-procedure/linux-xvfb-appimage-check.md`に差分案として書いた(このリポジトリの`.github/workflows/release.yml`は未編集)。各手順に根拠(公式資料のURLか実装のファイルと行)を付ける。確かめられなかった項目は「不明」と明記する。electron-builderの公式サイト(www.electron.build)の`NSIS`・`Portable`の解説ページは、2026-09-24にWebFetchで確認したところ`https://www.electron.build/nsis`はコンテンツが空、`https://www.electron.build/configuration/nsis`は404で内容を取得できなかったため、本節では採用済みの固定タグ([26.15.3の公式ソース](https://github.com/electron-userland/electron-builder/tree/electron-builder%4026.15.3))のソースコードとJSDocコメントを一次資料として使う。

### (a) ポータブル版の手順

1. 検証用フォルダをプロジェクトの作業フォルダ内(`scratchpad/`配下)に用意する(本書「Windowsポータブル版」の既存方針どおり、プロジェクトの外へは置かない)。`candidate.json`に記録された`PointerCAD-<版>-windows-x64-portable.exe`1つだけをそこへコピーする。開発用ファイルは置かない。
2. 通信を切った状態でポータブル版のexeを実行し、管理者権限への昇格を求められないことを確認する。根拠: `apps/desktop/electron-builder.yml`44行目の`requestExecutionLevel: user`、electron-builder 26.15.3の`PortableOptions.requestExecutionLevel`定義(既定値`user`) — https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/src/targets/nsis/nsisOptions.ts 。
3. 起動直後にできる一時展開先の実際のパスを画面かエクスプローラーで控える。`unpackDirName: true`のため、固定名フォルダではなくNSIS自身が起動ごとに割り当てる`$PLUGINSDIR`(`$TEMP`配下の使い捨てフォルダ)が使われる設計である。根拠: `apps/desktop/electron-builder.yml`45行目のコメント(46行目の`unpackDirName: true`に対する説明)、electron-builder 26.15.3の`NsisTarget.ts`(`unpackDirName`が真偽値`true`のときだけ`UNPACK_DIR_NAME`を定義しない実装 — https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/src/targets/nsis/NsisTarget.ts )と`portable.nsi`(`UNPACK_DIR_NAME`が未定義なら`$INSTDIR`を`$PLUGINSDIR\app`にする分岐 — https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/templates/nsis/portable.nsi )。
4. 検証用フォルダの範囲内で新規図面を作成し、数式・形状の計算を1件以上行って保存する。通常終了後に再度開き、保存内容が引き継がれることを確認する。
5. 全巻の取扱説明書と許諾表示を画面から開けることを確認する。
6. 同じポータブルexeを2つ同時に起動し、双方が独立して動作すること、一時展開先(手順3)が競合しないことを確認する。根拠: `apps/desktop/src/main/main.ts`および`apps/desktop/src`全体に`requestSingleInstanceLock`の呼び出しが無く(grep 0件)、多重起動を妨げない実装であることと、手順3の$PLUGINSDIRが起動ごとに独立する設計であること。
7. 両方を通常終了し、検証用フォルダに一時展開物が残っていないことを確認する。根拠: NSIS公式ドキュメントの`$PLUGINSDIR`の説明「automatically deleted when the installer exits」 — https://nsis.sourceforge.io/Docs/Chapter4.html 。

#### ポータブル版の一時展開先・利用者データの向け先(調査結果)

- `--user-data-dir=<パス>`引数: **効く**。ポータブル起動用exeは受け取った引数を`${StdUtils.GetAllParameters}`で丸ごと取得し、展開後の本体`PointerCAD.exe`へ`ExecWait "$INSTDIR\PointerCAD.exe <引数>"`として転送する(根拠: electron-builder 26.15.3の`portable.nsi`、上記URL)。転送された`--user-data-dir`は、固定採用中のElectron 44.1.0(`pnpm-workspace.yaml`17行目)本体の`PreSandboxStartup()`がコマンドラインから読み取り、`app.getPath('userData')`の基準になる`chrome::DIR_USER_DATA`を上書きする。根拠: `command_line->GetSwitchValuePath(::switches::kUserDataDir)` → `base::PathService::OverrideAndCreateIfNeeded(chrome::DIR_USER_DATA, user_data_dir, false, true)` — https://github.com/electron/electron/blob/v44.1.0/shell/app/electron_main_delegate.cc 。PointerCAD側のコード変更は不要(`apps/desktop/src`に`userData`・`commandLine`・`app.setPath`・`process.argv`の扱いが無いことをgrepで確認済み、0件)。導入版(NSISで入れた本体)でも同じ理由で効く。
- `PORTABLE_EXECUTABLE_DIR`・`PORTABLE_EXECUTABLE_FILE`・`PORTABLE_EXECUTABLE_APP_FILENAME`環境変数: ポータブル起動用exeが自身のパスをこれらへ設定してから本体を起動する(根拠: `portable.nsi`内の`System::Call 'Kernel32::SetEnvironmentVariable(...)'`、上記URL)。ただし**PointerCAD側はこれらを読んでいない**(`apps/desktop/src`全体のgrepで0件)。設定はされるが、単独では利用者データの向け先を変えない。
- 一時展開先そのもの($PLUGINSDIRの物理的な位置)をプロジェクト内へ向ける方法: **不明**。$PLUGINSDIRは$TEMP配下に作られる(前述のNSIS公式ドキュメント)。起動元プロセスの環境変数`TEMP`・`TMP`を検証用フォルダへ向けてからポータブルexeを起動すれば追随すると見込まれるが、NSIS公式ドキュメントは`$TEMP`を「The temporary directory.」とのみ説明し、環境変数`TEMP`/`TMP`を実行時に読むとは明記していない。断定できないため、(a)手順3で実際の展開先を毎回確認することを必須の代替手順とする。

### (b) 導入版の手順(プロジェクトの外へ書く手順は利用者の許可済み(2026-09-24)。各項目に明記する)

1. **導入**(プロジェクト外。利用者の許可済み・2026-09-24): `candidate.json`のNSISインストーラー(`PointerCAD-<版>-windows-x64-setup.exe`)を実行する。アシステッド形式(`oneClick: false`)のため導入先フォルダを選べる案内が出ること、管理者への昇格を求められないこと(`allowElevation: false`)を確認する。根拠: `apps/desktop/electron-builder.yml`29-33行目、electron-builder 26.15.3の`nsisOptions.ts`(`oneClick`「Whether to create one-click installer or assisted.」、`allowToChangeInstallationDirectory`「allow user to change installation directory」、`allowElevation`「Allow requesting for elevation」) — https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/src/targets/nsis/nsisOptions.ts 。導入完了後、スタートメニューにショートカットが作られ(`createStartMenuShortcut: true`)、デスクトップには作られない(`createDesktopShortcut: false`)ことも確認する(根拠: 同ファイル39-40行目)。
   - 導入が終わったら、2. の手動の起動より前に、(d) の配布物の起動確認を導入先の実行ファイル(既定は`%LOCALAPPDATA%\Programs\PointerCAD\PointerCAD.exe`)で走らせる(2026-09-24 追記)。
2. **起動**(プロジェクト外。利用者の許可済み・2026-09-24): 導入した本体を起動し、通信を切った状態で操作できることを確認する。
3. **保存**(プロジェクト外。利用者の許可済み・2026-09-24): 新規図面を作成し、数式・形状の計算を1件以上行って保存する。
4. **再起動**: OSを再起動(または少なくともサインアウト→サインイン)した後にPointerCADを再度起動する。
5. **設定の引継ぎ**: 直前に保存した文書が開けること、前回終了時の状態(ウィンドウの大きさなど保持している値があれば)が引き継がれていることを確認する。
6. **上書きの更新**(旧版0.0.0の上に新版。プロジェクト外。利用者の許可済み・2026-09-24): package.jsonの`version`が`0.0.0`のビルド(`.github/workflows/release.yml`36行目のコメントが「空なら省略(0.0.0での模擬実行など)」と述べる、この配布作成での既定の試作版番号)を旧版として先に導入し、その上から新版のインストーラーを実行する。新インストーラーはレジストリの`UninstallString`・`InstallLocation`から旧版を検出し、旧版の`Uninstall PointerCAD.exe`を`/S /KEEP_APP_DATA`付きで無音実行してから新版のファイルを配置する設計である。根拠: electron-builder 26.15.3の`uninstallOldVersion`マクロ — https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/templates/nsis/include/installUtil.nsh 。このとき渡されるのは`/KEEP_APP_DATA`であって`--delete-app-data`ではないため、`apps/desktop/packaging/installer.nsh`17-26行目の`customUnInit`(`--delete-app-data`指定だけを拒否するマクロ)には抵触しない。更新後に手順3で保存した文書と設定が残っていることを確認する。
   - 起動中に更新(上書きインストール)を試みると保存を促す案内が出て中断することも確認する。根拠: `apps/desktop/packaging/installer.nsh`1-14行目の`customCheckAppRunning`マクロ、electron-builder 26.15.3で`installSection.nsh`がファイルコピー(`installApplicationFiles`)の直前に`CHECK_APP_RUNNING`を呼び、`CHECK_APP_RUNNING`は`customCheckAppRunning`が定義されていればそれを優先して使う実装 — https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/templates/nsis/installSection.nsh 、https://github.com/electron-userland/electron-builder/blob/electron-builder%4026.15.3/packages/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh 。
7. **削除**(文書と控えが残ること。プロジェクト外。利用者の許可済み・2026-09-24): PointerCADを終了させてから「アンインストール」を実行する。削除は配布時に実際に梱包されたファイル一覧だけを対象にする設計であり(根拠: `scripts/release/desktopInstallerResources.mjs`の`writeDesktopUninstallFiles`が実際に組み立てられた`appOutDir`を歩いて一覧を作る)、各ファイルを退避場所へ移してから削除し、1件でも移せなければ退避済みの分を復元して中断する設計である(根拠: `scripts/release/desktopUninstall.mjs`の`createDesktopUninstallScript`、`IfErrors pcadRemovalRestore`分岐)。起動中に削除を試みた場合は、本体exeが移せずこの復元処理が働いて「使用中のファイルを移動できなかったため、削除を中断しました。保存文書は削除していません。戻せずに残ったファイルの控え: …」という案内(`desktopUninstall.mjs`が生成する`Abort`のメッセージ文言)で中断することを確認する(customCheckAppRunningのような事前確認ではなく、この退避処理の失敗検知による)。削除後は、(i) 導入フォルダの本体ファイルが削除されていること、(ii) 保存した文書・設定など利用者データ(既定では`%APPDATA%\PointerCAD`)が残っていること(`deleteAppDataOnUninstall: false`。根拠: `apps/desktop/electron-builder.yml`34行目)、(iii) `--delete-app-data`相当の削除指定はこの配布物では使えないこと(手順6と同じ`customUnInit`)の3点を確認する。

### (c) 確認の記録の形

実機確認1回につき、次の項目を記録する(統括が`docs/報告記録.md`へ転記する)。

| 項目 | 内容 | 根拠・取得方法 |
|---|---|---|
| 日時 | 確認を行った日時(JST、`YYYY-MM-DD HH:MM`) | `python -c "import datetime;print(datetime.datetime.now().strftime('%Y-%m-%d %H:%M'))"` (本書共通規律の進捗記録と同じ取得方法) |
| 版 | `candidate.json`の`version`・`sourceCommit` | `scripts/release/package-desktop.mjs`が書く`receipt` |
| 対象ファイル | 実行したファイルの相対パスとSHA-256(全64桁) | `read_bytes()`のSHA-256。`candidate.json`の`assets[].sha256`と一致することも突き合わせる |
| 操作 | (a)/(b)のどの手順を行ったか | 本節の番号 |
| 結果 | 合格・不合格と具体的な観察(展開先のパス、削除後の残存物の有無など) | 本節の各手順 |
| 画面 | 確認時の画面写しのファイル名と保存先 | 検証用フォルダ内 |

`candidate.json`のスキーマは`launchVerified`・`installed`・`releaseCertified`を型定義上つねに`false`に固定している。根拠: `scripts/release/desktopPackageTargets.d.mts`の`readonly launchVerified: false`、`scripts/release/desktopDistribution.d.mts`・`scripts/release/releaseManifest.d.mts`の`readonly releaseCertified: false`。したがって本節の実機確認結果は、現時点では`candidate.json`自体を書き換える機構を持たず、上表の記録を`docs/報告記録.md`に残すことで代替する。これらのフラグを実際の確認結果と連動させる(型を`false`固定から可変にする)かどうかはスキーマ変更を伴う設計判断であり、本書のこの節の範囲外とする。

### (d) 配布物の起動確認(自動。2026-09-24 追記)

配布物そのものを画面の自動操作で起動し、配布物だけで起きる失敗(同梱の漏れ・パス・字体・WASM・計算部の読込み)を見つける検査。通常の画面検査(`e2e/tests/electronAppFlow.ts`の`launchDesktop`)は開発用のElectronに組み立て済みのmainを読ませて起動するため、これらを見つけられない。設定は`e2e/packaged-desktop.config.ts`、検査の本体は`e2e/release/packagedDesktop.spec.ts`。配布CI(`.github/workflows/release.yml`)は同じ検査を、Windowsのwin-unpackedと、LinuxのAppImageを展開したAppRun(xvfb)で、artifactへ保存する前に走らせる(本節冒頭の「`.github/workflows/release.yml`は未編集」はw31dの時点の記述)。

1回の起動で次を順に確かめ、項目ごとの結果と所要時間を、実行の記録の`[配布物の起動]`の行と、Playwrightの出力先の`packaged-desktop-results.json`に残す。

| 項目 | 確かめること |
|---|---|
| (0) | 起動前に、配布物と同じ名前の本体(`PointerCAD.exe`)が動いていないこと。実際のプロファイル(`%APPDATA%\PointerCAD`と`%LOCALAPPDATA%\PointerCAD`)の一覧(名前・大きさ・更新時刻)を控える |
| (1) | 一時のuserData(プロジェクト内の`scratchpad/temp/p/<6文字>/u`。Chromiumの`--user-data-dir`で渡す)で起動し、起動の直後に`app.getPath('userData')`がその下にあること。外れたら他の操作をせずに閉じて失敗にする |
| (a) | 窓が表示され、最初の読込みが終わること |
| (b) | 製品の名前、版、Electronの版、OSとCPU、作ったcommit、アプリの`package.json`のSHA-256、同梱の説明書の版とPDFの巻数、`resources/app`のファイル数が、`candidate.json`と配布物の`resources/app/desktop-package.json`に一致すること |
| (c) | 主要な画面の要素(`e2e/tests/electron-startup.spec.ts`と同じもの。開く・関数作図の画面・3D表示とビューキューブ・WebGL2・左の欄の入力・読み直し) |
| (d-1)〜(d-3) | 同梱の資源を軽い操作で1回ずつ使う。箱(20×30×40mm)の体積が24000 mm³になる(形状の計算部)、`integrate(t^2,t,0,3)`が`= 9`になる(数式の計算部)、部品から図面を作る(字体。図面が読んだ字体を読み直し、配布物の記録の大きさとSHA-256に照らす) |
| (e) | pageerrorが0件、画面の処理の停止が0件 |
| (f) | 閉じた後、終了コード0で終わり、30秒以内に配布物のフォルダーから動くプロセスが無くなること |
| (2) | 実際のプロファイルの一覧が起動の前後で変わらないこと(起動した配布物が一時のuserDataを使ったことも確かめる) |

手順(導入版。(b)の1.の直後、2.の手動の起動より前に行う):

1. PointerCADを全て終了する。同じ名前の本体が動いていると(0)で止まる(実際のプロファイルを書き換え得るため)。
2. 統括は担当(Claudeのサブエージェント)に次を実行させる。画面検査の排他(`scratchpad/claude/tools/README.md`の「E2Eの排他ロック」)を守るため`diag.py`を通す(統括はpnpmを直接呼ばない。`rules/01-役割と委譲.md`)。`PCAD_PACKAGED_EXECUTABLE`は導入先の実行ファイル、`PCAD_PACKAGED_CANDIDATE`は導入したインストーラーを作ったときの`candidate.json`。既定の導入先は`%LOCALAPPDATA%\Programs\PointerCAD`(根拠: electron-builder 26.15.3の`templates/nsis/multiUser.nsh`の`setInstallModePerUser`が、前回の導入先が無ければ`FOLDERID_UserProgramFiles`〔既定は`$LocalAppData\Programs`〕の下を選ぶ)。

   ```powershell
   $env:PCAD_PACKAGED_EXECUTABLE = "$env:LOCALAPPDATA\Programs\PointerCAD\PointerCAD.exe"
   $env:PCAD_PACKAGED_CANDIDATE = 'dist\<候補の名前>\candidate.json'
   python -B -X utf8 scratchpad/claude/tools/diag.py e2e --owner <担当名> -- --config e2e/packaged-desktop.config.ts
   ```

   `diag.py e2e`は`pnpm run test:e2e`(中身は`playwright test --config e2e/playwright.config.ts`)の後ろへ引数を足す。Playwright 1.62.1が同梱する引数の解析(commander)は同じ指定を2回受けると後の値を採るため、この`--config`で設定が替わる(同梱のcommanderだけで確かめた。`diag.py`を通した実行での確認と、`diag.py`へ専用の指定を足すかどうかは2026-09-24時点で統括の判断待ち)。
3. 導入の前に、同じ手順で`dist\<候補の名前>\artifacts\win-unpacked\PointerCAD.exe`を走らせてもよい(配布CIのWindowsと同じ対象)。
4. 結果を(c)の表の形で記録する。「操作」は「(d) 配布物の起動確認」、「結果」は項目ごとの成功・失敗と所要時間とRUN_ID。失敗した回は、Playwrightの出力先の`packaged-desktop-failure.png`と、残した一時フォルダー(`scratchpad/temp/p/`の下。次の実行が1時間より古いものを消す)も控える。

注意:

- 起動の直後の一瞬、配布物の窓が前面に出て焦点を取ることがある。焦点を外す指定(`setFocusable(false)`)は窓ができた後にしか掛けられない(配布物にはPlaywrightの起動の保留〔loader〕を入れられず、製品のコードにも検査用の口を足さないため)。
- ポータブル版の.exeは、起動した後に一時フォルダーへ展開した本体を別のプロセスとして起動する。Playwrightが起動したプロセス(展開する側)から本体の接続の案内を読めない見込みのため、この検査の対象にしない(未確認)。ポータブル版は(a)の手順で確かめる。
- Linuxは開発機に無いため、配布CIのUbuntu(xvfb)だけで確かめる。AppRunは`unshare -Ur true`で利用者の名前空間を試し、使えないときだけ自分で`--no-sandbox`を足して本体を起動する(根拠: electron-builder 26.15.3の`out/targets/appimage/appImageUtil.js`の`generateAppRunScript`)。検査からは`--no-sandbox`を足さず、この判断をそのまま確かめる(どちらだったかは`packaged-desktop-results.json`の`userData.sandbox`に出る)。
