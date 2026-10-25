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
