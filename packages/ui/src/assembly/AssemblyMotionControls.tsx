import { useEffect } from 'react';
import type { Joint, JointCoordinate } from '@pointercad/model';
import { saveFileAsThrough } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { ExportIcon } from '../shell/icons.js';
import {
  createAnimationPlayer, exportAnimationPngSequence,
} from './animation.js';
import {
  currentJointSliderValue, jointSliderBounds, jointSliderCoordinates, jointSliderDomain,
  jointSliderReference,
} from './jointSlider.js';

function jointValueKey(jointId: string, coordinate: JointCoordinate): string {
  return `${jointId}\u0000${coordinate}`;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => { resolve(); });
  });
}

function coordinateLabel(coordinate: JointCoordinate): string {
  return t(coordinate === 'angle' ? 'assembly.motion.angle' : 'assembly.motion.translation');
}

function formatBound(value: number | null, coordinate: JointCoordinate, lower: boolean): string {
  if (value === null) return lower ? '−∞' : '+∞';
  return `${String(value)}${coordinate === 'angle' ? '°' : 'mm'}`;
}

export function JointSliderControls(props: {
  readonly joint: Joint;
  readonly idPrefix: string;
}): React.JSX.Element | null {
  const document = useAppStore((state) => state.assembly);
  const view = useAppStore((state) => state.assemblyView);
  const values = useAppStore((state) => state.assemblyMotionJointValues);
  const notice = useAppStore((state) => state.assemblyMotionNotice);
  if (document === null || view === null || view.sourceDocument !== document) return null;
  const frames = view.jointFrames?.get(props.joint.id);
  const coordinates = jointSliderCoordinates(props.joint);
  if (coordinates.length === 0 || frames === undefined) return null;
  return (
    <div className="pcad-assembly-motion__joints">
      {coordinates.map((coordinate) => {
        const bounds = jointSliderBounds(document, props.joint, coordinate);
        const key = jointValueKey(props.joint.id, coordinate);
        if (!bounds.ok) return (
          <p key={`joint-error:${key}`} className="pcad-field__message pcad-field__message--error">
            {t('assembly.motion.invalidRange')}
          </p>
        );
        const value = values.get(key) ?? currentJointSliderValue({ document, joint: props.joint,
          coordinate, placements: view.resolved.placements, frames,
          referenceAngle: coordinate === 'angle' ? jointSliderReference(bounds.bounds) : undefined }) ?? 0;
        const domain = jointSliderDomain(coordinate, value, bounds.bounds);
        if (domain === null) return (
          <p key={`joint-error:${key}`} className="pcad-field__message pcad-field__message--error">
            {t('assembly.motion.invalidRange')}
          </p>
        );
        const id = `${props.idPrefix}-${props.joint.id}-${coordinate}`;
        const apply = (source: string): void => {
          const next = Number(source);
          if (Number.isFinite(next)) useAppStore.getState().driveAssemblyJoint(props.joint.id, coordinate, next);
        };
        return (
          <label key={`joint-slider:${key}`} className="pcad-assembly-motion__joint" htmlFor={id}>
            <span>{coordinateLabel(coordinate)}</span>
            <input id={id} type="range" min={domain.min} max={domain.max} step={domain.step}
              value={value} disabled={domain.disabled} onChange={(event) => { apply(event.currentTarget.value); }} />
            <input type="number" className="pcad-field__input" value={value} step={domain.step}
              onChange={(event) => { apply(event.currentTarget.value); }} />
            <span className="pcad-field__unit">{coordinate === 'angle' ? '°' : 'mm'}</span>
            {notice?.kind === 'rangeEnd' ? (
              <span className="pcad-field__message" role="status">
                {t('assemblyError.jointRangeEnd')
                  .replace('{min}', formatBound(notice.min, coordinate, true))
                  .replace('{max}', formatBound(notice.max, coordinate, false))}
              </span>
            ) : notice?.kind === 'failed' ? (
              <span className="pcad-field__message pcad-field__message--error" role="status">
                {t('assembly.motion.failed')}
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

/** ビューポート内の共通時間軸。分解とジョイントの全ステップがこの t を共有する。 */
export function AssemblyMotionControls(): React.JSX.Element | null {
  const document = useAppStore((state) => state.assembly);
  const time = useAppStore((state) => state.assemblyMotionTime);
  const playing = useAppStore((state) => state.assemblyMotionPlaying);
  const view = useAppStore((state) => state.assemblyView);
  const selection = useAppStore((state) => state.selection);
  const capture = useAppStore((state) => state.capturePrintFrame);
  const selectedJoint = document?.joints.find((joint) => selection.includes(joint.id));

  useEffect(() => {
    if (!playing || document === null) return undefined;
    const startTime = useAppStore.getState().assemblyMotionTime;
    const player = createAnimationPlayer({
      from: startTime >= 1 ? 0 : startTime,
      onFrame: (next) => {
        if (!useAppStore.getState().setAssemblyMotionTime(next)) throw new Error('motion');
      },
      onStopped: () => { useAppStore.getState().setAssemblyMotionPlaying(false); },
    });
    player.start();
    return () => { player.stop(); };
  }, [playing, document]);

  if (document === null) return null;
  const hasSteps = document.presentation.length > 0;
  const ready = view?.sourceDocument === document;
  const exportFrames = async (): Promise<void> => {
    const state = useAppStore.getState();
    const documentId = state.activeDocumentId;
    const snapshot = {
      assemblyMotionTime: state.assemblyMotionTime,
      assemblyMotionPlaying: false,
      assemblyMotionPlacements: state.assemblyMotionPlacements,
      assemblyMotionSourceDocument: state.assemblyMotionSourceDocument,
      assemblyMotionJointValues: state.assemblyMotionJointValues,
      assemblyMotionNotice: state.assemblyMotionNotice,
    };
    state.setAssemblyMotionPlaying(false);
    const result = await exportAnimationPngSequence({
      renderFrame: async (frameTime) => {
        if (!useAppStore.getState().setAssemblyMotionTime(frameTime)) throw new Error('motion');
        await nextPaint();
      },
      captureFrame: () => useAppStore.getState().capturePrintFrame?.() ?? null,
      restoreFrame: async () => {
        const current = useAppStore.getState();
        if (current.activeDocumentId === documentId && current.assembly === document) {
          useAppStore.setState(snapshot);
          await nextPaint();
        }
      },
      save: (bytes) => {
        const current = useAppStore.getState();
        const base = document.name.trim() || t('assembly.untitled');
        return saveFileAsThrough(current.fileGateway,
          base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`, 'zip', bytes);
      },
    });
    if (!result.ok && result.reason !== 'cancelled') {
      useAppStore.setState({ assemblyMotionNotice: { kind: 'failed' } });
    }
  };

  return (
    <div className="pcad-assembly-motion" role="group" aria-label={t('assembly.motion.title')}>
      <button type="button" className="pcad-button" disabled={!hasSteps || !ready}
        title={t(playing ? 'assembly.motion.pauseTooltip' : 'assembly.motion.playTooltip')}
        aria-label={t(playing ? 'assembly.motion.pause' : 'assembly.motion.play')}
        onClick={() => { useAppStore.getState().setAssemblyMotionPlaying(!playing); }}>
        <span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>
      </button>
      <input type="range" min={0} max={1} step={1 / 30} value={time} disabled={!hasSteps || !ready}
        aria-label={t('assembly.motion.timeline')}
        onChange={(event) => { useAppStore.getState().setAssemblyMotionPlaying(false);
          useAppStore.getState().setAssemblyMotionTime(Number(event.currentTarget.value)); }} />
      <output aria-label={t('assembly.motion.time')}>{Math.round(time * 100)}%</output>
      <button type="button" className="pcad-button" disabled={!hasSteps || !ready || capture === null}
        title={t('assembly.motion.exportTooltip')} aria-label={t('assembly.motion.export')}
        onClick={() => { void exportFrames(); }}><ExportIcon /></button>
      {selectedJoint === undefined ? null : <JointSliderControls joint={selectedJoint} idPrefix="viewport" />}
    </div>
  );
}
