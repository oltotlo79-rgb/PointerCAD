/** 使用する公開APIだけを宣言する。2.0.0は型定義を同梱しない。実字体probeで照合済み。 */
declare module 'opentype.js' {
  export interface Font {
    readonly unitsPerEm: number;
    charToGlyphIndex(character: string): number;
    getAdvanceWidth(text: string, fontSize: number): number;
    getPath(text: string, x: number, y: number, fontSize: number): {
      readonly commands: readonly import('./textOutline.js').GlyphPathCommand[];
    };
  }
  export function parse(buffer: ArrayBuffer): Font;
}
