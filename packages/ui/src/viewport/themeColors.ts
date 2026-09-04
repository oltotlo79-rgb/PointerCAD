/**
 * 3D 表示の色を画面のテーマから読み取る(計画書 docs/plans/P4-スケッチ拡張.md タスク2、
 * §0.a-0.1、§2.2)。
 *
 * 対応要件: FR-908(表示テーマの切替。**切り替えは再起動なしに即時反映**)。
 *
 * three.js は CSS のカスタムプロパティを読めないので、これまで各層
 * (`createViewportScene.ts` / `createSketchLayer.ts` / `createSolidLayer.ts`)は
 * 16 進の定数を直接持っていた。テーマを切り替えても 3D の中身だけダークのままになるため、
 * **色の正本を `appShell.css` の `--pcad-*` トークン 1 か所へ寄せ**、ここが
 * `getComputedStyle` で読んで 16 進へ直す。
 *
 * この場所の分け方: 文字列を数へ直す部分(`parseCssColor` / `themeColorsFrom`)は
 * DOM に触れない純関数にして Node で検査でき(ui に jsdom は入れない)、DOM を見るのは
 * `readThemeColors` の 1 関数だけにする。
 *
 * **ダークの見た目は変えない。** `DEFAULT_THEME_COLORS` は各層が持っていた定数の値
 * そのままで、`appShell.css` の `:root`(= ダーク)にも同じ値を書いた。
 * 両者が食い違わないことは `themeColors.test.ts` が CSS を読んで固定する。
 */

/** 3D 表示で使う色。すべて 0xRRGGBB の整数(three.js の `setHex` にそのまま渡せる)。 */
export interface ThemeColors {
  /** 方眼の副線(FR-104)。 */
  readonly gridMinor: number;
  /** 方眼の主線(FR-104)。 */
  readonly gridMajor: number;
  readonly axisX: number;
  readonly axisY: number;
  readonly axisZ: number;
  /** スケッチの点・線/円弧・面の縁。 */
  readonly sketchPoint: number;
  readonly sketchCurve: number;
  readonly sketchOutline: number;
  /** ホバー・選択の強調(FR-106)。スケッチと立体で同じ色にそろえる。 */
  readonly hovered: number;
  readonly selected: number;
  /** 立体の既定色と、稜線(面の上に重ねるとき / 線だけの表示のとき)。 */
  readonly solid: number;
  readonly solidEdgeOverSolid: number;
  readonly solidEdgeWireframe: number;
  /** ねじの簡略表示の印。 */
  readonly threadMark: number;
  /** 作図面の薄い矩形。 */
  readonly workPlane: number;
  /** 半球光の地面側の色。明るいテーマでは立体の下面が沈みすぎないよう明るくする。 */
  readonly sceneGround: number;
  /**
   * ビューキューブの 6 面(P4 タスク2 仕上げ、docs/報告記録.md 2026-09-04 14:05)。
   * 面ごとに明るさを変えて立体に見せる(上・前・右から光が当たっている想定)。
   */
  readonly viewCubeFaceTop: number;
  readonly viewCubeFaceFront: number;
  readonly viewCubeFaceRight: number;
  readonly viewCubeFaceLeft: number;
  readonly viewCubeFaceBack: number;
  readonly viewCubeFaceBottom: number;
  /** ビューキューブの稜線。 */
  readonly viewCubeEdge: number;
  /** ビューキューブの面の文字。 */
  readonly viewCubeText: number;
}

/**
 * 既定(ダーク)の色。**P0〜P3 で各層が持っていた定数と同じ値**で、
 * テーマのトークンが読めない場面(まだ CSS が効いていない・値が壊れている)の後退先も兼ねる。
 */
export const DEFAULT_THEME_COLORS: ThemeColors = {
  gridMinor: 0x343945,
  gridMajor: 0x454b59,
  axisX: 0xe5484d,
  axisY: 0x46a758,
  axisZ: 0x3e63dd,
  sketchPoint: 0xe8eaf0,
  sketchCurve: 0x9aa3b2,
  sketchOutline: 0x6b7380,
  hovered: 0x8ec5ff,
  selected: 0x4f8cff,
  solid: 0xb8bfcc,
  solidEdgeOverSolid: 0x0f1115,
  solidEdgeWireframe: 0xd6dae2,
  threadMark: 0x8a93a6,
  workPlane: 0x4f8cff,
  sceneGround: 0x3a3f4a,
  // ビューキューブ(P0〜P3 で faceTexture.ts / createViewCubeScene.ts が直接持っていた定数)。
  viewCubeFaceTop: 0xeef1f6,
  viewCubeFaceFront: 0xe3e7ee,
  viewCubeFaceRight: 0xdfe3ea,
  viewCubeFaceLeft: 0xcbd0da,
  viewCubeFaceBack: 0xc6cbd6,
  viewCubeFaceBottom: 0xb6bcc9,
  viewCubeEdge: 0x8a91a0,
  viewCubeText: 0x1f2430,
};

/**
 * 欄と CSS トークンの対応。`appShell.css` のテーマごとの塊にこの 24 個がそろっていること
 * (どのテーマでも 1 つも欠けないこと)は `themeColors.test.ts` が固定する。
 */
