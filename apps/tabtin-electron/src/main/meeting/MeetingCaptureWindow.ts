import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';

import type {
  MeetingArchiveScope,
  MeetingCaptureSourceSelection,
  MeetingMediaProbeInput,
  MeetingMediaProbeResult,
  MeetingMicrophoneDevice,
  MeetingMicrophoneTestInput,
  MeetingMicrophoneTestResult,
  MeetingSystemAudioSource,
} from '../../shared/meeting-recording-contract';
import { registerTabtinFileProtocol } from '../file-system/protocol';
import { installDisplayMediaHandlers } from '../services/display-media';

const CAPTURE_PARTITION = 'persist:tabtin:meeting-capture';
const PACKAGED_CAPTURE_URL = 'tabtin-file://app/meeting-capture.html';
const DEFAULT_CAPTURE_RUNTIME_WATCHDOG_MS = 30_000;

type CaptureMethod =
  | 'probe'
  | 'listMicrophones'
  | 'listSystemAudioSources'
  | 'testMicrophone'
  | 'prepareMicrophoneSwitch'
  | 'prepareSystemAudioSwitch'
  | 'commitSourceSwitch'
  | 'abortSourceSwitch'
  | 'finalizeSourceSwitch'
  | 'rollbackSourceSwitch'
  | 'start'
  | 'stop'
  | 'getState';

export interface PreparedMeetingCaptureSource
  extends MeetingCaptureSourceSelection {
  operationId: string;
}

export interface MeetingCaptureSourceSwitchReference {
  operationId: string;
  source: MeetingCaptureSourceSelection['source'];
}

export interface MeetingCaptureHost {
  listMicrophones(): Promise<MeetingMicrophoneDevice[]>;
  listSystemAudioSources(): Promise<MeetingSystemAudioSource[]>;
  probe(input?: MeetingMediaProbeInput): Promise<MeetingMediaProbeResult>;
  testMicrophone(
    input?: MeetingMicrophoneTestInput,
  ): Promise<MeetingMicrophoneTestResult>;
  prepareMicrophoneSwitch(
    deviceId: string,
  ): Promise<PreparedMeetingCaptureSource>;
  prepareSystemAudioSwitch(
    sourceId: string,
  ): Promise<PreparedMeetingCaptureSource>;
  commitSourceSwitch(
    input: MeetingCaptureSourceSwitchReference,
  ): Promise<MeetingCaptureSourceSelection>;
  abortSourceSwitch(input: MeetingCaptureSourceSwitchReference): Promise<void>;
  finalizeSourceSwitch(
    input: MeetingCaptureSourceSwitchReference,
  ): Promise<MeetingCaptureSourceSelection>;
  rollbackSourceSwitch(
    input: MeetingCaptureSourceSwitchReference,
  ): Promise<MeetingCaptureSourceSelection>;
  start(
    scope: MeetingArchiveScope,
    options?: { microphoneDeviceId?: string },
  ): Promise<MeetingCaptureSourceSelection[]>;
  stop(): Promise<void>;
  destroy(): void;
}

export interface MeetingCaptureWindowOptions {
  isDev?: boolean;
  rendererUrl?: string;
  onUnexpectedTermination?: (reason: string) => void;
  captureRuntimeWatchdogMs?: number;
}

export class MeetingCaptureWindow implements MeetingCaptureHost {
  private readonly isDev: boolean;
  private readonly rendererUrl?: string;
  private readonly onUnexpectedTermination?: (reason: string) => void;
  private readonly captureRuntimeWatchdogMs: number;
  private window: BrowserWindow | null = null;
  private loadPromise: Promise<BrowserWindow> | null = null;
  private capturePolicyInstalled = false;
  private readonly expectedClosures = new WeakSet<BrowserWindow>();

  constructor(options: MeetingCaptureWindowOptions = {}) {
    this.isDev = options.isDev ?? !app.isPackaged;
    this.rendererUrl = options.rendererUrl ?? process.env.ELECTRON_RENDERER_URL;
    this.onUnexpectedTermination = options.onUnexpectedTermination;
    this.captureRuntimeWatchdogMs =
      options.captureRuntimeWatchdogMs ?? DEFAULT_CAPTURE_RUNTIME_WATCHDOG_MS;
  }

  private resolveUrl(): string {
    if (!this.isDev) return PACKAGED_CAPTURE_URL;
    if (!this.rendererUrl) {
      throw new Error('meeting capture renderer URL is unavailable');
    }
    return new URL('/meeting-capture.html', this.rendererUrl).toString();
  }

