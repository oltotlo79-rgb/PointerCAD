# JavaScript実行器の採用資料

## 現在の構成（2026-09-16実装、9月21日結果確認）

利用者の指示により、許諾原文が未取得だった`quickjs-wasi`は依存から削除した。そのJavaScript接続処理だけでなく、生成に用いていた同部品の`c/interface.c`も使わない。QuickJS-ng本体の版`65641a0c1e85cc266d7613d6673a22ec834bb941`と、最初の資源超過・元の行を保持するPointerCADの修正を維持し、独自の`pcad-interface.c`と`nativeScriptVm.ts`で接続する。新しい第三者部品は追加していない。

実行ファイルは721575バイト、SHA-256 `d037fab24cf898def1085e5147020cd486fc986a1db299395167acb71fc4c740`。生成元、独自の接続ソースの照合値、資源制限の修正、コンパイル引数を`packages/model/src/vendor/script-runtime/`に保持する。実行ごとに独立した実行器を作り、値は所有先と寿命を持つ番号で渡す。関数呼出しの間だけ貸した値、破棄後の値、他の実行器の値は使えない。利用者のJavaScriptへホストのオブジェクトを渡さない。

実行器本体に必要なメモリは64MiB、呼出しの深さに使う領域は128KiB、JavaScriptは5秒、準備と形状計算を含む全体は90秒。命令1000件/8MiB、記録1000行/1MiB、同梱モジュール32個/ソース合計1MiBを維持する。WASMの全メモリにも128MiBの上限を付ける。非同期処理の完了とエラーは、利用者が書き換えられる`Promise.prototype`を介さず、本体の公開APIから確認する。時刻・乱数、許可済みモジュールの読込み、異常後の再実行も従来の契約を維持する。

原文は`docs/standards/licenses/script-runtime-notices.json`の出典と照合値を正本とし、QuickJS-ng、組込みのC実行部と算術補助部の原文を`licenses/script-runtime/`へ両版とも同梱する。QuickJS-ngの原文は固定版の作者公開ファイルとバイト単位で再照合した。WASI SDK 32の固定されたwasi-libc・compiler-rtの出典も記録する。配布の前にバイナリ、独自の接続処理、資源制限の修正、生成元と原文を照合し、旧接続ソースの再混入を拒否する。

9月16日21:19に関連189項目、21:26にChromium・Firefox・Electronの実操作9件が成功した。値の寿命、資源制限、元の行、正常と異常、保存再開、同じ入力10回の一致を含む。変更後の型・書き方と許諾23項目、配布の組み立ても成功した。22:03には固定した生成元から独立して再生成し、上記721575バイトの全内容が一致した。証拠は`scratchpad/tasks/6131650ed8c2-script-runtime-replacement-98osinsk/`。両OS最終CIは未了であり、以下の過去の採用記録を現在の配布構成や今回の全体合格として扱わない。

## 旧構成の採用記録（履歴。現在の依存ではない）

2026-09-11。P11の実装判断。機能全体の完了記録とは別に、依存差分と実証の範囲を固定する。

## 依存差分

- modelのみに`quickjs-wasi`を追加し、workspace catalogは**3.6.0完全固定**。OCCT、式評価器、その他の版は変更しない。
- npm配布のWASMは636400バイト、SHA-256 `b006d95d9475edf7c6648cc3eb391d3b780efdd99022fbfbb470f2359da460ff`。配布tarballは567491バイト。実行時JavaScript依存は0件。
- 組み込むのはJavaScript wrapperとQuickJS-NGのWASM。追加の`.so`拡張（crypto・URL等）は読み込まず、成果物にも含めない。VMのsnapshot/bytecodeは保存・読込しない。
- **製品WASMは最小修正付きの再ビルド版**: 748917バイト、SHA-256 `86984372d287728d6b7e947b706a1fa8ef7a07c754a167542830ad0942baf8df`。配布元の636400バイトと混同しない。配布元では、メモリ・再帰超過をguestがcatchすると成功へ戻ることを製品診断で確認した。QuickJS-NGのメモリ・再帰・割込み経路に最初の資源超過と元の行を保持する印を追加し、ホストが実行後と割込み時に読む。guestにはこの印や実行器を公開しない。修正なしのWASMを読み込んだ場合も必ず失敗する。
- 本体の`eval`許可や外部通信権限は追加しない。アプリが生成する専用Worker内にVMを作り、検証済みの文字列だけを境界にする。

