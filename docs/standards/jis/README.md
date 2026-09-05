# JIS 規格部品の規格番号と寸法表

P7 の規格部品ライブラリ(要件 FR-616、計画書 `docs/plans/P7-アセンブリ.md` §0.a-0.31)の材料。
利用者の決定(2026-09-06 00:27)「統括が調査して番号と寸法表を用意する」に基づき、
**web の公開資料だけ**から集めた。

## 著作権上の扱い

- **規格本文は複製していない。** 条文・図・注記は一切写していない。
- **数値はメーカーのカタログ・技術資料等の公開資料から写した**寸法の事実であり、**原典(JIS 規格票)と食い違う可能性がある。**
- 食い違いの恐れがある行には各 JSON の `verified: false` と `note` を付け、この README の一覧で **要確認** とした。
- 規格番号・名称・版(年)は **日本規格協会(JSA)の書誌ページ**で照合した。規格票そのものは見ていない。
- 規格本文をそのまま転載しているとみられるサイト(kikakurui.com など)は**出典に使っていない。**

## 確認の基準

| 印 | 意味 |
|---|---|
| **確認済み** | 独立した 2 件以上の公開資料が同じ値を示し、食い違いが無かった |
| **要確認** | 資料が 1 件しか得られなかった、または資料どうしで値が食い違った |
| **得られず** | 数値が見つからなかった。JSON では `null`、`verified: false` |

**推測で数値を書いた行は 1 つも無い。**

## 規格番号の一覧(JSA の書誌で照合)

計画書 §0.a-0.31 の候補 10 件は、**番号・名称ともすべて正しかった。訂正は無い。**
版(年)は候補には書かれていなかったので、新たに付けた。

| # | 規格番号 | 名称 | 版 | 番号の照合 | JSON |
|---|---|---|---|---|---|
| 1 | JIS B 1180 | 六角ボルト | 2014 | 確認済み | `hex-bolt-jis-b-1180.json` |
| 2 | JIS B 1181 | 六角ナット | 2014 | 確認済み | `hex-nut-jis-b-1181.json` |
| 3 | JIS B 1256 | 平座金 | 2008 | 確認済み | `plain-washer-jis-b-1256.json` |
| 4 | JIS B 1251 | ばね座金 | 2018 | 確認済み | `spring-washer-jis-b-1251.json` |
| 5 | JIS B 1176 | 六角穴付きボルト | 2014 | 確認済み | `socket-head-cap-screw-jis-b-1176.json` |
| 6 | JIS B 1521 | 転がり軸受—深溝玉軸受 | 2012 | 確認済み | `deep-groove-ball-bearing-jis-b-1521.json` |
| 6b | JIS B 1513 | 転がり軸受の呼び番号 | 1995 | 確認済み | (上に同じ) |
| 7 | JIS G 3192 | 熱間圧延形鋼の形状，寸法，質量及びその許容差 | **2024** | 確認済み | `equal-angle-…` / `channel-…` / `h-beam-jis-g-3192.json` |
| 8 | JIS B 0205-4 | 一般用メートルねじ—基準寸法 | — | P3 で採用済み(この調査では扱わない) | — |
| 9 | JIS B 1111 | 十字穴付き小ねじ | 2017 | 確認済み | `pan-head-screw-jis-b-1111.json` |
| 10 | JIS B 1354 | 平行ピン | 2012 | 確認済み | `parallel-pin-jis-b-1354.json` |

番号の照合に使った出典: 日本規格協会の書誌ページ
`https://webdesk.jsa.or.jp/books/W11M0090/index/?bunsyo_id=JIS+B+1180:2014` の形(規格番号ごと)。

## 寸法表の一覧

