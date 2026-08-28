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

  it('routes source switching through prepare, commit, and abort methods', async () => {
    const captureWindow = new MeetingCaptureWindow({
      isDev: true,
      rendererUrl: 'http://127.0.0.1:5173',
    });
    await captureWindow.start(scope);
    const executeJavaScript = createdWindows[0]!.webContents.executeJavaScript;
    executeJavaScript
      .mockResolvedValueOnce({
        operationId: 'local-op-1',
        source: 'local',
        sourceId: 'mic-2',
        label: 'USB microphone',
      })
      .mockResolvedValueOnce({
        source: 'local',
        sourceId: 'mic-2',
        label: 'USB microphone',
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        source: 'local',
        sourceId: 'mic-2',
        label: 'USB microphone',
      })
      .mockResolvedValueOnce({
        source: 'local',
        sourceId: 'built-in-mic',
        label: 'Built-in microphone',
      });

    await expect(
      captureWindow.prepareMicrophoneSwitch('mic-2'),
    ).resolves.toMatchObject({ operationId: 'local-op-1' });
    await expect(
      captureWindow.commitSourceSwitch({
        operationId: 'local-op-1',
        source: 'local',
      }),
    ).resolves.toMatchObject({ sourceId: 'mic-2' });
    await captureWindow.abortSourceSwitch({
      operationId: 'local-op-1',
      source: 'local',
    });
    await captureWindow.finalizeSourceSwitch({
      operationId: 'local-op-1',
      source: 'local',
    });
    await captureWindow.rollbackSourceSwitch({
      operationId: 'local-op-1',
      source: 'local',
    });

    expect(executeJavaScript.mock.calls.at(-5)?.[0]).toContain(
      '__TABTIN_MEETING_CAPTURE__.prepareMicrophoneSwitch({"deviceId":"mic-2"})',
    );
    expect(executeJavaScript.mock.calls.at(-4)?.[0]).toContain(
      '__TABTIN_MEETING_CAPTURE__.commitSourceSwitch({"operationId":"local-op-1","source":"local"})',
    );
    expect(executeJavaScript.mock.calls.at(-3)?.[0]).toContain(
      '__TABTIN_MEETING_CAPTURE__.abortSourceSwitch({"operationId":"local-op-1","source":"local"})',
    );
    expect(executeJavaScript.mock.calls.at(-2)?.[0]).toContain(
      '__TABTIN_MEETING_CAPTURE__.finalizeSourceSwitch({"operationId":"local-op-1","source":"local"})',
    );
    expect(executeJavaScript.mock.calls.at(-1)?.[0]).toContain(
      '__TABTIN_MEETING_CAPTURE__.rollbackSourceSwitch({"operationId":"local-op-1","source":"local"})',
    );
  });

  it('reports a renderer watchdog failure without issuing a business abort', async () => {
    vi.useFakeTimers();
    try {
      const captureWindow = new MeetingCaptureWindow({
        isDev: true,
        rendererUrl: 'http://127.0.0.1:5173',
        captureRuntimeWatchdogMs: 30,
      });
      await captureWindow.start(scope);
      createdWindows[0]!.webContents.executeJavaScript.mockImplementationOnce(
        () => new Promise(() => undefined),
      );

      const preparation = captureWindow.prepareMicrophoneSwitch('mic-hung');
      const expectation = expect(preparation).rejects.toThrow(
        'meeting capture renderer is unresponsive',
      );
      await vi.advanceTimersByTimeAsync(30);

      await expectation;
      expect(createdWindows[0]!.webContents.executeJavaScript).toHaveBeenCalledTimes(
        2,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
