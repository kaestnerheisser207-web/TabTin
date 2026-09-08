/** Local DeepSeek Harness availability; status checks never install software. */
export interface LocalDshStatus {
  installed: boolean
  executable: string | null
  version: string | null
  installing: boolean
  canInstall: boolean
  detail: string | null
  error: string | null
  /** An incompatible installation may exist; it is never overwritten. */
  errorCode?: 'DSH_VERSION_INCOMPATIBLE'
  supportedVersion?: string
}
