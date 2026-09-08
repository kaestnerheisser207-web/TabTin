import { AskInteractionRequestSchema, ApprovalRequestedPayloadSchema, ApprovalResolvedPayloadSchema, StreamDoneSchema, StreamLifecycleSchema, SingleHitlResolvedPayloadSchema } from '@muse/agent-wire'
import { describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { DshRuntimeDriver } from '../src/application/agent/runtime/dsh-runtime-driver.js'

function businessPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const { protocol_version, min_compatible_version, thread_id, run_id, event_id,
    arrival_seq, _seq, agent_id, subagent_run_id, ...business } = payload
  void [protocol_version, min_compatible_version, thread_id, run_id, event_id,
    arrival_seq, _seq, agent_id, subagent_run_id]
  return business
}

const SESSION_ID = 'thread-1'

function rpc(value: unknown) {
  return { rpcId: 'rpc-response', result: { ok: true, value } }
}

function frame(payload: MuxFrame, rpcId = `rpc-${Math.random()}`): RpcRequest<MuxFrame> {
  return { rpcId: rpcId as any, payload }
}

function sessionEvent(type: string, seq: number, data: Record<string, unknown>): MuxFrame {
  return {
    type: 'session/event',
    sessionId: SESSION_ID as any,
    event: { type, seq, time: Date.now(), data } as any,
  }
}

function clientWithFrames(frames: RpcRequest<MuxFrame>[]) {
  const respond = vi.fn(async () => ({ accepted: true as const }))
  const prompt = vi.fn(async () => rpc({ accepted: true }))
  const create = vi.fn(async () => rpc({ sessionId: SESSION_ID }))
  const cancel = vi.fn(async () => rpc({ accepted: true }))
  const list = vi.fn(async () => rpc({ items: [{ sessionId: SESSION_ID, running: false }] }))
  const client = {
    sessions: { create, prompt, cancel, list },
    events: {
      mux: async function* () {
        for (const item of frames) yield item
      },
    },
    respond,
  } as unknown as IApiClient
  return { client, create, prompt, cancel, list, respond }
}

async function createRuntime(client: IApiClient, interactions?: import('../src/application/agent/runtime/dsh-runtime-driver.js').DshInteractionPort, modelId?: string, options: { terminateUnconfirmedRun?: () => Promise<void> } = {}) {
  const driver = new DshRuntimeDriver(client, interactions, modelId, undefined, options)
  const session = await driver.create({
    threadId: SESSION_ID,
    workspaceId: 'workspace-1',
    workspaceRoot: '/workspace',
    owner: { userId: 'user-1', organizationId: 'organization-1' },
  })
  return session.runtime
}

