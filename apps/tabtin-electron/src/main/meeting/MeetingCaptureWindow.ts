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
import { installDisplayMediaHandlers } from '../services/display-media';

const CAPTURE_PARTITION = 'persist:tabtin:meeting-capture';
const PACKAGED_CAPTURE_URL = 'tabtin-file://app/meeting-capture.html';

type CaptureMethod =
  | 'probe'
  | 'listMicrophones'
  | 'listSystemAudioSources'
  | 'testMicrophone'
  | 'switchMicrophone'
  | 'switchSystemAudio'
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'getState';

export interface MeetingCaptureHost {
  listMicrophones(): Promise<MeetingMicrophoneDevice[]>;
  listSystemAudioSources(): Promise<MeetingSystemAudioSource[]>;
  probe(input?: MeetingMediaProbeInput): Promise<MeetingMediaProbeResult>;
  testMicrophone(
    input?: MeetingMicrophoneTestInput,
  ): Promise<MeetingMicrophoneTestResult>;
  switchMicrophone(deviceId: string): Promise<MeetingCaptureSourceSelection>;
  switchSystemAudio(sourceId: string): Promise<MeetingCaptureSourceSelection>;
  start(
    scope: MeetingArchiveScope,
    options?: { microphoneDeviceId?: string },
  ): Promise<MeetingCaptureSourceSelection[]>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  destroy(): void;
}

export interface MeetingCaptureWindowOptions {
  isDev?: boolean;
  rendererUrl?: string;
}

export class MeetingCaptureWindow implements MeetingCaptureHost {
  private readonly isDev: boolean;
  private readonly rendererUrl?: string;
  private window: BrowserWindow | null = null;
  private loadPromise: Promise<BrowserWindow> | null = null;
  private capturePolicyInstalled = false;

  constructor(options: MeetingCaptureWindowOptions = {}) {
    this.isDev = options.isDev ?? !app.isPackaged;
    this.rendererUrl = options.rendererUrl ?? process.env.ELECTRON_RENDERER_URL;
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
      window.on('closed', () => {
        if (this.window === window) this.window = null;
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

  async switchMicrophone(
    deviceId: string,
  ): Promise<MeetingCaptureSourceSelection> {
    return (await this.invoke('switchMicrophone', {
      deviceId,
    })) as MeetingCaptureSourceSelection;
  }

  async switchSystemAudio(
    sourceId: string,
  ): Promise<MeetingCaptureSourceSelection> {
    return (await this.invoke('switchSystemAudio', {
      sourceId,
    })) as MeetingCaptureSourceSelection;
  }

  async pause(): Promise<void> {
    await this.invoke('pause');
  }

  async resume(): Promise<void> {
    await this.invoke('resume');
  }

  async stop(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;
    await this.invoke('stop');
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.loadPromise = null;
  }
}
