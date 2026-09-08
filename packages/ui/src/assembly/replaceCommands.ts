import { writeAssemblyDocument } from '@pointercad/io';
import {
  SUB_ASSEMBLY_CYCLE_MESSAGE,
  addComponent,
  applyReplacement,
  createComponentFor,
  detectSubAssemblyProblem,
  planReplacement,
  type AssemblyComponent,
  type AssemblyDocument,
  type AssemblyDocumentBundle,
  type ComponentSource,
  type EmbeddedPartAttachments,
  type PartDocument,
  type PartLibrary,
  type ReplacementPlan,
  type SolidBody,
} from '@pointercad/model';

export type PlaceSubAssemblyResult =
  | {
      readonly ok: true;
      readonly document: AssemblyDocument;
      readonly library: PartLibrary;
      readonly component: AssemblyComponent;
    }
  | { readonly ok: false; readonly message: string };

function sameStoredAssembly(left: AssemblyDocument, right: AssemblyDocument): boolean {
  const savedAt = '1970-01-01T00:00:00.000Z';
  return writeAssemblyDocument(left, { savedAt }) === writeAssemblyDocument(right, { savedAt });
}

function nextRef(prefix: string, occupied: Set<string>): string {
  let serial = 1;
  while (occupied.has(`${prefix}${serial}`)) serial += 1;
  const ref = `${prefix}${serial}`;
  occupied.add(ref);
  return ref;
}

function remapDocument(
  document: AssemblyDocument,
  partRefs: ReadonlyMap<string, string>,
  assemblyRefs: ReadonlyMap<string, string>,
): AssemblyDocument {
  return {
    ...document,
    components: document.components.map((component) => {
      const source = component.source;
      if (source.kind === 'part') {
        return { ...component, source: { ...source, partRef: partRefs.get(source.partRef) ?? source.partRef } };
      }
      if (source.kind === 'subAssembly') {
        return { ...component, source: { ...source, assemblyRef: assemblyRefs.get(source.assemblyRef) ?? source.assemblyRef } };
      }
      return component;
    }),
  };
}

/** `.pcada` 一式の参照を現在の名前空間へ写し、1つの剛体として末尾へ置く。 */
export function placeSubAssemblyBundle(
  document: AssemblyDocument,
  library: PartLibrary,
  bundle: AssemblyDocumentBundle,
  currentFileDocument?: AssemblyDocument,
): PlaceSubAssemblyResult {
  // `AssemblyDocument.id` は文書内のローカルIDで、新規文書はどれも `assembly-1` になる。
  // 同じ保存ファイルを選んだときだけ、呼び手が最後に保存した文書を渡して内容で照合する。
  const sameCurrentFile = currentFileDocument !== undefined
    && sameStoredAssembly(bundle.document, currentFileDocument);
  if (bundle.document === document || sameCurrentFile) {
    return { ok: false, message: SUB_ASSEMBLY_CYCLE_MESSAGE };
  }

  const occupiedParts = new Set([
    ...library.parts.keys(),
    ...library.partFiles.map((file) => file.ref),
  ]);
  const partRefs = new Map<string, string>();
  for (const ref of bundle.embeddedDocuments.keys()) partRefs.set(ref, nextRef('part-', occupiedParts));

  const occupiedAssemblies = new Set(library.assemblies?.keys() ?? []);
  const assemblyRefs = new Map<string, string>();
  for (const ref of bundle.embeddedAssemblies.keys()) {
    assemblyRefs.set(ref, nextRef('assembly-', occupiedAssemblies));
  }
  const rootRef = nextRef('assembly-', occupiedAssemblies);

  const parts = new Map(library.parts);
  const attachments = new Map(library.attachments);
  for (const [ref, embedded] of bundle.embeddedDocuments) {
    const mapped = partRefs.get(ref);
    if (mapped === undefined) continue;
    parts.set(mapped, embedded.document);
    attachments.set(mapped, embedded.attachments);
  }
  const importedFiles = bundle.partFiles.flatMap((file) => {
    const ref = partRefs.get(file.ref);
    return ref === undefined ? [] : [{ ...file, ref }];
  });
  const assemblies = new Map(library.assemblies ?? []);
  for (const [ref, embedded] of bundle.embeddedAssemblies) {
    const mapped = assemblyRefs.get(ref);
    if (mapped !== undefined) assemblies.set(mapped, remapDocument(embedded.document, partRefs, assemblyRefs));
  }
  assemblies.set(rootRef, remapDocument(bundle.document, partRefs, assemblyRefs));

  const nextLibrary: PartLibrary = {
    partFiles: [...library.partFiles, ...importedFiles],
    parts,
    attachments,
    assemblies,
  };
  const component = createComponentFor(document, { kind: 'subAssembly', assemblyRef: rootRef }, {
    partName: bundle.document.name,
  });
  const nextDocument = addComponent(document, component);
  const problem = detectSubAssemblyProblem(nextDocument, assemblies);
  if (problem !== null) return { ok: false, message: problem.message };
  return { ok: true, document: nextDocument, library: nextLibrary, component };
}

export interface PreparedReplacement {
  readonly plan: ReplacementPlan;
  readonly requiresConfirmation: boolean;
}

export interface AssemblyReplacementPreview {
  readonly documentId: string;
  readonly prepared: PreparedReplacement;
  readonly library: PartLibrary;
}

/** カーネルを所有する入口が差し出す、新しい部品を予告用に一度だけ計算する口。 */
export interface AssemblyReplacementRunner {
  readonly resolve: (
    document: PartDocument,
    attachments: EmbeddedPartAttachments,
    requestId: string,
  ) => Promise<readonly SolidBody[]>;
}

/** 新しい形との対応を調べ、選び直せない参照があるときだけ確認を要求する。 */
export function prepareComponentReplacement(
  document: AssemblyDocument,
  componentId: string,
  source: ComponentSource,
  bodies: readonly SolidBody[],
): PreparedReplacement | null {
  const plan = planReplacement(document, componentId, source, { bodies });
  return plan === null ? null : { plan, requiresConfirmation: plan.unmatchedCount > 0 };
}

/** 予告済みの計画だけを確定する。予告の前後で計画を作り直さない。 */
export function confirmComponentReplacement(prepared: PreparedReplacement): AssemblyDocument {
  return applyReplacement(prepared.plan);
}
