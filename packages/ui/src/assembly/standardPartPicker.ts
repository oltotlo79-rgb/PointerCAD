import { evaluateExpression } from '@pointercad/expression';
import {
  createStandardPartSource, DEEP_GROOVE_BALL_BEARINGS, EQUAL_ANGLE_TABLE,
  type FastenerDimensionSeries, HEX_BOLT_TABLE, HEX_NUT_TABLE, H_BEAM_TABLE, CHANNEL_TABLE,
  PAN_HEAD_SCREW_TABLE, PLAIN_WASHER_TABLE, SOCKET_HEAD_CAP_SCREW_TABLE,
  SPRING_WASHER_TABLE, type StandardCatalogId, type StandardPartSource, type ThreadSeries,
} from '@pointercad/model';

export type StandardPartCategory =
  | 'hexBolt'
  | 'hexNut'
  | 'plainWasher'
  | 'springWasher'
  | 'socketHeadCapScrew'
  | 'panHeadScrew'
  | 'deepGrooveBallBearing'
  | 'structuralSection';

export interface StandardPartChoice {
  readonly key: string;
  readonly catalog: StandardCatalogId;
  readonly size: string;
  readonly dimensionSeries?: FastenerDimensionSeries;
  readonly verified: boolean;
  readonly note: string;
  readonly requiresLength: boolean;
}

export interface StandardPartPickerDefaults {
  readonly category: StandardPartCategory;
  readonly choiceKey: string;
  readonly lengthSource: string;
  readonly dimensionSeries: FastenerDimensionSeries;
  readonly threadSeries: ThreadSeries;
}

export interface StandardPartCommit {
  readonly source: StandardPartSource;
  readonly name: string;
}

export type StandardPartCommitResult =
  | { readonly ok: true; readonly value: StandardPartCommit }
  | { readonly ok: false; readonly reason: 'unknownChoice' | 'invalidLength' };

export const STANDARD_PART_CATEGORIES: readonly StandardPartCategory[] = [
  'hexBolt', 'hexNut', 'plainWasher', 'springWasher', 'socketHeadCapScrew',
  'panHeadScrew', 'deepGrooveBallBearing', 'structuralSection',
];

export function standardPartUsesDimensionSeries(category: StandardPartCategory): boolean {
  return category === 'hexBolt' || category === 'hexNut';
}

export function standardPartUsesThreadSeries(category: StandardPartCategory): boolean {
  return category === 'hexBolt' || category === 'hexNut' || category === 'socketHeadCapScrew'
    || category === 'panHeadScrew';
}

function choicesFromRows(
  catalog: StandardCatalogId,
  rows: readonly { readonly key: string; readonly size: string; readonly verified: boolean;
    readonly note: string; readonly dimensionSeries?: FastenerDimensionSeries }[],
  requiresLength: boolean,
): readonly StandardPartChoice[] {
  return rows.map((row) => ({
    key: `${catalog}:${row.key}`,
    catalog,
    size: row.size,
    ...(row.dimensionSeries === undefined ? {} : { dimensionSeries: row.dimensionSeries }),
    verified: row.verified,
    note: row.note,
    requiresLength,
  }));
}

const CHOICES: Readonly<Record<StandardPartCategory, readonly StandardPartChoice[]>> = {
  hexBolt: choicesFromRows('hexBolt', HEX_BOLT_TABLE, false),
  hexNut: choicesFromRows('hexNut', HEX_NUT_TABLE, false),
  plainWasher: choicesFromRows('plainWasher', PLAIN_WASHER_TABLE, false),
  springWasher: choicesFromRows('springWasher', SPRING_WASHER_TABLE, false),
  socketHeadCapScrew: choicesFromRows(
    'socketHeadCapScrew', SOCKET_HEAD_CAP_SCREW_TABLE.filter((row) => row.available), false,
  ),
  panHeadScrew: choicesFromRows('panHeadScrew', PAN_HEAD_SCREW_TABLE, false),
  deepGrooveBallBearing: choicesFromRows('deepGrooveBallBearing', DEEP_GROOVE_BALL_BEARINGS, false),
  structuralSection: [
    ...choicesFromRows('equalAngle', EQUAL_ANGLE_TABLE, true),
    ...choicesFromRows('channel', CHANNEL_TABLE, true),
    ...choicesFromRows('hBeam', H_BEAM_TABLE, true),
  ],
};

const DEFAULT_DIMENSION_SERIES: FastenerDimensionSeries = 'annexJA';
const DEFAULT_THREAD_SERIES: ThreadSeries = 'coarse';
const defaultBoltChoices = CHOICES.hexBolt.filter(
  (choice) => choice.dimensionSeries === DEFAULT_DIMENSION_SERIES,
);

