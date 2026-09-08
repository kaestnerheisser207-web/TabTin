import { mkdtemp, realpath, writeFile, readFile, rm, mkdir, symlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTabCodeTools } from '../../src/tools/tabcode-adapter.js';
import type { ToolContext } from '@muse/agent-runtime';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'native-adapter-'))); roots.push(root);
  const trackEdit = vi.fn();
  const context: ToolContext = { threadId: 'thread', runtimeId: 'rt', agentRunId: 'run',
    readFileState: new Map(), fileHistoryAnchorId: 'anchor', workspaceRoot: root, messages: [], abortSignal: new AbortController().signal,
    workspaceSnapshot: { allowedPaths: [root], allowedFiles: [] }, permissionContext: { judgedDecision: 'allow' },
    fileHistory: { beginSnapshot: async () => {}, trackEdit } };
  const tool = createTabCodeTools().find(tool => tool.name === 'write_file')!;
  return { root, context, trackEdit, tool };
}
describe('native file execution uses Builtin critical section', () => {
  it('backs up before native write and produces actual change metadata', async () => {
    const f = await setup(); const target = path.join(f.root, 'file.txt'); await writeFile(target, 'before');
    f.trackEdit.mockImplementation(async (_anchor, file) => { expect(await readFile(file, 'utf8')).toBe('before'); });
    const perform = vi.fn(async () => {
      expect(f.trackEdit).toHaveBeenCalledWith('anchor', target);
      await writeFile(target, 'after'); return { content: 'written' };
    });
    const result = await f.tool.executeNative!({ path: target, contents: 'after' }, f.context, perform);
    expect(result.isError).toBeFalsy();
    expect(perform).toHaveBeenCalledTimes(1);
    expect(result.hostMetadata?.fileEditPatch).toBeDefined();
  });
  it('rejects symlink to sensitive location without invoking native or backup', async () => {
    const f = await setup(); await mkdir(path.join(f.root, '.ssh'));
    await symlink(path.join(f.root, '.ssh'), path.join(f.root, 'alias'));
    const perform = vi.fn();
    const result = await f.tool.executeNative!({ path: path.join(f.root, 'alias', 'key'), contents: 'bad' }, f.context, perform);
    expect(result.isError).toBe(true); expect(perform).not.toHaveBeenCalled(); expect(f.trackEdit).not.toHaveBeenCalled();
  });
  async function nativeRead(f: Awaited<ReturnType<typeof setup>>, file: string, offset = 1, limit?: number) {
    const tool = createTabCodeTools().find(tool => tool.name === 'read_file')!;
    return tool.executeNative!({ path: file, offset, ...(limit === undefined ? {} : { limit }) }, f.context, async () => {
      const all = (await readFile(file, 'utf8')).split('\n');
      const lines = all.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit)
        .map((text, index) => ({ number: offset + index, text }));
      return { content: 'rendered numbered read', hostMetadata: { nativeToolName: 'read', nativeRead: { path: file, offset, lines, totalLines: all.length } } };
    });
  }
  it('native read then edit succeeds using the observed read state', async () => {
    const f = await setup(); const file = path.join(f.root, 'read-edit.txt'); await writeFile(file, 'before');
    await nativeRead(f, file);
    expect(f.context.readFileState!.get(file)?.content).toBe('before');
    const edit = createTabCodeTools().find(tool => tool.name === 'edit_file')!;
    const perform = vi.fn(async () => { await writeFile(file, 'after'); return { content: 'edited' }; });
    const result = await edit.executeNative!({ path: file, old_string: 'before', new_string: 'after' }, f.context, perform);
    expect(result.isError).toBeFalsy(); expect(perform).toHaveBeenCalledTimes(1);
  });
  it('native read followed by external modification denies edit before effects', async () => {
    const f = await setup(); const file = path.join(f.root, 'changed.txt'); await writeFile(file, 'before');
    await nativeRead(f, file); await writeFile(file, 'external change');
    const future = new Date(Date.now() + 2000); await utimes(file, future, future);
    const edit = createTabCodeTools().find(tool => tool.name === 'edit_file')!; const perform = vi.fn();
    const result = await edit.executeNative!({ path: file, old_string: 'before', new_string: 'after' }, f.context, perform);
    expect(result.isError).toBe(true); expect(String(result.content)).toContain('stale'); expect(perform).not.toHaveBeenCalled();
  });
  it('partial native read records only observed range and never claims full content', async () => {
    const f = await setup(); const file = path.join(f.root, 'partial.txt'); await writeFile(file, 'unread-first\nseen-second\nunread-third');
    await nativeRead(f, file, 2, 1);
    expect(f.context.readFileState!.get(file)).toEqual(expect.objectContaining({ content: 'seen-second', offset: 2, limit: 1 }));
    expect(f.context.readFileState!.get(file)?.content).not.toContain('unread');
  });

});
