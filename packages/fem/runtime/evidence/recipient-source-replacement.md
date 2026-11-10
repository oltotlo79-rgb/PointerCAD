# FEM部品のソース取得・変更・再構築

PointerCADのFEM機能はOOFEM、Pyodide、NumPyなどを使用します。PointerCAD本体はApache-2.0ですが、各部品の許諾を置き換えません。この文書は同梱資料から自分用の変更版を作る手順です。任意の変更に対するABI互換、数値精度、収束、または配布全体の承認を保証するものではありません。

## 1. 受領した版の資料を保存する

Web版はアプリと同じ配布場所の `licenses/fem/index.html`、デスクトップ版は同梱Web資源の同じ相対パスを開いてください。この一覧には許諾原文、ソース、ビルド資料へのリンクがあります。CIの一時artifactや開発者のscratchpadを取得先にする必要はありません。

最初に `licenses/fem/manifest.json` を保存します。`components[].notices` は部品ごとの許諾原文、`files` は実配布ファイルのバイト数・SHA-256と分割順です。`assets/` の実行部材は `fem/assets/`、それ以外は `licenses/fem/` 以下へ配布されています。**配布した同じ版**の一覧とファイルを組み合わせてください。

大きいソースは `files[論理ファイル名].parts` の順で全partを保存し、バイナリ連結します。各partの `bytes`/`sha256` と連結後の親行の `bytes`/`sha256` を照合してください。たとえば `sources/upstream-source-materials.zip` は配布先の `.part-001` 以降を連結します。リポジトリ内部の `.stored-001` は別の保管形式なので混ぜません。元書庫は107113078バイト、SHA-256 `9eee0266fb68942775cebe7e34cf35b24455926539cd4f46e6d1808146aa66fd` です。新しい版では受領したmanifestを正とします。

次の資料を同梱リンクから取得してください。

| 用途 | licenses/fem/からの相対パス |
|---|---|
| 原文と対応表 | `notices/` の部品別原文、`evidence/notice-links.json`、`evidence/source-index.json` |
| アプリソースと各ファイルの索引 | `sources/pointercad-beam-application-source.zip`、`evidence/application-source-index.json` |
| 上流ソース・レシピ | `sources/upstream-source-materials.zip` |
| OOFEM | `sources/051-oofem-214b161ed3acb471f2d0104b004c37fd73bafaa2.tar.gz` |
| OOFEMが使うpybind11 | `sources/026-pybind11-d6ae0e163a6fb414c81c7f4a98291460e5a18bfe.tar.gz` |
| OOFEMの配布変更 | `sources/native-rebuild/oofem-051-timer.patch`、`oofem-util.py.diff`、`patch-provenance.json` |
| コンパイル設定と結果 | `sources/native-rebuild/constraints.txt`、`cmake-config.txt`、`toolchain-record.txt`、`build-provenance.json`、`build-receipt.json` |
| 可搬再構築手順 | `sources/native-rebuild/portable/` のrecipe、環境・取得一覧、requirements、wheelhouseハッシュ一覧、検査用スクリプト |

アプリソース書庫を作業フォルダーへ展開し、アーカイブ内の `LICENSE`、`NOTICE`、`README.md`、`package.json`、`pnpm-lock.yaml` を保存します。FEMの大きな実行部材はこのソース書庫に含まれていないため、受領したmanifestの全FEMファイルを上表の配布場所から別途保存し、論理名のまま `packages/fem/runtime/` 以下へ復元してください。

復元用のローカル `packages/fem/runtime/manifest.json` は、配布manifestの各 `files` 行から配布用 `parts` だけを除き、トップレベルの `storedParts` を除いた形にします。これは既に連結した元ファイルを使うための形式変換です。親行のバイト数・SHAは変えません。元の配布manifestも別名で保管してください。これ以外の部品のビルド前提はソース内READMEに従います。

## 2. NumPy・Pyodideの原文と対象ソース

