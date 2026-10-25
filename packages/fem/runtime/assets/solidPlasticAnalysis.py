"""Fixed program for solidPlastic.ts plans: OOFEM ltrspace (tet4), MisesMat htype 0,
StaticStructural. Units N-mm-MPa; Voigt [xx, yy, zz, yz, xz, xy], engineering shear.

The plan mirror, native state loop, finite/small-strain refusals and result-size
bounds are implemented. Contract parity is checked by solidPlasticResults.test.ts.
Method /2 normalizes free-DOF imbalance using current forces and previously
accepted applied forces/constrained reactions. Its independent force-check
regressions are in solidPlasticForceBalance.test.py; qualification remains a
separate execution requirement, not a claim made by this source header.
"""

DECK = '/pcad_fem/solid-plastic.in'
OUT = '/pcad_fem/solid-plastic.out'
DOF_IDS = {'x': 1, 'y': 2, 'z': 3}


import math

PLAN_SCHEMA = 'pointercad-oofem-solid-plastic-plan/1'
MAXIMUM_NODES, MAXIMUM_ELEMENTS, MAXIMUM_KNOTS = 2000, 5000, 64
MAXIMUM_STEPS_PER_SEGMENT, MAXIMUM_STEPS, MAXIMUM_RECORDED_STATES = 200, 2000, 20000
REFERENCE_WHITESPACE = frozenset([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
                                  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
                                  0x3000, 0xfeff])


def _fail(detail):
    raise ValueError(f'solid-plastic: {detail}')


def _record(value, names, path):
    if not isinstance(value, dict):
        _fail(f'{path} must be an object')
    if len(value) != len(names) or any(name not in value for name in names):
        _fail(f'{path} must have exactly the fields {", ".join(names)}')
    return value


def _finite(value, path):
    # A JSON integer beyond the double range (e.g. 1 followed by 400 zeros) is Infinity after JSON.parse in TS;
    # here float() raises OverflowError, so it must be refused with the same message instead of escaping.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f'{path} must be a finite number')
    try:
        number = float(value)
    except OverflowError:
        _fail(f'{path} must be a finite number')
    if not math.isfinite(number):
        _fail(f'{path} must be a finite number')
    return 0.0 if number == 0 else number


def _positive(value, path):
    number = _finite(value, path)
    if not number > 0:
        _fail(f'{path} must be positive')
    return number


def _array(value, path, minimum, maximum):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        _fail(f'{path} must have {minimum} to {maximum} entries')
    return value


