import { createHash } from 'node:crypto'

const dimensions = {
  tools: 'name', cliCommands: 'name', skills: 'key',
  contextSections: 'name', hooks: null, policies: null, controls: null,
}
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value

/** Build only fields backed by real host data; missing catalogs stay missing. */
export function snapshotFromHostSession({ host, scope, harness, session, catalogs = {} }) {
  const snapshot = { schemaVersion: 1, host, scope, harness }
  if (Array.isArray(session.tools)) snapshot.tools = session.tools.map(({ name, inputSchema }) => ({ name, inputSchema }))
  if (typeof session.systemPrompt === 'string') snapshot.contextSections = [{
    name: 'systemPrompt', sha256: createHash('sha256').update(session.systemPrompt).digest('hex'),
  }]
  for (const key of ['hooks', 'policies', 'controls']) if (Array.isArray(session[key])) snapshot[key] = session[key]
  for (const key of ['cliCommands', 'skills']) if (Array.isArray(catalogs[key])) snapshot[key] = catalogs[key]
  return snapshot
}

/** Compare two actual captures from the same host and authorization context. */
export function compareCapabilitySnapshots(builtin, dsh) {
  const failures = []
  if (builtin?.schemaVersion !== 1 || dsh?.schemaVersion !== 1) failures.push('schemaVersion must equal 1')
  if (!['electron', 'daemon'].includes(builtin?.host) || builtin.host !== dsh?.host) failures.push('same-host comparison required')
  if (builtin?.harness !== 'builtin' || dsh?.harness !== 'dsh') failures.push('captures must identify builtin and dsh respectively')
  for (const key of ['organizationId', 'workspaceId', 'agentId', 'mode']) {
    if (typeof builtin?.scope?.[key] !== 'string' || !builtin.scope[key] || builtin.scope[key] !== dsh?.scope?.[key]) failures.push(`scope.${key} missing or different`)
  }
  for (const [dimension, identity] of Object.entries(dimensions)) {
    const captures = [builtin?.[dimension], dsh?.[dimension]]
    if (captures.some(value => !Array.isArray(value))) { failures.push(`${dimension}: missing actual capture`); continue }
    // A genuinely empty skills catalog is valid. Empty execution/context captures
    // are not useful evidence and must never make an incomplete adapter pass.
    if (dimension !== 'skills' && captures.some(value => value.length === 0)) failures.push(`${dimension}: empty capture`)
    const normalized = captures.map((entries, index) => {
      const names = new Set()
      const items = []
      for (const entry of entries) {
        const name = identity ? entry?.[identity] : entry
        if (typeof name !== 'string' || !name) { failures.push(`${dimension}: invalid identity in ${index === 0 ? 'builtin' : 'dsh'}`); continue }
        if (names.has(name)) failures.push(`${dimension}: duplicate ${name}`)
        names.add(name)
        if (dimension === 'tools' && (!entry.inputSchema || typeof entry.inputSchema !== 'object' || Array.isArray(entry.inputSchema))) failures.push(`tools: ${name} has no inputSchema`)
        if (dimension === 'contextSections' && !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) failures.push(`contextSections: ${name} has no actual content hash`)
        items.push([name, canonical(dimension === 'tools' ? { name, inputSchema: entry.inputSchema } : entry)])
      }
      return new Map(items)
    })
    for (const name of [...new Set([...normalized[0].keys(), ...normalized[1].keys()])].sort()) {
      if (!normalized[1].has(name)) failures.push(`${dimension}: missing in dsh: ${name}`)
      else if (!normalized[0].has(name)) failures.push(`${dimension}: unexpected in dsh: ${name}`)
      else if (JSON.stringify(normalized[0].get(name)) !== JSON.stringify(normalized[1].get(name))) failures.push(`${dimension}: definition differs: ${name}`)
    }
  }
  return { ok: failures.length === 0, failures }
}