export const DEFAULT_STANDARD_PART_PICKER: StandardPartPickerDefaults = {
  category: 'hexBolt',
  choiceKey: defaultBoltChoices.find((choice) => choice.size === 'M8')?.key
    ?? defaultBoltChoices[0].key,
  lengthSource: '30',
  dimensionSeries: DEFAULT_DIMENSION_SERIES,
  threadSeries: DEFAULT_THREAD_SERIES,
};

export function standardPartChoices(
  category: StandardPartCategory,
  dimensionSeries: FastenerDimensionSeries = DEFAULT_DIMENSION_SERIES,
): readonly StandardPartChoice[] {
  return standardPartUsesDimensionSeries(category)
    ? CHOICES[category].filter((choice) => choice.dimensionSeries === dimensionSeries)
    : CHOICES[category];
}

export function defaultStandardPartChoice(
  category: StandardPartCategory,
  dimensionSeries: FastenerDimensionSeries = DEFAULT_DIMENSION_SERIES,
): StandardPartChoice {
  const choices = standardPartChoices(category, dimensionSeries);
  if (category === DEFAULT_STANDARD_PART_PICKER.category
    && dimensionSeries === DEFAULT_STANDARD_PART_PICKER.dimensionSeries) {
    const preferred = choices.find((choice) => choice.key === DEFAULT_STANDARD_PART_PICKER.choiceKey);
    if (preferred !== undefined) return preferred;
  }
  const first = choices[0];
  if (first === undefined) throw new Error(`No standard-part choices: ${category}/${dimensionSeries}`);
  return first;
}

export function findStandardPartChoice(
  category: StandardPartCategory,
  choiceKey: string,
  dimensionSeries: FastenerDimensionSeries = DEFAULT_DIMENSION_SERIES,
): StandardPartChoice | undefined {
  return standardPartChoices(category, dimensionSeries).find((choice) => choice.key === choiceKey);
}

function partName(choice: StandardPartChoice, length: string): string {
  switch (choice.catalog) {
    case 'hexBolt': return `\u516d\u89d2\u30dc\u30eb\u30c8 ${choice.size}\u00d7${length}`;
    case 'hexNut': return `\u516d\u89d2\u30ca\u30c3\u30c8 ${choice.size}`;
    case 'plainWasher': return `\u5e73\u5ea7\u91d1 ${choice.size}`;
    case 'springWasher': return `\u3070\u306d\u5ea7\u91d1 ${choice.size}`;
    case 'socketHeadCapScrew': return `\u516d\u89d2\u7a74\u4ed8\u304d\u30dc\u30eb\u30c8 ${choice.size}\u00d7${length}`;
    case 'panHeadScrew': return `\u5341\u5b57\u7a74\u4ed8\u304d\u306a\u3079\u5c0f\u306d\u3058 ${choice.size}\u00d7${length}`;
    case 'deepGrooveBallBearing': return `\u6df1\u6e9d\u7389\u8ef8\u53d7 ${choice.size}`;
    case 'equalAngle':
    case 'channel':
    case 'hBeam':
      return `${choice.size} \u9577\u3055${length}`;
  }
}

/** Convert a picker choice into the stable source persisted by an assembly document. */
export function commitStandardPartChoice(
  category: StandardPartCategory,
  choiceKey: string,
  lengthSource: string,
  dimensionSeries: FastenerDimensionSeries = DEFAULT_DIMENSION_SERIES,
  threadSeries: ThreadSeries = DEFAULT_THREAD_SERIES,
): StandardPartCommitResult {
  const choice = findStandardPartChoice(category, choiceKey, dimensionSeries);
  if (choice === undefined) return { ok: false, reason: 'unknownChoice' };
  const length = choice.requiresLength ? evaluateExpression(lengthSource) : null;
  if (length !== null && (!length.ok || length.value.value <= 0)) {
    return { ok: false, reason: 'invalidLength' };
  }
  const normalizedLength = length?.ok === true ? length.value.source : '30';
  const options: Record<string, string> = {};
  if (choice.requiresLength || choice.catalog === 'hexBolt'
    || choice.catalog === 'socketHeadCapScrew' || choice.catalog === 'panHeadScrew') {
    options.length = normalizedLength;
  }
  if (standardPartUsesDimensionSeries(category)) options.dimensionSeries = dimensionSeries;
  if (standardPartUsesThreadSeries(category)) options.threadSeries = threadSeries;
  return {
    ok: true,
    value: {
      source: createStandardPartSource(choice.catalog, choice.size, options),
      name: partName(choice, normalizedLength),
    },
  };
}