## 出典と許諾表示

- [配布元](https://github.com/vercel-labs/quickjs-wasi)と配布package.jsonの宣言はMIT。npm provenanceのsource commitは`54c4d2dd4be2445409aeab603ecfc3bb209c7310`。
- QuickJS-NG submoduleは`65641a0c1e85cc266d7613d6673a22ec834bb941`。この版の[許諾原文](https://github.com/quickjs-ng/quickjs/blob/65641a0c1e85cc266d7613d6673a22ec834bb941/LICENSE)を`licenses/quickjs-ng.txt`へそのまま同梱する。
- wrapper自身のLICENSEファイルは配布物・対応commitのtreeで見つからなかった。MITの配布元宣言は保存するが、推測した著作権文を作らない。配布時の依存許諾一覧には宣言と出典を明記し、原文の不足を未確認のまま「全依存許諾確認済み」としない。
- 取得日時、API tree、npm attestation、版の照合値は開発記録`scratchpad/p8-next-implementation/p11-wasi-candidate/license-evidence/summary.json`へ保存。製品に必要な原文と採用判断はこの文書の隣にも同梱する。

## 採用に使った実証と製品側の契約

実WASMで正常実行、module、元の行列、Promise、無限ループ、再帰、メモリ超過、敵対的なエラーgetter、巨大エラー、および各失敗直後の正常実行を確認した。初期のglobal評価では例外読出しに問題があったため、元のsourceをmoduleとして評価し、ネイティブPromise完了観測と事前に捕捉したエラー読出しを使う。下書きの実証は製品検査の代わりにしない。

製品側はheap64MiB、stack128KiB、JS5秒、実行全体30秒、命令1000件/8MiB、ログ1000行/1MiB、同梱module32個/source合計1MiB。上限超過はhost側へ失敗を保持し、利用者コードのtry/catchで成功に戻さない。未処理Promiseは32件まで資源を保持し、33件目で必ず失敗する。VM外のFunction/DOM/ネットワーク/ファイルAPIを公開しない。時刻は入力snapshotへ固定し、乱数はseed付きとする。入力時刻はWASIのuint64ナノ秒へ桁あふれなく換算できる0〜18446744073709ミリ秒に限定し、実VMのDate/Date.nowを上端でも照合する。

製品に追加する通常検査で実WASMを読み、正常・異常・再実行と同一入力10回の一致を検証する。専用Workerの停止、原子的CAD適用、UI、保存、Windows/LinuxとChrome/Firefox/Electronの結合はP11全体の完了条件として続けて実装する。

## 再ビルドと失敗の記録

`packages/model/src/vendor/script-runtime`へバイナリ、元ソースの版、取得ファイルのSHA-256、最小patch、許諾原文、コンパイル引数を同梱した。`python scripts/build-script-runtime.py --output-dir scratchpad/script-runtime-rebuild`は、clang 22.1.8を確認し、版32のWASI sysroot/runtimeと固定sourceを照合して新しいフォルダーに作る。製品ファイルを上書きしない。2026-09-11に割込み時の行捕捉、7種類の分岐位置保持、空のwhile/do/forのソース位置を追加した。`rebuild-product-script-v8`で独立して再ビルドし、748917バイトと上記SHA-256の一致を確認した。`script-model10`は27/27件成功し、主処理とモジュールの空ループ、関数内ループ、catchした資源超過の元の行を検証した。利用者PCの絶対パスはバイナリへ含めない。

`script-model1`は41件成功・2件失敗。再帰エラーの実際の文言と、Promiseを保持する連鎖が時間より先にメモリ制限へ達することを修正した。保持しない連鎖は5秒の時間超過、保持する連鎖は64MiBのメモリ超過として別々に検査する。`script-model2`では捕捉済みのメモリ・再帰超過2件が成功に戻る不足を検出し、上記のnative側保持を追加。`script-model3`は47/47件成功した。絶対パスを除いた最終バイナリについても、後続の通常検査へ含める。