describe('DshRuntimeDriver', () => {
  it('resumes by idempotently reattaching the same business session and cwd', async () => {
    const { client, create } = clientWithFrames([])
    const driver = new DshRuntimeDriver(client)
    const context = {
      threadId: SESSION_ID,
      workspaceId: 'workspace-1',
      workspaceRoot: '/workspace',
      owner: { userId: 'user-1', organizationId: 'organization-1' },
    }

    const resumed = await driver.resume(context, { sessionId: SESSION_ID })

    expect(create).toHaveBeenCalledWith({ sessionId: SESSION_ID, cwd: '/workspace' })
    expect(resumed.binding).toEqual({ sessionId: SESSION_ID })
    expect(resumed.runtime.getRuntimeId()).toBe(`dsh:${SESSION_ID}`)
  })

  it('uses the stable business thread and translates DSH text stream into TabTin events', async () => {
    const frames = [
      frame({ type: 'session/subscribed', sessionId: SESSION_ID as any, lastSeq: -1 }),
      frame(sessionEvent('turn/start', 0, { turn: 0 })),
      frame(sessionEvent('step/start', 1, { turn: 0, step: 0 })),
      frame(sessionEvent('assistant/chunk', 2, {
        turn: 0,
        step: 0,
        chunk: { type: 'block-start', index: 0, blockType: 'text' },
      })),
      frame(sessionEvent('assistant/chunk', 3, {
        turn: 0,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: '你好' },
      })),
      frame(sessionEvent('assistant/chunk', 4, {
        turn: 0,
        step: 0,
        chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
      })),
      frame(sessionEvent('assistant/message', 5, {
        turn: 0,
        step: 0,
        message: {
          id: 'assistant-1',
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          content: [{ type: 'text', text: '你好' }],
        },
        usage: { inputTokens: 10, outputTokens: 2 },
      })),
      frame(sessionEvent('step/end', 6, { turn: 0, step: 0 })),
      frame(sessionEvent('turn/end', 7, { turn: 0, reason: { kind: 'completed' } })),
    ]
    const { client, create, prompt } = clientWithFrames(frames)
    const runtime = await createRuntime(client, undefined, 'muse-selected-model')

    const events = []
    for await (const event of runtime.query({ prompt: '打个招呼' })) events.push(event)

    expect(create).toHaveBeenCalledWith({ sessionId: SESSION_ID, cwd: '/workspace' })
    expect(prompt).toHaveBeenCalledOnce()
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      'agent.stream.user',
      'agent.stream.message_start',
      'agent.stream.content_block_start',
      'agent.stream.content_block_delta',
      'agent.stream.content_block_stop',
      'agent.stream.message_stop',
      'agent.stream.persist_message',
      'agent.stream.done',
    ]))
    const delta = events.find(event => event.type === 'agent.stream.content_block_delta')
    expect((delta?.payload as any).delta).toEqual({ type: 'text_delta', text: '你好' })
    const lifecycle = events.filter(event => event.type === 'agent.stream.lifecycle')
    for (const event of lifecycle) expect(StreamLifecycleSchema.safeParse(event.payload).success).toBe(true)
    expect(lifecycle.map(event => event.payload.phase)).toEqual(['start', 'turn_start', 'turn_end', 'end'])
    expect(events.some(event => event.type === 'agent.stream.step')).toBe(false)
    expect(events.findIndex(event => event.type === 'agent.stream.lifecycle' && event.payload.phase === 'turn_start'))
      .toBeLessThan(events.findIndex(event => event.type === 'agent.stream.content_block_delta'))
    const done = events.find(event => event.type === 'agent.stream.done')
    expect(StreamDoneSchema.safeParse(done?.payload).success).toBe(true)
    expect((done?.payload as any).content).toBe('你好')
    expect((done?.payload as any).agent_type).toBe('dsh')
    expect((done?.payload as any).usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 2,
      last_input_tokens: 10,
    })
    const persisted = events.find(event => event.type === 'agent.stream.persist_message')
    expect((persisted?.payload as any).message_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect((persisted?.payload as any)).toMatchObject({
      role: 'assistant',
      message_kind: 'llm',
      stop_reason: 'end_turn',
      model_id: 'muse-selected-model',
      blocks_json: [{ type: 'text', text: '你好' }],
    })
  })

  it('bridges DSH approval requests through TabTin HITL and responds on the same rpc id', async () => {
    const approval = frame({
      type: 'approval/requested',
      sessionId: SESSION_ID as any,
      approvalId: 'approval-1' as any,
      toolName: 'bash',
      callId: 'call-1' as any,
      reason: 'execute command',
    }, 'approval-rpc')
    const frames = [
      frame({ type: 'session/subscribed', sessionId: SESSION_ID as any, lastSeq: -1 }),
      frame(sessionEvent('turn/start', 0, { turn: 0 })),
      approval,
      frame({ type: 'approval/resolved', sessionId: approval.payload.sessionId,
        approvalId: 'approval-1' as Extract<MuxFrame, { type: 'approval/resolved' }>['approvalId'], outcome: 'allowed-once' }),
      frame(sessionEvent('turn/end', 1, { turn: 0, reason: { kind: 'blocked' } })),
    ]
    const { client, respond } = clientWithFrames(frames)
    const interactions = {
      request: vi.fn(async () => ({
        decisions: [{ outcome: 'allow' }],
      })),
    }
    const runtime = await createRuntime(client, interactions)

    const events = []
    for await (const event of runtime.query({ prompt: '运行命令' })) events.push(event)

    expect(ApprovalRequestedPayloadSchema.safeParse(events.find(event => event.type === 'agent.stream.approval_requested')?.payload).success).toBe(true)
    expect(ApprovalResolvedPayloadSchema.safeParse(events.find(event => event.type === 'agent.stream.approval_resolved')?.payload).success).toBe(true)
    const approvalFacts = events.filter(event => event.type === 'agent.stream.persist_message' && event.payload.message_kind === 'hitl_interaction')
    expect(approvalFacts).toHaveLength(2)
    expect(approvalFacts[0].payload.message_id).toBe(approvalFacts[1].payload.message_id)
    expect(approvalFacts[0].payload.metadata).toMatchObject({ hitl: { kind: 'tool_approval', status: 'pending' } })
    expect(approvalFacts[1].payload.metadata).toMatchObject({ hitl: { status: 'resolved' } })
    expect(interactions.request).toHaveBeenCalledOnce()
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      type: 'client-response',
      rpcId: 'approval-rpc',
      result: {
        ok: true,
        value: expect.objectContaining({ outcome: 'allowed-once' }),
      },
    }))
  })
  it('cancels a pending approval promptly and removes its waiter on abort', async () => {
    const frames = [
      frame({ type: 'session/subscribed', sessionId: SESSION_ID as Extract<MuxFrame, { type: 'session/subscribed' }>['sessionId'], lastSeq: -1 }),
      frame({
        type: 'approval/requested',
        sessionId: SESSION_ID as Extract<MuxFrame, { type: 'approval/requested' }>['sessionId'],
        approvalId: 'approval-abort' as Extract<MuxFrame, { type: 'approval/requested' }>['approvalId'],
        toolName: 'bash', reason: 'execute',
      }, 'pending-approval'),
    ]
    const { client, cancel, respond } = clientWithFrames(frames)
    let settle: ((value: unknown) => void) | undefined
    const interactions = {
      request: vi.fn(() => new Promise<unknown>(resolve => { settle = resolve })),
      cancel: vi.fn(() => settle?.({ outcome: 'deny' })),
    }
    const runtime = await createRuntime(client, interactions)
    const controller = new AbortController()
    const collected = (async () => {
      const events = []
      for await (const event of runtime.query({ prompt: 'run', signal: controller.signal })) events.push(event)
      return events
    })()
    await vi.waitFor(() => expect(interactions.request).toHaveBeenCalledOnce())
    controller.abort()
    const events = await collected
    expect(events.at(-1)?.payload).toMatchObject({ error_class: 'ABORT' })
    const cancelled = events.find(event => event.type === 'agent.stream.persist_message' && (event.payload.metadata as { hitl?: { status?: string } })?.hitl?.status === 'cancelled')
    expect(cancelled).toBeDefined()
    expect(interactions.cancel).toHaveBeenCalledWith('pending-approval')
    expect(cancel).toHaveBeenCalled()
    expect(respond).not.toHaveBeenCalled()
  })

  it('passes structured question answers back on the matching RPC', async () => {
    const frames = [
      frame({ type: 'session/subscribed', sessionId: SESSION_ID as Extract<MuxFrame, { type: 'session/subscribed' }>['sessionId'], lastSeq: -1 }),
      frame({
        type: 'question/requested',
        sessionId: SESSION_ID as Extract<MuxFrame, { type: 'question/requested' }>['sessionId'],
        questions: [{ id: 'color', question: 'Pick a color', options: [{ label: 'Red' }, { label: 'Blue' }] }],
      }, 'question-rpc'),
      frame({ type: 'question/resolved', sessionId: SESSION_ID as Extract<MuxFrame, { type: 'question/resolved' }>['sessionId'],
        questionRpcId: 'question-rpc' as Extract<MuxFrame, { type: 'question/resolved' }>['questionRpcId'], outcome: 'answered' }),
      frame(sessionEvent('turn/end', 1, { turn: 0, reason: { kind: 'completed' } })),
    ]
    const { client, respond } = clientWithFrames(frames)
    const runtime = await createRuntime(client, {
      request: async () => ({ answers: [{ question_id: 'color', selected_options: ['Red'], free_text: 'bright' }] }),
    })
    const events = []
    for await (const event of runtime.query({ prompt: 'ask' })) events.push(event)
    const ask = events.find(event => event.type === 'agent.stream.ask_user_required')!
    expect(AskInteractionRequestSchema.safeParse(businessPayload(ask.payload)).success).toBe(true)
    expect(SingleHitlResolvedPayloadSchema.safeParse(events.find(event => event.type === 'agent.stream.single_hitl_resolved')?.payload).success).toBe(true)
    expect(ask.payload).not.toHaveProperty('expires_at')
    expect(ask.payload).not.toHaveProperty('_seq')
    expect(ask.payload).toHaveProperty('event_id')
    expect(ask.payload).toHaveProperty('arrival_seq')
    expect(ask.payload)
      .toMatchObject({ questions: [{ id: 'color', prompt: 'Pick a color', options: [{ id: 'Red', label: 'Red' }, { id: 'Blue', label: 'Blue' }] }] })
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      rpcId: 'question-rpc', result: { ok: true, value: {
        sessionId: SESSION_ID, answer: { answers: [{ id: 'color', selected: ['Red'], custom: 'bright' }] },
      } },
    }))
  })

  it('uses a valid form for DSH free-text questions and converts submitted fields back', async () => {
    const frames = [
      frame({ type: 'session/subscribed', sessionId: SESSION_ID as Extract<MuxFrame, { type: 'session/subscribed' }>['sessionId'], lastSeq: -1 }),
      frame({ type: 'question/requested',
        sessionId: SESSION_ID as Extract<MuxFrame, { type: 'question/requested' }>['sessionId'],
        questions: [{ id: 'reason', question: 'What should change?' }] }, 'free-text-rpc'),
      frame(sessionEvent('turn/end', 1, { turn: 0, reason: { kind: 'completed' } })),
    ]
    const { client, respond } = clientWithFrames(frames)
    const runtime = await createRuntime(client, { request: async () => ({ field_values: { reason: 'show status' } }) })
    const events = []
    for await (const event of runtime.query({ prompt: 'ask' })) events.push(event)
    const ask = events.find(event => event.type === 'agent.stream.ask_form_required')!
    expect(AskInteractionRequestSchema.safeParse(businessPayload(ask.payload)).success).toBe(true)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ result: { ok: true, value: {
      sessionId: SESSION_ID, answer: { answers: [{ id: 'reason', selected: [], custom: 'show status' }] },
    } } }))
  })

  async function pendingCancellation(options: { terminateUnconfirmedRun?: () => Promise<void> } = {}) {
    const f = clientWithFrames([
      frame({ type: 'session/subscribed', sessionId: SESSION_ID as any, lastSeq: -1 }),
      frame({ type: 'approval/requested', sessionId: SESSION_ID as any, approvalId: 'cancel-test' as any, toolName: 'bash', reason: 'execute' }, 'cancel-request'),
    ])
    const interactions = { request: vi.fn(() => new Promise<unknown>(() => {})), cancel: vi.fn() }
    const runtime = await createRuntime(f.client, interactions, undefined, options)
    const controller = new AbortController()
    const events = (async () => { const result=[]; for await (const event of runtime.query({ prompt:'test', signal:controller.signal })) result.push(event); return result })()
    await vi.waitFor(() => expect(interactions.request).toHaveBeenCalledOnce())
    return { ...f, runtime, controller, events }
  }

  it('does not confirm cancellation until delayed SDK acknowledgement and idle status arrive', async () => {
    const f = await pendingCancellation()
    let acknowledge!: (value: any) => void
    f.cancel.mockImplementation(() => new Promise(resolve => { acknowledge=resolve }))
    f.controller.abort()
    let finished=false; void f.events.then(()=>{finished=true})
    await Promise.resolve(); expect(finished).toBe(false); expect(f.list).not.toHaveBeenCalled()
    acknowledge(rpc({accepted:true}))
    const events=await f.events
    expect(events.at(-1)?.payload).toMatchObject({ error:false,error_class:'ABORT',metadata:{host_confirmed:true} })
    expect(f.list).toHaveBeenCalled()
  })

  it('reports rejected cancellation as unconfirmed, requests cleanup, and prevents runtime reuse', async () => {
    const terminateUnconfirmedRun=vi.fn(async()=>{})
    const f=await pendingCancellation({terminateUnconfirmedRun})
    f.cancel.mockResolvedValue({rpcId:'rejected',result:{ok:false,error:{message:'cancel rejected'}}} as any)
    f.controller.abort()
    const events=await f.events
    expect(events.at(-1)?.payload).toMatchObject({error:true,error_class:'CANCELLATION_UNCONFIRMED',metadata:{host_confirmed:false}})
    expect(events.at(-1)?.payload.content).toContain('停止未确认')
    expect(StreamDoneSchema.safeParse(events.at(-1)?.payload).success).toBe(true)
    expect(terminateUnconfirmedRun).toHaveBeenCalledOnce()
    await expect(f.runtime.query({prompt:'must not execute'}).next()).rejects.toThrow('需重建运行实例')
    expect(f.prompt).toHaveBeenCalledTimes(1)
  })

  it('does not turn accepted cancellation into stopped while DSH remains running', async () => {
    const f=await pendingCancellation(); f.list.mockResolvedValue(rpc({items:[{sessionId:SESSION_ID,running:true}]}))
    vi.useFakeTimers()
    try {
      f.controller.abort(); await vi.advanceTimersByTimeAsync(10001)
      const events=await f.events
      expect(events.at(-1)?.payload).toMatchObject({error:true,error_class:'CANCELLATION_UNCONFIRMED',metadata:{host_confirmed:false}})
      await expect(f.runtime.query({prompt:'must not execute'}).next()).rejects.toThrow('需重建运行实例')
    } finally { vi.useRealTimers() }
  })

  it('uses a separate confirmation signal and waits for the plugin idle acknowledgement', async () => {
    const f=await pendingCancellation(); let resolveIdle!:(value:{stopped:boolean})=>void
    const control=vi.fn((_method: string,_params: unknown,signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      return new Promise(resolve=>{resolveIdle=resolve})
    })
    Object.assign(f.runtime,{bridge:{control},initialized:true})
    f.controller.abort(); await Promise.resolve()
    expect(control).toHaveBeenCalledWith('cancelAndWait',{sessionId:SESSION_ID},expect.any(AbortSignal))
    expect(f.cancel).not.toHaveBeenCalled()
    resolveIdle({stopped:true}); const events=await f.events
    expect(events.at(-1)?.payload).toMatchObject({error:false,error_class:'ABORT',metadata:{host_confirmed:true}})
  })

})
