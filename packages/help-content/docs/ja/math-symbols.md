# 数学記号と演算の一覧

構造化した数式の入力で使える記号と演算を、分野ごとの表にまとめます。「記号／入力の書き方」はその場に挿入される数式、「例」は実際に計算して確かめた入力です。詳しい説明は各行の案内、または[構造化した数式と係数を入力する](math-input.md)から読めます。

## 数学記号

| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |
|---|---|---|---|
| 円周率 | `π`／`\pi` | `\pi` | [係数と数学記号を区別する](math-input.md#係数と数学記号を区別する) |
| 虚数単位 | `ⅈ`／`\mathrm{i}` | `\mathrm{i}` | [係数と数学記号を区別する](math-input.md#係数と数学記号を区別する) |
| 自然対数の底 | `e`／`\exponentialE` | `\exponentialE` | [係数と数学記号を区別する](math-input.md#係数と数学記号を区別する) |

## 基本演算

| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |
|---|---|---|---|
| 整数の商 | `q`／`\operatorname{integerquotient}\left(#1,#2\right)` | `\operatorname{integerquotient}\left(-7,3\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 整数の余り | `r`／`\operatorname{integerremainder}\left(#1,#2\right)` | `\operatorname{integerremainder}\left(-7,-3\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 次の素数 | `next prime`／`\operatorname{nextprime}\left(#1\right)` | `\operatorname{nextprime}\left(97\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 素因数と指数 | `n=∏pᵏ`／`\operatorname{primefactors}\left(#1\right)` | `\operatorname{primefactors}\left(360\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 正の約数の一覧 | `d|n`／`\operatorname{divisors}\left(#1\right)` | `\operatorname{divisors}\left(36\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| オイラーのトーシェント | `φ(n)`／`\operatorname{eulertotient}\left(#1\right)` | `\operatorname{eulertotient}\left(36\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 逆数 | `1/x`／`\operatorname{reciprocal}\left(#1\right)` | `\operatorname{reciprocal}\left(4\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 二重階乗 | `n!!`／`{#1}!!` | `{5}!!` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 順列 | `nPr`／`\operatorname{permutations}\left(#1,#2\right)` | `\operatorname{permutations}\left(5,3\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 上下限で制限 | `clamp`／`\operatorname{clamp}\left(#1,#2,#3\right)` | `\operatorname{clamp}\left(8,1,5\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 分数 | `a/b`／`\frac{#1}{#2}` | `\frac{3}{2}` | [入力方式と単位](math-input.md#入力方式と単位) |
| 累乗 | `xⁿ`／`{#1}^{#2}` | `{2}^{3}` | [入力方式と単位](math-input.md#入力方式と単位) |
| 平方根 | `√`／`\sqrt{#1}` | `\sqrt{9}` | [入力方式と単位](math-input.md#入力方式と単位) |
| n乗根 | `ⁿ√`／`\sqrt[#2]{#1}` | `\sqrt[3]{8}` | [入力方式と単位](math-input.md#入力方式と単位) |
| 階乗 | `n!`／`{#1}!` | `{5}!` | [入力方式と単位](math-input.md#入力方式と単位) |
| 絶対値・大きさ | `|x|`／`\left|#1\right|` | `\left|-3\right|` | [入力方式と単位](math-input.md#入力方式と単位) |
| 床関数 | `⌊x⌋`／`\operatorname{floor}\left(#1\right)` | `\operatorname{floor}\left(2.7\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 天井関数 | `⌈x⌉`／`\operatorname{ceil}\left(#1\right)` | `\operatorname{ceil}\left(2.1\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 四捨五入 | `round`／`\operatorname{round}\left(#1\right)` | `\operatorname{round}\left(2.6\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 符号関数 | `sgn`／`\operatorname{sign}\left(#1\right)` | `\operatorname{sign}\left(-5\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 最小値 | `min`／`\operatorname{min}\left(#1,#2\right)` | `\operatorname{min}\left(3,5\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 最大値 | `max`／`\operatorname{max}\left(#1,#2\right)` | `\operatorname{max}\left(3,5\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 組合せ | `nCk`／`\operatorname{binomial}\left(#1,#2\right)` | `\operatorname{binomial}\left(5,2\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 最大公約数 | `gcd`／`\operatorname{gcd}\left(#1,#2\right)` | `\operatorname{gcd}\left(24,18\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 最小公倍数 | `lcm`／`\operatorname{lcm}\left(#1,#2\right)` | `\operatorname{lcm}\left(4,6\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 剰余 | `mod`／`\operatorname{mod}\left(#1,#2\right)` | `\operatorname{mod}\left(7,3\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 複号±（符号ごとの候補） | `±`／`#1\pm#2` | `1\pm2` | [±・∓で複数の答えの候補を扱う](math-input.md#で複数の答えの候補を扱う) |
| 複号∓（符号ごとの候補） | `∓`／`#1\mp#2` | `1\mp2` | [±・∓で複数の答えの候補を扱う](math-input.md#で複数の答えの候補を扱う) |

## 関数

| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |
|---|---|---|---|
| 離散フーリエ変換 DFT | `DFT`／`\operatorname{dft}\left(#1\right)` | `\operatorname{dft}\left([1,2,3,4]\right)` | [数値の並びを離散フーリエ変換する](math-input.md#数値の並びを離散フーリエ変換する) |
| 逆離散フーリエ変換 IDFT | `IDFT`／`\operatorname{idft}\left(#1\right)` | `\operatorname{idft}\left([1,2,3,4]\right)` | [数値の並びを離散フーリエ変換する](math-input.md#数値の並びを離散フーリエ変換する) |
| 高速離散フーリエ変換 FFT | `FFT`／`\operatorname{fft}\left(#1\right)` | `\operatorname{fft}\left([1,2,3,4]\right)` | [数値の並びを離散フーリエ変換する](math-input.md#数値の並びを離散フーリエ変換する) |
| 逆高速離散フーリエ変換 IFFT | `IFFT`／`\operatorname{ifft}\left(#1\right)` | `\operatorname{ifft}\left([1,2,3,4]\right)` | [数値の並びを離散フーリエ変換する](math-input.md#数値の並びを離散フーリエ変換する) |
| ゼータ関数 | `ζ`／`\operatorname{zeta}\left(#1\right)` | `\operatorname{zeta}\left(2\right)` | [ゼータ関数の値と微分を求める](math-input.md#ゼータ関数の値と微分を求める) |
| ゼータ関数の微分 | `ζ⁽ⁿ⁾`／`\operatorname{zetaderivative}\left(#1,#2\right)` | `\operatorname{zetaderivative}\left(1,2\right)` | [ゼータ関数の値と微分を求める](math-input.md#ゼータ関数の値と微分を求める) |
| 楕円積分 K（完全第1種） | `K`／`\operatorname{elliptick}\left(#1\right)` | `\operatorname{elliptick}\left(0\right)` | [楕円積分の種類と角度を選ぶ](math-input.md#楕円積分の種類と角度を選ぶ) |
| 楕円積分 E（完全第2種） | `E`／`\operatorname{elliptice}\left(#1\right)` | `\operatorname{elliptice}\left(1\right)` | [楕円積分の種類と角度を選ぶ](math-input.md#楕円積分の種類と角度を選ぶ) |
| 楕円積分 F（不完全第1種） | `F`／`\operatorname{ellipticf}\left(#1,#2\right)` | `\operatorname{ellipticf}\left(90,0\right)` | [楕円積分の種類と角度を選ぶ](math-input.md#楕円積分の種類と角度を選ぶ) |
| 楕円積分 Einc（不完全第2種） | `Einc`／`\operatorname{ellipticeinc}\left(#1,#2\right)` | `\operatorname{ellipticeinc}\left(90,1\right)` | [楕円積分の種類と角度を選ぶ](math-input.md#楕円積分の種類と角度を選ぶ) |
| 楕円積分 Pi（完全第3種） | `Pi`／`\operatorname{ellipticpi}\left(#1,#2\right)` | `\operatorname{ellipticpi}\left(0,0\right)` | [楕円積分の種類と角度を選ぶ](math-input.md#楕円積分の種類と角度を選ぶ) |
| 楕円積分 Piinc（不完全第3種） | `Piinc`／`\operatorname{ellipticpiinc}\left(#1,#2,#3\right)` | `\operatorname{ellipticpiinc}\left(0,90,0\right)` | [楕円積分の種類と角度を選ぶ](math-input.md#楕円積分の種類と角度を選ぶ) |
| Airy Ai（Airy関数） | `Airy Ai`／`\operatorname{airyai}\left(#1\right)` | `\operatorname{airyai}\left(1\right)` | [Airy関数の値と傾きを求める](math-input.md#airy関数の値と傾きを求める) |
| Airy Bi（Airy関数） | `Airy Bi`／`\operatorname{airybi}\left(#1\right)` | `\operatorname{airybi}\left(1\right)` | [Airy関数の値と傾きを求める](math-input.md#airy関数の値と傾きを求める) |
| Airy Ai′（Airy関数） | `Airy Ai′`／`\operatorname{airyaiprime}\left(#1\right)` | `\operatorname{airyaiprime}\left(1\right)` | [Airy関数の値と傾きを求める](math-input.md#airy関数の値と傾きを求める) |
| Airy Bi′（Airy関数） | `Airy Bi′`／`\operatorname{airybiprime}\left(#1\right)` | `\operatorname{airybiprime}\left(1\right)` | [Airy関数の値と傾きを求める](math-input.md#airy関数の値と傾きを求める) |
| Lambert W（実数の二枝） | `Lambert W`／`\operatorname{lambertw}\left(#1,#2\right)` | `\operatorname{lambertw}\left(0,1\right)` | [Lambert Wの二つの実数の答えを選ぶ](math-input.md#lambert-wの二つの実数の答えを選ぶ) |
| Bessel J（第1種） | `Bessel J`／`\operatorname{besselj}\left(#1,#2\right)` | `\operatorname{besselj}\left(0,1\right)` | [Bessel関数を数値や作図に使う](math-input.md#bessel関数を数値や作図に使う) |
| Bessel Y（第2種） | `Bessel Y`／`\operatorname{bessely}\left(#1,#2\right)` | `\operatorname{bessely}\left(0,1\right)` | [Bessel関数を数値や作図に使う](math-input.md#bessel関数を数値や作図に使う) |
| Bessel I（変形第1種） | `Bessel I`／`\operatorname{besseli}\left(#1,#2\right)` | `\operatorname{besseli}\left(0,1\right)` | [Bessel関数を数値や作図に使う](math-input.md#bessel関数を数値や作図に使う) |
| Bessel K（変形第2種） | `Bessel K`／`\operatorname{besselk}\left(#1,#2\right)` | `\operatorname{besselk}\left(0,1\right)` | [Bessel関数を数値や作図に使う](math-input.md#bessel関数を数値や作図に使う) |
| Beta関数 | `Beta`／`\operatorname{beta}\left(#1,#2\right)` | `\operatorname{beta}\left(2,3\right)` | [Beta関数を数値や作図に使う](math-input.md#beta関数を数値や作図に使う) |
| Gamma関数 | `Gamma`／`\operatorname{gamma}\left(#1\right)` | `\operatorname{gamma}\left(5\right)` | [Gamma関数と微分した関数を数値や作図に使う](math-input.md#gamma関数と微分した関数を数値や作図に使う) |
| Gammaの微分関数 polygamma | `polygamma`／`\operatorname{polygamma}\left(#1,#2\right)` | `\operatorname{polygamma}\left(1,1\right)` | [Gamma関数と微分した関数を数値や作図に使う](math-input.md#gamma関数と微分した関数を数値や作図に使う) |
| 誤差関数 erf | `erf`／`\operatorname{erf}\left(#1\right)` | `\operatorname{erf}\left(1\right)` | [誤差関数の小さい値を数値や関数に使う](math-input.md#誤差関数の小さい値を数値や関数に使う) |
| 相補誤差関数 erfc | `erfc`／`\operatorname{erfc}\left(#1\right)` | `\operatorname{erfc}\left(1\right)` | [誤差関数の小さい値を数値や関数に使う](math-input.md#誤差関数の小さい値を数値や関数に使う) |
| Legendre多項式 | `legendre`／`\operatorname{legendre}\left(#1,#2\right)` | `\operatorname{legendre}\left(4,0\right)` | [Legendre多項式を数値や関数に使う](math-input.md#legendre多項式を数値や関数に使う) |
| 逆余接 | `arccot`／`\operatorname{arccot}\left(#1\right)` | `\operatorname{arccot}\left(-1\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 逆正割 | `arcsec`／`\operatorname{arcsec}\left(#1\right)` | `\operatorname{arcsec}\left(2\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 逆余割 | `arccsc`／`\operatorname{arccsc}\left(#1\right)` | `\operatorname{arccsc}\left(2\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 2成分から向きの角度 | `atan2(y,x)`／`\operatorname{arctan2}\left(#1,#2\right)` | `\operatorname{arctan2}\left(1,-1\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 双曲線余接 | `coth`／`\operatorname{coth}\left(#1\right)` | `\operatorname{coth}\left(\ln(3)\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 双曲線正割 | `sech`／`\operatorname{sech}\left(#1\right)` | `\operatorname{sech}\left(0\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 双曲線余割 | `csch`／`\operatorname{csch}\left(#1\right)` | `\operatorname{csch}\left(\ln(3)\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 逆双曲線余接 | `acoth`／`\operatorname{arcoth}\left(#1\right)` | `\operatorname{arcoth}\left(2\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 逆双曲線正割 | `asech`／`\operatorname{arsech}\left(#1\right)` | `\operatorname{arsech}\left(1\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 逆双曲線余割 | `acsch`／`\operatorname{arcsch}\left(#1\right)` | `\operatorname{arcsch}\left(1\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 正弦 | `sin`／`\sin\left(#1\right)` | `\sin\left(30\right)` | [入力方式と単位](math-input.md#入力方式と単位) |
| 余弦 | `cos`／`\cos\left(#1\right)` | `\cos\left(60\right)` | [入力方式と単位](math-input.md#入力方式と単位) |
| 正接 | `tan`／`\tan\left(#1\right)` | `\tan\left(45\right)` | [入力方式と単位](math-input.md#入力方式と単位) |
| 逆正弦 | `arcsin`／`\arcsin\left(#1\right)` | `\arcsin\left(0.5\right)` | [入力方式と単位](math-input.md#入力方式と単位) |
| 自然対数 | `ln`／`\ln\left(#1\right)` | `\ln\left(\exponentialE\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 常用対数 | `log₁₀`／`\log_{10}\left(#1\right)` | `\log_{10}\left(100\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 底を指定する対数 | `logₐ`／`\log_{#2}\left(#1\right)` | `\log_{2}\left(8\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 双曲線正弦 | `sinh`／`\sinh\left(#1\right)` | `\sinh\left(0\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 逆余弦 | `arccos`／`\operatorname{arccos}\left(#1\right)` | `\operatorname{arccos}\left(0.5\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 逆正接 | `arctan`／`\operatorname{arctan}\left(#1\right)` | `\operatorname{arctan}\left(1\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 余接 | `cot`／`\operatorname{cot}\left(#1\right)` | `\operatorname{cot}\left(45\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 正割 | `sec`／`\operatorname{sec}\left(#1\right)` | `\operatorname{sec}\left(60\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 余割 | `csc`／`\operatorname{csc}\left(#1\right)` | `\operatorname{csc}\left(30\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 双曲線余弦 | `cosh`／`\operatorname{cosh}\left(#1\right)` | `\operatorname{cosh}\left(0\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 双曲線正接 | `tanh`／`\operatorname{tanh}\left(#1\right)` | `\operatorname{tanh}\left(\ln(3)\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 逆双曲線正弦 | `asinh`／`\operatorname{arsinh}\left(#1\right)` | `\operatorname{arsinh}\left(0\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 逆双曲線余弦 | `acosh`／`\operatorname{arcosh}\left(#1\right)` | `\operatorname{arcosh}\left(1\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 逆双曲線正接 | `atanh`／`\operatorname{artanh}\left(#1\right)` | `\operatorname{artanh}\left(0.8\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 指数関数 | `exp`／`\operatorname{exp}\left(#1\right)` | `\operatorname{exp}\left(1\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 2を底とする対数 | `log₂`／`\log_{2}\left(#1\right)` | `\log_{2}\left(8\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |

## 微積分

| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |
|---|---|---|---|
| 上極限 | `limsup`／`\limsup_{#2\to #3}{#1}` | `\limsup_{x\to 0}{\sin(1/x)}` | [上極限・下極限](math-input.md#上極限下極限) |
| 下極限 | `liminf`／`\liminf_{#2\to #3}{#1}` | `\liminf_{x\to 0}{\sin(1/x)}` | [上極限・下極限](math-input.md#上極限下極限) |
| 定積分 | `∫`／`\int_{#2}^{#3}{#1}\,\mathrm{d}x` | `\int_{0}^{3}{x^2}\,\mathrm{d}x` | [端点や途中に注意が必要な積分](math-input.md#端点や途中に注意が必要な積分) |
| 極限 | `lim`／`\lim_{x\to #2}{#1}` | `\lim_{x\to 2}{(x^2-4)/(x-2)}` | [左右から近づける極限](math-input.md#左右から近づける極限) |
| 指定位置の勾配 | `∇f(p)`／`\operatorname{gradientat}\left(#1,#2,#3\right)` | `\operatorname{gradientat}\left(x^2*y,[x,y],[2,3]\right)` | [指定した位置の勾配や行列を座標に使う](math-input.md#指定した位置の勾配や行列を座標に使う) |
| 指定位置の発散 | `∇·F(p)`／`\operatorname{divergenceat}\left(#1,#2,#3\right)` | `\operatorname{divergenceat}\left([x*y,x^2],[x,y],[2,3]\right)` | [指定した位置の勾配や行列を座標に使う](math-input.md#指定した位置の勾配や行列を座標に使う) |
| 指定位置の回転 | `∇×F(p)`／`\operatorname{curlat}\left(#1,#2,#3\right)` | `\operatorname{curlat}\left([-y,x,0],[x,y,z],[2,3,4]\right)` | [指定した位置の勾配や行列を座標に使う](math-input.md#指定した位置の勾配や行列を座標に使う) |
| 指定位置のラプラシアン | `∇²f(p)`／`\operatorname{laplacianat}\left(#1,#2,#3\right)` | `\operatorname{laplacianat}\left(x^2*y,[x,y],[2,3]\right)` | [指定した位置の勾配や行列を座標に使う](math-input.md#指定した位置の勾配や行列を座標に使う) |
| 指定位置のヤコビ行列 | `J(p)`／`\operatorname{jacobianat}\left(#1,#2,#3\right)` | `\operatorname{jacobianat}\left([x*y,x^2],[x,y],[2,3]\right)` | [指定した位置の勾配や行列を座標に使う](math-input.md#指定した位置の勾配や行列を座標に使う) |
| 指定位置のヘッセ行列 | `H(p)`／`\operatorname{hessianat}\left(#1,#2,#3\right)` | `\operatorname{hessianat}\left(x^2*y,[x,y],[2,3]\right)` | [指定した位置の勾配や行列を座標に使う](math-input.md#指定した位置の勾配や行列を座標に使う) |
| 線積分 | `∫C f ds`／`\operatorname{lineintegral}\left(#1,#2,#3,#4,#5,#6\right)` | `\operatorname{lineintegral}\left(x,[x,y],[3*t,4*t],t,0,1\right)` | [曲線に沿って量を積分する](math-input.md#曲線に沿って量を積分する) |
| 循環（仕事の線積分） | `∮C F·dr`／`\operatorname{circulation}\left(#1,#2,#3,#4,#5,#6\right)` | `\operatorname{circulation}\left([2*x,2*y],[x,y],[t,t^2],t,0,1\right)` | [曲線に沿って量を積分する](math-input.md#曲線に沿って量を積分する) |
| 面積分 | `∬S f dS`／`\operatorname{surfaceintegral}\left(#1,#2,#3,#4,#5,#6\right)` | `\operatorname{surfaceintegral}\left(1,[x,y,z],[2*u,3*v,0],[u,v],[0,0],[1,1]\right)` | [面や体積に沿って量を積分する](math-input.md#面や体積に沿って量を積分する) |
| 流束積分 | `∬S F·dS`／`\operatorname{fluxintegral}\left(#1,#2,#3,#4,#5,#6\right)` | `\operatorname{fluxintegral}\left([0,0,4],[x,y,z],[2*u,3*v,0],[u,v],[0,0],[1,1]\right)` | [面や体積に沿って量を積分する](math-input.md#面や体積に沿って量を積分する) |
| 体積分 | `∭V f dV`／`\operatorname{volumeintegral}\left(#1,#2,#3,#4,#5,#6\right)` | `\operatorname{volumeintegral}\left(1,[x,y,z],[-2*u,3*v,4*w],[u,v,w],[0,0,0],[1,1,1]\right)` | [面や体積に沿って量を積分する](math-input.md#面や体積に沿って量を積分する) |
| 指定位置の微分 | `f⁽ⁿ⁾(a)`／`\operatorname{derivativeat}\left(#1,#2,#3,#4\right)` | `\operatorname{derivativeat}\left(t^3,t,2,3\right)` | [指定した位置で微分する](math-input.md#指定した位置で微分する) |
| 勾配 | `∇f`／`\operatorname{gradient}\left(#1,#2\right)` | `\operatorname{gradient}\left(X^2+3*Y^2+Z^3,[X,Y,Z]\right)` | [直交座標のベクトル解析](math-input.md#直交座標のベクトル解析) |
| 発散 | `∇·F`／`\operatorname{divergence}\left(#1,#2\right)` | `\operatorname{divergence}\left([X^2,X*Y,Z^3],[X,Y,Z]\right)` | [直交座標のベクトル解析](math-input.md#直交座標のベクトル解析) |
| 回転 | `∇×F`／`\operatorname{curl}\left(#1,#2\right)` | `\operatorname{curl}\left([-Y,X,0],[X,Y,Z]\right)` | [直交座標のベクトル解析](math-input.md#直交座標のベクトル解析) |
| ラプラシアン | `∇²f`／`\operatorname{laplacian}\left(#1,#2\right)` | `\operatorname{laplacian}\left(X^2*Y+Z^3,[X,Y,Z]\right)` | [直交座標のベクトル解析](math-input.md#直交座標のベクトル解析) |
| ヤコビ行列 | `J`／`\operatorname{jacobian}\left(#1,#2\right)` | `\operatorname{jacobian}\left([X^2*Y,Y*Z],[X,Y,Z]\right)` | [直交座標のベクトル解析](math-input.md#直交座標のベクトル解析) |
| ヘッセ行列 | `H`／`\operatorname{hessian}\left(#1,#2\right)` | `\operatorname{hessian}\left(T^3,[T]\right)` | [直交座標のベクトル解析](math-input.md#直交座標のベクトル解析) |
| 微分 | `d/dx`／`\frac{\mathrm{d}}{\mathrm{d}#2}{#1}` | `\frac{\mathrm{d}}{\mathrm{d}T}{(T+2)^3}` | [導関数で曲線と曲面を作る](math-input.md#導関数で曲線と曲面を作る) |
| 偏微分 | `∂/∂x`／`\frac{\partial}{\partial #2}{#1}` | `\frac{\partial}{\partial X}{X^2*Y+Z}` | [導関数で曲線と曲面を作る](math-input.md#導関数で曲線と曲面を作る) |
| 指定位置の全微分 | `df(p)`／`\operatorname{totaldifferentialat}\left(\operatorname{Function}\left(#1,#2,#3\right),#4,#5\right)` | `\operatorname{totaldifferentialat}\left(\operatorname{Function}\left(x^2+y^2,x,y\right),[1,2],[1/10,1/5]\right)` | [指定した位置の勾配や行列を座標に使う](math-input.md#指定した位置の勾配や行列を座標に使う) |
| 閉曲線の線積分 | `∮ f ds`／`\oint\left(#1,#2,#3,#4,#5,#6\right)` | `\oint\left(1,[x,y],[\cos(t),\sin(t)],t,0,360\right)` | [閉じた曲線・曲面で積分する](math-input.md#閉じた曲線曲面で積分する) |
| 閉曲線の循環 | `∮ F·dr`／`\oint\left(#1,#2,#3,#4,#5,#6\right)` | `\oint\left([-y,x],[x,y],[\cos(t),\sin(t)],t,0,360\right)` | [閉じた曲線・曲面で積分する](math-input.md#閉じた曲線曲面で積分する) |
| 閉曲面の面積分 | `∯ f dS`／`\oiint\left(#1,#2,#3,#4,#5,#6\right)` | `\oiint\left(1,[x,y,z],[\sin(u)*\cos(v),\sin(u)*\sin(v),\cos(u)],[u,v],[0,0],[180,360]\right)` | [閉じた曲線・曲面で積分する](math-input.md#閉じた曲線曲面で積分する) |
| 閉曲面の流束積分 | `∯ F·dS`／`\oiint\left(#1,#2,#3,#4,#5,#6\right)` | `\oiint\left([x,y,z],[x,y,z],[\sin(u)*\cos(v),\sin(u)*\sin(v),\cos(u)],[u,v],[0,0],[180,360]\right)` | [閉じた曲線・曲面で積分する](math-input.md#閉じた曲線曲面で積分する) |
| 不定積分（原始関数） | `∫f dx`／`\int{#1}\,\mathrm{d}#2` | `\int{t^2}\,\mathrm{d}t` | [不定積分（原始関数）](math-input.md#不定積分原始関数) |

## 線形代数

| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |
|---|---|---|---|
| 特異値分解の左の基底 | `U`／`\operatorname{svdu}\left(#1\right)` | `\operatorname{svdu}\left([[3,0],[4,0]]\right)` | [特異値分解の3つの行列を使う](math-input.md#特異値分解の3つの行列を使う) |
| 特異値分解の対角行列 | `Σ`／`\operatorname{svds}\left(#1\right)` | `\operatorname{svds}\left([[3,0],[4,0]]\right)` | [特異値分解の3つの行列を使う](math-input.md#特異値分解の3つの行列を使う) |
| 特異値分解の右の基底 | `V`／`\operatorname{svdv}\left(#1\right)` | `\operatorname{svdv}\left([[3,0],[4,0]]\right)` | [特異値分解の3つの行列を使う](math-input.md#特異値分解の3つの行列を使う) |
| 固有値を指定した基底 | `ker(A−λI)`／`\operatorname{eigenspace}\left(#1,#2\right)` | `\operatorname{eigenspace}\left([[2,1],[0,2]],2\right)` | [固有値を指定して基底を求める](math-input.md#固有値を指定して基底を求める) |
| テンソル積 | `A⊗B`／`\operatorname{tensorproduct}\left(#1,#2\right)` | `\operatorname{tensorproduct}\left([1,2],[3,4]\right)` | [テンソルの軸と成分を指定する](math-input.md#テンソルの軸と成分を指定する) |
| 成分ごとの積 | `A⊙B`／`\operatorname{hadamardproduct}\left(#1,#2\right)` | `\operatorname{hadamardproduct}\left([[1,2],[3,4]],[[2,3],[4,5]]\right)` | [テンソルの軸と成分を指定する](math-input.md#テンソルの軸と成分を指定する) |
| 軸を指定して縮約 | `ΣTᵢᵢ`／`\operatorname{tensorcontract}\left(#1,#2,#3\right)` | `\operatorname{tensorcontract}\left([[1,2],[3,4]],1,2\right)` | [テンソルの軸と成分を指定する](math-input.md#テンソルの軸と成分を指定する) |
| 軸を並べ替える | `Tσ`／`\operatorname{tensorpermute}\left(#1,#2\right)` | `\operatorname{tensorpermute}\left([[1,2,3],[4,5,6]],[2,1]\right)` | [テンソルの軸と成分を指定する](math-input.md#テンソルの軸と成分を指定する) |
| 各軸の成分数 | `shape(T)`／`\operatorname{tensorshape}\left(#1\right)` | `\operatorname{tensorshape}\left([[1,2,3],[4,5,6]]\right)` | [テンソルの軸と成分を指定する](math-input.md#テンソルの軸と成分を指定する) |
| テンソルの成分を選ぶ | `Tᵢⱼₖ`／`\operatorname{tensorelement}\left(#1,#2\right)` | `\operatorname{tensorelement}\left([[[1,2],[3,4]],[[5,6],[7,8]]],[2,1,2]\right)` | [テンソルの軸と成分を指定する](math-input.md#テンソルの軸と成分を指定する) |
| クロネッカーのデルタ | `δᵢⱼ`／`\operatorname{kroneckerdelta}\left(#1,#2\right)` | `\operatorname{kroneckerdelta}\left(2,2\right)` | [テンソルの軸と成分を指定する](math-input.md#テンソルの軸と成分を指定する) |
| レヴィ＝チヴィタ記号 | `εᵢⱼₖ`／`\operatorname{levicivita}\left(#1\right)` | `\operatorname{levicivita}\left([2,3,1]\right)` | [テンソルの軸と成分を指定する](math-input.md#テンソルの軸と成分を指定する) |
| 特異値 | `σ`／`\operatorname{singularvalues}\left(#1\right)` | `\operatorname{singularvalues}\left([[3,0],[0,4]]\right)` | [特異値を選ぶ](math-input.md#特異値を選ぶ) |
| 固有値 | `λ`／`\operatorname{eigenvalues}\left(#1\right)` | `\operatorname{eigenvalues}\left([[2,1],[1,2]]\right)` | [固有値を選ぶ](math-input.md#固有値を選ぶ) |
| 行列を簡約する | `rref`／`\operatorname{rowreduce}\left(#1\right)` | `\operatorname{rowreduce}\left([[1,2,3],[2,4,6]]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| QR分解の直交行列Q | `Q`／`\operatorname{qrq}\left(#1\right)` | `\operatorname{qrq}\left([[3,0],[4,5]]\right)` | [行列をQR分解する](math-input.md#行列をqr分解する) |
| QR分解の上三角行列R | `R`／`\operatorname{qrr}\left(#1\right)` | `\operatorname{qrr}\left([[3,0],[4,5]]\right)` | [行列をQR分解する](math-input.md#行列をqr分解する) |
| LU分解の行交換P | `P`／`\operatorname{lup}\left(#1\right)` | `\operatorname{lup}\left([[0,2],[3,4]]\right)` | [行交換を含めてLU分解する](math-input.md#行交換を含めてlu分解する) |
| LU分解の下三角行列L | `L`／`\operatorname{lul}\left(#1\right)` | `\operatorname{lul}\left([[1,1,1],[2,2,3],[4,5,6]]\right)` | [行交換を含めてLU分解する](math-input.md#行交換を含めてlu分解する) |
| LU分解の上三角行列U | `U`／`\operatorname{luu}\left(#1\right)` | `\operatorname{luu}\left([[1,1,1],[2,2,3],[4,5,6]]\right)` | [行交換を含めてLU分解する](math-input.md#行交換を含めてlu分解する) |
| 特性多項式の係数 | `det(tI−A)`／`\operatorname{characteristiccoefficients}\left(#1\right)` | `\operatorname{characteristiccoefficients}\left([[1,2],[3,4]]\right)` | [特性多項式の係数を取り出す](math-input.md#特性多項式の係数を取り出す) |
| 零空間の基底 | `ker A`／`\operatorname{nullspace}\left(#1\right)` | `\operatorname{nullspace}\left([[1,2,3],[2,4,6]]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 列空間の基底 | `col A`／`\operatorname{columnspace}\left(#1\right)` | `\operatorname{columnspace}\left([[1,2,3],[2,4,6]]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 行空間の基底 | `row A`／`\operatorname{rowspace}\left(#1\right)` | `\operatorname{rowspace}\left([[1,2,3],[2,4,6]]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 連立一次式の一意な解 | `Ax=b`／`\operatorname{linearsolve}\left(#1,#2\right)` | `\operatorname{linearsolve}\left([[2,1],[1,-1]],[5,1]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 連立一次式の全ての解 | `x₀+Σtᵢvᵢ`／`\operatorname{linearsolutionspace}\left(#1,#2\right)` | `\operatorname{linearsolutionspace}\left([[1,2,3],[2,4,6]],[4,8]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 行列から成分を選ぶ | `Aᵢⱼ`／`\operatorname{component}\left(#1,#2,#3\right)` | `\operatorname{component}\left(\begin{pmatrix}1&2\\3&4\end{pmatrix},2,1\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 2×2行列 | `[A]`／`\begin{pmatrix}#1&#2\\#3&#4\end{pmatrix}` | `\begin{pmatrix}1&2\\3&4\end{pmatrix}` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 行列式 | `det`／`\det\left(#1\right)` | `\det\left([[1,2],[3,4]]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 転置 | `Aᵀ`／`\operatorname{transpose}\left(#1\right)` | `\operatorname{transpose}\left([[1,2,3],[4,5,6]]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 随伴（共役転置） | `Aᴴ`／`\operatorname{conjugatetranspose}\left(#1\right)` | `\operatorname{conjugatetranspose}\left([[1,2],[3,4]]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 逆行列 | `A⁻¹`／`\operatorname{inverse}\left(#1\right)` | `\operatorname{inverse}\left([[1,0],[0,2]]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| トレース | `tr A`／`\operatorname{trace}\left(#1\right)` | `\operatorname{trace}\left([[1,2],[3,4]]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 階数 | `rank A`／`\operatorname{rank}\left(#1\right)` | `\operatorname{rank}\left([[1,2],[2,4]]\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 内積 | `a·b`／`#1\cdot #2` | `[1,2,3]\cdot [4,5,6]` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 外積 | `a×b`／`#1\times #2` | `[1,0,0]\times [0,1,0]` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| ノルム | `‖v‖`／`\operatorname{norm}\left(#1\right)` | `\operatorname{norm}\left([3,4]\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| ベクトルの正射影 | `proj`／`\operatorname{projection}\left(#1,#2\right)` | `\operatorname{projection}\left([1,2],[3,4]\right)` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 単位行列 | `I`／`\operatorname{identitymatrix}\left(#1\right)` | `\operatorname{identitymatrix}\left(3\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |
| 零行列 | `0`／`\operatorname{zeromatrix}\left(#1,#2\right)` | `\operatorname{zeromatrix}\left(2,3\right)` | [連立一次式と行列から値を求める](math-input.md#連立一次式と行列から値を求める) |

## 複素数

| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |
|---|---|---|---|
| 偏角 | `arg`／`\operatorname{arg}\left(#1\right)` | `\operatorname{arg}\left(\operatorname{complex}\left(1,1\right)\right)` | [複素数の関数と主値](math-input.md#複素数の関数と主値) |
| 極形式の複素数 | `cis`／`\operatorname{cis}\left(#1\right)` | `\operatorname{cis}\left(90\right)` | [複素数の関数と主値](math-input.md#複素数の関数と主値) |
| 実部 | `Re`／`\operatorname{Re}\left(#1\right)` | `\operatorname{Re}\left(\operatorname{complex}\left(3,4\right)\right)` | [複素数の関数と主値](math-input.md#複素数の関数と主値) |
| 虚部 | `Im`／`\operatorname{Im}\left(#1\right)` | `\operatorname{Im}\left(\operatorname{complex}\left(3,4\right)\right)` | [複素数の関数と主値](math-input.md#複素数の関数と主値) |
| 共役 | `z̄`／`\overline{#1}` | `\overline{\operatorname{complex}\left(3,4\right)}` | [複素数の関数と主値](math-input.md#複素数の関数と主値) |

## 数列・総和・総積

| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |
|---|---|---|---|
| フーリエ級数 | `fourierseries`／`\operatorname{fourierseries}\left(#1,#2,#3,#4,#5\right)` | `\operatorname{fourierseries}\left(x,x,-\pi,\pi,2\right)` | [フーリエ級数の係数と部分和を使う](math-input.md#フーリエ級数の係数と部分和を使う) |
| フーリエ部分和の値 | `fourierat`／`\operatorname{fourierat}\left(#1,#2\right)` | `\operatorname{fourierat}\left(\operatorname{fourierseries}\left(x,x,-\pi,\pi,2\right),\pi/2\right)` | [フーリエ級数の係数と部分和を使う](math-input.md#フーリエ級数の係数と部分和を使う) |
| フーリエ余弦係数 | `fouriercos`／`\operatorname{fouriercos}\left(#1,#2\right)` | `\operatorname{fouriercos}\left(\operatorname{fourierseries}\left(x,x,-\pi,\pi,2\right),1\right)` | [フーリエ級数の係数と部分和を使う](math-input.md#フーリエ級数の係数と部分和を使う) |
| フーリエ正弦係数 | `fouriersin`／`\operatorname{fouriersin}\left(#1,#2\right)` | `\operatorname{fouriersin}\left(\operatorname{fourierseries}\left(x,x,-\pi,\pi,2\right),2\right)` | [フーリエ級数の係数と部分和を使う](math-input.md#フーリエ級数の係数と部分和を使う) |
| 展開の係数を選ぶ | `seriescoefficient`／`\operatorname{seriescoefficient}\left(#1,#2\right)` | `\operatorname{seriescoefficient}\left(\operatorname{taylor}\left(x^3,x,2,4\right),1\right)` | [展開の係数を座標に使う](math-input.md#展開の係数を座標に使う) |
| Taylor展開 | `taylor`／`\operatorname{taylor}\left(#1,#2,#3,#4\right)` | `\operatorname{taylor}\left(x^3,x,1,3\right)` | [Taylor展開・Maclaurin展開](math-input.md#taylor展開maclaurin展開) |
| Maclaurin展開 | `maclaurin`／`\operatorname{maclaurin}\left(#1,#2,#3\right)` | `\operatorname{maclaurin}\left(1/(1-x),x,4\right)` | [Taylor展開・Maclaurin展開](math-input.md#taylor展開maclaurin展開) |
| 数列の指定項 | `sequencevalue`／`\operatorname{sequencevalue}\left(#1,#2,#3\right)` | `\operatorname{sequencevalue}\left(n^2,n,5\right)` | [数列の値・差分・漸化式](math-input.md#数列の値差分漸化式) |
| 指定した項での差分 | `differenceat`／`\operatorname{differenceat}\left(#1,#2,#3,#4,#5\right)` | `\operatorname{differenceat}\left(n^2,n,4,1,2\right)` | [数列の値・差分・漸化式](math-input.md#数列の値差分漸化式) |
| 漸化式の指定項 | `recurrencevalue`／`\operatorname{recurrencevalue}\left(#1,#2,#3,#4,#5\right)` | `\operatorname{recurrencevalue}\left(a+b,[n,a,b],0,[0,1],10\right)` | [数列の値・差分・漸化式](math-input.md#数列の値差分漸化式) |
| 総和 | `Σ`／`\sum_{i=1}^{#2}{#1}` | `\sum_{i=1}^{3}{i^2}` | [一定の間隔で足す・掛ける](math-input.md#一定の間隔で足す掛ける) |
| 総積 | `∏`／`\prod_{i=1}^{#2}{#1}` | `\prod_{i=1}^{4}{i}` | [一定の間隔で足す・掛ける](math-input.md#一定の間隔で足す掛ける) |
| 無限級数の和 | `Σ_{k=1}^∞`／`\sum_{k=1}^{\infty}{#1}` | `\sum_{k=1}^{\infty}{1/k^2}` | [無限に続く和・積](math-input.md#無限に続く和積) |
| 無限級数の積 | `Π_{k=1}^∞`／`\prod_{k=1}^{\infty}{#1}` | `\prod_{k=1}^{\infty}{4*k^2/(4*k^2-1)}` | [無限に続く和・積](math-input.md#無限に続く和積) |

## 統計

| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |
|---|---|---|---|
| 事象の確率 | `probability`／`\operatorname{probability}\left(#1,#2,#3\right)` | `\operatorname{probability}\left(x>0,[x],\operatorname{normaldistribution}(0,1)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 条件を満たすときの確率 | `givenprobability`／`\operatorname{givenprobability}\left(#1,#2,#3,#4\right)` | `\operatorname{givenprobability}\left(x>2,x>1,[x],\operatorname{uniformdistribution}(0,4)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 確率変数の期待値 | `randomexpectation`／`\operatorname{randomexpectation}\left(#1,#2,#3\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{normaldistribution}(3,2)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 確率変数の分散 | `randomvariance`／`\operatorname{randomvariance}\left(#1,#2,#3\right)` | `\operatorname{randomvariance}\left(x,[x],\operatorname{normaldistribution}(3,2)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 確率変数の共分散 | `randomcovariance`／`\operatorname{randomcovariance}\left(#1,#2,#3,#4\right)` | `\operatorname{randomcovariance}\left(x,2*x,[x],\operatorname{normaldistribution}(1,3)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 確率変数の相関 | `randomcorrelation`／`\operatorname{randomcorrelation}\left(#1,#2,#3,#4\right)` | `\operatorname{randomcorrelation}\left(x,-2*x,[x],\operatorname{uniformdistribution}(-1,1)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 事象の独立 | `independentevents`／`\operatorname{independentevents}\left(#1,#2,#3,#4\right)` | `\operatorname{independentevents}\left(x>1,x<3,[x],\operatorname{uniformdistribution}(0,4)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 確率変数の独立 | `independentvariables`／`\operatorname{independentvariables}\left(#1,#2,#3,#4\right)` | `\operatorname{independentvariables}\left(x,y,[x,y],\operatorname{independentdistributions}([\operatorname{normaldistribution}(0,1),\operatorname{normaldistribution}(0,1)])\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| χ²分布の密度 | `chisquarepdf`／`\operatorname{chisquarepdf}\left(#1,#2\right)` | `\operatorname{chisquarepdf}\left(2,2\right)` | [χ²・t・F分布の確率と位置を求める](math-input.md#χ2tf分布の確率と位置を求める) |
| χ²分布の累積確率 | `chisquarecdf`／`\operatorname{chisquarecdf}\left(#1,#2\right)` | `\operatorname{chisquarecdf}\left(2,2\right)` | [χ²・t・F分布の確率と位置を求める](math-input.md#χ2tf分布の確率と位置を求める) |
| χ²分布の分位点 | `chisquarequantile`／`\operatorname{chisquarequantile}\left(#1,#2\right)` | `\operatorname{chisquarequantile}\left(2,1/2\right)` | [χ²・t・F分布の確率と位置を求める](math-input.md#χ2tf分布の確率と位置を求める) |
| t分布の密度 | `tpdf`／`\operatorname{tpdf}\left(#1,#2\right)` | `\operatorname{tpdf}\left(1,0\right)` | [χ²・t・F分布の確率と位置を求める](math-input.md#χ2tf分布の確率と位置を求める) |
| t分布の累積確率 | `tcdf`／`\operatorname{tcdf}\left(#1,#2\right)` | `\operatorname{tcdf}\left(1,1\right)` | [χ²・t・F分布の確率と位置を求める](math-input.md#χ2tf分布の確率と位置を求める) |
| t分布の分位点 | `tquantile`／`\operatorname{tquantile}\left(#1,#2\right)` | `\operatorname{tquantile}\left(1,3/4\right)` | [χ²・t・F分布の確率と位置を求める](math-input.md#χ2tf分布の確率と位置を求める) |
| F分布の密度 | `fpdf`／`\operatorname{fpdf}\left(#1,#2,#3\right)` | `\operatorname{fpdf}\left(2,2,1\right)` | [χ²・t・F分布の確率と位置を求める](math-input.md#χ2tf分布の確率と位置を求める) |
| F分布の累積確率 | `fcdf`／`\operatorname{fcdf}\left(#1,#2,#3\right)` | `\operatorname{fcdf}\left(2,2,1\right)` | [χ²・t・F分布の確率と位置を求める](math-input.md#χ2tf分布の確率と位置を求める) |
| F分布の分位点 | `fquantile`／`\operatorname{fquantile}\left(#1,#2,#3\right)` | `\operatorname{fquantile}\left(2,2,3/4\right)` | [χ²・t・F分布の確率と位置を求める](math-input.md#χ2tf分布の確率と位置を求める) |
| Gamma分布の密度 | `gammapdf`／`\operatorname{gammapdf}\left(#1,#2,#3\right)` | `\operatorname{gammapdf}\left(2,1,1\right)` | [Gamma・Beta分布の確率と位置を求める](math-input.md#gammabeta分布の確率と位置を求める) |
| Gamma分布の累積確率 | `gammacdf`／`\operatorname{gammacdf}\left(#1,#2,#3\right)` | `\operatorname{gammacdf}\left(2,1,1\right)` | [Gamma・Beta分布の確率と位置を求める](math-input.md#gammabeta分布の確率と位置を求める) |
| Gamma分布の分位点 | `gammaquantile`／`\operatorname{gammaquantile}\left(#1,#2,#3\right)` | `\operatorname{gammaquantile}\left(1,2,0.5\right)` | [Gamma・Beta分布の確率と位置を求める](math-input.md#gammabeta分布の確率と位置を求める) |
| Beta分布の密度 | `betapdf`／`\operatorname{betapdf}\left(#1,#2,#3\right)` | `\operatorname{betapdf}\left(2,2,0.5\right)` | [Gamma・Beta分布の確率と位置を求める](math-input.md#gammabeta分布の確率と位置を求める) |
| Beta分布の累積確率 | `betacdf`／`\operatorname{betacdf}\left(#1,#2,#3\right)` | `\operatorname{betacdf}\left(2,3,0.5\right)` | [Gamma・Beta分布の確率と位置を求める](math-input.md#gammabeta分布の確率と位置を求める) |
| Beta分布の分位点 | `betaquantile`／`\operatorname{betaquantile}\left(#1,#2,#3\right)` | `\operatorname{betaquantile}\left(2,2,0.5\right)` | [Gamma・Beta分布の確率と位置を求める](math-input.md#gammabeta分布の確率と位置を求める) |
| 正規分布の密度 | `normalpdf`／`\operatorname{normalpdf}\left(#1,#2,#3\right)` | `\operatorname{normalpdf}\left(0,1,0\right)` | [正規分布の確率と位置を求める](math-input.md#正規分布の確率と位置を求める) |
| 正規分布の累積確率 | `normalcdf`／`\operatorname{normalcdf}\left(#1,#2,#3\right)` | `\operatorname{normalcdf}\left(0,1,0\right)` | [正規分布の確率と位置を求める](math-input.md#正規分布の確率と位置を求める) |
| 正規分布の分位点 | `normalquantile`／`\operatorname{normalquantile}\left(#1,#2,#3\right)` | `\operatorname{normalquantile}\left(3,2,1/2\right)` | [正規分布の確率と位置を求める](math-input.md#正規分布の確率と位置を求める) |
| 確率表の期待値 | `expectation`／`\operatorname{expectation}\left(#1,#2\right)` | `\operatorname{expectation}\left([0,4],[1/4,3/4]\right)` | [確率表の期待値・分散と条件付き確率を求める](math-input.md#確率表の期待値分散と条件付き確率を求める) |
| 確率表の分散 | `probabilityvariance`／`\operatorname{probabilityvariance}\left(#1,#2\right)` | `\operatorname{probabilityvariance}\left([0,4],[1/4,3/4]\right)` | [確率表の期待値・分散と条件付き確率を求める](math-input.md#確率表の期待値分散と条件付き確率を求める) |
| 条件付き確率 | `conditionalprobability`／`\operatorname{conditionalprobability}\left(#1,#2\right)` | `\operatorname{conditionalprobability}\left(1/4,1/2\right)` | [確率表の期待値・分散と条件付き確率を求める](math-input.md#確率表の期待値分散と条件付き確率を求める) |
| 一様分布の密度 | `uniformpdf`／`\operatorname{uniformpdf}\left(#1,#2,#3\right)` | `\operatorname{uniformpdf}\left(2,6,3\right)` | [一様分布・指数分布・ポアソン分布を使う](math-input.md#一様分布指数分布ポアソン分布を使う) |
| 一様分布の累積確率 | `uniformcdf`／`\operatorname{uniformcdf}\left(#1,#2,#3\right)` | `\operatorname{uniformcdf}\left(2,6,3\right)` | [一様分布・指数分布・ポアソン分布を使う](math-input.md#一様分布指数分布ポアソン分布を使う) |
| 一様分布の分位点 | `uniformquantile`／`\operatorname{uniformquantile}\left(#1,#2,#3\right)` | `\operatorname{uniformquantile}\left(2,6,1/4\right)` | [一様分布・指数分布・ポアソン分布を使う](math-input.md#一様分布指数分布ポアソン分布を使う) |
| 指数分布の密度 | `exponentialpdf`／`\operatorname{exponentialpdf}\left(#1,#2\right)` | `\operatorname{exponentialpdf}\left(2,1\right)` | [一様分布・指数分布・ポアソン分布を使う](math-input.md#一様分布指数分布ポアソン分布を使う) |
| 指数分布の累積確率 | `exponentialcdf`／`\operatorname{exponentialcdf}\left(#1,#2\right)` | `\operatorname{exponentialcdf}\left(2,1\right)` | [一様分布・指数分布・ポアソン分布を使う](math-input.md#一様分布指数分布ポアソン分布を使う) |
| 指数分布の分位点 | `exponentialquantile`／`\operatorname{exponentialquantile}\left(#1,#2\right)` | `\operatorname{exponentialquantile}\left(2,3/4\right)` | [一様分布・指数分布・ポアソン分布を使う](math-input.md#一様分布指数分布ポアソン分布を使う) |
| 二項分布の分位点 | `binomialquantile`／`\operatorname{binomialquantile}\left(#1,#2,#3\right)` | `\operatorname{binomialquantile}\left(4,1/2,11/16\right)` | [指定した確率になる最小の回数を求める](math-input.md#指定した確率になる最小の回数を求める) |
| ポアソン分布の分位点 | `poissonquantile`／`\operatorname{poissonquantile}\left(#1,#2\right)` | `\operatorname{poissonquantile}\left(2,3/4\right)` | [指定した確率になる最小の回数を求める](math-input.md#指定した確率になる最小の回数を求める) |
| ポアソン分布の確率 | `poissonpmf`／`\operatorname{poissonpmf}\left(#1,#2\right)` | `\operatorname{poissonpmf}\left(2,3\right)` | [一様分布・指数分布・ポアソン分布を使う](math-input.md#一様分布指数分布ポアソン分布を使う) |
| ポアソン分布の累積確率 | `poissoncdf`／`\operatorname{poissoncdf}\left(#1,#2\right)` | `\operatorname{poissoncdf}\left(2,2\right)` | [一様分布・指数分布・ポアソン分布を使う](math-input.md#一様分布指数分布ポアソン分布を使う) |
| 二項分布の確率（ちょうどk回） | `P(X=k)`／`\operatorname{binomialpmf}\left(#1,#2,#3\right)` | `\operatorname{binomialpmf}\left(4,1/2,2\right)` | [二項分布の確率を求める](math-input.md#二項分布の確率を求める) |
| 二項分布の累積確率（x回以下） | `P(X≤x)`／`\operatorname{binomialcdf}\left(#1,#2,#3\right)` | `\operatorname{binomialcdf}\left(4,1/2,2\right)` | [二項分布の確率を求める](math-input.md#二項分布の確率を求める) |
| 平均 | `mean`／`\operatorname{mean}\left(#1\right)` | `\operatorname{mean}\left([1,2,6]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 中央値 | `median`／`\operatorname{median}\left(#1\right)` | `\operatorname{median}\left([9,1,3,5]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 最頻値の一覧 | `modes`／`\operatorname{modes}\left(#1\right)` | `\operatorname{modes}\left([1,1,2,2,3]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 分位点（線形補間） | `quantile`／`\operatorname{quantile}\left(#1,#2\right)` | `\operatorname{quantile}\left([0,10,20,30],0.25\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 母分散（nで割る） | `σ²`／`\operatorname{populationvariance}\left(#1\right)` | `\operatorname{populationvariance}\left([1,2,3]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 標本分散（n−1で割る） | `s²`／`\operatorname{samplevariance}\left(#1\right)` | `\operatorname{samplevariance}\left([1,2,3]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 母標準偏差 | `σ`／`\operatorname{populationstandarddeviation}\left(#1\right)` | `\operatorname{populationstandarddeviation}\left([1,3]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 標本標準偏差 | `s`／`\operatorname{samplestandarddeviation}\left(#1\right)` | `\operatorname{samplestandarddeviation}\left([1,3]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 母共分散（nで割る） | `covₙ`／`\operatorname{populationcovariance}\left(#1,#2\right)` | `\operatorname{populationcovariance}\left([1,2,3],[2,4,6]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 標本共分散（n−1で割る） | `covₙ₋₁`／`\operatorname{samplecovariance}\left(#1,#2\right)` | `\operatorname{samplecovariance}\left([1,2,3],[2,4,6]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 相関係数 | `r`／`\operatorname{correlation}\left(#1,#2\right)` | `\operatorname{correlation}\left([1,2,3],[6,4,2]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 回帰直線の傾き | `a`／`\operatorname{regressionslope}\left(#1,#2\right)` | `\operatorname{regressionslope}\left([1,2,3],[3,5,7]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 回帰直線の切片 | `b`／`\operatorname{regressionintercept}\left(#1,#2\right)` | `\operatorname{regressionintercept}\left([1,2,3],[3,5,7]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 回帰の決定係数 | `R²`／`\operatorname{rsquared}\left(#1,#2\right)` | `\operatorname{rsquared}\left([1,2,3],[3,5,7]\right)` | [データから統計量を求める](math-input.md#データから統計量を求める) |
| 正規分布を宣言 | `Normal(μ,σ)`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{normaldistribution}\left(#1,#2\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{normaldistribution}\left(3,2\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 一様分布を宣言 | `Uniform(a,b)`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{uniformdistribution}\left(#1,#2\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{uniformdistribution}\left(0,4\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 指数分布を宣言 | `Exp(rate)`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{exponentialdistribution}\left(#1\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{exponentialdistribution}\left(2\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| Gamma分布を宣言 | `Gamma(k,θ)`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{gammadistribution}\left(#1,#2\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{gammadistribution}\left(2,3\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| Beta分布を宣言 | `Beta(a,b)`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{betadistribution}\left(#1,#2\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{betadistribution}\left(2,3\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| χ²分布を宣言 | `χ²(df)`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{chisquaredistribution}\left(#1\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{chisquaredistribution}\left(4\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| t分布を宣言 | `t(df)`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{tdistribution}\left(#1\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{tdistribution}\left(4\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| F分布を宣言 | `F(d1,d2)`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{fdistribution}\left(#1,#2\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{fdistribution}\left(3,6\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 二項分布を宣言 | `Binomial(n,p)`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{binomialdistribution}\left(#1,#2\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{binomialdistribution}\left(4,1/2\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| ポアソン分布を宣言 | `Poisson(λ)`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{poissondistribution}\left(#1\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{poissondistribution}\left(3\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 有限分布を宣言 | `有限分布`／`\operatorname{randomexpectation}\left(x,[x],\operatorname{finitedistribution}\left(#1,#2\right)\right)` | `\operatorname{randomexpectation}\left(x,[x],\operatorname{finitedistribution}\left([2,8],[1/4,3/4]\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 同時分布を宣言 | `同時分布`／`\operatorname{randomexpectation}\left(x+y,[x,y],\operatorname{jointfinitedistribution}\left(#1,#2\right)\right)` | `\operatorname{randomexpectation}\left(x+y,[x,y],\operatorname{jointfinitedistribution}\left([[0,0],[2,2]],[1/4,3/4]\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |
| 独立分布の組を宣言 | `独立分布`／`\operatorname{randomexpectation}\left(x+y,[x,y],\operatorname{independentdistributions}\left(#1\right)\right)` | `\operatorname{randomexpectation}\left(x+y,[x,y],\operatorname{independentdistributions}\left([\operatorname{normaldistribution}(0,1),\operatorname{normaldistribution}(3,2)]\right)\right)` | [分布を宣言して事象と確率変数を計算する](math-input.md#分布を宣言して事象と確率変数を計算する) |

## 集合・論理

| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |
|---|---|---|---|
| 写像を定義 | `↦`／`\operatorname{mapping}\left(#1,#2,#3,#4\right)` | `\operatorname{mapping}\left(2x+1,x,\mathbb{R},\mathbb{R}\right)` | [写像・合成・逆写像](math-input.md#写像合成逆写像) |
| 写像の値 | `mapat`／`\operatorname{mapat}\left(#1,#2\right)` | `\operatorname{mapat}\left(\operatorname{mapping}(2x+1,x,\mathbb{R},\mathbb{R}),4\right)` | [写像・合成・逆写像](math-input.md#写像合成逆写像) |
| 写像の合成 | `∘`／`\operatorname{composemaps}\left(#1,#2\right)` | `\operatorname{composemaps}\left(\operatorname{mapping}(x+1,x,\mathbb{R},\mathbb{R}),\operatorname{mapping}(2x,x,\mathbb{R},\mathbb{R})\right)` | [写像・合成・逆写像](math-input.md#写像合成逆写像) |
| 逆写像 | `inversemap`／`\operatorname{inversemap}\left(#1\right)` | `\operatorname{inversemap}\left(\operatorname{mapping}(2x+1,x,\mathbb{R},\mathbb{R})\right)` | [写像・合成・逆写像](math-input.md#写像合成逆写像) |
| 写像による像 | `mapimage`／`\operatorname{mapimage}\left(#1,#2\right)` | `\operatorname{mapimage}\left(\operatorname{mapping}(x^2,x,\mathbb{R},\mathbb{R}),\operatorname{set}(-2,3)\right)` | [写像・合成・逆写像](math-input.md#写像合成逆写像) |
| 写像による逆像 | `mappreimage`／`\operatorname{mappreimage}\left(#1,#2\right)` | `\operatorname{mappreimage}\left(\operatorname{mapping}(x^2,x,\mathbb{R},\mathbb{R}),\operatorname{set}(4)\right)` | [写像・合成・逆写像](math-input.md#写像合成逆写像) |
| 集合の上限 | `sup`／`\operatorname{sup}\left(#1\right)` | `\operatorname{sup}\left(\operatorname{interval}(\operatorname{open}(0),\operatorname{open}(1))\right)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 集合の下限 | `inf`／`\operatorname{inf}\left(#1\right)` | `\operatorname{inf}\left(\operatorname{interval}(\operatorname{open}(0),\operatorname{open}(1))\right)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 集合の最大値 | `setmax`／`\operatorname{setmax}\left(#1\right)` | `\operatorname{setmax}\left(\operatorname{set}(1,3,2)\right)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 集合の最小値 | `setmin`／`\operatorname{setmin}\left(#1\right)` | `\operatorname{setmin}\left(\operatorname{set}(1,3,2)\right)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 整数が割り切るか | `a|b`／`\operatorname{divides}\left(#1,#2\right)` | `\operatorname{divides}\left(4,20\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 法を指定した合同 | `a≡b (mod m)`／`\operatorname{congruentmodulo}\left(#1,#2,#3\right)` | `\operatorname{congruentmodulo}\left(-1,5,3\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 素数か判定する | `prime?`／`\operatorname{isprime}\left(#1\right)` | `\operatorname{isprime}\left(13\right)` | [整数の商・約数・素数・合同](math-input.md#整数の商約数素数合同) |
| 和集合 | `∪`／`#1\cup #2` | `\operatorname{set}(1,2)\cup \operatorname{set}(2,3)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 共通集合 | `∩`／`#1\cap #2` | `\operatorname{set}(1,2,3)\cap \operatorname{set}(2,3,4)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 場合分け | `cases`／`\begin{cases}#1&#2\\#3&#4\end{cases}` | `\begin{cases}10&1>5\\20&1<5\end{cases}` | [パレットの例と引数の順序](math-input.md#パレットの例と引数の順序) |
| 等しくない | `≠`／`#1\neq #2` | `3\neq 4` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| より小さい | `<`／`#1<#2` | `2<3` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 以下 | `≤`／`#1\leq #2` | `3\leq 3` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| より大きい | `>`／`#1>#2` | `5>2` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 以上 | `≥`／`#1\geq #2` | `5\geq 5` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 論理積 | `∧`／`#1\land #2` | `3>1\land 5<10` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 論理和 | `∨`／`#1\lor #2` | `3>10\lor 5<10` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 否定 | `¬`／`\neg #1` | `\neg 3>10` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| ならば | `⇒`／`#1\implies #2` | `3>10\implies 5<10` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 同値 | `⇔`／`#1\iff #2` | `3>1\iff 5<10` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 空集合 | `∅`／`\emptyset` | `\emptyset` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 自然数全体 | `ℕ`／`\mathbb{N}` | `\mathbb{N}` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 整数全体 | `ℤ`／`\mathbb{Z}` | `\mathbb{Z}` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 有理数全体 | `ℚ`／`\mathbb{Q}` | `\mathbb{Q}` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 実数全体 | `ℝ`／`\mathbb{R}` | `\mathbb{R}` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 複素数全体 | `ℂ`／`\mathbb{C}` | `\mathbb{C}` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 要素である | `∈`／`#1\in #2` | `3\in \operatorname{set}(1,2,3)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 差集合 | `∖`／`#1\setminus #2` | `\operatorname{set}(1,2,3)\setminus \operatorname{set}(2,3)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 非所属 | `∉`／`#1\notin #2` | `3\notin \operatorname{set}(1,2)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 真部分集合 | `⊂`／`#1\subset #2` | `\operatorname{set}(1)\subset \operatorname{set}(1,2)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 部分集合 | `⊆`／`#1\subseteq #2` | `\operatorname{set}(2,1)\subseteq \operatorname{set}(1,2)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 真の上位集合 | `⊃`／`#1\supset #2` | `\operatorname{set}(1,2)\supset \operatorname{set}(1)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 上位集合 | `⊇`／`#1\supseteq #2` | `\operatorname{set}(1)\supseteq \operatorname{set}(1)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 補集合 | `∁`／`\operatorname{complement}\left(#1,#2\right)` | `\operatorname{complement}\left(\operatorname{set}(2),\operatorname{set}(1,2,3)\right)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 直積 | `A×B`／`\operatorname{cartesianproduct}\left(#1,#2\right)` | `\operatorname{cartesianproduct}\left(\operatorname{set}(1,2),\operatorname{set}(3)\right)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 近似等号 | `≈`／`\operatorname{approxequal}\left(#1,#2,#3\right)` | `\operatorname{approxequal}\left(0.3,0.2,0.1\right)` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 要素数 | `n(A)`／`\operatorname{cardinality}\left(#1\right)` | `\operatorname{cardinality}\left(\{1,2,3\}\right)` | [集合の上限・下限と最大値・最小値](math-input.md#集合の上限下限と最大値最小値) |
| 真 | `⊤`／`\top` | `\top` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 偽 | `⊥`／`\bot` | `\bot` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 全称量化 | `∀`／`\operatorname{forall}\left(#1,#2,#3\right)` | `\operatorname{forall}\left(x,\{1,2,3\},x>0\right)` | [近似等号と集合の全称・存在を判定する](math-input.md#近似等号と集合の全称存在を判定する) |
| 存在量化 | `∃`／`\operatorname{exists}\left(#1,#2,#3\right)` | `\operatorname{exists}\left(x,\{0,1,3\},x^2=4\right)` | [近似等号と集合の全称・存在を判定する](math-input.md#近似等号と集合の全称存在を判定する) |

## 方程式

| 名前 | 記号／入力の書き方 | 例 | 説明の節への案内 |
|---|---|---|---|
| 微分方程式の解候補 | `odesolve`／`\operatorname{odesolve}\left(#1,#2,#3,#4\right)` | `\operatorname{odesolve}\left([\operatorname{diff}(y,x)=2],x,[y],[[y,0,3]]\right)` | [微分方程式の条件と解候補を確認する](math-input.md#微分方程式の条件と解候補を確認する) |
| 微分方程式の値を選ぶ | `odeat`／`\operatorname{odeat}\left(#1,#2,#3,#4\right)` | `\operatorname{odeat}\left(\operatorname{odesolve}([\operatorname{diff}(y,x)=2],x,[y],[[y,0,3]]),1,[],4\right)` | [微分方程式の条件と解候補を確認する](math-input.md#微分方程式の条件と解候補を確認する) |
| 数値で解を探す | `numericroots`／`\operatorname{numericroots}\left(#1,#2,#3,#4,#5\right)` | `\operatorname{numericroots}\left(x^2-2,x,-2,2,0.000001\right)` | [数値で解を探し、区間を確認する](math-input.md#数値で解を探し区間を確認する) |
| 解の区間を選ぶ | `rootinterval`／`\operatorname{rootinterval}\left(#1,#2\right)` | `\operatorname{rootinterval}\left(\operatorname{numericroots}(x^2-2,x,0,2,0.000001),1\right)` | [数値で解を探し、区間を確認する](math-input.md#数値で解を探し区間を確認する) |
| 複数の方程式 | `solvesystem`／`\operatorname{solvesystem}\left(#1,#2,#3\right)` | `\operatorname{solvesystem}\left([x+y=2,x-y=0],[x,y],\mathbb{R}\right)` | [複数の方程式の解と自由な値を使う](math-input.md#複数の方程式の解と自由な値を使う) |
| 複数式の解を選ぶ | `systemsolution`／`\operatorname{systemsolution}\left(#1,#2,#3\right)` | `\operatorname{systemsolution}\left(\operatorname{solvesystem}([x+y=2],[x,y],\mathbb{R}),1,[3]\right)` | [複数の方程式の解と自由な値を使う](math-input.md#複数の方程式の解と自由な値を使う) |
| 方程式・不等式の解 | `solve`／`\operatorname{solve}\left(#1,#2,#3\right)` | `\operatorname{solve}\left(x^2=1,x,\mathbb{R}\right)` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 多項式の根と重複度 | `polynomialroots`／`\operatorname{polynomialroots}\left(#1,#2,#3\right)` | `\operatorname{polynomialroots}\left((x-1)^2*(x+2),x,\mathbb{C}\right)` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 解を一つ選ぶ | `solution`／`\operatorname{solution}\left(#1,#2\right)` | `\operatorname{solution}\left(\operatorname{solve}\left(x^2=4,x,\mathbb{R}\right),2\right)` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| フーリエ変換 | `fourier`／`\operatorname{fourier}\left(#1,#2,#3\right)` | `\operatorname{fourier}\left(\exp\left(-x^2\right),x,k\right)` | [連続変換の式と成立範囲を確認する](math-input.md#連続変換の式と成立範囲を確認する) |
| 逆フーリエ変換 | `inversefourier`／`\operatorname{inversefourier}\left(#1,#2,#3\right)` | `\operatorname{inversefourier}\left(\exp\left(-\pi x^2\right),x,t\right)` | [連続変換の式と成立範囲を確認する](math-input.md#連続変換の式と成立範囲を確認する) |
| ラプラス変換 | `laplace`／`\operatorname{laplace}\left(#1,#2,#3\right)` | `\operatorname{laplace}\left(\exp\left(-x\right),x,s\right)` | [連続変換の式と成立範囲を確認する](math-input.md#連続変換の式と成立範囲を確認する) |
| 逆ラプラス変換 | `inverselaplace`／`\operatorname{inverselaplace}\left(#1,#2,#3\right)` | `\operatorname{inverselaplace}\left(1/(x+1),x,t\right)` | [連続変換の式と成立範囲を確認する](math-input.md#連続変換の式と成立範囲を確認する) |
| Z変換 | `ztransform`／`\operatorname{ztransform}\left(#1,#2,#3\right)` | `\operatorname{ztransform}\left((1/2)^n,n,z\right)` | [連続変換の式と成立範囲を確認する](math-input.md#連続変換の式と成立範囲を確認する) |
| 変換の値 | `transformat`／`\operatorname{transformat}\left(#1,#2\right)` | `\operatorname{transformat}\left(\operatorname{laplace}\left(\exp\left(-x\right),x,s\right),1\right)` | [連続変換の式と成立範囲を確認する](math-input.md#連続変換の式と成立範囲を確認する) |
| 等式 | `=`／`#1=#2` | `3=3` | [方程式・不等式の解を選んで使う](math-input.md#方程式不等式の解を選んで使う) |
| 偏微分方程式を宣言 | `PDE`／`\operatorname{pde}\left(#1,#2,#3,#4\right)` | `\operatorname{pde}\left([\operatorname{diff}(u,t)=\operatorname{diff}(u,x,x)],[x,t],[u],[[u,[0,t],3]]\right)` | [解けていない式と条件を保存する](math-input.md#解けていない式と条件を保存する) |
