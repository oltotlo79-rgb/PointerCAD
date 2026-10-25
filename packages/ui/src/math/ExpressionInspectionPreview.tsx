import type { ParameterUnit } from '@pointercad/model';
import { t } from '../i18n/t.js';
import type { InputExpressionInspection } from './expressionInspectionContext.js';
import './expressionInspection.css';

export interface ExpressionInspectionPreviewProps {
  readonly id: string;
  readonly context: InputExpressionInspection | null;
  readonly unitLabel: string;
  readonly unitHeading?: string;
  readonly parameterUnits?: ReadonlyMap<string, ParameterUnit>;
  /** One occurrence in one owned expression is one site, including repeated owners. */
  readonly usageCounts?: ReadonlyMap<string, number>;
  /** Features depending on the names directly or indirectly; absent (shown as unconfirmed) when it cannot be counted. */
  readonly affectedPartCount?: number;
  readonly showErrorPosition?: boolean;
}

function markedSource(source: string, position: number): React.JSX.Element {
  if (position === source.length) {
    return <code>{source}<mark className="pcad-expression-inspection__end" aria-hidden="true">│</mark></code>;
  }
  const point = source.codePointAt(position);
  const end = position + (point !== undefined && point > 0xffff ? 2 : 1);
  return <code>{source.slice(0, position)}<mark>{source.slice(position, end)}</mark>{source.slice(end)}</code>;
}

/** Pure presentation: no document or editor-state writes, and no focusable controls. */
export function ExpressionInspectionPreview({ id, context, unitLabel, unitHeading, parameterUnits, usageCounts,
  affectedPartCount, showErrorPosition = true }: ExpressionInspectionPreviewProps): React.JSX.Element | null {
  if (context === null) return null;
  const { inspection, references, errorPosition } = context;
  if (references.length === 0 && inspection.units.length === 0 && (!showErrorPosition || errorPosition === null)) return null;
  return <aside id={id} className="pcad-expression-inspection" aria-label={t('inspection.title')} aria-live="polite">
    <p>{unitHeading ?? t('inspection.unit')}: {unitLabel}</p>
    {inspection.units.length === 0 ? null : <p>{t('inspection.explicitUnits')}: {
      inspection.units.map(unit => inspection.source.slice(unit.start, unit.end)).join(t('inspection.listSeparator'))
    }</p>}
    {references.length === 0 ? null : <>
      <p>{t('inspection.references')}</p>
      <ul>{references.map((reference, index) => {
        const unit = parameterUnits?.get(reference.name);
        const count = usageCounts?.get(reference.name);
        return <li key={`${String(reference.start)}-${String(index)}`}>
          <code>{inspection.source.slice(reference.start, reference.end)}</code>
          {' '}({String(reference.start + 1)}{t('inspection.character')}){t('inspection.positionSeparator')}
          {reference.circular ? t('inspection.circular') : reference.value === null ? t('inspection.unresolved')
            : `${String(reference.value)}${unit === 'degree' ? '°' : unit === 'mm' ? ' mm' : ''}`}
          {' · '}{t('inspection.usageSites')}: {count === undefined ? t('inspection.unknown') : String(count)}
        </li>;
      })}</ul>
      <p>{t('inspection.affectedParts')}: {affectedPartCount === undefined ? t('inspection.unknown') : String(affectedPartCount)}</p>
    </>}
    {showErrorPosition && errorPosition !== null ? <p className="pcad-expression-inspection__error">
      {t('inspection.errorLocation')}: {String(errorPosition + 1)}{t('inspection.character')}{' '}
      {markedSource(inspection.source, errorPosition)}
    </p> : null}
  </aside>;
}
