import type { Scene } from '@babylonjs/core/scene'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder'
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder'
import { CreatePolyhedron } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder'
import type { ShapeKind } from './types'

/**
 * Build the canonical unit mesh for a paint stamp.
 *
 * Both the editor and the runtime icon renderer call this function, so a
 * brush button can never drift into being an approximate glyph of the shape
 * it actually paints. Square and triangle are XY plates facing +Z; the paint
 * session rotates that local +Z onto the writing surface.
 */
export function createPaintShapeMesh(shape: ShapeKind, scene: Scene): Mesh {
  switch (shape) {
    case 'cube': return CreateBox('p-cube', { size: 1 }, scene)
    case 'sphere': return CreateSphere('p-sphere', { diameter: 1, segments: 8 }, scene)
    case 'cylinder': return CreateCylinder('p-cylinder', { height: 1, diameter: 1, tessellation: 8 }, scene)
    case 'tetra': return CreatePolyhedron('p-tetra', { type: 0, size: 0.5 }, scene)
    case 'square': return CreatePlane('p-square', { size: 1 }, scene)
    case 'triangle': return createTriangle(scene)
  }
}

function createTriangle(scene: Scene): Mesh {
  const mesh = new Mesh('p-triangle', scene)
  const data = new VertexData()
  data.positions = [
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0, 0.5, 0,
  ]
  data.indices = [0, 1, 2]
  data.normals = [
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]
  data.applyToMesh(mesh)
  return mesh
}
