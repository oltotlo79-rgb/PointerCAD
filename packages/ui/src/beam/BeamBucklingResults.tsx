import type { BeamBucklingResult } from '@pointercad/fem';
import { t } from '../i18n/t.js';
import { beamDisplayNumber } from './BeamResults.js';
import type { BucklingEdges } from './beamSession.js';

function ModeProjection({ result, mode, edges, axes }: {
  readonly result: BeamBucklingResult;
  readonly mode: BeamBucklingResult['modes'][number];
  readonly edges: BucklingEdges;
  readonly axes: readonly [number, number];
}): React.JSX.Element {
  const minimum = axes.map(axis => Math.min(...mode.nodes.map(node => node.positionM[axis])));
  const maximum = axes.map(axis => Math.max(...mode.nodes.map(node => node.positionM[axis])));
  const centre = minimum.map((value, index) => (value + maximum[index]) / 2);
  const nodes = new Map(mode.nodes.map(node => [node.solverNode, node]));
  const point = (number: number, moved: boolean): readonly [number, number] | null => {
    const node = nodes.get(number);
    if (node === undefined) return null;
    const coordinate = (axis: number, centreIndex: number): number =>
      (node.positionM[axis] - centre[centreIndex]) / result.normalizationLengthM + (moved ? 0.08 * node.translation[axis] : 0);
    return [110 + 160 * coordinate(axes[0], 0), 110 - 160 * coordinate(axes[1], 1)];
  };
  const label = `${t('beam.modeProjection')} ${['X', 'Y', 'Z'][axes[0]]}${['X', 'Y', 'Z'][axes[1]]}`;
  return <figure>
    <svg viewBox="0 0 220 220" width="220" height="220" role="img" aria-label={label}>
      <title>{label}</title>
      {edges.map((edge, index) => {
        const start = point(edge[0], false), end = point(edge[1], false);
        const movedStart = point(edge[0], true), movedEnd = point(edge[1], true);
        if (start === null || end === null || movedStart === null || movedEnd === null) return null;
        return <g key={index}>
          <line x1={start[0]} y1={start[1]} x2={end[0]} y2={end[1]} stroke="currentColor" opacity="0.45" strokeDasharray="3 3" />
          <line x1={movedStart[0]} y1={movedStart[1]} x2={movedEnd[0]} y2={movedEnd[1]} stroke="currentColor" strokeWidth="2" />
        </g>;
      })}
    </svg>
    <figcaption>{label}</figcaption>
  </figure>;
}

export function BeamBucklingResults({ result, edges }: {
  readonly result: BeamBucklingResult; readonly edges: BucklingEdges;
}): React.JSX.Element {
  return <section className="pcad-beam__results" data-testid="beam-buckling-results" aria-label={t('beam.bucklingResults')}>
    <h4>{t('beam.bucklingResults')}</h4>
    <p>{t('beam.bucklingResultScope')}</p>
    <p>{t('beam.bucklingNormalization')}</p>
    <p>{t('beam.modalShapeHelp')}</p>
    <dl>
      <dt>{t('beam.normalizationLength')}</dt><dd data-testid="beam-buckling-length">{beamDisplayNumber(result.normalizationLengthM)} m</dd>
      <dt>{t('beam.meshSize')}</dt><dd>{result.meshNodes} / {result.meshElements}</dd>
      <dt>{t('beam.referenceEquilibrium')}</dt><dd>{beamDisplayNumber(result.referenceEquilibriumResidual)}</dd>
      <dt>{t('beam.stiffnessOrthogonality')}</dt><dd>{beamDisplayNumber(result.maximumStiffnessOrthogonalityError)}</dd>
    </dl>
    {result.modes.map(mode => <details key={mode.number} open={mode.number === 1} data-beam-buckling-mode={mode.number}>
      <summary>{t('beam.mode')} {mode.number}: {t('beam.loadFactor')} <span data-beam-load-factor={mode.loadFactor}>
        {beamDisplayNumber(mode.loadFactor)}</span></summary>
      <p>{t('beam.eigenResidual')}: <span data-beam-eigen-residual={mode.normalizedResidual}>
        {beamDisplayNumber(mode.normalizedResidual)}</span></p>
      <div className="pcad-beam__numbers">
        {([[0, 1], [0, 2], [1, 2]] as const).map(axes =>
          <ModeProjection key={axes.join('-')} result={result} mode={mode} edges={edges} axes={axes} />)}
      </div>
      <details><summary>{t('beam.modeComponents')}</summary>
        <table><thead><tr><th>{t('beam.node')}</th>
          {['uX/L', 'uY/L', 'uZ/L', 'θX', 'θY', 'θZ'].map(name => <th key={name}>{name}</th>)}
        </tr></thead><tbody>{mode.nodes.map(node => <tr key={node.solverNode} data-beam-mode-node={node.solverNode}>
          <th>{node.nodeId ?? `${t('beam.interiorNode')} ${node.solverNode}`}</th>
          {[...node.translation, ...node.rotation].map((value, index) => <td key={index} data-component={index} data-value={value}>
            {beamDisplayNumber(value)}</td>)}
        </tr>)}</tbody></table>
      </details>
    </details>)}
  </section>;
}
