"""Run the unmodified upstream test and retain its actual two displacements.

Reference: oofem/oofem v3.0, bindings/python/tests/test_2.py.
This wrapper is PointerCAD code. The original LGPL-2.1-or-later fixture is
distributed separately, byte-for-byte, with its source and license inventory.
"""
import importlib.metadata
import json
import math
import os
import platform
import runpy
import sys
import sysconfig


def run_beam_proof():
    import pyodide
    if pyodide.__version__ != '0.29.3':
        raise RuntimeError('Unexpected Pyodide runtime: ' + pyodide.__version__)
    if sys.version_info[:3] != (3, 13, 2) or sys.platform != 'emscripten':
        raise RuntimeError('Expected CPython 3.13.2 on Emscripten: ' + sys.version)
    if tuple(sys._emscripten_info.emscripten_version) != (4, 0, 9):
        raise RuntimeError('Emscripten version differs from fixed ABI metadata')
    distribution_version = importlib.metadata.version('oofem')
    if distribution_version != '3.1.dev5+g214b161ed':
        raise RuntimeError('Unexpected OOFEM embedded version: ' + distribution_version)
    if not __debug__:
        raise RuntimeError('Upstream assertions must remain enabled')
    # The upstream util imports plotting packages even though the test does not
    # draw. Agg uses the local interpreter only; no GUI or browser is requested.
    os.environ['MPLBACKEND'] = 'Agg'
    os.environ['MPLCONFIGDIR'] = '/pcad_fem/matplotlib'
    program = runpy.run_path('/pcad_fem/upstream_test_2.py', run_name='_pcad_upstream_beam')
    test = program['test_2']
    measured = {}

    def observe(frame, event, unused):
        if event == 'return' and frame.f_code is test.__code__ and 'u1' in frame.f_locals and 'u4' in frame.f_locals:
            # The function has returned after its original assertions and
            # terminateAnalysis. Never synthesize a value if a local is absent.
            measured['u1'] = float(frame.f_locals['u1'])
            measured['u4'] = float(frame.f_locals['u4'])

    previous_profile = sys.getprofile()
    previous_directory = os.getcwd()
    try:
        os.chdir('/pcad_fem')
        sys.setprofile(observe)
        test()
    finally:
        sys.setprofile(previous_profile)
        os.chdir(previous_directory)
    u1, u4 = measured['u1'], measured['u4']
    if not math.isfinite(u1) or not math.isfinite(u4):
        raise RuntimeError('OOFEM returned a non-finite displacement')
    error = max(abs(u1 + 8.64000000e-4), abs(u4 - 9.47333333e-4))
    if error >= 5e-9:
        raise RuntimeError('Displacement differs from the upstream reference')
    return json.dumps({
        'kind': 'oofem-upstream-test-2', 'purpose': 'runtime-qualification-only',
        'pyodideVersion': pyodide.__version__, 'pythonVersion': platform.python_version(),
        'oofemVersion': distribution_version, 'pythonAbi': sysconfig.get_config_var('SOABI'),
        'u1': u1, 'u4': u4, 'upstreamAssertionsPassed': True,
        'maximumAbsoluteError': error,
    }, allow_nan=False)
