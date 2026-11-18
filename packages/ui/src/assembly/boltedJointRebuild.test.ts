import {
  addComponent, createAssemblyDocument, createComponentFor, createEmptyPartDocument, emptyEmbeddedPartAttachments,
  type AssemblyDocument, type BoltedJointRecord, type PartLibrary, type SubShapeRef,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  boltedJointRebuildNotice, componentsUsingPart, pendingBoltedJointRebuilds, withoutRebuiltRecord,
} from './boltedJointRebuild.js';

beforeEach(resetTestStore);

const ref: SubShapeRef = { bodyFeatureId: 'body', index: 1,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } };

function library(revisions: Readonly<Record<string, string>>): PartLibrary {
  const refs = Object.keys(revisions);
  return { parts: new Map(refs.map((name) => [name, createEmptyPartDocument()])),
    attachments: new Map(refs.map((name) => [name, emptyEmbeddedPartAttachments()])),
    partFiles: refs.map((name) => ({ ref: name, fileName: `${name}.pcad`, path: `${name}.pcad`, contentHash: revisions[name] ?? '',
      attachmentsDigest: 'empty', importedAt: '2026-11-18T00:00:00Z' })) };
}

function record(id: string, first: string, second: string, parts: readonly string[]): BoltedJointRecord {
  const pick = (componentId: string) => ({ componentId, holeFeatureId: 'hole', holeFace: ref, matingFace: ref });
  return { id, first: pick(first), second: pick(second), choices: { dimensionSeries: 'main', headWashers: [], nutWashers: [] },
    componentIds: parts };
}

/** 板 2 枚(同じ元部品 plate)と板 1 枚(別の元部品 other)、締結の部品 2 つ。締結は 板1−板2 と 板2−板3 の 2 本。 */
function joined(): AssemblyDocument {
  let document = createAssemblyDocument('締結');
  for (const source of [{ kind: 'part', partRef: 'plate' }, { kind: 'part', partRef: 'plate' }, { kind: 'part', partRef: 'other' },
    { kind: 'part', partRef: 'bolt' }, { kind: 'part', partRef: 'bolt' }] as const) {
    document = addComponent(document, createComponentFor(document, source, {}));
  }
  return { ...document, boltedJoints: [record('bolted-joint-1', 'component-1', 'component-2', ['component-4']),
    record('bolted-joint-2', 'component-2', 'component-3', ['component-5'])] };
}

describe('部品が替わった締結を、作り直しを待つ一覧にする(J-02 P8)', () => {
  it('替わった部品を板に持つ締結だけを挙げ、無ければ null', () => {
    const document = joined(), parts = library({ plate: 'rev-2', other: 'rev-1', bolt: 'rev-1' });
    const notice = boltedJointRebuildNotice('doc', document, parts, ['component-3']);
    expect(notice?.pending.map((entry) => entry.recordId)).toEqual(['bolted-joint-2']);
    expect(boltedJointRebuildNotice('doc', document, parts, ['component-4'])).toBeNull();
    expect(componentsUsingPart(document, 'plate')).toEqual(['component-1', 'component-2']);
    const shared = boltedJointRebuildNotice('doc', document, parts, componentsUsingPart(document, 'plate'));
    expect(pendingBoltedJointRebuilds(shared, 'doc', document, parts)).toEqual(['bolted-joint-1', 'bolted-joint-2']);
  });

  it('別の文書・消えた記録・版が戻った板(差し替えを元に戻した)は数えず、直した締結は一覧から外す', () => {
    const document = joined(), parts = library({ plate: 'rev-2', other: 'rev-1', bolt: 'rev-1' });
    const notice = boltedJointRebuildNotice('doc', document, parts, componentsUsingPart(document, 'plate'));
    expect(pendingBoltedJointRebuilds(notice, 'other-doc', document, parts)).toEqual([]);
    expect(pendingBoltedJointRebuilds(notice, 'doc', { ...document, boltedJoints: [] }, parts)).toEqual([]);
    expect(pendingBoltedJointRebuilds(notice, 'doc', document, library({ plate: 'rev-1', other: 'rev-1', bolt: 'rev-1' }))).toEqual([]);
    if (notice === null) throw new Error('notice');
    const rest = withoutRebuiltRecord(notice, 'bolted-joint-1');
    expect(pendingBoltedJointRebuilds(rest, 'doc', document, parts)).toEqual(['bolted-joint-2']);
    expect(rest === null ? null : withoutRebuiltRecord(rest, 'bolted-joint-2')).toBeNull();
  });

  it('store: 作り直すは待つ締結の 1 つ目を直す窓で開き、閉じると一覧を消す。待つ物が無ければ開かない', () => {
    const document = joined(), parts = library({ plate: 'rev-2', other: 'rev-1', bolt: 'rev-1' });
    useAppStore.getState().openAssembly(document, parts);
    const opened = useAppStore.getState().assembly ?? document;
    const state = useAppStore.getState();
    useAppStore.setState({ assemblyBoltedJointRebuild: boltedJointRebuildNotice(state.activeDocumentId, opened, parts, ['component-3']) });
    expect(useAppStore.getState().beginBoltedJointRebuild()).toBe(true);
    expect(useAppStore.getState().assemblyBoltedJointDraft?.editRecordId).toBe('bolted-joint-2');
    expect(useAppStore.getState().assembly).toBe(opened);
    useAppStore.getState().cancelBoltedJoint();
    useAppStore.getState().dismissBoltedJointRebuild();
    expect(useAppStore.getState().assemblyBoltedJointRebuild).toBeNull();
    useAppStore.setState({ assemblyBoltedJointRebuild: { documentId: 'other-doc', pending: [] } });
    expect(useAppStore.getState().beginBoltedJointRebuild()).toBe(false);
    expect(useAppStore.getState().assemblyBoltedJointRebuild).toBeNull();
    expect(useAppStore.getState().assemblyBoltedJointDraft).toBeNull();
  });
});
