import type {
  CompactCheckpointSummary,
  Message,
  QueryParams,
  StreamEvent,
} from '@tabtin/agent-runtime'

/** Agent harnesses shipped by TabTin Cloud Agent v1. */
export type RuntimeHarness = 'builtin' | 'dsh'

/**
 * Runtime surface consumed by the shared host pipeline.
 *
 * Builtin implements all capabilities. A remote harness may omit checkpoint
 * compaction when that capability is not available; query, cancellation and a
 * stable runtime identifier are required for every driver.
 */
export interface HostedRuntime {
  query(params: QueryParams): AsyncIterable<StreamEvent>
  abort(): void | Promise<void>
  getRuntimeId(): string
  compactCheckpoint?(params: {
    messages: Message[]
    summaryFocus?: string
    keepLastN?: number
  }): Promise<CompactCheckpointSummary>
}

/** Stable identity and workspace authority supplied by the host. */
export interface RuntimeDriverContext {
  threadId: string
  workspaceId: string
  workspaceRoot: string
  owner: {
    userId: string
    organizationId: string
  }
}

/**
 * Opaque binding persisted by the platform for a hosted runtime.
 *
 * For DSH this identifies the ACP session on the selected Cloud Workspace;
 * builtin runtimes normally leave the binding undefined.
 */
export interface RuntimeDriverSession<Binding = unknown> {
  runtime: HostedRuntime
  binding?: Binding
}

/** Harness-specific construction and teardown behind the shared Host runtime. */
export interface RuntimeDriver<
  Context extends RuntimeDriverContext = RuntimeDriverContext,
  Binding = unknown,
> {
  readonly harness: RuntimeHarness
  create(context: Context): Promise<RuntimeDriverSession<Binding>>
  resume?(
    context: Context,
    binding: Binding,
  ): Promise<RuntimeDriverSession<Binding>>
  dispose(session: RuntimeDriverSession<Binding>): Promise<void>
}

export class RuntimeDriverRegistry {
  private readonly drivers = new Map<RuntimeHarness, RuntimeDriver>()

  constructor(drivers: readonly RuntimeDriver[] = []) {
    for (const driver of drivers) this.register(driver)
  }

  register(driver: RuntimeDriver): void {
    if (this.drivers.has(driver.harness)) {
      throw new Error(`Runtime driver already registered: ${driver.harness}`)
    }
    this.drivers.set(driver.harness, driver)
  }

  resolve(harness: RuntimeHarness): RuntimeDriver {
    const driver = this.drivers.get(harness)
    if (!driver) throw new Error(`Runtime driver not registered: ${harness}`)
    return driver
  }
}