  private installCapturePolicy(): void {
    if (this.capturePolicyInstalled) return;
    const captureSession = session.fromPartition(CAPTURE_PARTITION);
    registerTabtinFileProtocol(captureSession);
    installDisplayMediaHandlers({
      targetSession: captureSession,
      rendererUrl: this.rendererUrl,
      isDev: this.isDev,
      captureMode: 'loopback-audio',
      allowScreenFallback: false,
    });
    this.capturePolicyInstalled = true;
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      this.installCapturePolicy();
      const window = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: 320,
        height: 180,
        webPreferences: {
          preload: join(import.meta.dirname, '../preload/index.cjs'),
          partition: CAPTURE_PARTITION,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      let terminationReported = false;
      const reportUnexpectedTermination = (reason: string): void => {
        if (terminationReported) return;
        terminationReported = true;
        this.onUnexpectedTermination?.(reason);
      };
      window.webContents.on('render-process-gone', (_event, details) => {
        reportUnexpectedTermination(
          `render-process-gone:${details.reason}:${details.exitCode}`,
        );
      });
      window.on('closed', () => {
        if (this.window === window) this.window = null;
        if (!this.expectedClosures.delete(window)) {
          reportUnexpectedTermination('window-closed');
        }
      });
      await window.loadURL(this.resolveUrl());
      this.window = window;
      return window;
    })();

    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async invoke(
    method: CaptureMethod,
    argument?: unknown,
  ): Promise<unknown> {
    const window = await this.ensureWindow();
    const serializedArgument =
      argument === undefined
        ? ''
        : JSON.stringify(argument).replaceAll('<', '\\u003c');
    return window.webContents.executeJavaScript(
      `globalThis.__TABTIN_MEETING_CAPTURE__.${method}(${serializedArgument})`,
      true,
    );
  }

  private async invokeWithRuntimeWatchdog(
    method: CaptureMethod,
    argument?: unknown,
  ): Promise<unknown> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.invoke(method, argument),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error('meeting capture renderer is unresponsive'));
          }, this.captureRuntimeWatchdogMs);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async start(
    scope: MeetingArchiveScope,
    options: { microphoneDeviceId?: string } = {},
  ): Promise<MeetingCaptureSourceSelection[]> {
    return (await this.invoke('start', {
      scope,
      microphoneDeviceId: options.microphoneDeviceId,
    })) as MeetingCaptureSourceSelection[];
  }

  async probe(
    input: MeetingMediaProbeInput = {},
  ): Promise<MeetingMediaProbeResult> {
    return (await this.invoke('probe', input)) as MeetingMediaProbeResult;
  }

  async listMicrophones(): Promise<MeetingMicrophoneDevice[]> {
    return (await this.invoke('listMicrophones')) as MeetingMicrophoneDevice[];
  }

  async listSystemAudioSources(): Promise<MeetingSystemAudioSource[]> {
    return (await this.invoke(
      'listSystemAudioSources',
    )) as MeetingSystemAudioSource[];
  }

  async testMicrophone(
    input: MeetingMicrophoneTestInput = {},
  ): Promise<MeetingMicrophoneTestResult> {
    return (await this.invoke(
      'testMicrophone',
      input,
    )) as MeetingMicrophoneTestResult;
  }

  async prepareMicrophoneSwitch(
    deviceId: string,
  ): Promise<PreparedMeetingCaptureSource> {
    return (await this.invokeWithRuntimeWatchdog('prepareMicrophoneSwitch', {
      deviceId,
    })) as PreparedMeetingCaptureSource;
  }

  async prepareSystemAudioSwitch(
    sourceId: string,
  ): Promise<PreparedMeetingCaptureSource> {
    return (await this.invokeWithRuntimeWatchdog('prepareSystemAudioSwitch', {
      sourceId,
    })) as PreparedMeetingCaptureSource;
  }

  async commitSourceSwitch(
    input: MeetingCaptureSourceSwitchReference,
  ): Promise<MeetingCaptureSourceSelection> {
    return (await this.invokeWithRuntimeWatchdog(
      'commitSourceSwitch',
      input,
    )) as MeetingCaptureSourceSelection;
  }

  async abortSourceSwitch(
    input: MeetingCaptureSourceSwitchReference,
  ): Promise<void> {
    await this.invokeWithRuntimeWatchdog('abortSourceSwitch', input);
  }

  async finalizeSourceSwitch(
    input: MeetingCaptureSourceSwitchReference,
  ): Promise<MeetingCaptureSourceSelection> {
    return (await this.invokeWithRuntimeWatchdog(
      'finalizeSourceSwitch',
      input,
    )) as MeetingCaptureSourceSelection;
  }

  async rollbackSourceSwitch(
    input: MeetingCaptureSourceSwitchReference,
  ): Promise<MeetingCaptureSourceSelection> {
    return (await this.invokeWithRuntimeWatchdog(
      'rollbackSourceSwitch',
      input,
    )) as MeetingCaptureSourceSelection;
  }

  async stop(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;
    await this.invoke('stop');
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.expectedClosures.add(this.window);
      this.window.destroy();
    }
    this.window = null;
    this.loadPromise = null;
  }
}
