import type {
  FastenerDimensionSeries, HexBoltRow, HexNutRow, PanHeadScrewRow, PlainWasherRow,
  SocketHeadCapScrewRow, SpringWasherRow, StandardTableSource,
} from './types.js';

/*
 * 数値の調査記録は docs/standards/jis/*.json。ここは P7 が使う M3〜M20 の実行時カタログで、
 * 本体規格の系列を採る。verified=false と note は調査記録から落とさない。
 */

export const HEX_BOLT_SOURCE = {
  standard: 'JIS B 1180', edition: '2014', title: '六角ボルト',
  scope: '\u672c\u4f53\u898f\u683c\u3068\u9644\u5c5e\u66f8JA\u306e2\u5bf8\u6cd5\u7cfb\u3001\u4e26\u76ee\u30fb\u7d30\u76ee\u306d\u3058',
  sourceUrls: [
    'https://jp.misumi-ec.com/tech-info/categories/machine_design/md05/a0041.html',
    'http://www.fasteners.eu/standards/ISO/4014/',
    'https://webdesk.jsa.or.jp/books/W11M0090/index/?bunsyo_id=JIS+B+1180:2014',
    'https://www.yura-sansyo.co.jp/handbook/handbookV8-1-59.pdf',
    'https://www.asahi55.co.jp/oyakudati/hexagon_bolt',
  ],
  verified: false,
} as const satisfies StandardTableSource;

