# 自動作図APIリファレンス

API版1の全公開操作です。コード内の`cad`から呼び出します。距離・半径・直径・座標は**数値ではなく式の文字列**で渡します。`'10'`、`'板厚*2'`、`'1inch'`などを使い、画面と同じ長さの単位・パラメータに従います。

![パラメータ・箱・穴のAPIを使った自動作図の実画面](./images/script-plate-created.png)

戻り値のIDは不透明な文字列です。その実行内で変数に保持するか、現在の`cad.document.read()`から取得してください。保存しておいた別実行・別文書のIDは使用できません。APIは命令を順に記録し、全処理後に形状を検証します。まだ作成していない形状の計測値を途中で読むAPIはありません。

## 文書とパラメータ

| 呼出し | 引数・戻り値 |
|---|---|
| `cad.document.read()` | 現在の文書の読取専用の写し。`name`、`lengthUnit`、`parameters`、`sketches`、`solids`を返します |
| `cad.parameters.set(name, source, unit?)` | 日本語を含むパラメータ名、式文字列。単位は`'mm'`・`'degree'`・`'none'`。省略時は既存の単位、新規なら長さ。既存値は更新、新規名は追加 |

`parameters`の各項目は`name, source, unit, description`。`sketches`は`id, name, elements`、対応する`elements`は点・線分・関数曲線・面の`id, kind, name`です。線分と関数曲線の種類はともに`edge`です。`solids`は`id, name, kind, suppressed`を返します。読んだ写しを変更しても部品には反映されません。APIの`set`を使ってください。

```javascript
cad.parameters.set('板厚', '5');
console.log(cad.document.read().parameters);
```

読み取れるのは実行開始時の値です。同じ実行の`set`による変更を読取用の写しへ逆反映しません。新しいパラメータの式は、それ以降の作図命令で使用できます。

関数作図を含む文書でも自動作図を実行できます。既存の係数を`set`で更新した場合は関数の参照先を保ち、数学用の計算部で関数も評価してから結果を反映します。関数や数学の条件を確認できなければ、その実行で追加した形も一緒に取り消し、元の文書を残します。

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

## 関数の曲線と曲面

| 呼出し | 引数・戻り値 |
|---|---|
| `cad.function.curve(sketch, definition)` | 所属スケッチのIDと関数定義。関数曲線の辺IDを返します |
| `cad.function.surface(definition)` | 関数定義。関数曲面のIDを返します。閉じていて有効な面は立体になり、開いた面は曲面のままです |

`definition`には次の欄を指定します。式は専用の[関数作図](function-curve.md)画面と同じ数学記号・変数の区別を使います。座標や範囲はmmです。

| 欄 | 指定方法 |
|---|---|
| `bounds` | **X・Y・Zのすべてが必須**。各軸に最小・最大の式文字列2個。例：`{X:['-2','2'],Y:['-2','2'],Z:['-2','2']}`。1軸でも欠ける場合や、有限でない値、最小より大きくない最大値は拒否します |
| `tolerance` | 正の誤差上限の式文字列。例：`'0.01'` |
| `angleUnit` | 省略すると度。`'degree'`または`'radian'`を指定でき、その関数の式と範囲の角度解釈をそろえます |
| `formula` | 下表のいずれか。大文字の`X/Y/Z`は描画する軸、`T/U/V`は媒介変数、`coef("係数名")`は文書の係数です |

| 作るもの | `formula`の指定例 |
|---|---|
| XからY・Zを求める曲線 | `{kind:'coordinate-curve',independent:'X',outputs:{Y:'X^2',Z:'0'}}`。独立軸をYまたはZに変更した場合は、残る2軸の式を指定します |
| Tを使う曲線 | `{kind:'parametric-curve',T:['0','360'],outputs:{X:'cos(T)',Y:'sin(T)',Z:'0'}}` |
| 平面内の等式の曲線 | `{kind:'implicit-curve',fixedAxis:'Z',fixedCoordinate:'0',expression:'X^2+Y^2-1'}`。式が0となる部分を描きます |
| X・YからZを求める曲面 | `{kind:'coordinate-surface',output:'Z',expression:'X*Y'}`。出力軸をXまたはYに変更することもできます |
| U・Vを使う曲面 | `{kind:'parametric-surface',U:['-1','1'],V:['-1','1'],outputs:{X:'U',Y:'V',Z:'U*V'}}` |
| 空間の等式の曲面 | `{kind:'implicit-surface',expression:'X^2+Y^2+Z^2-1'}`。式が0となる部分を描きます |

T/U/Vの範囲を指定しても、XYZの各範囲は省略できません。生成される形はXYZの範囲内に限ります。三角関数の円の例は度を前提にしています。ラジアンを選ぶ場合はTの範囲を`['0','2*pi']`のように指定してください。

関数の直前に`cad.parameters.set('係数','2','none')`を実行すれば、その後の関数で`coef("係数")*X`を使用できます。関数も含め、全命令の計算に成功してからまとめて反映します。途中の入力エラー・範囲の不成立・中止では一部の形だけを残しません。実行全体をUndo1回で戻せます。実行後は通常の関数の編集画面で式・範囲を変更でき、[関数上の点と接線・法線](function-point.md)も作れます。

## 基本形状と加工

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
