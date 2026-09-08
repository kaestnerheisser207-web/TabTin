import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const entrypoint = fileURLToPath(new URL('../scripts/cloud-entrypoint.sh', import.meta.url))
const roots: string[] = []
const retired = ['MUSE_DSH_GATEWAY_TOKEN', 'MUSE_DSH_API_URL', 'MUSE_DSH_GATEWAY_PORT', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_PERMISSION_MODE']
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(options: { initialized?: boolean; missingToken?: boolean; failInitializations?: number; dshHome?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-cloud-entrypoint-')); roots.push(root)
  const bin = join(root, 'bin')
  const config = join(root, 'daemon-config')
  const bootstrap = join(root, 'bootstrap-token')
  const calls = join(root, 'calls.jsonl')
  const received = join(root, 'received-token')
  const environment = join(root, 'started-environment.json')
  const counter = join(root, 'attempts')
  const sleeps = join(root, 'sleeps')
  await mkdir(bin)
  if (options.initialized) { await mkdir(config); await writeFile(join(config, 'config.json'), '{}') }
  if (!options.missingToken) await writeFile(bootstrap, 'fixture-bootstrap-token\n')
  // The daemon fixture uses the current Node binary directly. A separate PATH
  // sentinel catches any retired `node -e` gateway-token generation in the shell.
  const daemon = join(bin, 'tabtin-daemon')
  await writeFile(daemon, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'init') {
  fs.writeFileSync(process.env.FIXTURE_RECEIVED, fs.readFileSync(0, 'utf8'));
  const attempt = (fs.existsSync(process.env.FIXTURE_COUNTER) ? Number(fs.readFileSync(process.env.FIXTURE_COUNTER, 'utf8')) : 0) + 1;
  fs.writeFileSync(process.env.FIXTURE_COUNTER, String(attempt));
  if (attempt <= Number(process.env.FIXTURE_FAIL_COUNT)) process.exit(1);
  const config = args[args.indexOf('--config-dir') + 1];
  fs.mkdirSync(config, { recursive: true }); fs.writeFileSync(config + '/config.json', '{}');
} else if (args[0] === 'start') {
  fs.writeFileSync(process.env.FIXTURE_ENVIRONMENT, JSON.stringify({
    dshHome: process.env.DSH_HOME, telemetry: process.env.DSH_TELEMETRY_MODE,
    retired: Object.fromEntries(${JSON.stringify(retired)}.map(key => [key, Object.prototype.hasOwnProperty.call(process.env, key)]))
  }));
} else process.exit(2);
`)
  await chmod(daemon, 0o755)
  await writeFile(join(bin, 'node'), '#!/bin/sh\necho "Unexpected global DSH token generation" >&2\nexit 87\n')
  await chmod(join(bin, 'node'), 0o755)
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$FIXTURE_SLEEPS"\n')
  await chmod(join(bin, 'sleep'), 0o755)
  const env = { ...process.env }
  for (const key of [...retired, 'DSH_HOME', 'DSH_TELEMETRY_MODE']) delete env[key]
  Object.assign(env, { PATH: `${bin}:${process.env.PATH ?? ''}`, MUSE_DAEMON_CONFIG_DIR: config,
    MUSE_DAEMON_BOOTSTRAP_TOKEN_FILE: bootstrap, FIXTURE_CALLS: calls, FIXTURE_RECEIVED: received,
    FIXTURE_ENVIRONMENT: environment, FIXTURE_COUNTER: counter, FIXTURE_FAIL_COUNT: String(options.failInitializations ?? 0), FIXTURE_SLEEPS: sleeps,
    ...(options.dshHome ? { DSH_HOME: options.dshHome } : {}),
  })
  return {
    root, config, bootstrap, received, environment, counter, sleeps,
    run: () => execute('/bin/sh', [entrypoint], { env, timeout: 5000 }),
    calls: async () => (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  }
}

describe('Cloud entrypoint session-owned DSH bootstrap', () => {
  it('initializes over stdin, deletes the one-time token and starts without global DSH routing', async () => {
    const f = await fixture()
    await f.run()
    expect(await f.calls()).toEqual([['init', '--token-stdin', '--config-dir', f.config], ['start', '--config-dir', f.config]])
    expect(await readFile(f.received, 'utf8')).toBe('fixture-bootstrap-token\n')
    await expect(access(f.bootstrap)).rejects.toThrow()
    expect(JSON.parse(await readFile(f.environment, 'utf8'))).toEqual({
      dshHome: '/var/lib/tabtin/dsh', telemetry: 'DISABLED', retired: Object.fromEntries(retired.map(key => [key, false])),
    })
  })

  it('keeps existing configuration and the selected data root without requiring another token', async () => {
    const f = await fixture({ initialized: true, missingToken: true, dshHome: '/data/muse-dsh' })
    await f.run()
    expect(await f.calls()).toEqual([['start', '--config-dir', f.config]])
    expect(JSON.parse(await readFile(f.environment, 'utf8')).dshHome).toBe('/data/muse-dsh')
  })

  it('fails before daemon startup when neither configuration nor bootstrap token exists', async () => {
    const f = await fixture({ missingToken: true })
    await expect(f.run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('bootstrap token is missing') })
    await expect(access(f.environment)).rejects.toThrow()
  })

  it('retains initialization retries and removes the token only after success', async () => {
    const f = await fixture({ failInitializations: 2 })
    await f.run()
    expect((await f.calls()).map(call => call[0])).toEqual(['init', 'init', 'init', 'start'])
    expect(await readFile(f.sleeps, 'utf8')).toBe('60\n60\n')
    await expect(access(f.bootstrap)).rejects.toThrow()
  })

  it('stops after eight failures, preserving the bootstrap token and never starting the daemon', async () => {
    const f = await fixture({ failInitializations: 8 })
    await expect(f.run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('failed after 8 attempts') })
    expect((await f.calls()).map(call => call[0])).toEqual(Array(8).fill('init'))
    expect((await readFile(f.sleeps, 'utf8')).trim().split('\n')).toHaveLength(7)
    expect(await readFile(f.bootstrap, 'utf8')).toBe('fixture-bootstrap-token\n')
    await expect(access(f.environment)).rejects.toThrow()
  })

  it('keeps the image entrypoint contract and removes obsolete routing requirements from its fixture', async () => {
    const daemonRoot = resolve(dirname(entrypoint), '..')
    const docker = await readFile(join(daemonRoot, 'Dockerfile.cloud'), 'utf8')
    expect(docker).toContain('COPY apps/tabtin-daemon/scripts/cloud-entrypoint.sh /usr/local/bin/tabtin-cloud-entrypoint')
    expect(docker).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tabtin-cloud-entrypoint"]')
    const script = await readFile(entrypoint, 'utf8')
    expect(script).not.toMatch(/MUSE_DSH_(?:GATEWAY_TOKEN|API_URL|GATEWAY_PORT)|DEEPSEEK_|\b3080\b|\b3090\b/)
    const imageTest = await readFile(join(daemonRoot, 'tests/cloud-runtime-image.integration.test.ts'), 'utf8')
    expect(imageTest).not.toMatch(/MUSE_DSH_(?:GATEWAY_TOKEN|API_URL|GATEWAY_PORT)|ApiProxy and TabTin MCP bridge ready/)
  })
})
