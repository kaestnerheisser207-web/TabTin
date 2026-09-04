/**
 * RESTRICTED_READONLY_VERBS 内容守护。
 *
 * 从 agent-runtime restricted-shell-allowlist 测试迁来——只读动词表随源码迁到宿主，
 * 「不漏写命令 / 与 CLI risk 标注同步」这两条内容守护也随之落在这里。
 */
import { describe, it, expect } from 'vitest'
import { RESTRICTED_READONLY_VERBS } from '../src/capabilities/shell-restriction.js'

// 模拟 `muse commands --format json` 采样（risk='' 只读 / risk='write' 写）。
// 维护契约：CLI 新增 risk='' 命令时，要么把终末 verb 加进 RESTRICTED_READONLY_VERBS，
// 要么把命令加进本 fixture；漏则本测试红。
const PRODUCTION_SCHEMA_FIXTURE: ReadonlyArray<{ name: string; risk?: string }> = [
  { name: 'muse doc list', risk: '' },
  { name: 'muse doc read', risk: '' },
  { name: 'muse doc list-blocks', risk: '' },
  { name: 'muse doc search-blocks', risk: '' },
  { name: 'muse doc export', risk: '' },
  { name: 'muse doc search', risk: '' },
  { name: 'muse memo list', risk: '' },
  { name: 'muse memo read', risk: '' },
  { name: 'muse memo search', risk: '' },
  { name: 'muse table list', risk: '' },
  { name: 'muse table query', risk: '' },
  { name: 'muse table view records', risk: '' },
  { name: 'muse table view statistics', risk: '' },
  { name: 'muse browser glance', risk: '' },
  { name: 'muse browser print', risk: '' },
  { name: 'muse browser wait', risk: '' },
  { name: 'muse browser console', risk: '' },
  { name: 'muse browser cookies get', risk: '' },
  { name: 'muse browser network', risk: '' },
  { name: 'muse browser tab list', risk: '' },
  { name: 'muse browser tab state', risk: '' },
  { name: 'muse browser resource', risk: '' },
  { name: 'muse browser stream', risk: '' },
  { name: 'muse browser ua', risk: '' },
  { name: 'muse commands', risk: '' },
  { name: 'muse capabilities', risk: '' },
  { name: 'muse mcp list-servers', risk: '' },
  { name: 'muse mcp list-tools', risk: '' },
  { name: 'muse mcp list-resources', risk: '' },
  { name: 'muse mcp list-prompts', risk: '' },
  { name: 'muse mcp read-resource', risk: '' },
  { name: 'muse mcp get-prompt', risk: '' },
  { name: 'muse tracker show', risk: '' },
  { name: 'muse tracker dry-run', risk: '' },
  { name: 'muse code grep', risk: '' },
  { name: 'muse code glob', risk: '' },
  { name: 'muse doc create', risk: 'write' },
  { name: 'muse browser act', risk: 'write' },
  { name: 'muse browser eval', risk: 'write' },
]

describe('RESTRICTED_READONLY_VERBS — L20b codegen 守护', () => {
  it('每个 risk="" 命令的终末 verb 都在 RESTRICTED_READONLY_VERBS 中', () => {
    const missing: Array<{ name: string; verb: string }> = []
    for (const cmd of PRODUCTION_SCHEMA_FIXTURE) {
      if (cmd.risk !== '' && cmd.risk !== undefined) continue
      const verb = cmd.name.split(/\s+/).pop()!.toLowerCase()
      if (verb === 'muse') continue
      if (!RESTRICTED_READONLY_VERBS.has(verb)) missing.push({ name: cmd.name, verb })
    }
    expect(
      missing,
      `readonly commands whose terminal verb is NOT in RESTRICTED_READONLY_VERBS:\n` +
        missing.map((m) => `  - "${m.name}" → verb="${m.verb}"`).join('\n'),
    ).toEqual([])
  })

  it('每个 risk="write" 命令的终末 verb 都不在 RESTRICTED_READONLY_VERBS 中', () => {
    const leaked: Array<{ name: string; verb: string }> = []
    for (const cmd of PRODUCTION_SCHEMA_FIXTURE) {
      if (cmd.risk !== 'write' && cmd.risk !== 'high-risk-write') continue
      const verb = cmd.name.split(/\s+/).pop()!.toLowerCase()
      if (RESTRICTED_READONLY_VERBS.has(verb)) leaked.push({ name: cmd.name, verb })
    }
    expect(
      leaked,
      `write commands leaked into RESTRICTED_READONLY_VERBS:\n` +
        leaked.map((m) => `  - "${m.name}" → verb="${m.verb}"`).join('\n'),
    ).toEqual([])
  })

  it('已知写动词不在只读表（eval / create / act / delete / update / stop）', () => {
    for (const verb of ['eval', 'create', 'act', 'delete', 'update', 'stop', 'set', 'run', 'click', 'input']) {
      expect(RESTRICTED_READONLY_VERBS.has(verb)).toBe(false)
    }
  })
})
