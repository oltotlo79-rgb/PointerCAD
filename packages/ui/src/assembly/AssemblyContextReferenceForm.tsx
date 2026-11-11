import { useState } from 'react';
import { type AssemblyDocument, type ContextReferenceLink, type ContextReferenceRejectionCode, createSubShapeReference, findComponent, type SubShapeRef } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { contextBodiesOf, runContextReferenceCommit, type ContextReferenceCommandResult } from './contextReferenceCommand.js';

/** Keep the model's specific refusal codes intact and require a distinct translated reason for every code. */
export const CONTEXT_REFERENCE_REJECTION_MESSAGES = {
  targetComponentMissing: 'assembly.context.reason.targetComponentMissing',
  sourceComponentMissing: 'assembly.context.reason.sourceComponentMissing',
  targetNotEmbeddedPart: 'assembly.context.reason.targetNotEmbeddedPart',
  samePart: 'assembly.context.reason.samePart',
  targetReferenceMissing: 'assembly.context.reason.targetReferenceMissing',
  targetReferenceNotPoint: 'assembly.context.reason.targetReferenceNotPoint',
  sourceUnresolved: 'assembly.context.reason.sourceUnresolved',
  invalidPlacement: 'assembly.context.reason.invalidPlacement',
  cyclicReference: 'assembly.context.reason.cyclicReference',
  unsupportedSource: 'assembly.context.reason.unsupportedSource',
  targetPartShared: 'assembly.context.reason.targetPartShared',
  duplicateTarget: 'assembly.context.reason.duplicateTarget',
} as const satisfies Record<ContextReferenceRejectionCode, MessageKey>;

/** 選んだ基準点を今決めている結び付け。結び付けは先の配置と基準点の組で1つ(model・io が断る重複は作らない)。 */
export function contextLinkOfPoint(
  document: AssemblyDocument, componentId: string, pointId: string,
): ContextReferenceLink | undefined {
  return document.contextReferences?.find(link => link.targetComponentId === componentId && link.targetReferenceId === pointId);
}

/**
 * 確定する結び付け。選んだ基準点に結び付けがあれば、その id のまま元を置き換える(別の基準点の結び付けは変えない)。
 * 無ければ新しい id で作る。
 */
export function contextLinkToCommit(
  document: AssemblyDocument, componentId: string, pointId: string, sourceComponentId: string, source: SubShapeRef,
): ContextReferenceLink {
  const existing = contextLinkOfPoint(document, componentId, pointId);
  let serial = 1;
  while ((document.contextReferences ?? []).some(link => link.id === `context-${String(serial)}`)) serial += 1;
  return { id: existing?.id ?? `context-${String(serial)}`, targetComponentId: componentId, targetReferenceId: pointId,
    sourceComponentId, source };
}

/**
 * 組立の文脈の参照(EX-18)。選んだ置いた部品(先)の基準点を、別に置いた部品(元)の面の中心に合わせる。
 * 選んだ基準点の結び付けは同じ id のまま「参照から更新」で計算し直す。確定は `runContextReferenceCommit` だけを通す。
 */
export function AssemblyContextReferenceForm(props: { readonly componentId: string }): React.JSX.Element | null {
  const document = useAppStore(state => state.assembly);
  const library = useAppStore(state => state.assemblyLibrary);
  const view = useAppStore(state => state.assemblyView);
  const computing = useAppStore(state => state.isComputing);
  const target = document === null ? undefined : findComponent(document, props.componentId);
  const part = target?.source.kind === 'part' ? library.parts.get(target.source.partRef) : undefined;
  const points = part?.references.filter(feature => feature.kind === 'referencePoint') ?? [];
  const sources = document?.components.filter(component => component.id !== props.componentId && !component.suppressed) ?? [];
  const first = document?.contextReferences?.find(link => link.targetComponentId === props.componentId);
  const [pointId, setPointId] = useState(first?.targetReferenceId ?? points[0]?.id ?? '');
  const [sourceId, setSourceId] = useState(first?.sourceComponentId ?? sources[0]?.id ?? '');
  const [faceKey, setFaceKey] = useState('');
  const [result, setResult] = useState<ContextReferenceCommandResult | null>(null);
  if (document === null || target === undefined || part === undefined || view === null) return null;
  const existing = contextLinkOfPoint(document, target.id, pointId);
  const source = findComponent(document, sourceId);
  const bodies = source === undefined ? [] : contextBodiesOf(view, source) ?? [];
  const faces = bodies.flatMap(body => body.isValid ? body.faces.map(face => ({ key: `${body.featureId}:${String(face.index)}`,
    body, index: face.index, label: `${body.featureId} ${t('assembly.context.face')} ${String(face.index + 1)}` })) : []);
  const ready = view.sourceDocument === document && !computing;
  const apply = (link: ContextReferenceLink): void => {
    void runContextReferenceCommit(useAppStore.getState, link).then(setResult);
  };
  const create = (): void => {
    const face = faces.find(candidate => candidate.key === faceKey);
    const reference = face === undefined ? null : createSubShapeReference(face.body, 'face', face.index);
    if (!ready || reference === null || source === undefined || pointId === '') return;
    apply(contextLinkToCommit(document, target.id, pointId, source.id, reference));
  };
  return (
    <form aria-label={t('assembly.context.title')} data-testid="assembly-context-form"
      onKeyDown={event => {
        // 変換中の Enter は確定に使わない(既存の popover と同じ)。
        if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
      }}
      onSubmit={event => { event.preventDefault(); create(); }}>
      <h4>{t('assembly.context.title')}</h4>
      <label className="pcad-field"><span>{t('assembly.context.point')}</span>
        <select className="pcad-field__input" data-testid="assembly-context-point" value={pointId} disabled={!ready}
          onChange={event => { setPointId(event.currentTarget.value); }} title={t('assembly.guide.contextPoint')}>
          {points.map(point => <option key={point.id} value={point.id}>{point.name}</option>)}
        </select></label>
      <label className="pcad-field"><span>{t('assembly.context.source')}</span>
        <select className="pcad-field__input" data-testid="assembly-context-source" value={sourceId} disabled={!ready}
          onChange={event => { setSourceId(event.currentTarget.value); setFaceKey(''); }} title={t('assembly.guide.contextSource')}>
          {sources.map(component => <option key={component.id} value={component.id}>{component.name}</option>)}
        </select></label>
      <label className="pcad-field"><span>{t('assembly.context.face')}</span>
        <select className="pcad-field__input" data-testid="assembly-context-face" value={faceKey} disabled={!ready}
          onChange={event => { setFaceKey(event.currentTarget.value); }} title={t('assembly.guide.contextFace')}>
          <option value="">{t('assembly.context.chooseFace')}</option>
          {faces.map(face => <option key={face.key} value={face.key}>{face.label}</option>)}
        </select></label>
      <button type="submit" className="pcad-button" disabled={!ready || points.length === 0 || faceKey === ''} title={t('assembly.guide.contextCommit')}>
        {t(existing === undefined ? 'assembly.context.create' : 'assembly.context.replace')}</button>
      {existing === undefined ? null : <button type="button" className="pcad-button" data-testid="assembly-context-update"
        disabled={!ready} onClick={() => { apply(existing); }} title={t('assembly.guide.contextUpdate')}>{t('assembly.context.update')}</button>}
      {result === null || result.status === 'committed' ? null
        : <p role="alert">{t(result.status === 'rejected'
          ? CONTEXT_REFERENCE_REJECTION_MESSAGES[result.rejection.code] : 'assembly.context.stale')}</p>}
    </form>
  );
}
