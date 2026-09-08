import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDshLaunch, buildDshEnvironment } from '@muse/agent-host/runtime/dsh'

describe('DSH executable launch', () => {
  it('inherits only execution essentials and never application secrets or DSH overrides', () => {
    expect(buildDshEnvironment({PATH:'/bin',HOME:'/home/test',HTTPS_PROXY:'http://proxy',LANG:'en_US.UTF-8',
      PG_DB_PASSWORD:'secret',PG_DB_HOST:'private-db',SERPER_API_KEY:'secret',MUSE_TOKEN:'secret',DSH_PERMISSION_MODE:'danger-full-access',
      DEEPSEEK_BASE_URL:'https://untrusted',NODE_OPTIONS:'--require /untrusted.js',CUSTOM_PASSWORD:'secret'}))
      .toEqual({PATH:'/bin',HOME:'/home/test',HTTPS_PROXY:'http://proxy',LANG:'en_US.UTF-8'})
  })
  it('executes an installed Unix binary directly', async () => {
    expect(await resolveDshLaunch('/opt/homebrew/bin/dsh', 'darwin')).toEqual({
      executable: '/opt/homebrew/bin/dsh', args: [],
    })
  })
  it('resolves a verified npm Windows shim to Node and its package script without a shell', async () => {
    const prefix = await mkdtemp(join(tmpdir(), 'muse-dsh-launch-'))
    try {
      const packageRoot = join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
      await mkdir(join(packageRoot, 'lib'), { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }))
      await writeFile(join(packageRoot, 'lib/bin.js'), '')
      await writeFile(join(prefix, 'node.exe'), '')
      expect(await resolveDshLaunch(join(prefix, 'dsh.cmd'), 'win32', {})).toEqual({
        executable: join(prefix, 'node.exe'), args: [join(packageRoot, 'lib/bin.js')],
      })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'unrelated', bin: 'lib/bin.js' }))
      await expect(resolveDshLaunch(join(prefix, 'dsh.cmd'), 'win32', {})).rejects.toThrow('Invalid DSH package executable')
    } finally {
      await rm(prefix, { recursive: true, force: true })
    }
  })
})
