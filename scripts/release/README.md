# 通信なしで使うWeb版の確認用一式

製品の入力を固定し、他の検査・ビルドが終了した状態で、リポジトリ直下から順に実行する。各出力名は`dist/`直下の新しい名前とし、以前の出力には上書きしない。

```powershell
node scripts/release/build-web-offline.mjs web-offline-source-20260915
node scripts/manual/generate.mjs manual-offline-20260915
node scripts/manual/generate-pdf.mjs manual-offline-20260915 manual-offline-pdf-20260915
node scripts/release/assemble-web-offline.mjs web-offline-source-20260915 manual-offline-20260915 manual-offline-pdf-20260915 web-offline-candidate-20260915
```

1つ目は本体を新しく生成し、入力と出力の内容を`web-build.json`へ記録する。追加・削除・変更が生成中に起きた場合は停止する。2つ目と3つ目は同じ本文から全HTMLとPDF巻を生成する。

最後の処理は、本体と説明書の入力が現在の実装と同じこと、全出力の内容、HTMLとPDFの版・全巻・章の対応を確認する。本体・説明書・PDF・許諾原文を新しいフォルダーにまとめ、全ファイルの照合後に`offline-assets.json`を最後に書く。途中失敗ではこの一覧を完成させず、以前の一式を変更しない。公開操作は行わない。

この一式は確認用であり、公開済み・完成認定済みという意味ではない。CAD本体の通信なしでの起動・作図・保存・全ヘルプ、容量不足や保存内容の欠落からの復旧、全ページの画像・日本語・PDFの文字と改頁、公開環境での確認、同じ版の両OS検査は別途必要。生成された認定用の値を手でtrueへ変えて代用しない。
