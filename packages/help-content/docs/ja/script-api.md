# 自動作図APIリファレンス

API版1の全公開操作です。コード内の`cad`から呼び出します。距離・半径・直径・座標は**数値ではなく式の文字列**で渡します。`'10'`、`'板厚*2'`、`'1inch'`などを使い、画面と同じ長さの単位・パラメータに従います。

![パラメータ・箱・穴のAPIを使った自動作図の実画面](./images/script-plate-created.png)

戻り値のIDは不透明な文字列です。その実行内で変数に保持するか、現在の`cad.document.read()`から取得してください。保存しておいた別実行・別文書のIDは使用できません。APIは命令を順に記録し、全処理後に形状を検証します。まだ作成していない形状の計測値を途中で読むAPIはありません。

## 文書とパラメータ

| 呼出し | 引数・戻り値 |
|---|---|
| `cad.document.read()` | 現在の文書の読取専用の写し。`name`、`lengthUnit`、`parameters`、`sketches`、`solids`を返します |
| `cad.parameters.set(name, source, unit?)` | 日本語を含むパラメータ名、式文字列。単位は`'mm'`・`'degree'`・`'none'`。省略時は既存の単位、新規なら長さ。既存値は更新、新規名は追加 |

`parameters`の各項目は`name, source, unit, description`。`sketches`は`id, name, elements`、対応する`elements`は点・線・面の`id, kind, name`です。`solids`は`id, name, kind, suppressed`を返します。読んだ写しを変更しても部品には反映されません。APIの`set`を使ってください。

```javascript
cad.parameters.set('板厚', '5');
console.log(cad.document.read().parameters);
```

読み取れるのは実行開始時の値です。同じ実行の`set`による変更を読取用の写しへ逆反映しません。新しいパラメータの式は、それ以降の作図命令で使用できます。

## スケッチ

| 呼出し | 引数・戻り値 |
|---|---|
| `cad.sketch.create(name, plane?)` | 新しいスケッチのID。作図面は`'xy'`（既定）・`'xz'`・`'yz'` |
| `cad.sketch.point(sketch, coordinates)` | スケッチIDと`['xの式','yの式','zの式']`。点IDを返します |
| `cad.sketch.line(sketch, start, end)` | 同じスケッチの始点ID・終点ID。線分IDを返します |
| `cad.sketch.face(sketch, edges)` | 同じスケッチの線分IDの配列。閉じた輪郭から面IDを返します |

```javascript
const sketch = cad.sketch.create('輪郭', 'xy');
const p = [['0','0','0'], ['30','0','0'], ['30','20','0'], ['0','20','0']]
  .map(position => cad.sketch.point(sketch, position));
const edges = p.map((point, i) => cad.sketch.line(sketch, point, p[(i+1)%4]));
const face = cad.sketch.face(sketch, edges);
cad.solid.extrude(face, '10');
```

## 立体

基本形状は引数のオブジェクトに寸法を渡します。共通の省略可能な欄は`origin: ['0','0','0']`と`axis: 'z'`。軸は`'x'`・`'y'`・`'z'`です。原点・軸の意味は画面の[基本形状](primitive.md)と共通です。

| 呼出し | 必須寸法 |
|---|---|
| `cad.solid.box({x, y, z, origin?, axis?})` | 3方向の寸法 |
| `cad.solid.sphere({radius, origin?, axis?})` | 半径 |
| `cad.solid.cylinder({radius, height, origin?, axis?})` | 半径、高さ |
| `cad.solid.cone({bottomRadius, topRadius, height, origin?, axis?})` | 下側半径、上側半径、高さ |
| `cad.solid.torus({majorRadius, minorRadius, origin?, axis?})` | 中心線の半径、断面の半径 |
| `cad.solid.extrude(face, distance)` | 面IDと押し出す距離の式 |
| `cad.solid.hole(target, {origin, diameter, depth, axis?})` | 対象立体ID、穴の始点、直径、深さ。軸省略時`'z'` |

全操作は結果の立体IDを返します。箱の原点は中心、穴の原点は円柱状の工具の始点で、軸の正方向へ穴を作ります。対象と交わらない穴、対象を全部消してしまう穴、寸法や輪郭の不成立は全処理の失敗になります。

```javascript
const plate = cad.solid.box({x:'60', y:'40', z:'5'});
const first = cad.solid.hole(plate, {
  origin:['-10','0','-2.5'], diameter:'8', depth:'5'
});
cad.solid.hole(first, {
  origin:['10','0','-2.5'], diameter:'8', depth:'5'
});
```

## ログ・乱数・時刻・モジュール

- `console.log/info/warn/error(...values)`でログを表示します。オブジェクトは項目名と値の組として表示します。
- `Math.random()`は「乱数の種」を使用します。
- `Date.now()`と引数なしの`new Date()`は「処理へ渡す時刻」を使用します。
- `import { value } from './helpers.js'`は同梱モジュールを読みます。モジュール自身から同じ階層の`./`参照も使用できます。`../`・URL・絶対パス・外部パッケージは使えません。
- Promiseは使えますが、外部I/Oやブラウザーのタイマーを待つAPIはありません。完了しない非同期処理は失敗します。

各呼出しの値・ID・順序・所有者は実行器の外でも再検証します。対応していない引数を追加しても黙って無視せず、誤った指定として扱います。[実行上限とエラー](scripts.md)も参照してください。
