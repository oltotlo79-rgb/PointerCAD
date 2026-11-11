"""Independent initial-shortening orientation regression on EXISTING numerical modules.

Unlike the existing stress-free bolt orientation tests, this covers nonzero initial
shortening under BOTH endpoint reversal and world-axis reversal. Native is not run.
The grouped member branch is explicitly a 1000 N/m bar plus 1000 N/m finite weld
layer; it is neither a rigid weld nor a replacement for the two-bar native benchmark.
"""
import copy
import unittest
import numpy as np
import importlib.util
from pathlib import Path
import sys

# Match the existing native runtime module names using adjacent source bytes.
for _source_name, _runtime_name in (
        ('beamContact', 'beam_contact'),
        ('beamBoltContact', 'beam_bolt_contact'),
        ('beamWeldContact', 'beam_weld_contact'),
        ('beamJointContact', 'beam_joint_contact'),
        ('beamJointInitialStrain', 'beam_joint_initial_strain')):
    _spec = importlib.util.spec_from_file_location(
        _runtime_name, Path(__file__).resolve().with_name(_source_name + '.py'))
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_runtime_name] = _module
    _spec.loader.exec_module(_module)

from beam_joint_initial_strain import solve_joint_initial_strain_system

def contact_plan(direction=1):
    """Two E=1000 Pa, A=1 m2, L=.5 m axial members in series: km=1000 N/m.
    The coincident facing sections are distinct nodes 2/3, with actual unilateral contact.
    Other DOFs are fixed so the supplied exact axial matrices are the entire active model.
    """
    normal = [float(direction), 0.0, 0.0]
    return {'schema': 'pointercad-oofem-contact-plan/1', 'originalNodeCount': 4,
            'nodes': [{'number': i + 1, 'positionM': [direction*x, 0.0, 0.0],
                       'restrained': [True]*6 if i == 0 else [False, True, True, True, True, True],
                       'load': normal + [0.0]*3 if i == 3 else [0.0]*6}
                      for i, x in enumerate((0.0, 0.5, 0.5, 1.0))],
            'materials': [{'number': 1, 'youngPa': 1000.0, 'poisson': 0.25, 'densityKgM3': 1.0}],
            'sections': [{'number': 1, 'areaM2': 1.0, 'iyM4': 1.0, 'izM4': 1.0,
                          'torsionM4': 1.0, 'shearFactor': 1.0}],
            'members': [{'number': i+1, 'nodes': pair, 'material': 1, 'section': 1,
                         'frame': {'x': normal, 'y': [0.0, 1.0, 0.0],
                                   'z': [0.0, 0.0, float(direction)], 'lengthM': 0.5}}
                        for i, pair in enumerate(([1, 2], [3, 4]))],
            'contacts': [{'id': 'bearing', 'kind': 'node-pair', 'nodeA': 2, 'nodeB': 3,
                          'normal': normal, 'gapM': 0.0}], 'loadFactors': [0.0, 1.0]}


def mixed_fixture(direction=1, swapped=False, shortening=0.004):
    """Finite layer and member in parallel: km=1000+1000=2000 N/m, kb=2000 N/m.
    This is explicitly three physical elastic branches, not the two-bar preload fixture.
    Their grouped member stiffness gives F=4 N and d=-.002 m when delta=.004 m.
    """
    contact = contact_plan(direction)
    contact['originalNodeCount'] = 2
    contact['nodes'] = [contact['nodes'][0], {'number': 2, 'positionM': [float(direction), 0.0, 0.0],
        'restrained': [False, True, True, True, True, True], 'load': [0.0]*6}]
    contact['members'] = [copy.deepcopy(contact['members'][0])]
    contact['members'][0]['frame']['lengthM'] = 1.0
    contact['contacts'] = [{'id': 'remote-stop', 'kind': 'node-plane', 'node': 2,
                            'normal': [float(direction), 0.0, 0.0], 'gapM': 1.0}]
    contact['loadFactors'] = [0.0]
    weld = {'id': 'layer', 'nodeA': 1, 'nodeB': 2, 'centerM': [float(direction), 0.0, 0.0],
            'normal': [float(direction), 0.0, 0.0], 'along': [0.0, 1.0, 0.0],
            'widthM': 1.0, 'lengthM': 1.0, 'thicknessM': 1.0, 'youngPa': 1000.0, 'poisson': 0.25}
    bolt = {'id': 'bolt', 'nodeA': 2 if swapped else 1, 'nodeB': 1 if swapped else 2,
            'youngPa': 2000.0, 'areaM2': 1.0}
    plan = {'schema': 'pointercad-joint-initial-strain-plan/1',
            'joint': {'schema': 'pointercad-joint-contact-plan/1', 'contact': contact,
                      'bolts': [bolt], 'welds': [weld]},
            'shortenings': [{'boltId': 'bolt', 'shorteningM': shortening}]}
    matrix = np.zeros((12, 12))
    matrix[0, 0] = matrix[6, 6] = 1000.0
    matrix[0, 6] = matrix[6, 0] = -1000.0
    return plan, matrix



class InitialStrainOrientationTests(unittest.TestCase):
    def test_grouped_member_and_layer_force_balance_with_node_reversal(self):
        for direction in (-1, 1):
            for swapped in (False, True):
                with self.subTest(direction=direction, swapped=swapped):
                    plan, matrix = mixed_fixture(direction, swapped)
                    result = solve_joint_initial_strain_system(np, plan, matrix, 1.0)
                    state = result['states'][0]; bolt = state['bolts'][0]; layer = state['welds'][0]
                    self.assertAlmostEqual(bolt['axialForceN'], 4.0, delta=4e-9)
                    self.assertAlmostEqual(bolt['extensionM'], -0.002, delta=4e-12)
                    self.assertAlmostEqual(bolt['elasticExtensionM'], 0.002, delta=4e-12)
                    self.assertAlmostEqual(bolt['elasticExtensionM']-bolt['extensionM'], 0.004, delta=4e-12)
                    sign = -direction if swapped else direction
                    np.testing.assert_allclose(bolt['forceOnAN'], [4.0*sign, 0.0, 0.0], atol=4e-9, rtol=0)
                    np.testing.assert_allclose(bolt['forceOnBN'], [-4.0*sign, 0.0, 0.0], atol=4e-9, rtol=0)
                    np.testing.assert_allclose(layer['forceOnBN'], [2.0*direction, 0.0, 0.0], atol=2e-9, rtol=0)
                    # Physical tip: bolt -4, layer +2, native member +2, all in the declared axis.
                    u = np.array([v for n in result['contact']['states'][0]['nodes'] for v in n['displacementM']+n['rotationRad']])
                    bolt_tip = bolt['forceOnAN'] if swapped else bolt['forceOnBN']
                    np.testing.assert_allclose(-matrix[6:9]@u+np.array(bolt_tip)+np.array(layer['forceOnBN']), 0.0, atol=4e-9, rtol=0)
                    self.assertEqual(result['contact']['states'][0]['contacts'][0]['normalReactionN'], 0.0)



if __name__ == '__main__':
    unittest.main()
