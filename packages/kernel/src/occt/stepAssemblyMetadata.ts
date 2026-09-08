/** OCCT の STEP writer が失った配置名を復元できないときの断り。 */
export const ASSEMBLY_METADATA_WRITE_MESSAGE =
  'アセンブリの部品名を STEP ファイルへ書き込めませんでした。';

const OCCURRENCE_NAME_PREFIX = '__POINTERCAD_OCCURRENCE_';
const OCCURRENCE_ID_PREFIX = '__PCAD_NAUO_ID_';

/** 書き手へ一時的に渡す、ASCIIだけの配置名。 */
export interface StepAssemblyOccurrenceName {
  readonly index: number;
  readonly token: string;
  readonly name: string | null;
}

/** 配置名の一時印を作る。1始まりの番号はSTEP内の識別子にも使う。 */
export function stepAssemblyOccurrenceName(
  index: number,
  name: string | null,
): StepAssemblyOccurrenceName {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999_999) {
    throw new Error(ASSEMBLY_METADATA_WRITE_MESSAGE);
  }
  return {
    index,
    token: `${OCCURRENCE_NAME_PREFIX}${String(index).padStart(6, '0')}__`,
    name,
  };
}

/** STEP の文字列リテラルでは、単一引用符を2個へ重ねる。 */
function escapeStepString(value: string): string {
  return value.replaceAll("'", "''");
}

function hexName(name: string | null): string {
  if (name === null) return 'N';
  const bytes = new TextEncoder().encode(name);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `U${hex}`;
}

function occurrenceId(occurrence: StepAssemblyOccurrenceName): string {
  return `${OCCURRENCE_ID_PREFIX}${String(occurrence.index).padStart(6, '0')}_${(
    hexName(occurrence.name)
  )}__`;
}

/**
 * NAUOごとに一時印を探し、OCCTの通算idと一時名を安定した値へ置き換える。
 * 名前が第何引数へ出るかには依存しない。
 */
export function normalizeStepAssemblyMetadata(
  bytes: Uint8Array,
  occurrences: readonly StepAssemblyOccurrenceName[],
): Uint8Array {
  const unused = new Map(occurrences.map((occurrence) => [occurrence.token, occurrence]));
  let normalizedCount = 0;
  const text = new TextDecoder().decode(bytes);
  const normalized = text.replace(
    /(NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\()'((?:[^']|'')*)'([^;]*;)/g,
    (whole, prefix: string, _sourceId: string, tail: string) => {
      const tokens = [...new Set(whole.match(/__POINTERCAD_OCCURRENCE_\d{6}__/g) ?? [])];
      if (tokens.length !== 1) return whole;
      const token = tokens[0];
      if (token === undefined) return whole;
      const occurrence = unused.get(token);
      if (occurrence === undefined) return whole;
      unused.delete(occurrence.token);
      normalizedCount += 1;
      const restoredTail = tail.replaceAll(
        `'${occurrence.token}'`,
        `'${escapeStepString(occurrence.name ?? '')}'`,
      );
      return `${prefix}'${occurrenceId(occurrence)}'${restoredTail}`;
    },
  );
  if (unused.size > 0 || normalizedCount !== occurrences.length) {
    throw new Error(ASSEMBLY_METADATA_WRITE_MESSAGE);
  }
  return new TextEncoder().encode(normalized);
}

/** OCCTが配置名の代わりにNAUOのidを返したとき、埋め込んだ元名へ戻す。 */
export function decodeStepAssemblyOccurrenceName(value: string | null): string | null {
  if (value === null || !value.startsWith(OCCURRENCE_ID_PREFIX)) return value;
  const match = /^__PCAD_NAUO_ID_\d{6}_(N|U[0-9a-f]*)__$/.exec(value);
  if (match === null) return value;
  const payload = match[1];
  if (payload === 'N') return null;
  const hex = payload.slice(1);
  if (hex.length % 2 !== 0) return value;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) return value;
    bytes[index] = byte;
  }
  return new TextDecoder().decode(bytes);
}
