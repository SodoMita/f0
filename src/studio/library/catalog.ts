import manifest from './manifest.json'

export type LibraryGroup = 'face' | 'react' | 'status' | 'shape' | 'object' | 'voxel'
export type LibraryDim = '2d' | '3d'

export interface LibraryItem {
  id: string
  group: LibraryGroup
  dim: LibraryDim
  /**
   * Authored facing +Z (flat plates, face balls, voxel sprites). The studio
   * orbit sits on +X, so these are turned to the camera when placed —
   * otherwise a face ball lands showing the back of its head.
   */
  front?: boolean
}

export const LIBRARY: readonly LibraryItem[] = manifest as LibraryItem[]

export const GROUPS: readonly LibraryGroup[] = ['face', 'voxel', 'react', 'status', 'shape', 'object']
