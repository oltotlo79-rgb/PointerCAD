"""Finite elastic axial shanks and effective weld layers in one contact solve.

The bolt stiffness is added to the native Beam3d matrix before the existing
weld assembler adds its stiffness and invokes the contact solver exactly once.
Both connector responses are recovered from that same displacement. No preload,
friction, bearing, plasticity, strength or fatigue inference is introduced.
"""
import json
import math
from beam_contact import run_beam_contact
from beam_bolt_contact import validate_bolts
from beam_weld_contact import validate_welds, solve_weld_contact_system


def validate_joints(plan):
    if not isinstance(plan, dict) or set(plan) != {'schema', 'contact', 'bolts', 'welds'} or plan['schema'] != 'pointercad-joint-contact-plan/1':
        raise ValueError('joint-shape: explicit mixed bolt and weld plan required')
    bolt_plan = {'schema': 'pointercad-bolt-contact-plan/1', 'contact': plan['contact'], 'bolts': plan['bolts']}
    weld_plan = {'schema': 'pointercad-weld-layer-plan/1', 'contact': plan['contact'], 'welds': plan['welds']}
    bolts = validate_bolts(bolt_plan)
    validate_welds(weld_plan)
    if {b['id'] for b in plan['bolts']} & {w['id'] for w in plan['welds']}:
        raise ValueError('joint-id: connector identities must be distinct')
    return bolts, weld_plan


def solve_joint_contact_system(np, plan, native_stiffness, moment_length):
    bolts, weld_plan = validate_joints(plan)
    size = 6 * len(plan['contact']['nodes'])
    stiffness = np.array(native_stiffness, dtype=float, copy=True)
    if stiffness.shape != (size, size) or not np.isfinite(stiffness).all():
        raise ValueError('joint-stiffness: invalid native matrix')
    for bolt, normal, k in bolts:
        row = np.zeros(size)
        for axis in range(3):
            row[6 * (bolt['nodeA'] - 1) + axis] = -normal[axis]
            row[6 * (bolt['nodeB'] - 1) + axis] = normal[axis]
        stiffness += k * np.outer(row, row)
    # This is the only solve: it adds all weld operators BEFORE solving contact.
    coupled = solve_weld_contact_system(np, weld_plan, stiffness, moment_length)
    states = []
    for contact, weld_state in zip(coupled['contact']['states'], coupled['states'], strict=True):
        displacements = {node['number']: node['displacementM'] for node in contact['nodes']}
        forces = []
        for bolt, normal, k in bolts:
            extension = sum(normal[i] * (displacements[bolt['nodeB']][i] - displacements[bolt['nodeA']][i]) for i in range(3))
            force = k * extension
            if not math.isfinite(extension) or not math.isfinite(force):
                raise ValueError('joint-force: nonfinite axial response')
            forces.append({'id': bolt['id'], 'extensionM': extension, 'axialForceN': force,
                           'forceOnAN': [force*n for n in normal], 'forceOnBN': [-force*n for n in normal]})
        states.append({'loadFactor': contact['loadFactor'], 'bolts': forces, 'welds': weld_state['welds']})
    return {'schema': 'pointercad-joint-contact-result/1', 'contact': coupled['contact'], 'states': states}


def run_beam_joint_contact():
    with open('/pcad_fem/joint-contact-input.json', encoding='utf-8') as stream:
        plan = json.load(stream)
    validate_joints(plan)
    return run_beam_contact(plan=plan['contact'], solve_system=lambda np, unused, stiffness, length:
                            solve_joint_contact_system(np, plan, stiffness, length))