export const HEX_BOLT_TABLE = [
  { key: 'JIS-B-1180:2014:M3:P0.5:main', dimensionSeries: 'main', size: 'M3', d: 3, pitch: 0.5, s: 5.5, k: 2, b1: 12, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M4:P0.7:main', dimensionSeries: 'main', size: 'M4', d: 4, pitch: 0.7, s: 7, k: 2.8, b1: 14, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M5:P0.8:main', dimensionSeries: 'main', size: 'M5', d: 5, pitch: 0.8, s: 8, k: 3.5, b1: 16, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M6:P1:main', dimensionSeries: 'main', size: 'M6', d: 6, pitch: 1, s: 10, k: 4, b1: 18, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M8:P1.25:main', dimensionSeries: 'main', size: 'M8', d: 8, pitch: 1.25, s: 13, k: 5.3, b1: 22, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M10:P1.5:main', dimensionSeries: 'main', size: 'M10', d: 10, pitch: 1.5, s: 16, k: 6.4, b1: 26, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M12:P1.75:main', dimensionSeries: 'main', size: 'M12', d: 12, pitch: 1.75, s: 18, k: 7.5, b1: 30, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M14:P2:main', dimensionSeries: 'main', size: 'M14', d: 14, pitch: 2, s: 21, k: 8.8, b1: 34, verified: false, note: '第2選択。ISO 4014 の公開表1件のみのため要確認。' },
  { key: 'JIS-B-1180:2014:M16:P2:main', dimensionSeries: 'main', size: 'M16', d: 16, pitch: 2, s: 24, k: 10, b1: 38, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M18:P2.5:main', dimensionSeries: 'main', size: 'M18', d: 18, pitch: 2.5, s: 27, k: 11.5, b1: 42, verified: false, note: '第2選択。ISO 4014 の公開表1件のみのため要確認。' },
  { key: 'JIS-B-1180:2014:M20:P2.5:main', dimensionSeries: 'main', size: 'M20', d: 20, pitch: 2.5, s: 30, k: 12.5, b1: 46, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M3:P0.5:annexJA', dimensionSeries: 'annexJA', size: 'M3', d: 3, pitch: 0.5, s: 5.5, k: 2, b1: 12, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M4:P0.7:annexJA', dimensionSeries: 'annexJA', size: 'M4', d: 4, pitch: 0.7, s: 7, k: 2.8, b1: 14, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M5:P0.8:annexJA', dimensionSeries: 'annexJA', size: 'M5', d: 5, pitch: 0.8, s: 8, k: 3.5, b1: 16, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M6:P1:annexJA', dimensionSeries: 'annexJA', size: 'M6', d: 6, pitch: 1, s: 10, k: 4, b1: 18, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M8:P1.25:annexJA', dimensionSeries: 'annexJA', size: 'M8', d: 8, pitch: 1.25, s: 13, k: 5.5, b1: 22, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M10:P1.5:annexJA', dimensionSeries: 'annexJA', size: 'M10', d: 10, pitch: 1.5, s: 17, k: 7, b1: 26, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M12:P1.75:annexJA', dimensionSeries: 'annexJA', size: 'M12', d: 12, pitch: 1.75, s: 19, k: 8, b1: 30, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M16:P2:annexJA', dimensionSeries: 'annexJA', size: 'M16', d: 16, pitch: 2, s: 24, k: 10, b1: 38, verified: true, note: '' },
  { key: 'JIS-B-1180:2014:M20:P2.5:annexJA', dimensionSeries: 'annexJA', size: 'M20', d: 20, pitch: 2.5, s: 30, k: 13, b1: 46, verified: true, note: '' },
] as const satisfies readonly HexBoltRow[];

/** 調査できた呼び長さ。150mm より長い系列は未確認なので選択肢に出さない。 */
export const HEX_BOLT_NOMINAL_LENGTHS = [
  12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140, 150,
] as const;

export const HEX_NUT_SOURCE = {
  standard: 'JIS B 1181', edition: '2014', title: '六角ナット',
  scope: '\u672c\u4f53\u898f\u683c\u30b9\u30bf\u30a4\u30eb1\u3068\u9644\u5c5e\u66f8JA 1\u7a2e\u3001\u4e26\u76ee\u30fb\u7d30\u76ee\u306d\u3058',
  sourceUrls: [
    'https://www.yura-sansyo.co.jp/handbook/handbookV8-3-42.pdf',
    'https://jp.misumi-ec.com/tech-info/categories/machine_design/md05/a0042.html',
    'https://www.khkgears.co.jp/gear_technology/gear_reference/KHK494_2.html',
    'https://www.linex.co.jp/products/jis/parts05/',
  ],
  verified: false,
} as const satisfies StandardTableSource;

export const HEX_NUT_TABLE = [
  { key: 'JIS-B-1181:2014:M3:P0.5:main', dimensionSeries: 'main', size: 'M3', d: 3, pitch: 0.5, s: 5.5, mMax: 2.4, mMin: 2.15, verified: true, note: '' },
  { key: 'JIS-B-1181:2014:M4:P0.7:main', dimensionSeries: 'main', size: 'M4', d: 4, pitch: 0.7, s: 7, mMax: 3.2, mMin: 2.9, verified: true, note: '' },
  { key: 'JIS-B-1181:2014:M5:P0.8:main', dimensionSeries: 'main', size: 'M5', d: 5, pitch: 0.8, s: 8, mMax: 4.7, mMin: 4.4, verified: true, note: '' },
  { key: 'JIS-B-1181:2014:M6:P1:main', dimensionSeries: 'main', size: 'M6', d: 6, pitch: 1, s: 10, mMax: 5.2, mMin: 4.9, verified: true, note: '' },
  { key: 'JIS-B-1181:2014:M8:P1.25:main', dimensionSeries: 'main', size: 'M8', d: 8, pitch: 1.25, s: 13, mMax: 6.8, mMin: 6.44, verified: true, note: '' },
  { key: 'JIS-B-1181:2014:M10:P1.5:main', dimensionSeries: 'main', size: 'M10', d: 10, pitch: 1.5, s: 16, mMax: 8.4, mMin: 8.04, verified: true, note: '' },
  { key: 'JIS-B-1181:2014:M12:P1.75:main', dimensionSeries: 'main', size: 'M12', d: 12, pitch: 1.75, s: 18, mMax: 10.8, mMin: 10.37, verified: true, note: '' },
  { key: 'JIS-B-1181:2014:M14:P2:main', dimensionSeries: 'main', size: 'M14', d: 14, pitch: 2, s: 21, mMax: 12.8, mMin: 12.1, verified: true, note: '第2選択。' },
  { key: 'JIS-B-1181:2014:M16:P2:main', dimensionSeries: 'main', size: 'M16', d: 16, pitch: 2, s: 24, mMax: 14.8, mMin: 14.1, verified: true, note: '' },
  { key: 'JIS-B-1181:2014:M18:P2.5:main', dimensionSeries: 'main', size: 'M18', d: 18, pitch: 2.5, s: 27, mMax: 15.8, mMin: 15.1, verified: false, note: '公開資料1件のみのため要確認。' },
  { key: 'JIS-B-1181:2014:M20:P2.5:main', dimensionSeries: 'main', size: 'M20', d: 20, pitch: 2.5, s: 30, mMax: 18, mMin: 16.9, verified: true, note: '' },
  { key: 'JIS-B-1181:2014:M6:P1:annexJA', dimensionSeries: 'annexJA', size: 'M6', d: 6, pitch: 1, s: 10, mMax: 5, mMin: null, verified: true, note: '\u9644\u5c5e\u66f8JA\u306e\u516c\u958b\u8868\u306f\u4e0b\u9650\u5024\u3092\u8f09\u305b\u3066\u3044\u306a\u3044\u3002' },
  { key: 'JIS-B-1181:2014:M8:P1.25:annexJA', dimensionSeries: 'annexJA', size: 'M8', d: 8, pitch: 1.25, s: 13, mMax: 6.5, mMin: null, verified: true, note: '\u9644\u5c5e\u66f8JA\u306e\u516c\u958b\u8868\u306f\u4e0b\u9650\u5024\u3092\u8f09\u305b\u3066\u3044\u306a\u3044\u3002' },
  { key: 'JIS-B-1181:2014:M10:P1.5:annexJA', dimensionSeries: 'annexJA', size: 'M10', d: 10, pitch: 1.5, s: 17, mMax: 8, mMin: null, verified: true, note: '\u9644\u5c5e\u66f8JA\u306e\u516c\u958b\u8868\u306f\u4e0b\u9650\u5024\u3092\u8f09\u305b\u3066\u3044\u306a\u3044\u3002' },
  { key: 'JIS-B-1181:2014:M12:P1.75:annexJA', dimensionSeries: 'annexJA', size: 'M12', d: 12, pitch: 1.75, s: 19, mMax: 10, mMin: null, verified: true, note: '\u9644\u5c5e\u66f8JA\u306e\u516c\u958b\u8868\u306f\u4e0b\u9650\u5024\u3092\u8f09\u305b\u3066\u3044\u306a\u3044\u3002' },
  { key: 'JIS-B-1181:2014:M16:P2:annexJA', dimensionSeries: 'annexJA', size: 'M16', d: 16, pitch: 2, s: 24, mMax: 13, mMin: null, verified: true, note: '\u9644\u5c5e\u66f8JA\u306e\u516c\u958b\u8868\u306f\u4e0b\u9650\u5024\u3092\u8f09\u305b\u3066\u3044\u306a\u3044\u3002' },
  { key: 'JIS-B-1181:2014:M20:P2.5:annexJA', dimensionSeries: 'annexJA', size: 'M20', d: 20, pitch: 2.5, s: 30, mMax: 16, mMin: null, verified: true, note: '\u9644\u5c5e\u66f8JA\u306e\u516c\u958b\u8868\u306f\u4e0b\u9650\u5024\u3092\u8f09\u305b\u3066\u3044\u306a\u3044\u3002' },
] as const satisfies readonly HexNutRow[];

export const PLAIN_WASHER_SOURCE = {
  standard: 'JIS B 1256', edition: '2008', title: '平座金',
  scope: '並形・部品等級A（本体規格）',
  sourceUrls: [
    'https://www.yura-sansyo.co.jp/handbook/handbookV8-5-08.pdf',
    'https://hayamihyou.net/washer/',
  ],
  verified: false,
} as const satisfies StandardTableSource;

/** 旧JIS系列との食い違いがあるため全行を「要確認」のまま保持する。 */
export const PLAIN_WASHER_TABLE = [
  { key: 'JIS-B-1256:2008:M3', size: 'M3', d: 3, d1: 3.2, d2: 7, thickness: 0.5, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
  { key: 'JIS-B-1256:2008:M4', size: 'M4', d: 4, d1: 4.3, d2: 9, thickness: 0.8, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
  { key: 'JIS-B-1256:2008:M5', size: 'M5', d: 5, d1: 5.3, d2: 10, thickness: 1, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
  { key: 'JIS-B-1256:2008:M6', size: 'M6', d: 6, d1: 6.4, d2: 12, thickness: 1.6, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
  { key: 'JIS-B-1256:2008:M8', size: 'M8', d: 8, d1: 8.4, d2: 16, thickness: 1.6, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
  { key: 'JIS-B-1256:2008:M10', size: 'M10', d: 10, d1: 10.5, d2: 20, thickness: 2, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
  { key: 'JIS-B-1256:2008:M12', size: 'M12', d: 12, d1: 13, d2: 24, thickness: 2.5, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
  { key: 'JIS-B-1256:2008:M14', size: 'M14', d: 14, d1: 15, d2: 28, thickness: 2.5, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
  { key: 'JIS-B-1256:2008:M16', size: 'M16', d: 16, d1: 17, d2: 30, thickness: 3, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
  { key: 'JIS-B-1256:2008:M18', size: 'M18', d: 18, d1: 19, d2: 34, thickness: 3, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
  { key: 'JIS-B-1256:2008:M20', size: 'M20', d: 20, d1: 21, d2: 37, thickness: 3, verified: false, note: '公開表1件のみ。旧JIS系列と食い違うため要確認。' },
] as const satisfies readonly PlainWasherRow[];

export const SPRING_WASHER_SOURCE = {
  standard: 'JIS B 1251', edition: '2018', title: 'ばね座金', scope: '2号（一般用）',
  sourceUrls: [
    'https://www.yura-sansyo.co.jp/handbook/handbookV8-5-20.pdf',
    'https://hayamihyou.net/washer/',
  ],
  verified: true,
} as const satisfies StandardTableSource;

export const SPRING_WASHER_TABLE = [
  { key: 'JIS-B-1251:2018:M3', size: 'M3', d: 3, insideDiameter: 3.1, outsideDiameter: 5.9, width: 1.1, thickness: 0.7, verified: true, note: '外径だけは公開資料1件。' },
  { key: 'JIS-B-1251:2018:M4', size: 'M4', d: 4, insideDiameter: 4.1, outsideDiameter: 7.6, width: 1.4, thickness: 1, verified: true, note: '外径だけは公開資料1件。' },
  { key: 'JIS-B-1251:2018:M5', size: 'M5', d: 5, insideDiameter: 5.1, outsideDiameter: 9.2, width: 1.7, thickness: 1.3, verified: true, note: '外径だけは公開資料1件。' },
  { key: 'JIS-B-1251:2018:M6', size: 'M6', d: 6, insideDiameter: 6.1, outsideDiameter: 12.2, width: 2.7, thickness: 1.5, verified: true, note: '外径だけは公開資料1件。' },
  { key: 'JIS-B-1251:2018:M8', size: 'M8', d: 8, insideDiameter: 8.2, outsideDiameter: 15.4, width: 3.2, thickness: 2, verified: true, note: '外径だけは公開資料1件。' },
  { key: 'JIS-B-1251:2018:M10', size: 'M10', d: 10, insideDiameter: 10.2, outsideDiameter: 18.4, width: 3.7, thickness: 2.5, verified: true, note: '外径だけは公開資料1件。' },
  { key: 'JIS-B-1251:2018:M12', size: 'M12', d: 12, insideDiameter: 12.2, outsideDiameter: 21.5, width: 4.2, thickness: 3, verified: true, note: '外径だけは公開資料1件。' },
  { key: 'JIS-B-1251:2018:M14', size: 'M14', d: 14, insideDiameter: 14.2, outsideDiameter: 24.5, width: 4.7, thickness: 3.5, verified: true, note: '外径だけは公開資料1件。' },
  { key: 'JIS-B-1251:2018:M16', size: 'M16', d: 16, insideDiameter: 16.2, outsideDiameter: 28, width: 5.2, thickness: 4, verified: true, note: '外径だけは公開資料1件。' },
  { key: 'JIS-B-1251:2018:M18', size: 'M18', d: 18, insideDiameter: 18.2, outsideDiameter: 31, width: 5.7, thickness: 4.6, verified: true, note: '外径だけは公開資料1件。' },
  { key: 'JIS-B-1251:2018:M20', size: 'M20', d: 20, insideDiameter: 20.2, outsideDiameter: 33.8, width: 6.1, thickness: 5.1, verified: true, note: '外径だけは公開資料1件。' },
] as const satisfies readonly SpringWasherRow[];

export const SOCKET_HEAD_CAP_SCREW_SOURCE = {
  standard: 'JIS B 1176', edition: '2014', title: '六角穴付きボルト',
  scope: '並目ねじ・鋼製（ローレットなし）',
  sourceUrls: [
    'https://jp.misumi-ec.com/tech-info/categories/technical_data/td01/a0196.html',
    'https://www.mikipulley.co.jp/jp/resources/standards-hex-socket-head-cap-screw',
    'https://sanwa-fastener.com/specs',
  ],
  verified: false,
} as const satisfies StandardTableSource;

export const SOCKET_HEAD_CAP_SCREW_TABLE = [
  { key: 'JIS-B-1176:2014:M3:P0.5', size: 'M3', d: 3, pitch: 0.5, headDiameter: 5.5, headHeight: 3, socketWidth: 2.5, socketDepth: 1.3, available: true, verified: true, note: '' },
  { key: 'JIS-B-1176:2014:M4:P0.7', size: 'M4', d: 4, pitch: 0.7, headDiameter: 7, headHeight: 4, socketWidth: 3, socketDepth: 2, available: true, verified: true, note: '' },
  { key: 'JIS-B-1176:2014:M5:P0.8', size: 'M5', d: 5, pitch: 0.8, headDiameter: 8.5, headHeight: 5, socketWidth: 4, socketDepth: 2.5, available: true, verified: true, note: '' },
  { key: 'JIS-B-1176:2014:M6:P1', size: 'M6', d: 6, pitch: 1, headDiameter: 10, headHeight: 6, socketWidth: 5, socketDepth: 3, available: true, verified: true, note: '' },
  { key: 'JIS-B-1176:2014:M8:P1.25', size: 'M8', d: 8, pitch: 1.25, headDiameter: 13, headHeight: 8, socketWidth: 6, socketDepth: 4, available: true, verified: true, note: '' },
  { key: 'JIS-B-1176:2014:M10:P1.5', size: 'M10', d: 10, pitch: 1.5, headDiameter: 16, headHeight: 10, socketWidth: 8, socketDepth: 5, available: true, verified: true, note: '' },
  { key: 'JIS-B-1176:2014:M12:P1.75', size: 'M12', d: 12, pitch: 1.75, headDiameter: 18, headHeight: 12, socketWidth: 10, socketDepth: 6, available: true, verified: true, note: '' },
  { key: 'JIS-B-1176:2014:M14:P2', size: 'M14', d: 14, pitch: 2, headDiameter: 21, headHeight: 14, socketWidth: 12, socketDepth: 7, available: true, verified: true, note: '第2選択。' },
  { key: 'JIS-B-1176:2014:M16:P2', size: 'M16', d: 16, pitch: 2, headDiameter: 24, headHeight: 16, socketWidth: 14, socketDepth: 8, available: true, verified: true, note: '' },
  { key: 'JIS-B-1176:2014:M18:P2.5', size: 'M18', d: 18, pitch: 2.5, headDiameter: 27, headHeight: 18, socketWidth: 14, socketDepth: null, available: false, verified: false, note: '現行JISの規定外で六角穴深さも欠測。選択不可。' },
  { key: 'JIS-B-1176:2014:M20:P2.5', size: 'M20', d: 20, pitch: 2.5, headDiameter: 30, headHeight: 20, socketWidth: 17, socketDepth: 10, available: true, verified: true, note: '' },
] as const satisfies readonly SocketHeadCapScrewRow[];

export const PAN_HEAD_SCREW_SOURCE = {
  standard: 'JIS B 1111', edition: '2017', title: '\u5341\u5b57\u7a74\u4ed8\u304d\u306a\u3079\u5c0f\u306d\u3058',
  scope: '\u9644\u5c5e\u66f8\u5bf8\u6cd5\u306eM3\u301cM8\u3001\u4e26\u76ee\u30fb\u7d30\u76ee\u306d\u3058',
  sourceUrls: [
    'https://www.yura-sansyo.co.jp/handbook/handbookV8-6.pdf',
    'https://www.onoue1950.co.jp/products/koneji/jujikoneji/1667/',
    'https://webdesk.jsa.or.jp/books/W11M0090/index/?bunsyo_id=JIS+B+1111:2017',
  ],
  verified: false,
} as const satisfies StandardTableSource;

export const PAN_HEAD_SCREW_TABLE = [
  { key: 'JIS-B-1111:2017:M3', size: 'M3', d: 3.0, pitch: 0.5, headDiameter: 5.5, headHeight: 2, recessNumber: 2, verified: false, note: '\u9644\u5c5e\u66f8(\u65e7JIS)\u306e\u5024\u3002\u672c\u4f53\u898f\u683c\u306e\u5024\u3068\u98df\u3044\u9055\u3046\u53ef\u80fd\u6027\u304c\u3042\u308b\u3002\u8981\u78ba\u8a8d\u3002' },
  { key: 'JIS-B-1111:2017:M4', size: 'M4', d: 4.0, pitch: 0.7, headDiameter: 7, headHeight: 2.6, recessNumber: 2, verified: false, note: '\u9644\u5c5e\u66f8(\u65e7JIS)\u306e\u5024\u3002\u672c\u4f53\u898f\u683c\u306e\u5024\u3068\u98df\u3044\u9055\u3046\u53ef\u80fd\u6027\u304c\u3042\u308b\u3002\u8981\u78ba\u8a8d\u3002' },
  { key: 'JIS-B-1111:2017:M5', size: 'M5', d: 5.0, pitch: 0.8, headDiameter: 9, headHeight: 3.3, recessNumber: 2, verified: false, note: '\u9644\u5c5e\u66f8(\u65e7JIS)\u306e\u5024\u3002\u672c\u4f53\u898f\u683c\u306e\u5024\u3068\u98df\u3044\u9055\u3046\u53ef\u80fd\u6027\u304c\u3042\u308b\u3002\u8981\u78ba\u8a8d\u3002' },
  { key: 'JIS-B-1111:2017:M6', size: 'M6', d: 6.0, pitch: 1, headDiameter: 10.5, headHeight: 3.9, recessNumber: 3, verified: false, note: '\u9644\u5c5e\u66f8(\u65e7JIS)\u306e\u5024\u3002\u672c\u4f53\u898f\u683c\u306e\u5024\u3068\u98df\u3044\u9055\u3046\u53ef\u80fd\u6027\u304c\u3042\u308b\u3002\u8981\u78ba\u8a8d\u3002' },
  { key: 'JIS-B-1111:2017:M8', size: 'M8', d: 8.0, pitch: 1.25, headDiameter: 14, headHeight: 5.2, recessNumber: 3, verified: false, note: '\u9644\u5c5e\u66f8(\u65e7JIS)\u306e\u5024\u3002\u672c\u4f53\u898f\u683c\u306e\u5024\u3068\u98df\u3044\u9055\u3046\u53ef\u80fd\u6027\u304c\u3042\u308b\u3002\u8981\u78ba\u8a8d\u3002' },
] as const satisfies readonly PanHeadScrewRow[];

export function findHexBolt(
  size: string, dimensionSeries: FastenerDimensionSeries = 'annexJA',
): HexBoltRow | undefined {
  return HEX_BOLT_TABLE.find((row) => row.size === size && row.dimensionSeries === dimensionSeries);
}

export function findHexNut(
  size: string, dimensionSeries: FastenerDimensionSeries = 'annexJA',
): HexNutRow | undefined {
  return HEX_NUT_TABLE.find((row) => row.size === size && row.dimensionSeries === dimensionSeries);
}

export function findPanHeadScrew(size: string): PanHeadScrewRow | undefined {
  return PAN_HEAD_SCREW_TABLE.find((row) => row.size === size);
}

export function findPlainWasher(size: string): PlainWasherRow | undefined {
  return PLAIN_WASHER_TABLE.find((row) => row.size === size);
}

export function findSpringWasher(size: string): SpringWasherRow | undefined {
  return SPRING_WASHER_TABLE.find((row) => row.size === size);
}

export function findSocketHeadCapScrew(size: string): SocketHeadCapScrewRow | undefined {
  return SOCKET_HEAD_CAP_SCREW_TABLE.find((row) => row.size === size && row.available);
}
