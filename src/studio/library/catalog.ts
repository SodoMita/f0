import manifest from './manifest.json'

export type LibraryGroup = 'face' | 'react' | 'status' | 'shape' | 'object'
export type LibraryDim = '2d' | '3d'

export interface LibraryItem {
  id: string
  group: LibraryGroup
  dim: LibraryDim
}

export const LIBRARY: readonly LibraryItem[] = manifest as LibraryItem[]

export const GROUPS: readonly LibraryGroup[] = ['face', 'react', 'status', 'shape', 'object']
