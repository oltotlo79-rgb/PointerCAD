# JavaScript実行器の採用資料

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
