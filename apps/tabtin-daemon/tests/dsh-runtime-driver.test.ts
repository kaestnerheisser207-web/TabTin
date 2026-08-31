import { describe, expect, it, vi } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { DshRuntimeDriver } from '../src/application/agent/runtime/dsh-runtime-driver.js'

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
  const client = {
    sessions: { create, prompt, cancel },
    events: {
      mux: async function* () {
        for (const item of frames) yield item
      },
    },
    respond,
  } as unknown as IApiClient
  return { client, create, prompt, cancel, respond }
}

async function createRuntime(client: IApiClient, interactions?: any) {
  const driver = new DshRuntimeDriver(client, interactions)
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
    const runtime = await createRuntime(client)

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
    const done = events.find(event => event.type === 'agent.stream.done')
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
      model_id: 'deepseek-v4-flash',
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

    expect(events.some(event => event.type === 'agent.stream.approval_requested')).toBe(true)
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
})
