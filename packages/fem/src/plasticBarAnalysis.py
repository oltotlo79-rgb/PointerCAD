"""Fixed developer program: uniaxial elasto-plastic member through native OOFEM MisesMat (commit 214b161ed).

The request file contains one plan 'pointercad-oofem-plastic-bar-plan/1' (validated here exactly as readPlasticBarPlan
in plasticBar.ts). The member is an OOFEM truss1d with SimpleCS area and MisesMat (htype 0: J2 plasticity with linear
isotropic hardening, sigmaY = sig0 + H * kappa; misesmat.C:193-220). The far end displacement follows the plan's
piecewise-linear knots through a PiecewiseLinFunction, solved by StaticStructural (Newton) with deltat 1 per step,
exactly the pattern of the upstream test tests/sm/Mises01.in. The deck is read with OOFEMTXTDataReader and
InstanciateProblem (bindings/python/oofem.cpp:1033, 1556).

Native order (integration-r1 correction of plastic1, see NATIVE-ASSUMPTIONS-NOTE.md):
- InstanciateProblem already runs postInitialize (engngm.C:376); afterwards only checkProblemConsistency and init run,
  as in main.C:352-353. plastic1 called postInitialize a second time.
- initMetaStepAttributes(giveMetaStep(1)) runs once before stepping, as EngngModel::solveYourself does (engngm.C:590).
  It is the only path that creates and configures StaticStructural's Newton solver (staticstructural.C:87-96,
  159-188), so the deck's rtolf 1e-10 / maxiter 50 apply. plastic1 never called it.
- preInitializeNextStep runs before every giveNextStep (engngm.C:598-639). Bindings: oofem.cpp:1115, 1134, 1135.
- The end axial force is LastEquilibratedInternalForcesVector (structuralelement.C:926-930), which integrates the
  equilibrated stresses without recomputing the material state; plastic1 used InternalForcesVector.

Not modeled: bending, damage (omega_crit stays 0), softening, kinematic hardening, large strain. The density field
'd 1.0' is required by the record syntax and does not enter a static analysis.
"""
import json
import math
from importlib.metadata import version

PLAN_SCHEMA = 'pointercad-oofem-plastic-bar-plan/1'
RESULT_SCHEMA = 'pointercad-oofem-plastic-bar-result/1'
DECK = '/pcad_fem/plastic-bar.in'
OUT = '/pcad_fem/plastic-bar.out'
MAXIMUM_KNOTS, MAXIMUM_STEPS_PER_SEGMENT, MAXIMUM_STEPS, MAXIMUM_STRAIN = 64, 200, 2000, 0.05


def _fail(detail):
    raise ValueError(f'plastic-bar: {detail}')


def _record(value, names, path):
    if not isinstance(value, dict):
        _fail(f'{path} must be an object')
    if len(value) != len(names) or any(name not in value for name in names):
        _fail(f'{path} must have exactly the fields {", ".join(names)}')
    return value


def _finite(value, path):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(f'{path} must be a finite number')
    return float(value)


def _positive(value, path):
    number = _finite(value, path)
    if not number > 0:
        _fail(f'{path} must be positive')
    return number


