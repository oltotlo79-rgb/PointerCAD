"""Owned friction load history on the existing native Beam3d assembly.

The native K and termination belong to beamContact.run_beam_contact; friction
and its result contract belong to beamFrictionContact. No native code is run
until the complete input history has passed both modules' validators.
"""
from copy import deepcopy

from beamContact import run_beam_contact, validate_contact_plan
from beamFrictionContact import SOLVERS, solve_friction_steps, validate_friction, validate_loads


def run_beam_friction_contact(plan, friction, loads, *, solver='newton', max_iterations=None):
    """Return the existing native entry's JSON unchanged, or propagate its error.

    Each argument has its own owned snapshot. The assembly receives a separate
    copy, so neither caller mutation nor an altered callback plan can substitute
    a different model for the one validated before native startup.
    """
    owned_plan = deepcopy(plan)
    owned_friction = deepcopy(friction)
    owned_loads = deepcopy(loads)
    moment_length = validate_contact_plan(owned_plan)
    validate_friction(owned_friction, owned_plan['contacts'])
    validate_loads(owned_loads, 6 * len(owned_plan['nodes']))
    if solver not in SOLVERS:
        raise ValueError(f'friction-solver: one of {SOLVERS}')
    if max_iterations is not None and (
            not isinstance(max_iterations, int) or isinstance(max_iterations, bool) or max_iterations < 1):
        raise ValueError('friction-limit: the iteration limit must be a positive integer')
    called = False

    def solve(np, assembled_plan, stiffness, assembled_moment_length):
        nonlocal called
        if called:
            raise ValueError('friction-callback: assembly callback invoked more than once')
        called = True
        validate_contact_plan(assembled_plan)
        if assembled_plan != owned_plan or assembled_moment_length != moment_length:
            raise ValueError('friction-callback: assembly input differs from the owned snapshot')
        return solve_friction_steps(np, owned_plan, stiffness, moment_length, owned_friction, owned_loads,
                                    solver=solver, max_iterations=max_iterations)

    return run_beam_contact(deepcopy(owned_plan), solve_system=solve)
