import { resolveSubShapeReference, type SolidFeature } from '@pointercad/model';
import { t } from '../i18n/t.js';
import {
  planarBasisForReference, validPlanarHoleBasis, type PlanarHoleBasis,
} from '../solid/planarHoleInput.js';
import { selectedSubShapeRefs } from '../solid/subShapeSelection.js';
import type { AppState } from '../store/appState.js';
import { currentMathGeometry } from '../math/mathGeometryResults.js';
import {
  captureSolidMeshAdmission, isSolidMeshAdmissionCurrent,
} from '../viewport/solidMeshAdmission.js';
import { currentPartReferenceBodies } from '../solid/referenceRepairContext.js';
import { useAppStore } from '../store/useAppStore.js';

/** 作成と位置別編集で共有する、部品座標の基準説明。文書や履歴は変更しない。 */
export function PlanarHoleBasisInfo({ feature }: {
  readonly feature?: SolidFeature;
}): React.JSX.Element | null {
  const state = useAppStore();
  if (feature !== undefined && (
    (feature.kind !== 'hole' && feature.kind !== 'threadHole') || feature.planar === undefined
  )) return null;
  const basis = currentPlanarHoleBasis(state, feature);
  if (basis === null) return <p role="status">{t('numericInput.error.planarHoleBasis')}</p>;
  return <div className="pcad-section" role="note">
    <dl className="pcad-properties">
      <dt>{t('numericInput.planarBasis.origin')}</dt><dd>{basis.origin.join(', ')}</dd>
      <dt>{t('numericInput.planarBasis.xAxis')}</dt><dd>{basis.xAxis.join(', ')}</dd>
      <dt>{t('numericInput.planarBasis.yAxis')}</dt><dd>{basis.yAxis.join(', ')}</dd>
    </dl>
    <p>{t('numericInput.planarBasis.note')}</p>
  </div>;
}

/** 現在の確定形だけで基準を説明し、保存した平面参照の編集を許可する。 */
export function currentPlanarHoleBasis(state: AppState, feature?: SolidFeature): PlanarHoleBasis | null {
  const admission = captureSolidMeshAdmission(state);
  if (state.isComputing || state.stagedSolid !== null || currentMathGeometry(state).status !== 'current'
    || admission === null || admission.accounting === null || admission.bodies !== state.bodies
    || !isSolidMeshAdmissionCurrent(admission, state)) return null;
  if (feature === undefined) {
    const refs = selectedSubShapeRefs(state.bodies, state.selection, 'face');
    return refs.length === 1 ? planarBasisForReference(state.bodies, refs[0]) : null;
  }
  if ((feature.kind !== 'hole' && feature.kind !== 'threadHole') || feature.planar === undefined) return null;
  if (state.document.solids.find(row => row.id === feature.id) !== feature) return null;
  const bodies = currentPartReferenceBodies(state).filter(row => row.featureId === feature.face.bodyFeatureId
    && !state.partErrors.some(error => error.featureId === row.featureId));
  if (bodies.length !== 1 || !bodies[0].isValid) return null;
  const resolved = resolveSubShapeReference(bodies[0], feature.face);
  if (resolved.status !== 'matched') return null;
  const geometry = resolved.match.geometry;
  return geometry.kind === 'face' && geometry.surfaceKind === 'plane'
    && validPlanarHoleBasis(geometry.planarBasis)
    ? geometry.planarBasis : null;
}