NumPy 2.2.5のBSD系原文はmanifestのNumPy行から開けます。再配布時は著作権、条件、免責と同梱された他の部品の原文も保持してください。主ライセンスだけでvendored部品全体を代表させません。`notice-links.json` が原文と対象source memberを対応付けています。

Pyodide 0.29.3のMPL対象ソースは同梱の上流ソース書庫内にあります。ZIPを開き、次の実memberを取り出してください。

- `sources/049-pyodide-72e3c78d53a32a76e0aca7443ad24e5cae1042d3.tar.gz`
- `sources/050-recipes-c768cb28b5bf128642b9aa5aebd7114a4cfc17ce.tar.gz`
- `sources/027-pyodide-build-0eb494ffb3536971da3309d98ac56f6515f985a4.tar.gz`
- NumPy側は `sources/021-numpy-2.2.5.tar.gz`。

個別ソースのSHAは `source-index.json` の `materials[].bundlePath`/`sha256` で照合できます。Pyodideを変更する場合も、対象ファイルのMPL原文とソース入手案内を保持してください。[MPL 2.0 §3.1–3.4](https://www.mozilla.org/en-US/MPL/2.0/) を参照してください。OOFEMだけを交換する場合、Pyodide/NumPyを変更する必要はありません。

## 3. OOFEMの提供経路と変更の記録

OOFEMにはLGPL-2.1-or-laterが適用されます。この配布が採用する経路は **LGPL-2.1 §6aのsource/relink** です。同じ配布場所から、ライブラリの対象ソース・配布patch・コンパイル制御資料に加え、リンクするアプリのソースを提供し、受領者が変更版で自分用のアプリを再構築できる経路を使います。インストール済み署名アプリの任意ファイル置換を交換APIとして約束するものではありません。自分用の変更と、そのデバッグに必要なリバースエンジニアリングを禁じません。[対象版のLGPL原文 §2・§4・§6](https://raw.githubusercontent.com/oofem/oofem/214b161ed3acb471f2d0104b004c37fd73bafaa2/LICENSE) も同梱noticesから取得できます。

変更したソースには変更した旨・変更日を明示し、元の原文と著作権表示を残してください。配布済みpatchの対象と前後SHAは `patch-provenance.json`、配布wheelとの対応は `build-provenance.json` と `replacement-evidence.json` にあります。自分のpatch、変更版recipe、コマンド、出力wheelとmoduleのSHA、ログは新しい記録として残し、元の実証記録を上書きしません。

### 再構築

`portable/rebuild-oofem-pyodide.sh` はBash/Linux用です。実証環境はLinux aarch64で、Emscripten 4.0.9、Pyodide/CPython ABIと固定Python環境を要求します。Windowsだけで実行する場合は対応するLinux環境を別途用意してください。ツールチェーンや13個のbuild用wheelが全て同梱された、という意味ではありません。

`portable/replay-environment.json` と `venv-requirements.txt` に環境の版、`acquisition-request.json` に13個のwheelの固定取得URLとSHAがあります。開発者のcacheBodyパスではなく各行のPyPI URLを使い、空のwheelhouseへ保存して `wheelhouse-SHA256SUMS` と照合します。`packet-inventory.json` がrecipe/制御資料を固定しています。ビルド前にツールチェーン・xbuildenv・venvをこれらの固定条件で用意してください。

受領したruntimeの絶対パスを `RUNTIME`、用意した環境を `VENV`、`EMSDK_ENV`、`XBUILDENV`、`WHEELHOUSE`、まだ存在しない出力先を `BUILD_OUT` として指定します。利用者固有のパスに固定する必要はありません。

```sh
setsid --wait bash "$RUNTIME/sources/native-rebuild/portable/rebuild-oofem-pyodide.sh" \
  --oofem-tar "$RUNTIME/sources/051-oofem-214b161ed3acb471f2d0104b004c37fd73bafaa2.tar.gz" \
  --pybind11-tar "$RUNTIME/sources/026-pybind11-d6ae0e163a6fb414c81c7f4a98291460e5a18bfe.tar.gz" \
  --timer-patch "$RUNTIME/sources/native-rebuild/oofem-051-timer.patch" \
  --util-patch "$RUNTIME/sources/native-rebuild/oofem-util.py.diff" \
  --venv "$VENV" --emsdk-env "$EMSDK_ENV" --xbuildenv "$XBUILDENV" \
  --wheelhouse "$WHEELHOUSE" --out "$BUILD_OUT" --jobs 2
```

このrecipeは元tarを固定検証してから展開します。C++へ自分の変更を入れる場合はrecipeを作業用に複写し、末尾の `step 31-util-patch s_util_patch` の直後へ、次の1行を加えます。`RECIPIENT_PATCH` は変更内容と日付を記録した自分のpatchの絶対パスをexportした環境変数です。変更版recipeを上記コマンドの実行先に指定してください。

```sh
step 32-recipient-change patch --batch --forward --directory="$SRC" --strip=1 --input="$RECIPIENT_PATCH"
```

入力を検証しないようrecipeを書き換える必要はありません。この追加stepは失敗するとビルドを停止しログを残します。元のutil.pyやメタデータも変更する場合は、recipeと下記バージョン検査との契約を自分の変更に合わせて確認してください。出力は `$BUILD_OUT/dist/` のwheelと `$BUILD_OUT/rebuild-provenance.json`、各stepのログです。

### 自分用のアプリへ採用する

まず同じ `cp313-cp313-pyodide_2025_0_wasm32` tag、同じOOFEM Python API/依存条件/embedded versionを保持する変更で確認してください。OOFEMのzip memberとRECORDを正しく含むwheelを作り、上流・同梱の許諾ファイルを削除しません。出力wheelのSHA-256を自分で明示的に選択し、次の二つの入口へ同じ実バイト数とSHAを設定します。

1. 復元した `packages/fem/runtime/assets/oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl` を変更版wheelで置き換え、runtime `manifest.json` の対応 `files["assets/oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl"]` 行の `bytes` と `sha256` を更新します。元版は別フォルダーに保持します。
2. アプリソース `packages/fem/src/assets.ts` の `FEM_ASSETS` 内で同じファイル名の行だけの `bytes` と `sha256` を同じ値へ更新します。内容検証を削除したり、元のSHAで改変バイトを通したりしません。
3. distribution versionまで変更した場合は、`packages/fem/src/protocol.ts` の `OOFEM_DISTRIBUTION_VERSION`、`packages/fem/runtime/assets/beamProof.py` のembedded version検査と、変更したPython wrapper/manifestのピンも整合させます。同じ版名のままC++だけを変更する最初の経路では不要です。
4. 新しい輪郭のsource/patch/recipeとwheel/moduleの対応を別記録に残します。元の `replacement-evidence.json` は元wheelの実証なので変更版の成功証拠へ流用しません。再配布する場合は変更版のsource・notice・manifest・実証を揃えます。

アプリソースのREADMEの前提を満たした上で、固定lockfileから依存を準備し、Webアプリを再構築します。

```sh
pnpm install --frozen-lockfile
pnpm --filter @pointercad/web run build
pnpm --filter @pointercad/web run preview
```

別の出力/ブラウザープロファイルで開き、変更したnative markerと通常のはり計算の結果を両方確認します。ハッシュやサイズが違えばロード前に拒否されることも確認してください。元配布は別のまま保持します。公開版のリリースgateを通過したという意味にはなりません。既存のOOFEM実証は、実際に変更したnativeを採用できる1例と、元版/同サイズ異バイトを拒否する計3ケースの範囲です。任意のABI破壊や計算上の誤りまで互換と判定するものではありません。

`evidence/replacement-tool.py` は歴史的な私有proofパスに依存し、manifestでもhistoricalReplacementToolと表示されています。この手順の実行入口には使いません。

## 4. Netgenの変更版を作り読み込む

Netgen（netgen-mesher）もOOFEMと同じ `lgpl-source-relink` の義務区分で、`evidence/distribution-obligations.json` の同じ行に入口がまとめられています。ただしOOFEMとは別の対象です。§3のOOFEMの手順・3ケース・`sources/native-rebuild/replacement-evidence.json` をNetgenの証拠として使わず、Netgenの記録もOOFEMの証拠として使いません。

### 4.1 受領物と役割

次のファイルはすべて `licenses/fem/` からの相対パスで、受領したmanifestの `files` 行（バイト数・SHA-256）と照合してから、§1と同じく論理名のまま `packages/fem/runtime/` 以下へ復元します。`replacement-plan.json` の `files` も同じフォルダーのファイルのSHA-256を固定しています。

| 区分 | ファイル | 役割 |
|---|---|---|
| 変更元 | `sources/netgen-654ed121e44cedc4db45f955d9ab6ddf8dd48806.tar.gz` | Netgenの元ソース |
| 変更元 | `sources/pybind11-98e50b702d9ab784ec918399aaa20adcfd1af9a9.tar.gz`、`sources/zlib-v1.3.1.tar.gz`、`sources/netgen-sdk-zconf.h` | 結合部・zlibの元ソースと、出荷ビルドのzconf.h |
| 変更元 | `sources/netgen-654ed121-build-r4-recipe.zip` | 出荷wheelを作ったr4のpackaging（pyproject.toml、link変更、設定） |
| 対応表 | `evidence/netgen-build-source-map.json` | 出荷wheelの4モジュール、元ソース、許諾原文の対応。各行の `path` は作成時の記録で取得先ではありません。取得には `bundlePath` を使います |
| 手順 | `sources/netgen-rebuild/replacement-plan.json` | 実行する手順R3・R5・R6・R7の全引数と期待結果。`executed`・`sourceReplacementExecuted` はその版で記録された実行状況です |
| 手順 | `sources/netgen-rebuild/rebuild-netgen-pyodide.sh` | 再構築recipe（Bash、Linux aarch64、通信なし） |
| 手順 | `sources/netgen-rebuild/netgen_rebuild_steps.py` | recipeが呼ぶ、Python標準ライブラリだけの展開・検査・記録 |
| 手順 | `sources/netgen-rebuild/pins.json` | 期待するSHA-256、CMake設定、wheel名、モジュール構成、目印の文字列 |
| 変更の例 | `sources/netgen-rebuild/netgen-replacement-marker.patch` | pyngcoreに文字列の属性を1つ足すだけの変更。メッシュ生成の処理は変えません |
| 採用 | `sources/netgen-rebuild/stage_replacement.py` | 変更wheelを隔離コピーへ採用する |
| 確認 | `sources/netgen-rebuild/fem-netgen-replacement.spec.ts` | 製品のローダーで確かめる3つの実ケース |

出荷wheelは `assets/netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl`（2809006バイト、SHA-256 `3f0d507e8daa11b5a26654d904c529d6c1338e9a3a4c7d7728152f3596954ba3`）です。この元wheelは置き換えずに残します。

### 4.2 自分で用意するもの

次のツールと環境は配布物に含まれません。recipeが版とSHA-256を確かめ、違えば止まります。

- `VENV`: Python 3.13.2のvenvで、pyodide-build 0.31.1、scikit-build-core 0.11.6、packaging 26.3、pathspec 1.1.1を含むもの。§3のOOFEM用の `portable/replay-environment.json` のvenvも条件を満たします。
- `EMSDK`: Emscripten 4.0.9（`bbf1caa6e24f64fca9eb6a13a9e02d3f42123e77`）、LLVM `2f05451198e2f222ec66cec4892ada0509519290` のemsdk。`upstream/emscripten/cache` にPyodide 0.29.3のxbuildenv由来のsysrootが入っていること。recipeはこのcacheを出力先へ複写し、`EM_FROZEN_CACHE=1` で使います（足りないライブラリを生成・取得せず失敗します）。
- `XBUILDENV`: Pyodide 0.29.3のcross-build環境のフォルダー。recipeは、このフォルダーの直下の各フォルダーにある `xbuildenv/pyodide-root`（`*/xbuildenv/pyodide-root`）を実体のパスに解決し、同じ実体を指す別名（シンボリックリンクなど）を1つにまとめます。まとめた後の実体がちょうど1つの環境で、どの候補の実体もこのフォルダーの内側にあるときだけ使います。異なる実体が0個または2個以上ある場合や、実体がこのフォルダーの外にある場合は止まります。
- `WHEELHOUSE`: Linux aarch64用のcmake 4.4.4（wheel SHA-256 `b3029f586853e01ddf2824c1ff124a1c5284f8ae897994758e9c4eeb45903b58`）とninja 1.13.2（`d775a5e43e9088f507a6250d57fcf5678eb31268c545feb5064ffeee33735622`）のwheelがあるフォルダー。§3の `acquisition-request.json` の13個に両方含まれます。他のwheelは使われません。
- 実行環境: Linux aarch64で、bash、git、sha256sum、setsid、ps、find、nice、nproc、cut、grep、wc、tr、sortが使えること。

パスは利用者ごとに決めます。以下では次の名前で書きます。すべて絶対パスで、改行を含めません（recipeが拒否します）。

- `PCAD`: §1で復元したアプリソースの根。`packages/fem/runtime/` に受領ファイルがあり、元wheelもここに元のまま残します。
- `NEW`: 出力を置く既存のフォルダー。各実行の `--out` には、その下のまだ存在しない名前を毎回新しく指定します。
- `COPY`: `PCAD` とは別の場所に作ったアプリソースの隔離コピーで、`pnpm install --frozen-lockfile` で依存を用意したもの。
- `NODE`: node実行ファイルの絶対パス。

### 4.3 変更版wheelを作る（手順R5）

```sh
setsid --wait bash "$PCAD/packages/fem/runtime/sources/netgen-rebuild/rebuild-netgen-pyodide.sh" \
  --variant modified \
  --marker-patch "$PCAD/packages/fem/runtime/sources/netgen-rebuild/netgen-replacement-marker.patch" \
  --netgen-tar "$PCAD/packages/fem/runtime/sources/netgen-654ed121e44cedc4db45f955d9ab6ddf8dd48806.tar.gz" \
  --pybind11-tar "$PCAD/packages/fem/runtime/sources/pybind11-98e50b702d9ab784ec918399aaa20adcfd1af9a9.tar.gz" \
  --zlib-tar "$PCAD/packages/fem/runtime/sources/zlib-v1.3.1.tar.gz" \
  --zconf "$PCAD/packages/fem/runtime/sources/netgen-sdk-zconf.h" \
  --recipe-zip "$PCAD/packages/fem/runtime/sources/netgen-654ed121-build-r4-recipe.zip" \
  --venv "$VENV" --emsdk-env "$EMSDK/emsdk_env.sh" --xbuildenv "$XBUILDENV" \
  --em-cache "$EMSDK/upstream/emscripten/cache" --wheelhouse "$WHEELHOUSE" \
  --reference-wheel "$PCAD/packages/fem/runtime/assets/netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl" \
  --jobs 4 --out "$NEW/r86-modified"
```

`setsid --wait` は必須です（recipeは自分のprocess groupで動いていなければ止まります）。`--jobs` は1〜4です。`--variant original` は `--marker-patch` を拒否し、`--variant modified` はそれを必須にします。`--stop-after source` を加えると、ソースの準備（23-snapshot）までで止まります（plan の `notRequired` にある任意の手順R1・R2）。

recipeは次の順に進み、最初に失敗した段で止まって、それまでの出力とログを残します。

1. 元データの固定検証（10-inputs）: 補助スクリプトとpins、5つの変更元、変更patch、元wheelのSHA-256を確かめます。1つでも違えば展開しません。
2. 展開とpackaging（20-extract、21-packaging）: リンク・装置ファイル・パスの逸脱を拒んで展開し、上流のpyproject.toml・ng/CMakeLists.txt・zconf.hのSHA-256を確かめてから、r4のpackagingへ置き換えます。元のファイルは `dist-source/` に残ります。
3. 変更patch（22-marker、modifiedのみ）: `src/netgen` で `git apply --check` の後に適用し、変更後のファイルのSHA-256を確かめます。
4. ソース一覧（23-snapshot）、ツールとvenvの版の確認（11-tools、12-venv）、`XBUILDENV` の構築前の確認（14-xbuildenv。4.2の条件で実体がちょうど1つの環境であることを、Emscriptenの確認とコンパイルより前に確かめます）、Emscriptenの版の確認（13-toolchain）、zlib（30-zlib）、ビルド（50-build）、実際のCMake設定・リンク・compiler wrapperの確認（51-configure）。
5. wheelの検査（60-wheel）: wheel名が `netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl` だけであること、4つのモジュールとその依存（dylink needed）、埋め込み版 `6.2.2606.post5.dev0`・`v6.2.2606-5-g654ed121`、USE_OCC・USE_MPI・USE_GUIがOFFであること、目印の文字列がmodifiedで1回・originalで0回現れることを確かめます。元wheelとの比較は報告するだけで、一致を要求しません。
6. 記録（61-provenance）。

出力は `--out` の下だけに書かれ、入力は書き換えられません。

- 変更版wheel: `$NEW/r86-modified/dist/netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl`
- 記録: `$NEW/r86-modified/rebuild-provenance.json`（schema `pointercad-netgen-portable-rebuild/1`。`wheel.wheelSha256`・`wheelBytes`・`markerCounts`・`modules`・`comparison` と、各ログのSHA-256）
- ログ: `$NEW/r86-modified/logs/`（段ごとの `.command`・`.stdout`・`.stderr`・`.exit`、`steps.txt`、成功時は `REBUILD OK modified` で始まる `done.txt`）

やり直すときは、前の出力を消さずに新しい `--out` を指定します。

### 4.4 自分の変更を入れる

同梱のrecipeは、例の変更patchをSHA-256で固定しています（10-inputs）。変更後のファイルは `pins.json` の `marker`（`file`・`beforeSha256`・`afterSha256`）で、wheelの目印は `marker.token` で確かめます（22-marker、60-wheel）。自分の変更を入れるときは、次のとおりにします。

1. `rebuild-netgen-pyodide.sh`、`netgen_rebuild_steps.py`、`pins.json` を新しい作業フォルダーへ複写します。recipeは自分と同じフォルダーの補助スクリプトとpinsを使います。
2. 自分の変更をgit形式のpatchにします。パスはNetgenソースの根からの相対で `a/`・`b/` を付け、recipeが `src/netgen` で `git apply` します。変更した旨と日付をpatchと変更ファイルに書き、元の著作権表示と許諾文は残します。
3. 複写した `pins.json` の `marker` で、`file`・`beforeSha256`・`afterSha256` を変更したファイルの1つとその前後のSHA-256にし、`token` を、ビルドしたモジュール（`.so`）全体でちょうど1回現れる文字列にします（例のpatchのような目印を自分の変更と一緒に入れてください）。
4. 複写したrecipeの `s_inputs` で、`$PINS` と `$MARKER_PATCH` の期待SHA-256だけを自分のファイルの値にします。他の検査は消しません。
5. 4.3のコマンドで、recipeのパスを複写したものにし、`--marker-patch` に自分のpatchを指定します。

wheel名・版・ABI tag・モジュール構成・CMake設定を変える変更は、この手順の範囲外です（recipe、採用スクリプト、ローダーが同じwheel名を前提にしています）。

### 4.5 隔離コピーへ採用する（手順R6）

```sh
python3 -I -B "$PCAD/packages/fem/runtime/sources/netgen-rebuild/stage_replacement.py" \
  --copy "$COPY" \
  --modified-wheel "$NEW/r86-modified/dist/netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl" \
  --provenance "$NEW/r86-modified/rebuild-provenance.json" \
  --receipt "$NEW/r86-stage-receipt.json"
```

このスクリプトは、`--copy` が自分の属するアプリソース（ここでは `PCAD`）なら書き込まずに拒否します。また、`COPY` 側の元のバイトが出荷版と違う、記録が渡した変更wheel（同じバイト数・SHA-256、目印1回）の変更版ビルドの記録ではない、変更wheelが元wheelと同じ、確認用specが既にある、`--receipt` が既にある場合も、書き込む前に止まります。`COPY` で変わるのは次の5つだけです。

1. `packages/fem/runtime/assets/` のNetgen wheelを変更版へ置き換えます。
2. `packages/fem/runtime/manifest.json` の `files["assets/netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl"]` の `bytes`・`sha256` だけを変更版の値にします。
3. `packages/fem/src/assets.ts` の `NETGEN_ASSETS` の同じwheelの行の `bytes`・`sha256` を、2と同じ値にします。
4. `e2e/tests/fem-netgen-replacement.spec.ts` を新規に置きます（同梱specと同じバイト）。
5. `packages/test-utils/src/browserProjectCoverage.json` へ、このspecの分類行を1行だけ足します（コピーの単体検査用。Playwrightは読みません）。

`PCAD` の元wheelは変わりません。`--receipt` には各ファイルの前後のSHA-256、変更wheelのバイト数・SHA-256、記録のSHA-256が残ります。`COPY` のソース対応表、アプリソースの索引、SBOMは更新されないので、`COPY` は確認と自分用の利用のためのもので、そのまま再配布用にはなりません（receiptの `adoptionCandidate` は `false` です）。

### 4.6 製品のローダーで3ケースを確かめる（手順R7）

`COPY` で、一覧と実行を順に行います。`COPY/scratchpad/temp` は先に作っておきます。`e2e/playwright.config.ts` の `webServer` がデスクトップとWebのビルドとpreviewを自分で起動します。

```sh
cd "$COPY"
export PCAD_NETGEN_ORIGINAL_WHEEL="$PCAD/packages/fem/runtime/assets/netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl"
export TEMP="$COPY/scratchpad/temp" TMP="$COPY/scratchpad/temp" TMPDIR="$COPY/scratchpad/temp"
PLAYWRIGHT_JSON_OUTPUT_FILE="$NEW/r7-list.json" "$NODE" "$COPY/node_modules/@playwright/test/cli.js" test \
  --config "$COPY/e2e/playwright.config.ts" fem-netgen-replacement.spec.ts \
  --project=functional --no-deps --workers=1 --reporter=json --list
PLAYWRIGHT_JSON_OUTPUT_FILE="$NEW/r7-run.json" "$NODE" "$COPY/node_modules/@playwright/test/cli.js" test \
  --config "$COPY/e2e/playwright.config.ts" fem-netgen-replacement.spec.ts \
  --project=functional --no-deps --workers=1 --reporter=json
```

ChromiumのブラウザーをPlaywrightの既定以外の場所に置いている場合は、`PLAYWRIGHT_BROWSERS_PATH` にその場所を指定します。一覧では終了コード0で、project `functional` の下にこのspecの次の3題名だけが出ます。実行の結果は expected 3、unexpected 0、flaky 0、skipped 0 です。

| ケース | 題名 | 確かめること |
|---|---|---|
| `modified-accepted` | 作り直した宣言で、変えた Netgen wheel を実Workerが受け入れて 2×3×4 mm の箱を体積 24 mm³ で分割する | 宣言どおりの変更wheelを実Workerが受け入れ、四面体分割の体積が24 mm³（相対誤差1e-9以内） |
| `original-refused` | 同じアプリで、元の Netgen wheel は長さか SHA-256 の違いで断る | `PCAD_NETGEN_ORIGINAL_WHEEL` の元wheel（2809006バイト・出荷SHA-256を確認）を `asset-corrupt: <wheel> (size)`（長さが同じならSHA-256）で拒否し、段階は `loading-assets` だけ |
| `tampered-refused` | 同じアプリで、同じ長さで1バイトだけ変えた Netgen wheel は SHA-256 の違いで断る | 変更wheelの中央の1バイトだけを変えたものを `(SHA-256)` で拒否し、段階は `loading-assets` だけ |

この3ケースは、宣言を作り直した隔離コピーで、製品のローダーが変更wheelを受け入れ、元wheelと改ざんしたwheelを読み込む前に拒否する範囲を確かめるものです。任意の変更のABI互換、数値精度、他の解析の正しさまでは判定しません。拒否側の確認として、plan の手順R3（`--variant original` に `--marker-patch` を付けた実行と `--variant modified` で付けない実行は、`--out` を作る前に終了コード64、改ざんしたNetgen tarの複写を `--stop-after source` で渡した実行は10-inputsで失敗し `src/` を作らない）も同じ引数で実行できます。

### 4.7 自分用のアプリにする

R7が通った `COPY` で、§3と同じく `pnpm install --frozen-lockfile` の後に `pnpm --filter @pointercad/web run build` を実行します。runtime manifestと `assets.ts` は同じ値のままにし、内容の検証を消したり、元のSHA-256で変更したバイトを通したりしません。元wheelと元の配布物は別に残します。再配布する場合は、自分のpatch・複写して変えたrecipeとpins・許諾原文・manifest・ソース対応表・SBOMと、自分の実行の記録をそろえます。上流のNetgen・pybind11・zlibの許諾原文と、`evidence/netgen-build-source-map.json` が対応付けるヘッダーの原文（`notices/`）は削除しません。

### 4.8 配布された実証記録を照合する

Netgenの実証記録の置き場所は `sources/netgen-rebuild/replacement-evidence.json` です（`evidence/distribution-obligations.json` のnetgen-mesherの `replacement.evidence`）。受領したmanifestにこの行があれば、次を確かめます。公開前の検査（アプリソースの `scripts/vite/femRuntimeAssets.mjs` の `femDistributionObligationGaps`）も同じ条件を使います。

1. ファイルのバイト数・SHA-256がmanifestの行と一致する。
2. `format` が `pointercad-netgen-native-replacement-evidence/1`。
3. `shippedWheelSha256` が、manifestのNetgen wheelの行の `sha256`、および保存した元wheelの実ファイルのSHA-256と一致する。
4. `sourceSha256` が、manifestの `sources/netgen-654ed121e44cedc4db45f955d9ab6ddf8dd48806.tar.gz` の `sha256`、および保存した実ファイルのSHA-256と一致する。
5. `rebuild.passed` が `true`、`rebuild.wheelSha256` と `rebuild.receiptSha256` が64桁の16進で、`rebuild.wheelSha256` が `shippedWheelSha256` と違う。
6. `replacement.wheelSha256` が `rebuild.wheelSha256` と一致し、`replacement.receiptSha256` が64桁の16進。
7. `replacement.cases` に `modified-accepted`・`original-refused`・`tampered-refused` がそれぞれ1回だけあり、どれも `passed: true`。

記録が指す原票（再構築の記録、採用のreceipt、R7の結果）が配布物にあれば、そのSHA-256を記録の値と比べます。原票が無い場合、受領者はその中身を確かめられないので、その部分は未検証として区別します。この記録は配布者が作った変更wheelの実証で、あなたの再構築のwheelとバイトが一致するとは限りません。自分の実行は、自分の `rebuild-provenance.json`、receipt、R7のJSONで確かめます。

受領したmanifestにこの行が無い場合、または上の照合が通らない場合、その版のNetgenの交換は未検証です。plan・recipe・specがあることだけでは、成功や配布義務の完了にはなりません。

`evidence/replacement-tool.py` はOOFEMの歴史的な道具なので、Netgenには使いません。
