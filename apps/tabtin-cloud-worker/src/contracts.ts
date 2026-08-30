export interface WorkspaceSource {
  type: 'empty' | 'git'
  gitUrl?: string
  gitRef?: string
  credentialRef?: string
}

export interface ProvisionWorkspaceInput {
  allocationId: string
  generation: number
  image: string
  volumeRef: string
  cpuMillicores: number
  memoryMb: number
  storageGb: number
  source: WorkspaceSource
  /** Short-lived, allocation-bound daemon install token. */
  bootstrapToken: string
}

export interface AllocationIdentity {
  allocationId: string
  generation: number
}

export interface WorkspaceRuntimeStatus {
  allocationId: string
  generation: number
  state: 'running' | 'stopped' | 'missing'
  containerId?: string
}
