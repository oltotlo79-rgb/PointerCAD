# 使っている部品と許諾

PointerCAD自身のコードには、同梱している`LICENSE`ファイルのApache License 2.0が適用されます。PointerCADは、これに加えて実行時に使う部品・字体・追加の計算のための部品を同梱しており、それぞれに別の許諾(ライセンス)が適用されます。各部品の原文(著作権表示と条件を記した文章)は、アプリと一緒に次の場所へ同梱しています。

## 原文の同梱先

Web版はアプリのフォルダーの下、デスクトップ版は実行ファイルと同じフォルダーにある`resources/app/dist/renderer`の下に、次をまとめています。

| 同梱先 | 内容 |
|---|---|
| `licenses/runtime/index.html` | 実行時に使うJavaScriptの部品の原文と版 |
| `licenses/index.html` | 数式の入力と数式記号の表示に使う字体の原文 |
| `licenses/exact-math/index.html` | 追加の計算に使う部品の原文と関連ソース |
| `fonts/LICENSES.txt` | 画面・図面用の字体の原文 |

デスクトップ版だけ、実行ファイルと同じフォルダーに次も同梱します。

| 同梱先 | 内容 |
|---|---|
| `LICENSE.electron.txt`(または`LICENSE`) | Electronの原文 |
| `LICENSES.chromium.html` | Chromiumと同梱部品の原文 |

## 画面・図面用の字体と、字体を扱う部品

日本語の文字を図面に描くための字体(Noto Sans JP)と、その字体から文字の輪郭を取り出すための部品(opentype.js)の許諾の全文は、[字体と解析ライブラリのライセンス](font-licenses.md)に掲載しています。数式の入力・数式記号の表示に使う字体の原文は、上の表の`licenses/index.html`にまとめています。

## 確認できていない許諾の種類

上記の同梱先に、原文そのものが入っていない部品はありません。このうち、追加の計算に使う部品(`licenses/exact-math/index.html`)に含まれるliblzma・SQLite由来の部品の2件は、同梱している原文の中に許諾の正式な種類名を機械的に確定できる形では書かれていません。原文自体は同梱先で確認できますが、種類の分類は未確定のまま残しています。

[字体と解析ライブラリのライセンス](font-licenses.md)・[デスクトップ版の導入・更新・削除](desktop-install.md)・[作図したデータの保存場所と通信](local-data.md)