| JSON | 内容 | 行数 | 確認済み | 要確認 | 得られず | 主な出典 URL |
|---|---|---|---|---|---|---|
| `hex-bolt-jis-b-1180.json` | 六角ボルト 並目・部品等級A(本体規格) M3〜M24 | 13 | 10 | 3 (M14/M18/M22) | 0 | ミスミ技術情報 [a0041](https://jp.misumi-ec.com/tech-info/categories/machine_design/md05/a0041.html) / [fasteners.eu ISO 4014](http://www.fasteners.eu/standards/ISO/4014/) |
| `hex-nut-jis-b-1181.json` | 六角ナット スタイル1 並目(本体規格) M3〜M24 | 13 | 10 | 3 (M18/M22/M24) | 0 | [由良産商 handbookV8-3-42.pdf](https://www.yura-sansyo.co.jp/handbook/handbookV8-3-42.pdf) / [ミスミ a0042](https://jp.misumi-ec.com/tech-info/categories/machine_design/md05/a0042.html) / [KHK](https://www.khkgears.co.jp/gear_technology/gear_reference/KHK494_2.html) |
| `plain-washer-jis-b-1256.json` | 平座金 並形-部品等級A M3〜M24 | 13 | 0 | **13(全行)** | 0 | [由良産商 handbookV8-5-08.pdf](https://www.yura-sansyo.co.jp/handbook/handbookV8-5-08.pdf) / [hayamihyou](https://hayamihyou.net/washer/) |
| `spring-washer-jis-b-1251.json` | ばね座金 2号 呼び2〜24 | 15 | 15 | 0(外径 D の列だけ 1 件) | 0 | [由良産商 handbookV8-5-20.pdf](https://www.yura-sansyo.co.jp/handbook/handbookV8-5-20.pdf) / [hayamihyou](https://hayamihyou.net/washer/) |
| `socket-head-cap-screw-jis-b-1176.json` | 六角穴付きボルト M3〜M24 | 13 | 11 | 1 (M18) | 1 (M22) | [ミスミ a0196](https://jp.misumi-ec.com/tech-info/categories/technical_data/td01/a0196.html) / [三木プーリ](https://www.mikipulley.co.jp/jp/resources/standards-hex-socket-head-cap-screw) / [三和ファスナー](https://sanwa-fastener.com/specs) |
| `deep-groove-ball-bearing-jis-b-1521.json` | 深溝玉軸受 6000/6200/6300 系列 | 57 | 57 | 0 | 0 | [NSK 製品ページ](https://www.nsk.com/jp-ja/engineering/6000-apn.html)(呼び番号ごと 57 件) / [hayamihyou](https://hayamihyou.net/bearing/) |
| `equal-angle-jis-g-3192.json` | 等辺山形鋼 L25×25×3 〜 L100×100×13 | 26 | 22 | 4(丸みの食い違い) | 0 | [日本鉄鋼連盟 JIS G 3192 原案 PDF](https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai004_jis02G3192_20201202.pdf) / [ranoBlog](https://ranoblog.org/angle-yamagata-steel-%E2%85%BC-standard-size-cross-section-weight/) |
| `channel-jis-g-3192.json` | 溝形鋼 75×40 〜 380×100 | 16 | 16 | 0 | 0 | 同 JISF PDF / [ranoBlog チャンネル](https://ranoblog.org/channel-steel-material-c-standard-size-cross-sectional-area-weight-jis-g-3192/) |
| `h-beam-jis-g-3192.json` | H形鋼(表15) 100×50 〜 350×175 | 23 | 22 | 1 (175×175) | 0 | 同 JISF PDF / [hayamihyou H形鋼](https://hayamihyou.net/h-beam/) |
| `pan-head-screw-jis-b-1111.json` | なべ小ねじ(**附属書**) M2〜M8 | 8 | 0 | **8(全行)** | 0 | [由良産商 handbookV8-6.pdf](https://www.yura-sansyo.co.jp/handbook/handbookV8-6.pdf) / [オノウエ](https://www.onoue1950.co.jp/products/koneji/jujikoneji/1667/) |
| `parallel-pin-jis-b-1354.json` | 平行ピン 呼び径 2〜12 | 9 | 0 | **9(全行)** | 0 | [由良産商 handbookV8-8-07.pdf](https://www.yura-sansyo.co.jp/handbook/handbookV8-8-07.pdf) |

合計 **206 行**。確認済み **163 行**、要確認 **42 行**、得られず **1 行**(六角穴付きボルト M22)。

## JSON の形

```json
{
  "standard": "JIS B 1180",
  "edition": "2014",
  "title": "六角ボルト",
  "scope": "どの系列・どの部品等級の表か",
  "sourceUrls": ["…"],
  "verified": false,
  "unit": "mm",
  "columns": { "s": "二面幅 基準寸法=最大", "…": "…" },
  "notes": ["…"],
  "rows": [ { "size": "M6", "s": 10, "k": 4, "verified": true, "note": "" } ]
}
```

- 数値の列は **number**(得られなかったところは `null`)。欄名は英字の短い名で、意味は各 JSON の `columns` にある。
- ファイル全体の `verified` は「全行が確認済みか」。1 行でも要確認があれば `false`。
- 行の `verified` は「その行のすべての数値が 2 件以上の資料で一致したか」。

## 欄名の対応表(全ファイル共通の見方)

| 欄名 | 意味 | 使うところ |
|---|---|---|
| `s` | 二面幅(基準寸法=最大)。六角穴付きボルトでは六角穴の対辺 | ボルト・ナット・六角穴付きボルト |
| `k` | 頭の高さ | ボルト・六角穴付きボルト・小ねじ |
| `e` | 対角距離(最小) | ボルト・ナット・六角穴付きボルト(六角穴の対角) |
| `b` / `b1` `b2` `b3` | ねじ部の長さ。ボルトは呼び長さの範囲で 3 段(`b1`: l≤125、`b2`: 125<l≤200、`b3`: l>200) | ボルト・六角穴付きボルト |
| `r` | 首下丸み(最小)。形鋼では丸み | ボルト・六角穴付きボルト・形鋼 |
| `P` | ピッチ(並目) | ねじもの全部 |
| `mMax` / `mMin` | ナットの高さ(最大・最小)。JIS はナットの高さに基準寸法を与えない | ナット |
| `dk` | 頭の径 | 六角穴付きボルト・小ねじ |
| `t` | 六角穴の深さ / 座金の厚さ / 形鋼の厚さ | 六角穴付きボルト・ばね座金・形鋼 |
| `d1` / `d2` / `h` | 平座金の内径・外径・厚さ | 平座金 |
| `d` / `D` / `B` | 軸受の内径・外径・幅。ばね座金では内径・外径 | 軸受・ばね座金 |
| `rMin` | 軸受の面取寸法(最小) | 軸受 |
| `H` / `B` / `t1` / `t2` / `r1` / `r2` | 形鋼の高さ・幅・ウェブ厚・フランジ厚・内側の丸み・先端の丸み | 形鋼 |
| `area` / `mass` | 断面積(cm²)・単位質量(kg/m) | 形鋼 |

## 統括が判断する必要がある点

1. **本体規格か附属書(旧JIS)か。** JIS B 1180 / 1181 / 1256 / 1111 は、**ISO に合わせた「本体規格」と、旧来の寸法を残した「附属書」の 2 系統**が同じ規格番号の中にある。**二面幅も座金の外径も違う。**
   - この調査では**ボルト・ナット・平座金は本体規格**を、**なべ小ねじは附属書**(市販品がこちらのため)を採った。**統括が揃えるかどうかを決める。**
   - 例: 六角ボルト M10 の二面幅は 本体規格 **16**、附属書JA **17**。M12 は 18 と 19。M22 は 34 と 32。
2. **平座金の値の食い違い。** 由良産商の「JIS B 1256-2008 並形-部品等級A」の抜粋と、hayamihyou.net の「並形」で値が違う(後者は旧JIS の並丸・みがき丸とみられる)。**13 行すべて要確認。**
3. **JIS G 3192 の版。** 数値の出典は**日本鉄鋼連盟が公開している 2020年の改正原案 PDF**で、現行版は **2024**。**表の値が現行版と同じかは確かめていない。**
4. **JIS B 1176 に M18・M22 が無い。** 2014年版で M18・M22・M27 が削除されている。M18 はメーカー一覧に載っていた値(DIN 912 相当とみられる)を要確認として残し、M22 は `null` にした。**規格部品の一覧に出すかどうかを決める。**
5. **ナットの高さ m に基準寸法が無い。** JIS は最大・最小だけを規定する。**形を作るときにどちらを使うかを決める**(この表は `mMax` と `mMin` の両方を持つ)。
6. **呼び長さ。** 六角ボルトの呼び長さの一覧はミスミの表の行見出しから写した 21 個だけで、150 より長いものは確認していない。六角穴付きボルト・小ねじ・平行ピンの呼び長さは得られなかった。
7. **平行ピンと小ねじは 1 件の資料しか無い**(小ねじは 2 件だが附属書の値)。**P7 の範囲に入れるなら、もう一度調べ直すか、利用者に原典で照合してもらう必要がある。**
