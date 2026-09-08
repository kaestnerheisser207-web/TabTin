#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { DshCapabilityBridge } from '../../packages/agent-host/dist/runtime/dsh/dsh-capability-bridge.js'

// Measures ONLY authenticated loopback/MCP overhead; no model, policy, database or network service latency.
const capabilities = {
  async beginRun() {}, async endRun() {}, async dispose() {},
  async snapshot() { return { runId: 'benchmark-run', systemPrompt: '', context: '', tools: [] } },
  async invoke(call) { return { content: JSON.stringify(call.arguments) } },
  async beforeNative() { return { allowed: false, reason: 'benchmark does not run native code' } },
  async afterNative() { throw new Error('benchmark does not run native code') },
}
const bridge = new DshCapabilityBridge(capabilities)
const times = []
try {
  await bridge.start()
  await bridge.beginRun({ prompt: 'benchmark', hostRunId: 'benchmark-run' })
  for (let index = 0; index < 110; index++) {
    const start = performance.now()
    const response = await fetch(`${bridge.url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: index, method: 'tools/call', params: {
        name: 'benchmark_echo', arguments: { input: 'x'.repeat(4096) }, _meta: { runId: 'benchmark-run', callId: `call-${index}` },
      } }),
    })
    const value = await response.json()
    if (!response.ok || value.error || !value.result?.content?.length) throw new Error('Bridge benchmark request failed')
    if (index >= 10) times.push(performance.now() - start)
  }
} finally { await bridge.stop() }
times.sort((a, b) => a - b)
const report = { measuredAt: new Date().toISOString(), metric: 'authenticated_mcp_loopback_roundtrip_ms',
  excludes: ['policy execution', 'model', 'database', 'external services'], samples: times.length,
  p50: times[Math.ceil(times.length * .5) - 1], p95: times[Math.ceil(times.length * .95) - 1],
  maximum: times.at(-1), thresholdP95: 50,
}
if (process.argv[2]) {
  await mkdir(path.dirname(path.resolve(process.argv[2])), { recursive: true })
  await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
if (report.p95 > report.thresholdP95) throw new Error('Bridge transport p95 exceeded 50 ms')
