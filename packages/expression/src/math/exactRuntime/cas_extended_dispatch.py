"""Route operations registered before their exact calculation exists.

mathExtendedOperations.ts owns the IDs, heads, operand counts and each
operation's status. cas_input.py hands every registered operation here before
decoding any operand, so an outer 0, a selected component or a simplification
never hides one that has no calculation yet.

Each implementing task edits only its own module imported below: it maps its
operation IDs to functions in IMPLEMENTATIONS (MC-24 also maps its binders in
QUANTIFIERS) and marks the same IDs 'implemented' in mathExtendedOperations.ts.
localExactMathEngine.ts ships this module and every module imported here.
"""
from cas_cardinality import IMPLEMENTATIONS as CARDINALITY
from cas_vector_projection import IMPLEMENTATIONS as VECTOR_PROJECTION
from cas_matrix_constructors import IMPLEMENTATIONS as MATRIX_CONSTRUCTORS
from cas_set_relations import IMPLEMENTATIONS as SET_RELATIONS
from cas_logic_extended import IMPLEMENTATIONS as LOGIC_EXTENDED, QUANTIFIERS

# operation: (minimum operands, maximum operands, implementing task)
OPERATIONS = {
    'plus-minus': (1, 2, 'MC-11'),
    'minus-plus': (1, 2, 'MC-11'),
    'cardinality': (1, 1, 'MC-12'),
    'projection': (2, 2, 'MC-16'),
    'identity-matrix': (1, 1, 'MC-18'),
    'zero-matrix': (1, 2, 'MC-18'),
    'not-element': (2, 2, 'MC-23'),
    'subset': (2, 2, 'MC-23'),
    'subset-equal': (2, 2, 'MC-23'),
    'superset': (2, 2, 'MC-23'),
    'superset-equal': (2, 2, 'MC-23'),
    'complement': (2, 2, 'MC-23'),
    'cartesian-product': (2, 16, 'MC-23'),
    'approximately-equal': (2, 3, 'MC-24'),
    'total-differential-at': (3, 3, 'MC-30'),
    'closed-line-integral': (4, 4, 'MC-19'),
    'closed-circulation': (4, 4, 'MC-19'),
    'closed-surface-integral': (4, 4, 'MC-19'),
    'closed-flux-integral': (4, 4, 'MC-19'),
}
# operation -> function(decoder, operation, operands, scope, depth, fields,
# reference_key, problem), merged from the implementing modules.
IMPLEMENTATIONS = {}
for _table in (CARDINALITY, VECTOR_PROJECTION, MATRIX_CONSTRUCTORS, SET_RELATIONS, LOGIC_EXTENDED):
    IMPLEMENTATIONS.update(_table)


def extended_operation(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    """Decode one registered operation; one without a calculation never reaches its operands."""
    if operation not in OPERATIONS or type(operands) is not list:
        raise problem('syntax', 'Invalid registered operation input')
    minimum, maximum, _task = OPERATIONS[operation]
    if not minimum <= len(operands) <= maximum:
        raise problem('syntax', 'Invalid operand count')
    implementation = IMPLEMENTATIONS.get(operation)
    if implementation is None:
        raise problem('unsupported', 'A registered operation is not implemented yet')
    return implementation(decoder, operation, operands, scope, depth, fields, reference_key, problem)


def quantifier(decoder, value, scope, depth, fields, reference_key, problem):
    """Evaluate a for-all/exists binder once MC-24 connects it; until then it stays unsupported."""
    implementation = QUANTIFIERS.get(value.get('operation'))
    if implementation is None:
        raise problem('unsupported', 'Quantifiers are not evaluated yet')
    return implementation(decoder, value, scope, depth, fields, reference_key, problem)
