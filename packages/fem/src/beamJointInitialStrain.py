"""Prescribed stress-free shank shortening with simultaneous elastic weld/contact.

Shortening specifies an initial strain, not final bolt tension or tightening torque.
No friction, bearing, tightening sequence, yielding, strength or fatigue model.
"""
import json
import math
from beam_contact import run_beam_contact
from beam_joint_contact import validate_joints
from beam_weld_contact import solve_weld_contact_system


def validate_initial_strains(plan):
    if not isinstance(plan, dict) or set(plan) != {'schema', 'joint', 'shortenings'} or plan['schema'] != 'pointercad-joint-initial-strain-plan/1':
        raise ValueError('joint-initial-strain-shape')
    bolts, weld_plan = validate_joints(plan['joint'])
    rows = plan['shortenings']
    if not isinstance(rows, list) or len(rows) != len(bolts):
        raise ValueError('joint-initial-strain: one explicit shortening per shank required')
    values = {}
    lengths = {b['id']: math.dist(plan['joint']['contact']['nodes'][b['nodeA']-1]['positionM'],
                                  plan['joint']['contact']['nodes'][b['nodeB']-1]['positionM']) for b, _, _ in bolts}
    for row in rows:
        if (not isinstance(row, dict) or set(row) != {'boltId', 'shorteningM'}
                or not isinstance(row['boltId'], str) or row['boltId'] not in lengths or row['boltId'] in values):
            raise ValueError('joint-initial-strain: exact unique shank identities required')
        shortening = row['shorteningM']
        if (type(shortening) not in (int, float) or not math.isfinite(shortening)
                or not 0 <= shortening < lengths[row['boltId']]):
            raise ValueError('joint-initial-strain: finite nonnegative shortening and positive stress-free length required')
        values[row['boltId']] = shortening
    return bolts, weld_plan, values


def solve_joint_initial_strain_system(np, plan, native_stiffness, moment_length):
    bolts, weld_plan, shortenings = validate_initial_strains(plan)
    size = 6*len(plan['joint']['contact']['nodes'])
    stiffness = np.array(native_stiffness, dtype=float, copy=True)
    if stiffness.shape != (size, size) or not np.isfinite(stiffness).all():
        raise ValueError('joint-initial-strain: invalid native matrix')
    initial_force = np.zeros(size)
    for bolt, normal, k in bolts:
        row = np.zeros(size)
        for axis in range(3):
            row[6*(bolt['nodeA']-1)+axis] = -normal[axis]
            row[6*(bolt['nodeB']-1)+axis] = normal[axis]
        stiffness += k*np.outer(row, row)
        initial_force -= k*shortenings[bolt['id']]*row
    if not np.isfinite(initial_force).all():
        raise ValueError('joint-initial-strain: nonfinite initial force')
    coupled = solve_weld_contact_system(np, weld_plan, stiffness, moment_length, constant_force=initial_force.tolist())
    states = []
    for contact, state in zip(coupled['contact']['states'], coupled['states'], strict=True):
        displacements = {node['number']: node['displacementM'] for node in contact['nodes']}
        forces = []
        for bolt, normal, k in bolts:
            extension = sum(normal[i]*(displacements[bolt['nodeB']][i]-displacements[bolt['nodeA']][i]) for i in range(3))
            elastic_extension = extension+shortenings[bolt['id']]
            force, energy = k*elastic_extension, k*elastic_extension*elastic_extension/2
            if not all(math.isfinite(value) for value in (extension, elastic_extension, force, energy)):
                raise ValueError('joint-initial-strain: nonfinite recovered response')
            forces.append({'id': bolt['id'], 'extensionM': extension, 'elasticExtensionM': elastic_extension,
                           'axialForceN': force, 'forceOnAN': [force*n for n in normal],
                           'forceOnBN': [-force*n for n in normal], 'elasticEnergyJ': energy})
        states.append({'loadFactor': contact['loadFactor'], 'bolts': forces, 'welds': state['welds']})
    return {'schema': 'pointercad-joint-initial-strain-result/1', 'contact': coupled['contact'], 'states': states}


