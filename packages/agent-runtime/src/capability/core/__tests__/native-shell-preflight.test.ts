import { describe, expect, it, vi } from 'vitest';
import { ShellCap } from '../shell.js';
import type { ToolContext } from '../../../engine/contracts/tools.js';
const context: ToolContext = { threadId: 'thread', runtimeId: 'rt', agentRunId: 'run', toolUseId: 'call', messages: [], abortSignal: new AbortController().signal };
describe('shared native shell admission', () => {
  it('hardline prevents native performer with same Builtin error', async () => {
    const cap = new ShellCap({ ptyManagerBridge: {} as never, checkHardlineCommand: () => ({ hit: true, description: 'blocked test' }) });
    const tool = cap.tools()[0]; const perform = vi.fn();
    const native = await tool.executeNative!({ command: 'blocked' }, context, perform);
    const builtin = await tool.execute({ command: 'blocked' }, context);
    expect(native).toEqual(builtin); expect(native.isError).toBe(true); expect(perform).not.toHaveBeenCalled();
  });
  it('restricted checker prevents native performer', async () => {
    const cap = new ShellCap({ ptyManagerBridge: {} as never, checkHardlineCommand: () => ({ hit: false }),
      restrictedShellChecker: { isAllowed: async () => ({ allowed: false, code: 'denied', reason: 'readonly' }) } as never });
    const perform = vi.fn(); const result = await cap.tools()[0].executeNative!({ command: 'touch file' }, context, perform);
    expect(result.isError).toBe(true); expect(perform).not.toHaveBeenCalled();
  });
  it('does not silently omit Skill credentials in native shell', async () => {
    const cap = new ShellCap({ ptyManagerBridge: {} as never, checkHardlineCommand: () => ({ hit: false }),
      spaceId: 'workspace', agentId: 'agent', skillContextProvider: { resolveCredentials: async () => ({ env: { TEST_PRIVATE_VALUE: 'not-a-real-secret' } }) } });
    const perform = vi.fn();
    const result = await cap.tools()[0].executeNative!({ command: 'echo test' }, { ...context, skillContext: { skillKey: 'skill' } }, perform);
    expect(result.isError).toBe(true); expect(String(result.content)).toContain('run_terminal_command');
    expect(String(result.content)).not.toContain('not-a-real-secret'); expect(perform).not.toHaveBeenCalled();
  });

  it.each([
    'muse doc list', 'tabtin table list', '/usr/local/bin/muse doc create',
    'env FOO=bar muse doc list', 'command muse doc list',
    'git status && muse doc list', 'muse doc list | head -5',
    '\"/path with spaces/muse\" doc list', 'C:\\tools\\muse.exe doc list',
    './custom-script.sh', './custom-script.py',
    'bash -lc \"muse doc list\"', 'eval \"$CLI doc list\"',
    'python -c \"import os; os.system(\\\"muse doc list\\\")\"',
  ])('routes native CLI/evaluated command to trusted host: %s', async command => {
    const cap = new ShellCap({ ptyManagerBridge: {} as never, checkHardlineCommand: () => ({ hit: false }) });
    const perform = vi.fn(); const result = await cap.tools()[0].executeNative!({ command }, context, perform);
    expect(result.isError).toBe(true); expect(String(result.content)).toContain('run_terminal_command'); expect(perform).not.toHaveBeenCalled();
  });
  it.each(['git status', 'git diff --stat && git status', 'pnpm test', 'python -m pytest', 'node --test'])('keeps ordinary native code/test command: %s', async command => {
    const cap = new ShellCap({ ptyManagerBridge: {} as never, checkHardlineCommand: () => ({ hit: false }) });
    const perform = vi.fn(async () => ({ content: 'done' })); const result = await cap.tools()[0].executeNative!({ command }, context, perform);
    expect(result.isError).toBeFalsy(); expect(perform).toHaveBeenCalledTimes(1);
  });

});
