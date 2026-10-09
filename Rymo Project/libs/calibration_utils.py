import numpy as np

def mean(vectors):
    return np.mean(vectors, axis=0)


def minus(a):
    return -a

def normalize(vec):
    norm = np.linalg.norm(vec)
    return vec / norm if norm > 0 else vec

def cross(a, b):
    return np.cross(a, b)

def dot(a, b):
    return np.dot(a, b)

def angle_between(a, b):
    a_u = normalize(a)
    b_u = normalize(b)
    return np.arccos(np.clip(dot(a_u, b_u), -1.0, 1.0))

def project(a, b):
    b_u = normalize(b)
    return dot(a, b_u) * b_u

def compose_rotation_matrix(x, y, z):
    """Composes a rotation matrix given orthonormal x, y, z axes as column vectors"""
    return np.column_stack([normalize(x), normalize(y), normalize(z)])

def orthonormalize(x, z):
    """Given x and z (or any 2 non-parallel vectors), returns orthonormal axes"""
    z = normalize(z)
    x = normalize(x - project(x, z))  # remove z component from x
    y = normalize(cross(z, x))
    return x, y, z