def run_beam_joint_initial_strain():
    with open('/pcad_fem/joint-initial-strain-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    validate_initial_strains(plan)
    return run_beam_contact(plan=plan['joint']['contact'], solve_system=lambda np, unused, stiffness, length:
                            solve_joint_initial_strain_system(np, plan, stiffness, length))


# Candidate additive route. The version-1 joint/shortening entry above is unchanged.
def validate_native_preload(plan):
    """One coaxial two-member joint; no inferred compliance or legacy-result reuse."""
    from beam_bolt_contact import validate_bolts
    expected = {'schema', 'boltPlan', 'shorteningM', 'declaration'}
    if not isinstance(plan, dict) or set(plan) != expected or plan['schema'] != 'pointercad-native-bolt-preload-plan/1':
        raise ValueError('native-preload-plan')
    bolts = validate_bolts(plan['boltPlan'])
    c = plan['boltPlan']['contact']
    if len(bolts) != 1 or len(c['nodes']) != 4 or c['originalNodeCount'] != 4 or len(c['members']) != 2 or len(c['contacts']) != 1:
        raise ValueError('native-preload-scope: two members, four original nodes, one bolt/contact')
    d = plan['declaration']
    keys = {'boltId', 'model', 'modelSource', 'shankSource', 'shorteningSource', 'preloadN',
            'threadCompliance', 'headCompliance', 'bearingCompliance', 'memberCompliance', 'externalLoadsN', 'loadSource'}
    if not isinstance(d, dict) or set(d) != keys or d['model'] != 'coaxial-outer-planes-series-bearing':
        raise ValueError('native-preload-declaration')
    def source(v):
        if not isinstance(v, dict) or set(v) != {'kind', 'reference', 'condition'} or v['kind'] not in {'published', 'measured', 'user-supplied'}:
            raise ValueError('native-preload-source')
        for key, limit in [('reference', 2048), ('condition', 1024)]:
            text = v[key]
            if not isinstance(text, str) or not 1 <= len(text) <= limit or text.strip() != text or any(ord(x) < 32 for x in text):
                raise ValueError('native-preload-source')
    def number(v, positive=False):
        if type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1e30 or (positive and v <= 0):
            raise ValueError('native-preload-number')
        return v
    def sourced(v, positive=False):
        if not isinstance(v, dict) or set(v) != {'value', 'source'}: raise ValueError('native-preload-sourced-number')
        source(v['source'])
        return number(v['value'], positive)
    for key in ['modelSource', 'shankSource', 'shorteningSource', 'loadSource']: source(d[key])
    fi = sourced(d['preloadN'], True)
    extra = sum(sourced(d[key]) for key in ['threadCompliance', 'headCompliance', 'bearingCompliance'])
    cm_declared = sourced(d['memberCompliance'], True)
    loads = d['externalLoadsN']
    if not isinstance(loads, list) or not 1 <= len(loads) <= 31: raise ValueError('native-preload-stage-count')
    for load in loads: number(load)
    bolt, normal, shank_k = bolts[0]
    if d['boltId'] != bolt['id']: raise ValueError('native-preload-identity')
    nodes = {n['number']: n for n in c['nodes']}
    a, b = bolt['nodeA'], bolt['nodeB']
    pair = c['contacts'][0]
    if pair['kind'] != 'node-pair' or pair['gapM'] != 0: raise ValueError('native-preload-contact')
    left, right = pair['nodeA'], pair['nodeB']
    if len({a, left, right, b}) != 4: raise ValueError('native-preload-topology')
    if max(abs(pair['normal'][i]-normal[i]) for i in range(3)) > 1e-10: raise ValueError('native-preload-normal')
    length = math.dist(nodes[a]['positionM'], nodes[b]['positionM'])
    # Axis-aligned first admission: existing Boolean restraint masks cannot prescribe arbitrary oblique axial motion.
    axis = max(range(3), key=lambda i: abs(normal[i]))
    if abs(abs(normal[axis])-1) > 1e-12 or any(abs(normal[i]) > 1e-12 for i in range(3) if i != axis):
        raise ValueError('native-preload-axis-scope')
    free_mask = [i != axis for i in range(6)]
    if nodes[a]['restrained'] != [True]*6 or any(nodes[n]['restrained'] != free_mask for n in [left, right, b]):
        raise ValueError('native-preload-restraints')
    origin = nodes[a]['positionM']
    stations = {}
    for n in [left, right, b]:
        delta = [nodes[n]['positionM'][i]-origin[i] for i in range(3)]
        station = sum(delta[i]*normal[i] for i in range(3))
        if math.hypot(*(delta[i]-station*normal[i] for i in range(3))) > 1e-10*length:
            raise ValueError('native-preload-coaxial')
        stations[n] = station
    if not 0 < stations[left] < length or abs(stations[left]-stations[right]) > 1e-10*length:
        raise ValueError('native-preload-facing-sections')
    expected_pairs = {frozenset((a, left)), frozenset((right, b))}
    if {frozenset(m['nodes']) for m in c['members']} != expected_pairs: raise ValueError('native-preload-member-topology')
    member_compliance = 0.0
    for member in c['members']:
        material = c['materials'][member['material']-1]
        section = c['sections'][member['section']-1]
        member_compliance += member['frame']['lengthM']/(material['youngPa']*section['areaM2'])
    cb = number(1/shank_k+extra, True)
    cm = number(member_compliance, True)
    if abs(cm-cm_declared) > 1e-9*max(cm, cm_declared): raise ValueError('native-preload-member-compliance')
    shortening = number(plan['shorteningM'], True)
    required = number(fi*(cb+cm), True)
    if shortening >= length or required >= length or abs(shortening-required) > 1e-9*max(shortening, required):
        raise ValueError('native-preload-shortening-force')
    # 1 N at the explicitly named outer loading port, not an invented CAD load conversion.
    for n in c['nodes']:
        expected_load = normal+[0.0]*3 if n['number'] == b else [0.0]*6
        if n['load'] != expected_load: raise ValueError('native-preload-reference-load')
    if c['loadFactors'] != [0.0]+loads: raise ValueError('native-preload-stage-loads')
    return bolt, normal, cb, cm, shortening, fi


def solve_native_preload_system(np, plan, native_stiffness, moment_length):
    from beam_contact import _solve_contact_system
    bolt, normal, cb, cm, shortening, fi = validate_native_preload(plan)
    c = plan['boltPlan']['contact']; size = 6*len(c['nodes'])
    native = np.array(native_stiffness, dtype=float, copy=True)
    if native.shape != (size, size) or not np.isfinite(native).all(): raise ValueError('native-preload-matrix')
    row = np.zeros(size)
    for i in range(3):
        row[6*(bolt['nodeA']-1)+i] = -normal[i]
        row[6*(bolt['nodeB']-1)+i] = normal[i]
    k = 1/cb
    stiffness = native+k*np.outer(row, row)
    constant = -k*shortening*row
    response = _solve_contact_system(np, c, stiffness, moment_length, constant_force=constant.tolist())
    states = []
    for index, state in enumerate(response['states']):
        u = np.zeros(size)
        for n in state['nodes']: u[6*(n['number']-1):6*n['number']] = n['displacementM']+n['rotationRad']
        extension = float(row@u); tension = k*(extension+shortening)
        if not math.isfinite(tension) or tension < 0: raise ValueError('native-preload-tension')
        member_energy = float(u@native@u)/2
        bolt_energy = cb*tension*tension/2
        external = np.array([v for n in c['nodes'] for v in n['load']])*state['loadFactor']
        from beam_contact import constraint_rows
        contact_force = constraint_rows(np, c['nodes'], c['contacts']).T@np.array([v['normalReactionN'] for v in state['contacts']])
        residual = stiffness@u-constant-external-contact_force
        support = []
        for n in c['nodes']:
            start = 6*(n['number']-1)
            support.append({'number':n['number'], 'forceN':[float(residual[start+i]) if n['restrained'][i] else 0.0 for i in range(3)]})
        states.append({'stage':'tightening' if index == 0 else 'external', 'externalLoadN':state['loadFactor'],
            'boltId':bolt['id'], 'extensionM':extension, 'elasticExtensionM':extension+shortening,
            'boltTensionN':tension, 'memberCompressionN':state['contacts'][0]['normalReactionN'],
            'gapM':state['contacts'][0]['gapM'], 'boltEnergyJ':bolt_energy, 'memberEnergyJ':member_energy,
            'supportReactions':support})
    if abs(states[0]['boltTensionN']-fi) > 1e-3*fi: raise ValueError('native-preload-equilibrated-force')
    return {'schema':'pointercad-native-bolt-preload-result/1',
        'method':'native-beam3d-plus-series-bolt-and-existing-lcp', 'nativeContactSolver':False,
        'structuralCertification':False, 'lockedShorteningM':shortening,
        'lockAfterState':0, 'boltComplianceMPerN':cb, 'memberComplianceMPerN':cm,
        'contact':response, 'states':states}


def run_beam_bolt_preload_stages():
    """One native assembly; all states keep the authored stress-free shortening fixed."""
    import hashlib
    with open('/pcad_fem/bolt-preload-native-input.json', 'rb') as stream: raw = stream.read()
    if len(raw) > 4_000_000: raise ValueError('native-preload-input-bound')
    plan = json.loads(raw)
    validate_native_preload(plan)
    encoded = run_beam_contact(plan=plan['boltPlan']['contact'], solve_system=lambda np, unused, matrix, length:
        solve_native_preload_system(np, plan, matrix, length))
    result = json.loads(encoded)
    result['planSha256'] = hashlib.sha256(raw).hexdigest()
    return json.dumps(result, allow_nan=False)