def read_plastic_bar_plan(value):
    """Mirror of readPlasticBarPlan (plasticBar.ts): same acceptance, same order, same message prefixes."""
    row = _record(value, ['schema', 'lengthM', 'areaM2', 'material', 'endDisplacementM', 'stepsPerSegment'], 'plan')
    if row['schema'] != PLAN_SCHEMA:
        _fail('unsupported plan schema')
    length = _positive(row['lengthM'], 'lengthM')
    if length > 500:
        _fail('lengthM exceeds 500 m')
    area = _positive(row['areaM2'], 'areaM2')
    if area > 1:
        _fail('areaM2 exceeds 1 m2')
    m = _record(row['material'], ['youngPa', 'poisson', 'yieldStressPa', 'hardeningModulusPa', 'source'], 'material')
    young = _positive(m['youngPa'], 'material.youngPa')
    poisson = _finite(m['poisson'], 'material.poisson')
    if poisson < 0 or poisson >= 0.5:
        _fail('material.poisson must be in [0, 0.5)')
    sig0 = _positive(m['yieldStressPa'], 'material.yieldStressPa')
    if sig0 >= young:
        _fail('material.yieldStressPa must be below material.youngPa (yield strain < 1)')
    hardening = _finite(m['hardeningModulusPa'], 'material.hardeningModulusPa')
    if hardening < 0:
        _fail('material.hardeningModulusPa must not be negative (softening is not supported)')
    source = _record(m['source'], ['kind', 'reference'], 'material.source')
    if source['kind'] != 'user-supplied':
        _fail('material.source.kind must be user-supplied')
    reference = source['reference']
    if not isinstance(reference, str) or not reference.strip() or len(reference) > 500:
        _fail('material.source.reference must be a non-empty statement of where the values come from (at most 500 characters)')
    knots = row['endDisplacementM']
    if not isinstance(knots, list) or not 2 <= len(knots) <= MAXIMUM_KNOTS:
        _fail(f'endDisplacementM must have 2 to {MAXIMUM_KNOTS} knots')
    knots = [_finite(knot, f'endDisplacementM[{index}]') for index, knot in enumerate(knots)]
    if knots[0] != 0:
        _fail('the first end-displacement knot must be 0')
    if any(knots[index] == knots[index - 1] for index in range(1, len(knots))):
        _fail('consecutive end-displacement knots must differ')
    if any(abs(u) / length > MAXIMUM_STRAIN for u in knots):
        _fail(f'|end displacement| / length must not exceed {MAXIMUM_STRAIN} (small-strain formulation)')
    steps = row['stepsPerSegment']
    if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= MAXIMUM_STEPS_PER_SEGMENT:
        _fail(f'stepsPerSegment must be an integer from 1 to {MAXIMUM_STEPS_PER_SEGMENT}')
    if steps * (len(knots) - 1) > MAXIMUM_STEPS:
        _fail(f'at most {MAXIMUM_STEPS} steps are allowed')
    return {'lengthM': length, 'areaM2': area, 'youngPa': young, 'poisson': poisson, 'yieldStressPa': sig0,
            'hardeningModulusPa': hardening, 'endDisplacementM': knots, 'stepsPerSegment': steps}


def _number(value):
    return format(value, '.17g')


def plastic_bar_deck(plan):
    """OOFEM input deck text; records and fields follow tests/sm/Mises01.in."""
    s, knots = plan['stepsPerSegment'], plan['endDisplacementM']
    nsteps = s * (len(knots) - 1)
    times = ' '.join(_number(float(index * s)) for index in range(len(knots)))
    values = ' '.join(_number(u) for u in knots)
    return '\n'.join([
        OUT,
        'PointerCAD uniaxial elasto-plastic member (MisesMat, linear isotropic hardening)',
        f'StaticStructural nsteps {nsteps} rtolf 1e-10 maxiter 50 nmodules 0',
        'domain 1dtruss',
        'OutputManager',
        'ndofman 2 nelem 1 ncrosssect 1 nmat 1 nbc 2 nltf 2 nic 0 nset 3',
        'node 1 coords 3 0.0 0.0 0.0',
        f'node 2 coords 3 {_number(plan["lengthM"])} 0.0 0.0',
        'truss1d 1 nodes 2 1 2',
        f'SimpleCS 1 area {_number(plan["areaM2"])} material 1 set 1',
        f'MisesMat 1 d 1.0 tAlpha 0.0 E {_number(plan["youngPa"])} n {_number(plan["poisson"])} '
        f'sig0 {_number(plan["yieldStressPa"])} H {_number(plan["hardeningModulusPa"])}',
        'BoundaryCondition 1 loadTimeFunction 1 dofs 1 1 values 1 0.0 set 2',
        'BoundaryCondition 2 loadTimeFunction 2 dofs 1 1 values 1 1.0 set 3',
        'ConstantFunction 1 f(t) 1.0',
        f'PiecewiseLinFunction 2 t {len(knots)} {times} f(t) {len(knots)} {values}',
        'Set 1 elementranges {1}',
        'Set 2 nodes 1 1',
        'Set 3 nodes 1 2',
        '']), nsteps


