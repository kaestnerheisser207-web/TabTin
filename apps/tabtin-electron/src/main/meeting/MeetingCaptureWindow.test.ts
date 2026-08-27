import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createdWindows, FakeBrowserWindow } = vi.hoisted(() => {
  class FakeEmitter {
    private readonly listeners = new Map<
      string,
      Array<(...args: unknown[]) => void>
    >();

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
      return (this.listeners.get(event)?.length ?? 0) > 0;
    }
  }

  class FakeWebContents extends FakeEmitter {
    executeJavaScript = vi.fn().mockResolvedValue([]);
  }

  const windows: FakeBrowserWindow[] = [];
  class FakeBrowserWindow extends FakeEmitter {
    readonly webContents = new FakeWebContents();
    private destroyed = false;

    constructor(_options: unknown) {
      super();
      windows.push(this);
    }

    loadURL = vi.fn().mockResolvedValue(undefined);

    isDestroyed(): boolean {
      return this.destroyed;
    }

    destroy(): void {
      this.destroyed = true;
      this.emit('closed');
    }
  }

  return { createdWindows: windows, FakeBrowserWindow };
});

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: FakeBrowserWindow,
  session: { fromPartition: vi.fn(() => ({})) },
}));

vi.mock('../file-system/protocol', () => ({
  registerTabtinFileProtocol: vi.fn(),
}));

vi.mock('../services/display-media', () => ({
  installDisplayMediaHandlers: vi.fn(),
}));

import { MeetingCaptureWindow } from './MeetingCaptureWindow';

const scope = {
  organizationId: 'org-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

describe('MeetingCaptureWindow', () => {
  beforeEach(() => {
    createdWindows.length = 0;
    vi.clearAllMocks();
  });

  it('reports render termination once even when the window closes afterwards', async () => {
    const onUnexpectedTermination = vi.fn();
    const captureWindow = new MeetingCaptureWindow({
      isDev: true,
      rendererUrl: 'http://127.0.0.1:5173',
      onUnexpectedTermination,
    });
    await captureWindow.start(scope);
    const window = createdWindows[0]!;

    window.webContents.emit('render-process-gone', {}, {
      reason: 'crashed',
      exitCode: 9,
    });
    window.emit('closed');

    expect(onUnexpectedTermination).toHaveBeenCalledOnce();
    expect(onUnexpectedTermination).toHaveBeenCalledWith(
      'render-process-gone:crashed:9',
    );
  });

  it('does not report normal stop or an explicit destroy as a crash', async () => {
    const onUnexpectedTermination = vi.fn();
    const captureWindow = new MeetingCaptureWindow({
      isDev: true,
      rendererUrl: 'http://127.0.0.1:5173',
      onUnexpectedTermination,
    });
    await captureWindow.start(scope);

    await captureWindow.stop();
    captureWindow.destroy();

    expect(onUnexpectedTermination).not.toHaveBeenCalled();
  });
});