def _integer(value):
    """TS Number.isSafeInteger parity: JSON 1 and 1.0 are the same JS number, so an integral float is accepted."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer() and abs(value) <= 2 ** 53 - 1:
        return int(value)
    return None


def _node(value, count, path):
    index = _integer(value)
    if index is None or not 0 <= index < count:
        _fail(f'{path} must be a node index from 0 to {count - 1}')
    return index


def _dof(value, path):
    if value not in ('x', 'y', 'z'):
        _fail(f'{path} must be x, y or z')
    return value


def read_solid_plastic_plan(value):
    """Mirror of readSolidPlasticPlan (solidPlastic.ts): same acceptance, same order, same message prefixes."""
    row = _record(value, ['schema', 'units', 'nodes', 'elements', 'material', 'prescribedMm', 'forcesN',
                          'loadFactor', 'stepsPerSegment'], 'plan')
    if row['schema'] != PLAN_SCHEMA:
        _fail('unsupported plan schema')
    if row['units'] != 'N-mm-MPa':
        _fail('units must be N-mm-MPa')
    nodes = []
    for index, point in enumerate(_array(row['nodes'], 'nodes', 4, MAXIMUM_NODES)):
        xyz = _array(point, f'nodes[{index}]', 3, 3)
        nodes.append([_finite(xyz[axis], f'nodes[{index}][{axis}]') for axis in range(3)])
    elements = []
    for index, element in enumerate(_array(row['elements'], 'elements', 1, MAXIMUM_ELEMENTS)):
        ids = [_node(i, len(nodes), f'elements[{index}][{local}]')
               for local, i in enumerate(_array(element, f'elements[{index}]', 4, 4))]
        if len(set(ids)) != 4:
            _fail(f'elements[{index}] must use four distinct nodes')
        elements.append(ids)
    m = _record(row['material'], ['youngMPa', 'poisson', 'yieldStressMPa', 'hardeningModulusMPa', 'source'], 'material')
    young = _positive(m['youngMPa'], 'material.youngMPa')
    poisson = _finite(m['poisson'], 'material.poisson')
    if poisson < 0 or poisson >= 0.5:
        _fail('material.poisson must be in [0, 0.5)')
    sig0 = _positive(m['yieldStressMPa'], 'material.yieldStressMPa')
    if sig0 >= young:
        _fail('material.yieldStressMPa must be below material.youngMPa (yield strain < 1)')
    hardening = _finite(m['hardeningModulusMPa'], 'material.hardeningModulusMPa')
    if hardening < 0:
        _fail('material.hardeningModulusMPa must not be negative (softening is not supported)')
    source = _record(m['source'], ['kind', 'reference'], 'material.source')
    if source['kind'] != 'user-supplied':
        _fail('material.source.kind must be user-supplied')
    reference = source['reference']
    # Same contract as isReference in solidPlastic.ts: len counts code points; explicit whitespace set, not strip().
    if not isinstance(reference, str) or len(reference) > 500 or all(ord(c) in REFERENCE_WHITESPACE for c in reference):
        _fail('material.source.reference must be a non-empty statement of where the values come from (at most 500 characters)')
    seen, prescribed = set(), []
    for index, item in enumerate(_array(row['prescribedMm'], 'prescribedMm', 1, len(nodes) * 3)):
        p = _record(item, ['node', 'dof', 'valueMm'], f'prescribedMm[{index}]')
        key = (_node(p['node'], len(nodes), f'prescribedMm[{index}].node'), _dof(p['dof'], f'prescribedMm[{index}].dof'))
        if key in seen:
            _fail(f'prescribedMm[{index}] repeats a node direction')
        seen.add(key)
        prescribed.append({'node': key[0], 'dof': key[1], 'valueMm': _finite(p['valueMm'], f'prescribedMm[{index}].valueMm')})
    if len(seen) >= len(nodes) * 3:
        _fail('at least one degree of freedom must stay free')
    loaded, forces = set(), []
    for index, item in enumerate(_array(row['forcesN'], 'forcesN', 0, len(nodes) * 3)):
        f = _record(item, ['node', 'dof', 'forceN'], f'forcesN[{index}]')
        key = (_node(f['node'], len(nodes), f'forcesN[{index}].node'), _dof(f['dof'], f'forcesN[{index}].dof'))
        if key in seen:
            _fail(f'forcesN[{index}] acts on a prescribed direction')
        if key in loaded:
            _fail(f'forcesN[{index}] repeats a node direction')
        loaded.add(key)
        forces.append({'node': key[0], 'dof': key[1], 'forceN': _finite(f['forceN'], f'forcesN[{index}].forceN')})
    knots = [_finite(k, f'loadFactor[{i}]') for i, k in enumerate(_array(row['loadFactor'], 'loadFactor', 2, MAXIMUM_KNOTS))]
    if knots[0] != 0:
        _fail('the first load-factor knot must be 0')
    for index, p in enumerate(prescribed):
        if any(not math.isfinite(p['valueMm'] * knot) for knot in knots):
            _fail(f'prescribedMm[{index}].valueMm times a load-factor knot must be finite')
    for index, f in enumerate(forces):
        if any(not math.isfinite(f['forceN'] * knot) for knot in knots):
            _fail(f'forcesN[{index}].forceN times a load-factor knot must be finite')
    if any(knots[i] == knots[i - 1] for i in range(1, len(knots))):
        _fail('consecutive load-factor knots must differ')
    steps = _integer(row['stepsPerSegment'])
    if steps is None or not 1 <= steps <= MAXIMUM_STEPS_PER_SEGMENT:
        _fail(f'stepsPerSegment must be an integer from 1 to {MAXIMUM_STEPS_PER_SEGMENT}')
    if steps * (len(knots) - 1) > MAXIMUM_STEPS:
        _fail(f'at most {MAXIMUM_STEPS} steps are allowed')
    if (len(knots) - 1) * (len(nodes) + len(elements)) > MAXIMUM_RECORDED_STATES:
        _fail(f'at most {MAXIMUM_RECORDED_STATES} recorded node and element states are allowed')
    return {'nodes': nodes, 'elements': elements,
            'material': {'youngMPa': young, 'poisson': poisson, 'yieldStressMPa': sig0, 'hardeningModulusMPa': hardening},
            'prescribedMm': prescribed, 'forcesN': forces, 'loadFactor': knots, 'stepsPerSegment': steps}


def _number(value):
    return format(float(value), '.17g')


def solid_plastic_deck(plan):
    """OOFEM deck text for a plan already accepted by the reader; returns (deck, nsteps)."""
    s, knots = plan['stepsPerSegment'], plan['loadFactor']
    nsteps = s * (len(knots) - 1)
    m = plan['material']
    lines = [OUT, 'PointerCAD tet4 J2 plasticity (MisesMat htype 0, linear isotropic hardening)',
             f'StaticStructural nsteps {nsteps} rtolf 1e-10 maxiter 50 manrmsteps 1 nmodules 0', 'domain 3d', 'OutputManager']
    records = [f'BoundaryCondition {i + 1} loadTimeFunction 1 dofs 1 {DOF_IDS[p["dof"]]} '
               f'values 1 {_number(p["valueMm"])} set {p["node"] + 2}' for i, p in enumerate(plan['prescribedMm'])]
    base = len(records)
    records += [f'NodalLoad {base + i + 1} loadTimeFunction 1 dofs 1 {DOF_IDS[f["dof"]]} '
                f'Components 1 {_number(f["forceN"])} set {f["node"] + 2}' for i, f in enumerate(plan['forcesN'])]
    count = len(plan['nodes'])
    lines.append(f'ndofman {count} nelem {len(plan["elements"])} ncrosssect 1 nmat 1 nbc {len(records)} '
                 f'nltf 1 nic 0 nset {count + 1}')
    lines += [f'node {i + 1} coords 3 ' + ' '.join(_number(v) for v in point) for i, point in enumerate(plan['nodes'])]
    lines += [f'ltrspace {i + 1} nodes 4 ' + ' '.join(str(n + 1) for n in element)
              for i, element in enumerate(plan['elements'])]
    lines += ['SimpleCS 1 material 1 set 1',
              f'MisesMat 1 d 1.0 tAlpha 0.0 E {_number(m["youngMPa"])} n {_number(m["poisson"])} '
              f'sig0 {_number(m["yieldStressMPa"])} H {_number(m["hardeningModulusMPa"])}']
    lines += records
    times = ' '.join(_number(i * s) for i in range(len(knots)))
    lines.append(f'PiecewiseLinFunction 1 t {len(knots)} {times} f(t) {len(knots)} '
                 + ' '.join(_number(v) for v in knots))
    # Range syntax {(first last)} as upstream tests/sm/Buckling01.in:60; {1 N} would list only elements 1 and N.
    lines.append(f'Set 1 elementranges {{(1 {len(plan["elements"])})}}')
    lines += [f'Set {i + 2} nodes 1 {i + 1}' for i in range(count)]
    lines.append('')
    return '\n'.join(lines), nsteps


# Output contract read by solidPlasticResults.ts readSolidPlasticNative (field names checked by
# solidPlasticResults.test.ts); the 1e-8 free-residual bound is enforced by that reader.
RESULT_SCHEMA = 'pointercad-oofem-solid-plastic-result/1'
MAXIMUM_STRAIN = 0.05
FREE_RESIDUAL_BOUND = 1e-8


def _require_finite(values, what):
    """Explicit per-value check: max() and comparisons silently pass NaN, so every value is tested."""
    for value in values:
        if not math.isfinite(value):
            raise ValueError(f'solid-plastic: non-finite {what}')


def check_free_force_balance(internal, applied, fixed, accepted_reference, where):
    """Method/2: exact free imbalance relative to current or previously accepted physical forces.

    Pure transition: a rejected step returns no new reference. Only accepted applied forces and
    constrained reactions can establish history; future loads and free residuals cannot seed it.
    """
    if len(internal) != len(applied) or any(len(row) != 3 for row in internal + applied):
        raise ValueError('solid-plastic: force arrays must contain matching three-vectors')
    _require_finite((v for row in internal for v in row), f'assembled internal force at {where}')
    _require_finite((v for row in applied for v in row), f'applied load at {where}')
    _require_finite([accepted_reference], 'accepted force reference')
    if accepted_reference < 0:
        raise ValueError('solid-plastic: accepted force reference must not be negative')
    scale = max([1e-300, accepted_reference] + [abs(v) for row in internal for v in row]
                + [abs(v) for row in applied for v in row])
    ratios = [abs(internal[n][a] - applied[n][a]) / scale for n in range(len(internal))
              for a in range(3) if (n, a) not in fixed]
    _require_finite([scale] + ratios, f'force-balance residual at {where}')
    residual = max(ratios, default=0.0)
    if residual > FREE_RESIDUAL_BOUND:
        raise ValueError(f'solid-plastic: free-DOF force residual {residual!r} exceeds {FREE_RESIDUAL_BOUND} at {where}'
                         ' (no converged equilibrium)')
    reference = max([accepted_reference] + [abs(v) for row in applied for v in row]
                    + [abs(internal[n][a]) for n in range(len(internal)) for a in range(3) if (n, a) in fixed])
    return residual, reference


def run_solid_plastic():
    import json
    from importlib.metadata import version
    import oofem as fem

    if version('oofem') != '3.1.dev5+g214b161ed':
        raise ValueError('Unexpected fixed OOFEM distribution')
    with open('/pcad_fem/solid-plastic-input.json', encoding='utf-8') as stream:
        plan = read_solid_plastic_plan(json.load(stream))
    deck, nsteps = solid_plastic_deck(plan)
    with open(DECK, 'w', encoding='utf-8') as stream:
        stream.write(deck)
    problem = fem.InstanciateProblem(fem.OOFEMTXTDataReader(DECK), fem.problemMode.processor, 0, None, False)
    if problem is None:
        raise ValueError('solid-plastic: OOFEM rejected the generated deck')
    primary, records = None, []
    try:
        if problem.checkProblemConsistency() != 1:
            raise ValueError('solid-plastic: OOFEM rejected the model consistency')
        problem.init()
        problem.giveTimer().startTimer(fem.EngngModelTimerType.EMTT_AnalysisTimer)
        meta = problem.giveMetaStep(1)
        if meta is None or meta.giveNumberOfSteps() != nsteps:
            raise ValueError('solid-plastic: the default metastep does not carry the deck step count')
        problem.initMetaStepAttributes(meta)
        domain = problem.giveDomain(1)
        s, knots = plan['stepsPerSegment'], plan['loadFactor']
        ids = (fem.DofIDItem.D_u, fem.DofIDItem.D_v, fem.DofIDItem.D_w)
        fixed = {(p['node'], 'xyz'.index(p['dof'])) for p in plan['prescribedMm']}
        accepted_force_reference = 0.0
        # StaticStructural only warns on non-convergence (staticstructural.C:353-357) and the pinned binding exposes
        # no TimeStep convergedReason (oofem.cpp:1084-1095). Every solved step is therefore checked here, before the
        # next step builds on its material state: finite native values, small strain, and the free-DOF balance of the
        # equilibrated element forces against the applied loads within FREE_RESIDUAL_BOUND (as rtolf 1e-10 implies).
        for index in range(nsteps):
            problem.preInitializeNextStep()
            step = problem.giveNextStep()
            problem.initializeYourself(step)
            problem.solveYourselfAt(step)
            problem.updateYourself(step)
            where = f'step {index + 1}'
            segment, inner = index // s + 1, index % s + 1
            start_factor, end_factor = knots[segment - 1], knots[segment]
            factor = end_factor if inner == s else start_factor + (end_factor - start_factor) * inner / s
            displacement = [[float(domain.giveDofManager(n + 1).giveDofWithID(dof).giveUnknown(
                fem.ValueModeType.VM_Total, step)) for dof in ids] for n in range(len(plan['nodes']))]
            _require_finite((v for row in displacement for v in row), f'displacement at {where}')
            elements, internal = [], [[0.0, 0.0, 0.0] for _ in plan['nodes']]
            for e, nodes in enumerate(plan['elements']):
                element = domain.giveElement(e + 1)
                gp = element.giveDefaultIntegrationRulePtr().getIntegrationPoint(0)
                values = {}
                for name, kind in (('stressMPa', fem.InternalStateType.IST_StressTensor),
                                   ('strain', fem.InternalStateType.IST_StrainTensor),
                                   ('plasticStrain', fem.InternalStateType.IST_PlasticStrainTensor)):
                    answer = fem.FloatArray()
                    element.giveIPValue(answer, gp, kind, step)
                    values[name] = [float(v) for v in answer]
                    if len(values[name]) != 6:
                        raise ValueError(f'solid-plastic: element {e + 1} {name} is not a 6-vector at {where}')
                    _require_finite(values[name], f'element {e + 1} {name} at {where}')
                if any(abs(v) > MAXIMUM_STRAIN for v in values['strain']):
                    raise ValueError(f'solid-plastic: strain exceeds {MAXIMUM_STRAIN} (small-strain formulation) at {where}')
                forces = fem.FloatArray()
                element.giveCharacteristicVector(forces, fem.CharType.LastEquilibratedInternalForcesVector,
                                                 fem.ValueModeType.VM_Total, step)
                forces = [float(v) for v in forces]
                if len(forces) != 12:
                    raise ValueError(f'solid-plastic: element {e + 1} force is not a 12-vector at {where}')
                _require_finite(forces, f'element {e + 1} equilibrated force at {where}')
                for local, node in enumerate(nodes):
                    for axis in range(3):
                        internal[node][axis] += forces[3 * local + axis]
                elements.append(values)
            applied = [[0.0, 0.0, 0.0] for _ in plan['nodes']]
            for f in plan['forcesN']:
                applied[f['node']]['xyz'.index(f['dof'])] = f['forceN'] * factor
            residual, accepted_force_reference = check_free_force_balance(
                internal, applied, fixed, accepted_force_reference, where)
            if inner == s:
                records.append({'step': index + 1, 'loadFactor': factor, 'displacementMm': displacement,
                                'elements': elements, 'freeResidualRatio': residual})
        return json.dumps({'schema': RESULT_SCHEMA, 'method': 'oofem-misesmat-htype0-ltrspace-staticstructural/2',
                           'scope': 'small-strain-j2-linear-isotropic-hardening-tet4',
                           'structuralCertification': False, 'records': records,
                           'yielded': any(v != 0 for r in records for item in r['elements'] for v in item['plasticStrain'])},
                          allow_nan=False)
    except Exception as error:
        primary = error
        raise
    finally:
        try:
            problem.terminateAnalysis()
        except Exception as cleanup_error:
            if primary is None:
                raise
            primary.add_note(f'Additional terminateAnalysis error: {cleanup_error!r}')
