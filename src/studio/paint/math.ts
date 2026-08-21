/** Small vector / quaternion helpers. No Babylon — unit-testable. */

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1]

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

export function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2])
  if (l < 1e-10) return [0, 1, 0]
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** Rotation taking local +X → tangent, local +Y → normal (ink flatten axis). */
export function quatAlign(tangent: Vec3, normal: Vec3): Quat {
  const x = norm(tangent)
  let y = normal
  const d = dot(x, y)
  y = norm([y[0] - x[0] * d, y[1] - x[1] * d, y[2] - x[2] * d])
  if (Math.hypot(y[0], y[1], y[2]) < 1e-6) {
    const fallback: Vec3 = Math.abs(x[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const dd = dot(x, fallback)
    y = norm([fallback[0] - x[0] * dd, fallback[1] - x[1] * dd, fallback[2] - x[2] * dd])
  }
  const z = cross(x, y)
  return quatFromBasis(x, y, z)
}

/** Rotation taking local +Z → normal, local +X → tangent (for quads). */
export function quatFacing(normal: Vec3, tangent: Vec3): Quat {
  const z = norm(normal)
  let x = tangent
  const d = dot(x, z)
  x = norm([x[0] - z[0] * d, x[1] - z[1] * d, x[2] - z[2] * d])
  if (Math.hypot(x[0], x[1], x[2]) < 1e-6) {
    const fallback: Vec3 = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    x = norm(cross(fallback, z))
  }
  const y = cross(z, x)
  return quatFromBasis(x, y, z)
}

function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  // Shepperd's method on a left-handed? Babylon is LH but a rotation
  // matrix built from orthonormal axes is the same conversion.
  const m00 = x[0], m01 = y[0], m02 = z[0]
  const m10 = x[1], m11 = y[1], m12 = z[1]
  const m20 = x[2], m21 = y[2], m22 = z[2]
  const tr = m00 + m11 + m22
  let qx: number, qy: number, qz: number, qw: number
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    qw = 0.25 * s
    qx = (m21 - m12) / s
    qy = (m02 - m20) / s
    qz = (m10 - m01) / s
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    qw = (m21 - m12) / s
    qx = 0.25 * s
    qy = (m01 + m10) / s
    qz = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    qw = (m02 - m20) / s
    qx = (m01 + m10) / s
    qy = 0.25 * s
    qz = (m12 + m21) / s
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    qw = (m10 - m01) / s
    qx = (m02 + m20) / s
    qy = (m12 + m21) / s
    qz = 0.25 * s
  }
  const l = Math.hypot(qx, qy, qz, qw) || 1
  return [qx / l, qy / l, qz / l, qw / l]
}

export function mulQuat(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

/** Y-up cylinder → align +Y with tangent. */
export function quatCylinder(tangent: Vec3): Quat {
  return quatAlign(cross(tangent, absLeast(tangent)), tangent)
}

function absLeast(v: Vec3): Vec3 {
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2])
  if (ax <= ay && ax <= az) return [1, 0, 0]
  if (ay <= az) return [0, 1, 0]
  return [0, 0, 1]
}
