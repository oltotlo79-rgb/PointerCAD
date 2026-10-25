import type { BeamAnalysisResult, Vector3 } from '@pointercad/model/beam-analysis';
import { t } from '../i18n/t.js';
import { FIELD_VALUE_DISPLAY_DIGITS, roundToSignificantDigits } from '../sketch/numericInputPresentation.js';
import type { BeamMemberDraft } from './beamSession.js';

export function beamDisplayNumber(value: number): string {
  return String(roundToSignificantDigits(value, FIELD_VALUE_DISPLAY_DIGITS));
}

export function BeamResults({ result, members }: {
  readonly result: BeamAnalysisResult; readonly members: readonly BeamMemberDraft[];
}): React.JSX.Element {
  const labels = new Map<string, string>();
  for (const member of members) {
    labels.set(member.startNodeId, `${member.occurrence.label}: ${t('beam.start')}`);
    labels.set(member.endNodeId, `${member.occurrence.label}: ${t('beam.end')}`);
  }
  const vector = (values: Vector3, factor: number, kind: string): React.JSX.Element => <span data-beam-result={kind}>
    {values.map((value, axis) => <span key={axis} data-axis={axis} data-value={value * factor}>
      {['X', 'Y', 'Z'][axis]}: {beamDisplayNumber(value * factor)}{axis < 2 ? ', ' : ''}
    </span>)}
  </span>;
  return <section className="pcad-beam__results" data-testid="beam-results" aria-label={t('beam.results')}>
    <h4>{t('beam.results')}</h4>
    <p>{t('beam.resultScope')}</p>
    {result.nodes.map(node => <section key={node.nodeId} data-beam-node={node.nodeId}>
      <h5>{labels.get(node.nodeId) ?? node.nodeId}</h5>
      <dl>
        <dt>{t('beam.displacement')}</dt><dd>{vector(node.displacementM, 1000, 'displacement-mm')}</dd>
        <dt>{t('beam.rotation')}</dt><dd>{vector(node.rotationRad, 1, 'rotation-rad')}</dd>
        {node.constrained ? <>
          <dt>{t('beam.reaction')}</dt><dd>{vector(node.reactionN, 1, 'reaction-N')}</dd>
          <dt>{t('beam.reactionMoment')}</dt><dd>{vector(node.reactionNm, 1000, 'reaction-Nmm')}</dd>
        </> : null}
      </dl>
    </section>)}
  </section>;
}
