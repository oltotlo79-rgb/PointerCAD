/**
 * 規格部品の選ぶ窓の「寸法の図と表」(K-07c)。窓の欄の下の閉じた塊 1 つで、開くと選んだ行の線図(私たちの形の台本の作図面の線と弧。
 * 資料の図は使わない)と寸法の表を出す。開いた・閉じたはアプリを閉じるまで覚える(設定にも文書にも持たない。K-07b の D1 と同じ)。
 * 欄・釦は足さない(見出しの summary は Tab で止まり、Enter・Space で開閉する)。図は role=img と幅・高さの入った名前を持ち、中の線と数は読み上げない。
 */
import { type MessageKey, t } from '../i18n/t.js';
import { displayNumber } from '../sketch/numericInputPresentation.js';
import type { DimensionFigurePart } from './dimensionTable.js';
import { cachedPartOutline } from './partOutline.js';
import './dimensionFigure.css';

/** 塊を開いているか(窓を開き直しても、分類を替えても同じ。アプリを閉じるまで)。 */
let figureOpen = false;

type Outline = NonNullable<ReturnType<typeof cachedPartOutline>>;

/** 図の読み上げの名前(外形の幅と高さ。有効 6 桁)。 */
function figureLabel(widthMm: number, heightMm: number): string {
  return t('catalog.dimensionFigure.label').replace('{width}', displayNumber(widthMm).text).replace('{height}', displayNumber(heightMm).text);
}

function outlineSvg(outline: Outline): React.JSX.Element {
  const { widthLine, heightLine } = outline;
  return <svg className="pcad-dimension-figure__svg" role="img" width={outline.viewWidth} height={outline.viewHeight}
    viewBox={`0 0 ${String(outline.viewWidth)} ${String(outline.viewHeight)}`}
    aria-label={figureLabel(widthLine.valueMm, heightLine.valueMm)}>
    <g aria-hidden="true">
      {outline.paths.map((path, index) => <path key={index} className="pcad-dimension-figure__outline" d={path} />)}
      <path className="pcad-dimension-figure__dimension" d={widthLine.path} />
      <path className="pcad-dimension-figure__dimension" d={heightLine.path} />
      <text className="pcad-dimension-figure__value" x={widthLine.textX} y={widthLine.textY} textAnchor="middle">
        {`${displayNumber(widthLine.valueMm).text} mm`}</text>
      <text className="pcad-dimension-figure__value" x={heightLine.textX} y={heightLine.textY} textAnchor="start">
        {`${displayNumber(heightLine.valueMm).text} mm`}</text>
    </g>
  </svg>;
}

function dimensionTable(rows: DimensionFigurePart['rows']): React.JSX.Element {
  return <table className="pcad-dimension-figure__table">
    <caption>{t('catalog.dimensionFigure.tableCaption')}</caption>
    <thead><tr>
      <th scope="col">{t('catalog.dimensionFigure.name')}</th>
      <th scope="col">{t('catalog.dimensionFigure.value')}</th>
      <th scope="col">{t('catalog.dimensionFigure.unit')}</th>
    </tr></thead>
    <tbody>{rows.map((row) => {
      const shown = displayNumber(row.value);
      return <tr key={row.key}><th scope="row">{t(row.label)}</th>
        <td className="pcad-dimension-figure__number" title={shown.full}>{shown.text}</td><td>{row.unit}</td></tr>;
    })}</tbody>
  </table>;
}

/** 印の種類ごとの文の鍵(種類を足した時に書き漏れると型検査で分かる)。 */
const MARK_MESSAGES: Readonly<Record<DimensionFigurePart['marks'][number]['kind'], MessageKey>> = {
  unverified: 'catalog.dimensionFigure.unverified', simplified: 'catalog.dimensionFigure.simplified', toolScreen: 'catalog.dimensionFigure.toolScreen',
};

function markLines(marks: DimensionFigurePart['marks']): React.JSX.Element[] {
  return marks.map((mark) => {
    const parts = mark.kind === 'toolScreen' ? mark.parts.map((key) => t(key)) : mark.parts;
    return <p key={mark.kind} role="status">{t(MARK_MESSAGES[mark.kind]).replace('{parts}', parts.join(t('display.listSeparator')))}</p>;
  });
}

export function DimensionFigure({ part }: { readonly part: DimensionFigurePart | null }): React.JSX.Element | null {
  if (part === null) return null;
  const outline = cachedPartOutline(part.key, part.build);
  if (outline === null && part.rows.length === 0 && part.marks.length === 0) return null;
  return <details className="pcad-popover__hint pcad-dimension-figure" open={figureOpen}
    onToggle={(event) => { figureOpen = event.currentTarget.open; }}>
    <summary title={t('catalog.dimensionFigure.guide')}>{t('catalog.dimensionFigure.title')}</summary>
    {outline === null ? <p>{t('catalog.dimensionFigure.noFigure')}</p> : <>
      {outlineSvg(outline)}
      <p>{t('catalog.dimensionFigure.scale')}</p>
    </>}
    {part.rows.length === 0 ? null : dimensionTable(part.rows)}
    {markLines(part.marks)}
  </details>;
}
