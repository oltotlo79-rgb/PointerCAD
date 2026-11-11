"""W19: rate-independent Coulomb return mapping at one fixed contact point.

Units are mm, N, MPa and N/mm^3. Returned traction is the internal residual
direction, opposite to the force acting on the slave. No geometry/history
transfer, parameter-change acceptance, global convergence or native friction
binding is implemented here. The caller must use the same point, normal and
material/penalty conditions as the previously accepted history, and commit the
returned state only after its whole increment converges.
"""

import math

from solidContact import _dot, _finite, _positive_product, _vector


def _energy(area, stiffness, elastic):
    length = math.hypot(*elastic)
    return _positive_product(0.5, area, stiffness, length, length) if length else 0.0


def updateCoulombState(normal, gapMm, knNPerMm3, ktNPerMm3, mu, sourceId,
                       areaMm2, previousElasticSlipMm, accumulatedDissipationNmm,
                       relativeIncrementMm):
    """Return a new local state without altering accepted history or its inputs.

    P=I-n*n^T; p=kn*max(-g,0); t_trial=kt*(e_old+P*delta_s).
    Stick when |t_trial| <= mu*p (including the equality-side tangent).
    Otherwise t=mu*p*t_trial/|t_trial|. The slip tangent is not symmetrized:
    dt/dg=-mu*kn*d is the non-associated normal-to-tangential coupling.
    At g=0 use the open side. Separation resets elastic slip, retains accrued
    dissipation and reports released old elastic energy separately; open motion
    is not counted as plastic friction work. The source ID is provenance only,
    not proof of retrieval or physical verification of its material value.
    """
    direction = _vector(normal, 'friction normal')
    if abs(math.hypot(*direction) - 1) > 1e-12:
        raise ValueError('solid-friction: explicit unit normal required')
    gap = _finite(gapMm, 'friction gap')
    kn, kt = _finite(knNPerMm3, 'normal penalty'), _finite(ktNPerMm3, 'tangent penalty')
    area = _finite(areaMm2, 'contact point area')
    if kn <= 0 or kt <= 0 or area <= 0:
        raise ValueError('solid-friction: positive penalties and area required')
    if mu is None:
        if sourceId is not None:
            raise ValueError('solid-friction: frictionless null coefficient requires null source')
        coefficient = 0.0
    else:
        coefficient = _finite(mu, 'friction coefficient')
        if not 0 <= coefficient <= 1:
            raise ValueError('solid-friction: coefficient must be from zero to one')
        # Match W16: a numeric zero also needs the supplied source identity.
        if (not isinstance(sourceId, str) or not sourceId or sourceId.strip() != sourceId
                or len(sourceId.encode('utf-16-le', 'surrogatepass')) // 2 > 256
                or any(ord(character) < 32 for character in sourceId)):
            raise ValueError('solid-friction: numeric coefficient requires a nonempty source id')
    previous = _vector(previousElasticSlipMm, 'previous elastic slip')
    previous_length = math.hypot(*previous)
    if abs(_dot(previous, direction)) > 1e-12 * previous_length:
        raise ValueError('solid-friction: previous elastic slip contains a normal component')
    accumulated = _finite(accumulatedDissipationNmm, 'accumulated dissipation')
    if accumulated < 0:
        raise ValueError('solid-friction: accumulated dissipation cannot be negative')
    increment = _vector(relativeIncrementMm, 'relative displacement increment')
    projection = [[float(i == j) - direction[i] * direction[j] for j in range(3)] for i in range(3)]
    old_energy = _energy(area, kt, previous)
    tangent = [[0.0] * 3 for _ in range(3)]
    coupling = [0.0] * 3
    normal_stiffness = 0.0
    elastic, plastic_increment, traction = [0.0] * 3, [0.0] * 3, [0.0] * 3
    pressure, added, released, elastic_energy = 0.0, 0.0, 0.0, 0.0
    trial_length, limit = 0.0, 0.0
    if gap >= 0:
        status = 'open'
        released = old_energy
    else:
        pressure = _positive_product(kn, -gap)
        normal_stiffness = kn
        tangent_increment = [_dot(row, increment) for row in projection]
        trial_elastic = [_finite(old + step, 'trial elastic slip') for old, step in zip(previous, tangent_increment)]
        trial = [_finite(kt * value, 'trial tangential traction') for value in trial_elastic]
        trial_length = _finite(math.hypot(*trial), 'trial traction magnitude')
        limit = _positive_product(coefficient, pressure) if coefficient else 0.0
        if trial_length <= limit:
            status = 'stick' if coefficient else 'frictionless'
            traction, elastic = trial, trial_elastic
            if coefficient:
                tangent = [[_finite(kt * value, 'stick tangent') for value in row] for row in projection]
        else:
            status = 'slip' if coefficient else 'frictionless'
            slip_direction = [value / trial_length for value in trial]
            traction = [_finite(limit * value, 'slip traction') for value in slip_direction]
            elastic = [_finite(value / kt, 'returned elastic slip') for value in traction]
            plastic_increment = [_finite(trial_value - value, 'plastic slip increment')
                                 for trial_value, value in zip(trial_elastic, elastic)]
            if coefficient:
                scale = _positive_product(kt, limit / trial_length)
                tangent = [[_finite(scale * (projection[i][j] - slip_direction[i] * slip_direction[j]), 'slip tangent')
                            for j in range(3)] for i in range(3)]
                coupling = [_finite(-coefficient * kn * value, 'normal friction coupling') for value in slip_direction]
                # Exact return-map dissipation, separate from recoverable energy.
                added = _positive_product(area, limit, (trial_length - limit) / kt)
        elastic_energy = _energy(area, kt, elastic)
    accumulated_new = _finite(accumulated + added, 'accumulated dissipation')
    normal_force = _positive_product(area, pressure) if pressure else 0.0
    tangential_force = [_finite(area * value, 'tangential force') for value in traction]
    total_traction = [_finite(-pressure * direction[i] + traction[i], 'internal contact traction') for i in range(3)]
    total_tangent = [[_finite(normal_stiffness * direction[i] * direction[j]
                             + tangent[i][j] + coupling[i] * direction[j], 'total contact tangent')
                      for j in range(3)] for i in range(3)]
    return {'status': status, 'coefficient': mu, 'sourceId': sourceId,
            'normalPressureMPa': pressure, 'normalForceN': normal_force,
            'tangentialTractionMPa': traction, 'tangentialForceN': tangential_force,
            'tractionMPa': total_traction, 'elasticSlipMm': elastic,
            'plasticSlipIncrementMm': plastic_increment,
            'addedDissipationNmm': added, 'accumulatedDissipationNmm': accumulated_new,
            'elasticEnergyNmm': elastic_energy, 'releasedElasticEnergyNmm': released,
            'tangentialTangentNPerMm3': tangent, 'normalCouplingNPerMm3': coupling,
            'tractionTangentNPerMm3': total_tangent,
            'trialTangentialMagnitudeMPa': trial_length, 'frictionLimitMPa': limit}
