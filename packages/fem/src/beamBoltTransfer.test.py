"""Independent two-member force transmission: the bolt is their ONLY connection."""
import unittest
import numpy as np
from beamBoltContact import solve_bolt_contact_system


def transfer_fixture():
    fixed, axial = [True] * 6, [False, True, True, True, True, True]
    nodes = [{'number': i + 1, 'positionM': [float(i), 2.0, 3.0],
              'restrained': fixed.copy() if i in (0, 3) else axial.copy(),
              'load': [1.0 if i == 1 else 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]} for i in range(4)]
    members = [{'number': i + 1, 'nodes': ends, 'material': 1, 'section': 1,
                'frame': {'x': [1.0, 0.0, 0.0], 'y': [0.0, 1.0, 0.0], 'z': [0.0, 0.0, 1.0], 'lengthM': 1.0}}
               for i, ends in enumerate(([1, 2], [3, 4]))]
    contact = {'schema': 'pointercad-oofem-contact-plan/1', 'originalNodeCount': 4, 'nodes': nodes,
        'materials': [{'number': 1, 'youngPa': 1000.0, 'poisson': 0.3, 'densityKgM3': 1.0}],
        'sections': [{'number': 1, 'areaM2': 1.0, 'iyM4': 1.0, 'izM4': 1.0, 'torsionM4': 1.0, 'shearFactor': 1.0}],
        'members': members, 'contacts': [{'id': 'stop', 'kind': 'node-plane', 'node': 3, 'normal': [1.0, 0.0, 0.0], 'gapM': 0.001}],
        'loadFactors': [1.0, -1.0, -10.0]}
    plan = {'schema': 'pointercad-bolt-contact-plan/1', 'contact': contact,
            'bolts': [{'id': 'only-link', 'nodeA': 2, 'nodeB': 3, 'youngPa': 1000.0, 'areaM2': 1.0}]}
    stiffness = np.zeros((24, 24))
    for a, b in ([0, 1], [2, 3]):
        row = np.zeros(24)
        row[6 * a], row[6 * b] = -1, 1
        stiffness += 1000 * np.outer(row, row)
    return plan, stiffness


def assert_transfer(result):
    for state, bolts in zip(result['contact']['states'], result['states'], strict=True):
        force = state['loadFactor']
        # Independent 2x2 system [2000,-1000;-1000,2000]u=[F,lambda].
        expected_b = max(force / 3000, -0.001)
        expected_a = (force + 1000 * expected_b) / 2000
        a, b = [state['nodes'][i]['displacementM'][0] for i in (1, 2)]
        axial = bolts['bolts'][0]['axialForceN']
        reaction = state['contacts'][0]['normalReactionN']
        expected_axial = 1000 * (expected_b - expected_a)
        if max(abs(a - expected_a), abs(b - expected_b)) > 1e-12 or abs(axial - expected_axial) > 1e-10:
            raise AssertionError('distinct-member displacement or transferred axial force wrong')
        # Individual free-node balance and complete external force balance, including both clamps.
        if max(abs(1000 * a - axial - force), abs(1000 * b + axial - reaction),
               abs(-1000 * a - 1000 * b + force + reaction)) > 1e-10:
            raise AssertionError('distinct-member force equilibrium wrong')
        if force == 1 and abs(b) < 1e-5:
            raise AssertionError('uncoupled second member cannot count as transmission')


class DistinctMemberTests(unittest.TestCase):
    def test_same_system_transmits_tension_compression_and_contact_reaction(self):
        plan, stiffness = transfer_fixture()
        assert_transfer(solve_bolt_contact_system(np, plan, stiffness, 1.0))


def check_native_transfer():
    import json
    from beam_contact import run_beam_contact
    plan, _ = transfer_fixture()
    result = json.loads(run_beam_contact(plan=plan['contact'], solve_system=lambda np, unused, stiffness, length:
                                        solve_bolt_contact_system(np, plan, stiffness, length)))
    assert_transfer(result)
    return result


if __name__ == '__main__':
    unittest.main()
