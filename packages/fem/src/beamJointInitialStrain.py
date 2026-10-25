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