def _schedule(plan):
    s, knots, targets = plan['stepsPerSegment'], plan['endDisplacementM'], []
    for segment in range(1, len(knots)):
        start, end = knots[segment - 1], knots[segment]
        targets.extend(end if i == s else start + (end - start) * i / s for i in range(1, s + 1))
    return targets


def run_plastic_bar():
    import oofem as fem

    if version('oofem') != '3.1.dev5+g214b161ed':
        raise ValueError('Unexpected fixed OOFEM distribution')
    with open('/pcad_fem/analysis-input.json', encoding='utf-8') as stream:
        plan = read_plastic_bar_plan(json.load(stream))
    deck, nsteps = plastic_bar_deck(plan)
    with open(DECK, 'w', encoding='utf-8') as stream:
        stream.write(deck)
    problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader(DECK), fem.problemMode.processor, 0, None, False)
    if problem is None:
        raise ValueError('plastic-bar: OOFEM rejected the generated deck')
    primary_error = None
    try:
        if problem.checkProblemConsistency() != 1:
            raise ValueError('plastic-bar: OOFEM rejected the model consistency')
        problem.init()
        # Only solveYourself starts the analysis timer that terminateAnalysis stops (engngm.C:578, 2027).
        problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
        # giveNumberOfMetaSteps is not bound; the default metastep must carry exactly the deck's nsteps
        # (MetaStep.giveNumberOfSteps, oofem.cpp:1081).
        meta = problem.giveMetaStep(1)
        if meta is None or meta.giveNumberOfSteps() != nsteps:
            raise ValueError('plastic-bar: the default metastep does not carry the deck step count')
        problem.initMetaStepAttributes(meta)
        domain = problem.giveDomain(1)
        element, end = domain.giveElement(1), domain.giveDofManager(2)
        targets, samples = _schedule(plan), []
        for index in range(nsteps):
            problem.preInitializeNextStep()
            step = problem.giveNextStep()
            problem.initializeYourself(step)
            problem.solveYourselfAt(step)
            problem.updateYourself(step)
            gp = element.giveDefaultIntegrationRulePtr().getIntegrationPoint(0)
            values = {}
            for name, kind in (('stress', fem.InternalStateType.IST_StressTensor),
                               ('strain', fem.InternalStateType.IST_StrainTensor),
                               ('plastic', fem.InternalStateType.IST_PlasticStrainTensor)):
                answer = fem.FloatArray()
                element.giveIPValue(answer, gp, kind, step)
                values[name] = float(answer[0])
            forces = fem.FloatArray()
            element.giveCharacteristicVector(forces, fem.CharType.LastEquilibratedInternalForcesVector,
                                             fem.ValueModeType.VM_Total, step)
            displacement = float(end.giveDofWithID(fem.DofIDItem.D_u).giveUnknown(fem.ValueModeType.VM_Total, step))
            sample = {'step': index + 1, 'targetDisplacementM': targets[index], 'endDisplacementM': displacement,
                      'strain': values['strain'], 'stressPa': values['stress'], 'plasticStrain': values['plastic'],
                      'axialForceN': float(forces[1])}
            if not all(math.isfinite(v) for v in sample.values() if isinstance(v, float)):
                raise ValueError(f'plastic-bar: non-finite native value at step {index + 1}')
            samples.append(sample)
        area, sig0 = plan['areaM2'], plan['yieldStressPa']
        # Equilibrium of the single uniform element: end internal force = stress * area.
        mismatch = max(abs(s['axialForceN'] - s['stressPa'] * area) for s in samples) / (sig0 * area)
        return json.dumps({
            'schema': RESULT_SCHEMA,
            'method': 'oofem-misesmat-htype0-truss1d-staticstructural/1',
            'scope': 'uniaxial-small-strain-j2-linear-isotropic-hardening-displacement-control',
            'structuralCertification': False,
            'samples': samples,
            'yielded': any(s['plasticStrain'] != 0 for s in samples),
            'maximumEquilibriumMismatch': mismatch,
        })
    except Exception as error:
        primary_error = error
        raise
    finally:
        try:
            problem.terminateAnalysis()
        except Exception as cleanup_error:
            if primary_error is None:
                raise
            primary_error.add_note(f'Additional terminateAnalysis error: {cleanup_error!r}')
