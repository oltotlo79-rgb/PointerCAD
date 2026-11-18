/**
 * 部品の差し替え・取り込み直しの後に、作り直しを勧める締結(J-02 P8)。純関数だけ。
 *
 * 板の部品が替わっても、締結のボルト・ナット・座金は前の板に合わせた物のまま残る。差し替えた部品(取り込み直しでは
 * 同じ元部品を使う全部の配置)を板に持つ締結の記録を挙げ、「作り直す」で今ある「直す」の窓(記録した選び方と指定で
 * 計画し直し、締結部品を入れ替える。元に戻す 1 回)を開く。板の位置・当てる面が変わって直せない時は、直す窓が
 * 今までの理由(直すと板が動く など)を出す。保存はしない(表示だけの状態)。
 */
import { boltedJointRecords, type AssemblyDocument, type PartLibrary } from '@pointercad/model';

/** 作り直しを待つ締結の 1 つ。板の部品の出どころの版を覚え、元に戻して版が違う間は数えない。 */
interface BoltedJointRebuildEntry {
  readonly recordId: string;
  readonly componentId: string;
  readonly revision: string;
}

export interface BoltedJointRebuildNotice {
  readonly documentId: string;
  readonly pending: readonly BoltedJointRebuildEntry[];
}

/** 部品の出どころの版(元部品の参照と内容のハッシュ)。元部品の文書を持たない部品は null。 */
function componentRevision(document: AssemblyDocument, library: PartLibrary, componentId: string): string | null {
  const source = document.components.find((component) => component.id === componentId)?.source;
  if (source?.kind !== 'part') return null;
  const file = library.partFiles.find((candidate) => candidate.ref === source.partRef);
  return file === undefined ? null : `${source.partRef}@${file.contentHash}:${file.attachmentsDigest}`;
}

/** 差し替え・取り込み直しの直後の文書で、替わった部品を板に持つ締結を挙げる。1 つも無ければ null。 */
export function boltedJointRebuildNotice(documentId: string, document: AssemblyDocument, library: PartLibrary,
  componentIds: readonly string[]): BoltedJointRebuildNotice | null {
  const changed = new Set(componentIds);
  const pending: BoltedJointRebuildEntry[] = [];
  for (const record of boltedJointRecords(document)) {
    for (const componentId of [record.first.componentId, record.second.componentId]) {
      const revision = changed.has(componentId) ? componentRevision(document, library, componentId) : null;
      if (revision !== null) pending.push({ recordId: record.id, componentId, revision });
    }
  }
  return pending.length === 0 ? null : { documentId, pending };
}

/** 同じ元部品(取り込み直した元部品)を使う、一番上の組立の配置。 */
export function componentsUsingPart(document: AssemblyDocument, partRef: string): readonly string[] {
  return document.components.filter((component) => component.source.kind === 'part' && component.source.partRef === partRef)
    .map((component) => component.id);
}

/**
 * 今も作り直しを待つ締結の記録の id(重なりなし・挙げた順)。別の文書・記録が消えた・板の版が違う(差し替えを元に
 * 戻した)締結は数えない。
 */
export function pendingBoltedJointRebuilds(notice: BoltedJointRebuildNotice | null, documentId: string,
  document: AssemblyDocument | null, library: PartLibrary): readonly string[] {
  if (notice === null || document === null || notice.documentId !== documentId) return [];
  const records = new Set(boltedJointRecords(document).map((record) => record.id));
  const ids: string[] = [];
  for (const entry of notice.pending) {
    if (records.has(entry.recordId) && !ids.includes(entry.recordId)
      && componentRevision(document, library, entry.componentId) === entry.revision) ids.push(entry.recordId);
  }
  return ids;
}

/** 作り直した(直す窓で確定した)締結を、待つ一覧から外す。残りが無ければ null。 */
export function withoutRebuiltRecord(notice: BoltedJointRebuildNotice, recordId: string): BoltedJointRebuildNotice | null {
  const pending = notice.pending.filter((entry) => entry.recordId !== recordId);
  return pending.length === 0 ? null : { ...notice, pending };
}
