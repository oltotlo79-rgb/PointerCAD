import { weldGeometry, type DrawingDocument, type DrawingRenderElement, type InkBounds } from '@pointercad/drawing';
import {
  linkedWeldIssues, resolveLinkedWeld, weldDisplaySides,
  type DrawingSourceLibrary, type LinkedWeldData, type ResolvedWeldSymbol,
} from '@pointercad/model';
import { t } from '../i18n/t.js';
import type { DrawingGdtDisplay } from './gdtDisplay.js';
import type { OutlineDrawingText } from './dimensionDisplay.js';

type RenderText = NonNullable<DrawingRenderElement['texts']>[number];
const mm = (value: number): string => String(Number(value.toFixed(6)));

/**
 * 結び付けた溶接の実際の値の補足の一覧(溶接記号ではなく技術データ)。各ビードの始点・終点・長さ、ビードの間の
 * 間隔、2 脚、範囲を、溶接線に沿った mm で 1 行ずつ。
 */
export function linkedWeldSupplementLines(data: LinkedWeldData): readonly string[] {
  return [
    t('drawing.weld.linked.title').replace('{weld}', data.weldId),
    t('drawing.weld.linked.legs').replace('{second}', mm(data.legOnSecond)).replace('{first}', mm(data.legOnFirst)),
    t('drawing.weld.linked.extent').replace('{start}', mm(data.extent.start)).replace('{end}', mm(data.extent.end))
      .replace('{contact}', mm(data.contactLength)),
    ...data.beads.map((bead, index) => t('drawing.weld.linked.bead').replace('{index}', String(index + 1))
      .replace('{start}', mm(bead.start)).replace('{end}', mm(bead.end)).replace('{length}', mm(bead.length))),
    ...data.gaps.map((gap, index) => t('drawing.weld.linked.gap').replace('{index}', String(index + 1)).replace('{length}', mm(gap))),
  ];
}

/**
 * 補足の文字の紙上の範囲。字形を計れた行は基線の位置に字の墨の範囲(`inkBounds`)を足した枠、計れない行
 * (字体の読み込み前・欠字)は 1 字を文字高の正方形と見なした控えめに大きい枠にする(選べない文字を作らない)。
 */
function textBounds(texts: readonly RenderText[], outline: OutlineDrawingText): InkBounds | null {
  const boxes = texts.map((text): InkBounds => {
    const metrics = outline(text.text, text.sizeMm).metrics;
    return metrics === null
      ? { left: text.position[0], right: text.position[0] + [...text.text].length * text.sizeMm, bottom: text.position[1] - text.sizeMm * 0.3,
        top: text.position[1] + text.sizeMm }
      : { left: text.position[0] + metrics.inkBounds.left, right: text.position[0] + metrics.inkBounds.right,
        bottom: text.position[1] + metrics.inkBounds.bottom, top: text.position[1] + metrics.inkBounds.top };
  });
  return boxes.length === 0 ? null : { left: Math.min(...boxes.map((box) => box.left)), right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.min(...boxes.map((box) => box.bottom)), top: Math.max(...boxes.map((box) => box.top)) };
}

/**
 * 溶接記号の表示。`library` を渡すと、溶接へ結び付けた記号を抱き込んだ元の組立の溶接と照合する
 * (`linkedWeldIssues`)。照合の理由がある記号は形を描けても解決していない(赤)として扱い、溶接記号の 1 組で
 * 表せない溶接には補足の一覧を記号の下へ文字で添える。返す `bounds` は記号と補足の文字の両方を含む(画面で
 * 選ぶ時の当たり判定に使われる)。結び付けていない記号は従来どおり。
 */
export function displayDrawingWelds(document: DrawingDocument, resolution: readonly ResolvedWeldSymbol[], outline: OutlineDrawingText,
  library?: DrawingSourceLibrary): readonly DrawingGdtDisplay[] {
  return resolution.map((original) => {
    const link = original.symbol.weldId === undefined || library === undefined ? null : resolveLinkedWeld(document, library, original.symbol.weldId);
    const resolved: ResolvedWeldSymbol = link === null ? original : { ...original, issues: [...original.issues, ...linkedWeldIssues(original, link)] };
    const linked = link?.kind === 'linked' && link.data.limitations.length > 0 ? link.data : null;
    const symbol = document.weldSymbols.find((item) => item.id === resolved.symbol.id) ?? resolved.symbol;
    const sides = weldDisplaySides(resolved);
    const geometry = sides === null || resolved.feature === null ? null : weldGeometry({ ...symbol, sides,
      target: resolved.feature.paperPoint, measure: (text, height) => outline(text, height).metrics });
    const messages = resolved.issues.map((issue) => issue.message);
    if (geometry === null && messages.length === 0) messages.push('記号・文字・矢を配置できません。文字高と紙上位置を確認してください。');
    const fallback: InkBounds = { left: symbol.position[0], bottom: symbol.position[1], right: symbol.position[0] + 16, top: symbol.position[1] + 7 };
    const symbolBounds = geometry?.bounds ?? fallback;
    const unresolved = geometry === null || resolved.issues.some((issue) => issue.code === 'linkedWeld');
    const supplement: RenderText[] = linked === null ? [] : linkedWeldSupplementLines(linked).map((text, index) => ({ text, sizeMm: symbol.height,
      position: [symbolBounds.left, symbolBounds.bottom - (index + 1) * symbol.height * 1.6] }));
    const supplementBounds = textBounds(supplement, outline);
    const bounds: InkBounds = supplementBounds === null ? symbolBounds : {
      left: Math.min(symbolBounds.left, supplementBounds.left), right: Math.max(symbolBounds.right, supplementBounds.right),
      bottom: Math.min(symbolBounds.bottom, supplementBounds.bottom), top: Math.max(symbolBounds.top, supplementBounds.top) };
    const texts: readonly RenderText[] = geometry?.texts ?? [{ text: '?', sizeMm: 3.5, position: [symbol.position[0] + 2, symbol.position[1] + 2] }];
    return { id: symbol.id, bounds, unresolved, messages,
      element: { ownerId: symbol.id, layerId: symbol.layerId, style: unresolved ? { color: '#b91c1c' } : symbol.style,
        curves: geometry?.curves ?? [{ kind: 'polyline', points: [[fallback.left, fallback.bottom], [fallback.right, fallback.bottom],
          [fallback.right, fallback.top], [fallback.left, fallback.top]], closed: true }], fills: geometry?.fills,
        texts: [...texts, ...supplement] } };
  });
}
