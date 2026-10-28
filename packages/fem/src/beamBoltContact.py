"""Elastic axial bolt-shank ties coupled to the existing Beam3d/contact system.

Each tie is a bilateral, stress-free, small-displacement axial bar: k=EA/L,
delta=n.(uB-uA), N=k*delta (tension positive). It adds k*b.T*b to the SAME
global stiffness used by the contact complementarity solve. Compression is
linear elastic here, not a buckling prediction. No preload, head bearing,
friction, slip, thread flexibility, yielding, failure or solid contact claim.
The existing contact pivot/convergence and 1e-9 residual refusals remain.
"""
import json
import math
from beam_contact import run_beam_contact, validate_contact_plan, _solve_contact_system


def validate_bolts(plan):
    if not isinstance(plan, dict) or set(plan) != {'schema', 'contact', 'bolts'} or plan['schema'] != 'pointercad-bolt-contact-plan/1':
        raise ValueError('bolt-shape: unsupported plan')
    validate_contact_plan(plan['contact'])
    nodes = plan['contact']['nodes'][:plan['contact']['originalNodeCount']]
    positions = {node['number']: node['positionM'] for node in nodes}
    bolts = plan['bolts']
    if not isinstance(bolts, list) or not 1 <= len(bolts) <= 64:
        raise ValueError('bolt-count: expected 1..64')
    ids, pairs, result = set(), set(), []
    for bolt in bolts:
        if not isinstance(bolt, dict) or set(bolt) != {'id', 'nodeA', 'nodeB', 'youngPa', 'areaM2'}:
            raise ValueError('bolt-shape: unknown or absent bolt fields')
        identity, a, b = bolt['id'], bolt['nodeA'], bolt['nodeB']
        if not isinstance(identity, str) or not 1 <= len(identity) <= 64 or identity in ids:
            raise ValueError('bolt-id: missing or duplicate')
        if type(a) is not int or type(b) is not int or a not in positions or b not in positions or a == b:
            raise ValueError('bolt-node: original distinct nodes required')
        pair = tuple(sorted((a, b)))
        if pair in pairs:
            raise ValueError('bolt-duplicate: use one declared total shank area per pair')
        for key in ('youngPa', 'areaM2'):
            value = bolt[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 1e-30 < value <= 1e30:
                raise ValueError('bolt-number: positive bounded E and A required')
        span = [positions[b][i] - positions[a][i] for i in range(3)]
        length = math.hypot(*span)
        stiffness = bolt['youngPa'] * bolt['areaM2'] / length if length > 1e-9 else math.inf
        if not math.isfinite(stiffness) or not 1e-30 < stiffness <= 1e30:
            raise ValueError('bolt-length-stiffness: finite noncoincident axial tie required')
        ids.add(identity)
        pairs.add(pair)
        result.append((bolt, [value / length for value in span], stiffness))
    return result


def solve_bolt_contact_system(np, plan, native_stiffness, moment_length):
    """Native K remains unmodified. Contacts and bolt forces share one solution."""
    bolts = validate_bolts(plan)
    contact = plan['contact']
    size = 6 * len(contact['nodes'])
    stiffness = np.array(native_stiffness, dtype=float, copy=True)
    if stiffness.shape != (size, size) or not np.isfinite(stiffness).all():
        raise ValueError('bolt-stiffness: invalid native matrix')
    for bolt, normal, k in bolts:
        row = np.zeros(size)
        for axis in range(3):
            row[6 * (bolt['nodeA'] - 1) + axis] = -normal[axis]
            row[6 * (bolt['nodeB'] - 1) + axis] = normal[axis]
        stiffness += k * np.outer(row, row)
    response = _solve_contact_system(np, contact, stiffness, moment_length)
    states = []
    for state in response['states']:
        displacements = {node['number']: node['displacementM'] for node in state['nodes']}
        forces = []
        for bolt, normal, k in bolts:
            delta = sum(normal[i] * (displacements[bolt['nodeB']][i] - displacements[bolt['nodeA']][i]) for i in range(3))
            force = k * delta
            if not math.isfinite(force):
                raise ValueError('bolt-force: unrepresentable response')
            forces.append({'id': bolt['id'], 'extensionM': delta, 'axialForceN': force,
                           'forceOnAN': [force * n for n in normal],
                           'forceOnBN': [-force * n for n in normal]})
        states.append({'loadFactor': state['loadFactor'], 'bolts': forces})
    return {'schema': 'pointercad-bolt-contact-result/1', 'contact': response, 'states': states}


def run_beam_bolt_contact():
    with open('/pcad_fem/bolt-contact-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    validate_bolts(plan)  # refuse unsupported fields before native objects exist
    return run_beam_contact(plan=plan['contact'], solve_system=lambda np, unused, stiffness, length:
                            solve_bolt_contact_system(np, plan, stiffness, length))



# Explicit finite-length 6DOF route. No legacy axial/initial-strain plan accepts it.
def _frame_fields(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('frame-shape')
    return value


def _frame_number(value, zero=False):
    if type(value) not in (int, float) or not math.isfinite(value) or value > 1e30 or (value < 0 if zero else value <= 1e-30):
        raise ValueError('frame-number')
    return value


def _frame_text(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 2048 or value.strip() != value or any(ord(c) < 32 for c in value):
        raise ValueError('frame-source')
    return value


def _frame_source(value):
    _frame_fields(value, ['kind', 'reference', 'condition'])
    if value['kind'] not in ('published', 'measured', 'user-supplied'):
        raise ValueError('frame-source')
    _frame_text(value['reference']); _frame_text(value['condition'])


def _frame_quantity(value, role, zero=False):
    _frame_fields(value, ['role', 'value', 'source'])
    if value['role'] != role:
        raise ValueError('frame-quantity-role')
    _frame_source(value['source'])
    return _frame_number(value['value'], zero)


def validate_frame_bolt(plan):
    _frame_fields(plan, ['schema', 'contact', 'bolt'])
    if plan['schema'] != 'pointercad-frame-bolt-contact/1':
        raise ValueError('frame-schema')
    validate_contact_plan(plan['contact'])
    b = _frame_fields(plan['bolt'], ['id', 'memberId', 'member', 'model', 'couplingSource', 'shorteningM',
                                    'threadCompliance', 'headCompliance', 'bearingCompliance', 'section'])
    _frame_text(b['id']); _frame_text(b['memberId']); _frame_source(b['couplingSource'])
    if b['model'] != 'centroidal-frame-shank-explicit-end-coupling' or type(b['member']) is not int:
        raise ValueError('frame-model')
    members = plan['contact']['members']
    if not 1 <= b['member'] <= len(members):
        raise ValueError('frame-member')
    m = members[b['member'] - 1]
    if max(m['nodes']) > plan['contact']['originalNodeCount'] or sum(set(row['nodes']) == set(m['nodes']) for row in members) != 1:
        raise ValueError('frame-double-count')
    shortening = _frame_quantity(b['shorteningM'], 'shortening-m', True)
    if shortening >= m['frame']['lengthM']:
        raise ValueError('frame-shortening')
    extra = sum(_frame_quantity(b[key], role, True) for key, role in [
        ('threadCompliance', 'thread-compliance-m-per-n'), ('headCompliance', 'head-compliance-m-per-n'),
        ('bearingCompliance', 'bearing-compliance-m-per-n')])
    section = plan['contact']['sections'][m['section']-1]
    material = plan['contact']['materials'][m['material']-1]
    compliance = _frame_number(m['frame']['lengthM'] / (material['youngPa'] * section['areaM2']) + extra)
    stiffness = _frame_number(1 / compliance)
    if shortening > 0:
        _frame_number(stiffness * shortening)
    nominal = _frame_fields(b['section'], ['materialConditionId', 'tensileArea', 'shearArea', 'modulusY', 'modulusZ', 'fibreYM', 'fibreZM', 'limits'])
    _frame_text(nominal['materialConditionId'])
    values = {key: _frame_quantity(nominal[key], role) for key, role in [
        ('tensileArea', 'tensile-area-m2'), ('shearArea', 'plain-shank-shear-area-m2'),
        ('modulusY', 'section-modulus-y-m3'), ('modulusZ', 'section-modulus-z-m3'),
        ('fibreYM', 'extreme-y-m'), ('fibreZM', 'extreme-z-m')]}
    def same(a, c):
        return math.isfinite(a) and math.isfinite(c) and abs(a-c) <= 1e-9 * max(abs(c), 1e-300)
    if values['tensileArea'] > section['areaM2'] or not same(values['shearArea'], section['areaM2']) or not same(values['modulusY'], section['iyM4']/values['fibreZM']) or not same(values['modulusZ'], section['izM4']/values['fibreYM']):
        raise ValueError('frame-section-mismatch')
    limits = nominal['limits']
    if limits is not None:
        _frame_fields(limits, ['classId', 'materialConditionId', 'tensionPa', 'shearPa', 'bendingPa', 'source'])
        _frame_text(limits['classId']); _frame_text(limits['materialConditionId']); _frame_source(limits['source'])
        for key in ['tensionPa', 'shearPa', 'bendingPa']:
            _frame_number(limits[key])
    return m, stiffness, compliance, shortening


def solve_frame_bolt_contact_system(np, plan, native_stiffness, moment_length, element_matrices):
    """Use one native member once; replace only its uncoupled axial block in the SAME system."""
    m, k, compliance, shortening = validate_frame_bolt(plan)
    size = 6*len(plan['contact']['nodes'])
    stiffness = np.array(native_stiffness, dtype=float, copy=True)
    if stiffness.shape != (size, size) or not np.isfinite(stiffness).all():
        raise ValueError('frame-native-stiffness')
    records = [row for row in element_matrices if row['number'] == m['number']]
    if len(records) != 1:
        raise ValueError('frame-native-member')
    indices = [6*(n-1)+i for n in m['nodes'] for i in range(6)]
    record = records[0]
    if record['indices'] != indices:
        raise ValueError('frame-native-identity')
    original = np.array(record['localMatrix'], dtype=float, copy=True)
    if original.shape != (12, 12) or not np.isfinite(original).all():
        raise ValueError('frame-native-matrix')
    E = plan['contact']['materials'][m['material']-1]['youngPa']
    A = plan['contact']['sections'][m['section']-1]['areaM2']
    natural = E*A/m['frame']['lengthM']
    # Native axis block is independent of all lateral/rotational DOFs. Do not subtract nearly equal k values.
    for i in range(12):
        for j in (0, 6):
            expected = natural * (1 if i == j else -1) if i in (0, 6) else 0.0
            if abs(original[i, j]-expected) > 1e-9 * max(abs(expected), 1e-300):
                raise ValueError('frame-native-axial-block')
            if original[i, j] != original[j, i]:
                raise ValueError('frame-native-symmetry')
    local = original.copy()
    local[0, 0] = local[6, 6] = k
    local[0, 6] = local[6, 0] = -k
    R = np.array([m['frame'][a] for a in ('x', 'y', 'z')])
    T = np.kron(np.eye(4), R)
    # Reassemble supplied native blocks rather than subtracting two nearly equal global axial entries.
    # This preserves a very soft declared series stiffness without cancellation of EA/L.
    if len(element_matrices) != len(plan['contact']['members']):
        raise ValueError('frame-native-count')
    assembled = np.zeros_like(stiffness)
    replacement = np.zeros_like(stiffness)
    for member, captured in zip(plan['contact']['members'], element_matrices, strict=True):
        ids = [6*(n-1)+i for n in member['nodes'] for i in range(6)]
        if captured['number'] != member['number'] or captured['indices'] != ids:
            raise ValueError('frame-native-identity')
        block = np.array(captured['localMatrix'], dtype=float)
        if block.shape != (12, 12) or not np.isfinite(block).all():
            raise ValueError('frame-native-matrix')
        rotation = np.array([member['frame'][a] for a in ('x', 'y', 'z')])
        transform = np.kron(np.eye(4), rotation)
        assembled[np.ix_(ids, ids)] += transform.T @ block @ transform
        replacement[np.ix_(ids, ids)] += transform.T @ (local if member['number'] == m['number'] else block) @ transform
    if not np.array_equal(assembled, stiffness):
        raise ValueError('frame-native-assembly')
    stiffness = replacement
    b = np.zeros(12); b[0], b[6] = -1, 1
    initial = np.zeros(size); initial[indices] -= T.T @ (k*shortening*b)
    if not np.isfinite(stiffness).all() or not np.isfinite(initial).all():
        raise ValueError('frame-nonfinite')
    # The caller's original native K/element matrix remain unchanged. Same residual/refusal path as old contact.
    response = _solve_contact_system(np, plan['contact'], stiffness, moment_length, constant_force=initial.tolist())
    states = []
    for solved in response['states']:
        nodes = {node['number']: node for node in solved['nodes']}
        if any(n not in nodes for n in m['nodes']):
            raise ValueError('frame-node-identity')
        u = np.array([x for n in m['nodes'] for x in nodes[n]['displacementM']+nodes[n]['rotationRad']])
        d = T @ u
        q = local @ d + k*shortening*b
        end = -(T.T @ q)
        tension = float(q[6])
        transverse_displacement = d.copy()
        transverse_displacement[0] = transverse_displacement[6] = 0
        transverse_energy = float(transverse_displacement @ local @ transverse_displacement)/2
        energy = tension*tension*compliance/2 + transverse_energy
        a, z = [np.array(plan['contact']['nodes'][n-1]['positionM']) for n in m['nodes']]
        force_error = np.max(np.abs(end[:3]+end[6:9]))
        moment_error = np.max(np.abs(end[3:6]+end[9:12]+np.cross(z-a, end[6:9])))
        if not np.isfinite(q).all() or not math.isfinite(energy) or energy < -1e-12 or max(force_error, moment_error) > 1e-8:
            raise ValueError('frame-recovery-equilibrium')
        states.append({'loadFactor': solved['loadFactor'], 'boltId': plan['bolt']['id'], 'member': m['number'],
                       'forceOnAN': end[:3].tolist(), 'forceOnBN': end[6:9].tolist(),
                       'momentOnANm': end[3:6].tolist(), 'momentOnBNm': end[9:12].tolist(),
                       'axialForceN': tension, 'shearYN': float(q[7]), 'shearZN': float(q[8]),
                       'bendingYNm': float(max(abs(q[4]), abs(q[10]))), 'bendingZNm': float(max(abs(q[5]), abs(q[11]))),
                       'elasticEnergyJ': max(0.0, energy), 'transverseEnergyJ': transverse_energy})
    return {'schema': 'pointercad-frame-bolt-contact-result/1', 'contact': response, 'states': states}


def run_frame_bolt_contact():
    with open('/pcad_fem/frame-bolt-input.json', encoding='utf-8') as stream:
        envelope = json.load(stream)
    _frame_fields(envelope, ['inputSha256', 'plan'])
    digest = envelope['inputSha256']
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ValueError('frame-input-digest')
    plan = envelope['plan']; validate_frame_bolt(plan)
    def solve(np, unused, stiffness, length, matrices):
        result = solve_frame_bolt_contact_system(np, plan, stiffness, length, matrices)
        result['inputSha256'] = digest
        return result
    return run_beam_contact(plan=plan['contact'], solve_with_elements=solve)
