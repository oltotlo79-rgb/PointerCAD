/** GR-31: create a coefficient referring to a current measurement, in one Undo entry. */
import { mathGeometryParameterDraft, prepareDocumentMathIdentity,
  type MathGeometryValueUnit, type PartDocument } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { commitAddParameter } from '../parameters/parameterCommands.js';
import type { AppState } from '../store/appState.js';
import { activePartDocument } from '../store/documentKind.js';
import { currentMathGeometry, type MathGeometryResultState } from './mathGeometryResults.js';

export type MathGeometryParameterCommandState = MathGeometryResultState & Pick<AppState, 'applyDocument'>;
export type MathGeometryParameterCommandReason =
  | 'noValue' | 'notFound' | 'duplicateName' | 'invalidName' | 'notPart' | 'staleDocument';

const REFUSAL_KEYS = {
  noValue: 'mathGeometry.createParameter.disabled.noValue',
  // A removed definition has no usable value either; there is no dedicated notFound message key.
  notFound: 'mathGeometry.createParameter.disabled.noValue',
  duplicateName: 'mathGeometry.createParameter.disabled.duplicateName',
  invalidName: 'mathGeometry.createParameter.disabled.invalidName',
  notPart: 'mathGeometry.disabled.notPart',
  staleDocument: 'math.operation.cancelled',
} as const satisfies Record<MathGeometryParameterCommandReason, MessageKey>;

export type MathGeometryParameterCommandResult =
  | { readonly ok: true; readonly name: string; readonly key: 'mathGeometry.createParameter.notice'; readonly message: string }
  | { readonly ok: false; readonly reason: MathGeometryParameterCommandReason;
      readonly key: typeof REFUSAL_KEYS[MathGeometryParameterCommandReason]; readonly message: string };

function refuse(reason: MathGeometryParameterCommandReason): MathGeometryParameterCommandResult {
  const key = REFUSAL_KEYS[reason];
  return { ok: false, reason, key, message: t(key) };
}

/** The stored description names the internal measured unit, regardless of display-unit settings. */
const UNIT_KEYS = {
  mm: 'numericInput.unit.mm',
  mm2: 'propertyPanel.unitSquareMillimeter',
  mm3: 'propertyPanel.unitCubicMillimeter',
  degree: 'mathGeometry.unit.degree',
  radian: 'mathGeometry.unit.radian',
} as const satisfies Record<MathGeometryValueUnit, MessageKey>;

/**
 * GR-19b calls this with the latest store state and the document owning the clicked row.
 * No Worker or intermediate document is published. Refusals leave both document and Undo untouched;
 * success returns the localized notice (and its key/name) for the panel to display.
 */
export function createParameterFromMathGeometryCommand(state: MathGeometryParameterCommandState,
  owner: PartDocument, definitionId: string): MathGeometryParameterCommandResult {
  if (activePartDocument(state) === null) return refuse('notPart');
  if (state.document !== owner) return refuse('staleDocument');
  const current = currentMathGeometry(state);
  if (current.status !== 'current') return refuse('noValue');
  const definition = owner.mathGeometry?.find(item => item.id === definitionId);
  if (definition === undefined) return refuse('notFound');
  const outcome = current.outcomes.get(definitionId);
  if (outcome?.status !== 'value' || outcome.kind !== 'real' || outcome.documentId !== owner.id
    || outcome.id !== definitionId || outcome.generation !== current.generation) return refuse('noValue');

  const name = definition.name + t('mathGeometry.createParameter.nameSuffix');
  const quantity = definition.quantity;
  const kind = t(quantity.kind === 'coordinate'
    ? `mathGeometry.kind.coordinate.${quantity.component}` : `mathGeometry.kind.${quantity.kind}`);
  const description = t('mathGeometry.createParameter.description')
    .replace('{name}', () => definition.name).replace('{kind}', () => kind).replace('{unit}', () => t(UNIT_KEYS[outcome.unit]));
  const draft = mathGeometryParameterDraft(owner, definitionId, { name, value: outcome.value, unit: outcome.unit, description });
  if (!draft.ok) return refuse(draft.reason);
  // Match ParameterMathDialog: migrate identities privately and accept them with the formula atomically.
  // Preparing even an empty table sets serial=0; commitAddParameter then assigns the first ID as well.
  const added = commitAddParameter(prepareDocumentMathIdentity(owner), draft.parameter);
  if (!added.ok) return refuse(added.reason === 'duplicateName' ? 'duplicateName' : 'invalidName');
  state.applyDocument(added.document);
  const key = 'mathGeometry.createParameter.notice';
  return { ok: true, name, key, message: t(key).replace('{name}', () => name) };
}
