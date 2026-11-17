/**
 * 族: 資料 GF-2(パイプ形のフレームの総合カタログ)で寸法が確認できる、パイプの端のキャップとフット(2 族。統括の決定 2026-11-17 19:1x・19:2x・20:2x)。
 * 製造元の名前・型番は書かない(呼びは合うパイプの系列・種類の一般の語・段の寸法)。
 *
 * 形は段の並び(`profiles/stackedPart.ts`): 中心の線のまわりに、2 本の独立の読みで形・寸法・高さが一致した段だけを積む(円柱か四角の柱)。
 * 決まらない段(差し込みの寸法の記入が無いなど)から先は作らず、行の簡略の印に「差し込み（寸法の記入が無いため作っていない）」の形で出す。
 * おねじは呼びの径の円柱(ねじの山は入れない)。めねじ・付属品のボルト・頭の球面・面取り・十字の切り欠きは作らず印に出す。
 * 質量は資料の 1 個の値(2 本が一致した物)。密度の表に無い材料(LDPE・導電 PP・PU・NBR・部位ごとに材料の違う物)の行は密度の材質を持たない。
 * 行の表 `pipeFramePartRows.ts` は担当の道具が生成し、検査が照らす側の読み(fixture)と 1 行ずつ照らす。
 */
import { withName } from '../../standard/partPrimitives.js';
import { buildStackedPart, stackedPartHeight, stackedPartVolume, type StackedPartDimensions, type StackSegment } from '../profiles/stackedPart.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';
import { PIPE_FRAME_CAP_RECORDS, PIPE_FRAME_FOOT_RECORDS } from './pipeFramePartRows.js';

/** キャップとフットの行(道具が生成する。数は資料の記入のまま。段は 2 本の読みで一致した物だけ)。 */
export interface PipeFramePartRecord {
  readonly key: string;
  readonly size: string;
  /** 合うパイプの外径の呼び(19・28・43・53)。 */
  readonly series: number;
  /** 種類の一般の語(差し込みのキャップ・かぶせるキャップ・端面のキャップ・キャップ・フットコネクタ・アジャスター・ゴムの足・フット)。 */
  readonly kind: string;
  readonly page: number;
  readonly materialLabel: string;
  /** 密度の材質(密度の表に無い材料の行は null)。 */
  readonly densityMaterialId: 'nylon' | 'abs' | 'aluminum' | null;
  readonly segments: readonly StackSegment[];
  readonly thread: { readonly size: string; readonly length: number } | null;
  /** 資料の 1 個の質量(g。記入が無い行は null。その行は密度の材質を持つ)。 */
  readonly massG: number | null;
  readonly simplified: readonly string[];
}

const GENERATOR_REVISION = 'pipe-frame-part-1';
const EVIDENCE_TITLE = '資料 GF-2 パイプ形のフレームの総合カタログ(製造元の寸法に合わせた物)';

function dimensionsOf(record: PipeFramePartRecord): StackedPartDimensions {
  return { segments: record.segments, thread: record.thread };
}

function noteOf(record: PipeFramePartRecord): string {
  const mass = record.massG === null ? '質量は資料に記入が無いので、形 × 密度' : '質量は資料の 1 個の値';
  return record.simplified.length > 0 ? `形は簡略(${record.simplified.join('・')})。${mass}` : mass;
}

function rowOf(record: PipeFramePartRecord): CatalogItemRow {
  return {
    key: record.key,
    size: record.size,
    standardLabel: '製造元の寸法に合わせた物',
    materialLabel: record.materialLabel,
    ...(record.densityMaterialId === null ? {} : { densityMaterialId: record.densityMaterialId }),
    dims: { series: record.series, height: stackedPartHeight(dimensionsOf(record)), ...(record.massG === null ? {} : { massG: record.massG }) },
    evidence: { title: EVIDENCE_TITLE, edition: null, url: '', locator: `PDF ${record.page} 頁 部品の図(段の寸法)と質量の記入`, sha256: '',
      fetchedDate: '' },
    verification: 'manufacturer-catalog',
    verified: true,
    note: noteOf(record),
    simplified: record.simplified,
  };
}

function stackedFamily(id: string, kindKey: string, diagram: CatalogFamily['diagram'], records: readonly PipeFramePartRecord[]): CatalogFamily {
  const byKey = new Map(records.map((record) => [record.key, record]));
  const dims = (row: CatalogItemRow): StackedPartDimensions | null => {
    const record = byKey.get(row.key);
    return record === undefined ? null : dimensionsOf(record);
  };
  return {
    id, group: 'aluminumFrame', kindKey, catalogRevision: `${id}-2026-11-r1`, generatorRevision: GENERATOR_REVISION, options: [], stock: 'count',
    diagram, rows: records.map(rowOf),
    build: (row) => {
      const found = dims(row);
      const part = found === null ? null : buildStackedPart(found);
      return part === null ? null : withName(part, row.size);
    },
    nominalVolume: (row) => {
      const found = dims(row);
      return found === null ? null : stackedPartVolume(found);
    },
    // 1 個の質量(g)。資料の値。記入の無い行は null(部品表が形の体積 × 行の密度で出す)。
    nominalMassG: (row) => {
      const mass = row.dims.massG ?? NaN;
      return mass > 0 ? mass : null;
    },
    partName: (row) => row.size,
  };
}

export const PIPE_FRAME_CAP_FAMILY = stackedFamily('pipe-frame-cap', 'catalog.frame.kind.pipeFrameCap', 'pipeFrameCap', PIPE_FRAME_CAP_RECORDS);

export const PIPE_FRAME_FOOT_FAMILY = stackedFamily('pipe-frame-foot', 'catalog.frame.kind.pipeFrameFoot', 'pipeFrameFoot', PIPE_FRAME_FOOT_RECORDS);