export const THEME_COLOR_TOKENS: Readonly<Record<keyof ThemeColors, string>> = {
  gridMinor: '--pcad-grid-minor',
  gridMajor: '--pcad-grid-major',
  axisX: '--pcad-axis-x',
  axisY: '--pcad-axis-y',
  axisZ: '--pcad-axis-z',
  sketchPoint: '--pcad-sketch-point',
  sketchCurve: '--pcad-sketch-curve',
  sketchOutline: '--pcad-sketch-outline',
  hovered: '--pcad-emphasis-hovered',
  selected: '--pcad-emphasis-selected',
  solid: '--pcad-solid',
  solidEdgeOverSolid: '--pcad-solid-edge',
  solidEdgeWireframe: '--pcad-solid-edge-wireframe',
  threadMark: '--pcad-thread-mark',
  workPlane: '--pcad-work-plane',
  sceneGround: '--pcad-scene-ground',
  viewCubeFaceTop: '--pcad-viewcube-face-top',
  viewCubeFaceFront: '--pcad-viewcube-face-front',
  viewCubeFaceRight: '--pcad-viewcube-face-right',
  viewCubeFaceLeft: '--pcad-viewcube-face-left',
  viewCubeFaceBack: '--pcad-viewcube-face-back',
  viewCubeFaceBottom: '--pcad-viewcube-face-bottom',
  viewCubeEdge: '--pcad-viewcube-edge',
  viewCubeText: '--pcad-viewcube-text',
};

const COLOR_FIELDS: readonly (keyof ThemeColors)[] = Object.keys(
  THEME_COLOR_TOKENS,
) as readonly (keyof ThemeColors)[];

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
/** `rgb(18 58 138)` と `rgba(18, 58, 138, 0.7)` の両方。透過は 3D では使わないので読み飛ばす。 */
const RGB_FUNCTION = /^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)\s*(?:[,/][^)]*)?\)$/i;

const MAX_CHANNEL = 255;

function channelsToHex(red: number, green: number, blue: number): number | null {
  if (red > MAX_CHANNEL || green > MAX_CHANNEL || blue > MAX_CHANNEL) {
    return null;
  }
  return (red << 16) + (green << 8) + blue;
}

/**
 * CSS の色の文字列を 0xRRGGBB の整数へ直す。読めない書き方(`oklch(...)` や空文字)は null。
 *
 * カスタムプロパティは `getComputedStyle().getPropertyValue()` が**書いたままの文字列**を
 * 返す(色として解決されない)ので、`appShell.css` で使っている `#rrggbb` と `rgb(...)` の
 * 2 通りを読めれば足りる。短い `#rgb` も念のため読む。
 */
export function parseCssColor(text: string): number | null {
  const trimmed = text.trim();
  const short = HEX_SHORT.exec(trimmed);
  if (short !== null) {
    // #abc は #aabbcc の略記。1 桁を 2 桁へ広げる。
    return channelsToHex(
      Number.parseInt(`${short[1]}${short[1]}`, 16),
      Number.parseInt(`${short[2]}${short[2]}`, 16),
      Number.parseInt(`${short[3]}${short[3]}`, 16),
    );
  }
  const long = HEX_LONG.exec(trimmed);
  if (long !== null) {
    return channelsToHex(
      Number.parseInt(long[1], 16),
      Number.parseInt(long[2], 16),
      Number.parseInt(long[3], 16),
    );
  }
  const rgb = RGB_FUNCTION.exec(trimmed);
  if (rgb !== null) {
    return channelsToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  return null;
}

/**
 * トークンを読む相手を引数で受けて色一式を組み立てる(純関数。検査では偽の読み手を渡す)。
 * 読めなかった欄だけ既定(ダーク)へ後退するので、1 つ壊れても他は生きる
 * (`settings.ts` の「1 つ壊れたら全部捨てる」とは判断が違う。表示の色は欄ごとに独立していて、
 * 一部が既定でも画面は成立するため)。
 */
export function themeColorsFrom(read: (token: string) => string): ThemeColors {
  const colors: Record<string, number> = {};
  for (const field of COLOR_FIELDS) {
    colors[field] = parseCssColor(read(THEME_COLOR_TOKENS[field])) ?? DEFAULT_THEME_COLORS[field];
  }
  // 全欄をこの場で埋めたので、ThemeColors として読み直せる。
  return {
    gridMinor: colors.gridMinor,
    gridMajor: colors.gridMajor,
    axisX: colors.axisX,
    axisY: colors.axisY,
    axisZ: colors.axisZ,
    sketchPoint: colors.sketchPoint,
    sketchCurve: colors.sketchCurve,
    sketchOutline: colors.sketchOutline,
    hovered: colors.hovered,
    selected: colors.selected,
    solid: colors.solid,
    solidEdgeOverSolid: colors.solidEdgeOverSolid,
    solidEdgeWireframe: colors.solidEdgeWireframe,
    threadMark: colors.threadMark,
    workPlane: colors.workPlane,
    sceneGround: colors.sceneGround,
    viewCubeFaceTop: colors.viewCubeFaceTop,
    viewCubeFaceFront: colors.viewCubeFaceFront,
    viewCubeFaceRight: colors.viewCubeFaceRight,
    viewCubeFaceLeft: colors.viewCubeFaceLeft,
    viewCubeFaceBack: colors.viewCubeFaceBack,
    viewCubeFaceBottom: colors.viewCubeFaceBottom,
    viewCubeEdge: colors.viewCubeEdge,
    viewCubeText: colors.viewCubeText,
  };
}

/**
 * `parseCssColor` の逆変換。0xRRGGBB の整数を、canvas や three.js の材質へ渡せる
 * `#rrggbb` の文字列に直す(ビューキューブの面はテクスチャに焼き込むので、色を
 * 数のまま渡せない。`createFaceTexture` がここを使う)。
 */
export function cssColor(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * いま画面に効いているテーマの色を読む(FR-908 の即時反映)。
 * ルート要素の `data-theme` が変わった後に呼ぶと、そのテーマの値が返る。
 */
export function readThemeColors(root: Element = globalThis.document.documentElement): ThemeColors {
  const style = globalThis.getComputedStyle(root);
  return themeColorsFrom((token) => style.getPropertyValue(token));
}
