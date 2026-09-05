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
  /**
   * 完全に決まったスケッチ要素の色(FR-313、利用者の決定②(2026-09-05)、P4b タスク22b)。
   * 動かせる数が 1 つも残っていない要素だけをこの色で描き、まだ決まっていない要素は
   * 既定色(`sketchCurve` / `sketchPoint`)のままにする。判定は `constrainedElements.ts`。
   * 選択・ホバーの青が優先なので、この色と青が同時に出ることはない。
   * 5 テーマすべてで、ビューポートの地(`--pcad-viewport-top` / `--pcad-viewport-bottom`)
   * に対して 3:1 以上の明度差を持つ(実測は `themeColors.test.ts`)。
   */
  readonly sketchConstrained: number;
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
  /**
   * トリムで消える区間の強調(FR-322、P4 タスク22)。マウスを乗せた区間だけをこの色で
   * 重ねて描き、クリックするとそこが消える(§0.a-0.26 の利用者の決定)。
   * 「消える」を示す色なので、ホバー・選択の青とは別の赤系にする。
   * 延長の予告はホバーと同じ色を薄く使うので、専用の欄は持たない。
   */
  readonly trimRemove: number;
  /**
   * 向きの吸着の案内線(FR-110、P4b タスク16)。細い破線で画面いっぱいに引く線の色で、
   * **吸着の印(`--pcad-accent`)と同じアクセント色**にする(§0.14 の利用者の決定)。
   * 5 テーマすべてで、ビューポートの地(`--pcad-viewport-top` / `--pcad-viewport-bottom`)
   * に対して 3:1 以上の明度差を持つ(実測は `themeColors.test.ts`)。
   */
  readonly track: number;
  /**
   * 拘束の印(FR-313、P4b タスク13、§0.a-0.7 の①)。要素の脇に出す記号の色を状態で
   * 分ける(統括の指示「満たしている / 冗長は薄い / 矛盾は赤 / 動かない点は鍵」)。
   * 5 テーマすべてで、ビューポートの地(`--pcad-viewport-top` / `--pcad-viewport-bottom`)
   * に対して 3:1 以上の明度差を持つ(実測は `themeColors.test.ts`)。
   */
  readonly constraintOk: number;
  /** 足しすぎ(冗長)の印。満たしている印より弱い色にして「消してよい」と見せる。 */
  readonly constraintRedundant: number;
  /** 同時に成り立たない・指す先が消えた印。直すべきものなので赤系。 */
  readonly constraintConflict: number;
  /** 「固定」の印。動かない点であることを、他の拘束と別の色で見分ける。 */
  readonly constraintFixed: number;
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
  // 完全に決まった要素(P4b タスク22b)。ダークの値は appShell.css の :root と同じ。
  sketchConstrained: 0x7ee08a,
  hovered: 0x8ec5ff,
  selected: 0x4f8cff,
  solid: 0xb8bfcc,
  solidEdgeOverSolid: 0x0f1115,
  solidEdgeWireframe: 0xd6dae2,
  threadMark: 0x8a93a6,
  workPlane: 0x4f8cff,
  trimRemove: 0xff6b6b,
  // ダークの --pcad-accent と同じ値(吸着の印と同じアクセント色、§0.14)。
  track: 0x4f8cff,
  // 拘束の印(P4b タスク13)。ダークの値は appShell.css の :root と同じ。
  constraintOk: 0x5ad1c8,
  constraintRedundant: 0xc8a04a,
  constraintConflict: 0xff6b6b,
  constraintFixed: 0xc08cff,
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
 * 欄と CSS トークンの対応。`appShell.css` のテーマごとの塊にこの 31 個がそろっていること
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
  sketchConstrained: '--pcad-sketch-constrained',
  hovered: '--pcad-emphasis-hovered',
  selected: '--pcad-emphasis-selected',
  solid: '--pcad-solid',
  solidEdgeOverSolid: '--pcad-solid-edge',
  solidEdgeWireframe: '--pcad-solid-edge-wireframe',
  threadMark: '--pcad-thread-mark',
  workPlane: '--pcad-work-plane',
  trimRemove: '--pcad-trim-remove',
  track: '--pcad-track',
  constraintOk: '--pcad-constraint-ok',
  constraintRedundant: '--pcad-constraint-redundant',
  constraintConflict: '--pcad-constraint-conflict',
  constraintFixed: '--pcad-constraint-fixed',
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
    sketchConstrained: colors.sketchConstrained,
    hovered: colors.hovered,
    selected: colors.selected,
    solid: colors.solid,
    solidEdgeOverSolid: colors.solidEdgeOverSolid,
    solidEdgeWireframe: colors.solidEdgeWireframe,
    threadMark: colors.threadMark,
    workPlane: colors.workPlane,
    trimRemove: colors.trimRemove,
    track: colors.track,
    constraintOk: colors.constraintOk,
    constraintRedundant: colors.constraintRedundant,
    constraintConflict: colors.constraintConflict,
    constraintFixed: colors.constraintFixed,
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
