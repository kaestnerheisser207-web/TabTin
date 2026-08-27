import { app, BrowserWindow } from 'electron';
import { okResponse } from '@tabtin/agent-wire';

import {
  MEETING_CAPTURE_LEVEL_CHANNEL,
  MEETING_MICROPHONE_TEST_LEVEL_CHANNEL,
  MEETING_RECORDING_STATUS_CHANNEL,
  type AppendMeetingAudioChunkInput,
  type AppendMeetingPcmChunkInput,
  type MeetingArchiveListScope,
  type MeetingArchiveScope,
  type MeetingAsrProbeInput,
  type MeetingCaptureLevelEvent,
  type MeetingMediaProbeInput,
  type MeetingMicrophoneTestInput,
  type MeetingMicrophoneTestLevelEvent,
  type MeetingTranscriptCheckpoint,
  type PrepareMeetingArchiveInput,
  type SwitchMeetingMicrophoneInput,
  type SwitchMeetingSystemAudioInput,
} from '../../shared/meeting-recording-contract';
import { guardedHandle } from '../utils/guarded-handle';
import { MeetingRecordingManager } from './MeetingRecordingManager';
import { MeetingCaptureWindow } from './MeetingCaptureWindow';
import {
  MeetingAsrCoordinator,
  probeMeetingAsrReadiness,
} from './MeetingAsrCoordinator';
import { MeetingServerSync } from './MeetingServerSync';
import { electronWsGateway } from '../ws/ElectronWsGateway';

export const MEETING_RECORDING_IPC_CHANNELS = [
  'meeting-recording:probe-storage',
  'meeting-recording:probe-media',
  'meeting-recording:probe-asr',
  'meeting-recording:list-microphones',
  'meeting-recording:list-system-audio-sources',
  'meeting-recording:test-microphone',
  'meeting-recording:switch-microphone',
  'meeting-recording:switch-system-audio',
  'meeting-recording:report-microphone-test-level',
  'meeting-recording:report-capture-level',
  'meeting-recording:prepare',
  'meeting-recording:start',
  'meeting-recording:stop',
  'meeting-recording:cancel',
  'meeting-recording:status',
  'meeting-recording:append-audio-chunk',
  'meeting-recording:append-pcm-chunk',
  'meeting-recording:append-transcript',
  'meeting-recording:recover-interrupted',
  'meeting-recording:list-archives',
  'meeting-recording:get-archive',
  'meeting-recording:set-copilot',
  'meeting-recording:answer-copilot',
] as const;

let manager: MeetingRecordingManager | null = null;
let serverSync: MeetingServerSync | null = null;
let unsubscribeServerReconnect: (() => void) | null = null;

function getManager(): MeetingRecordingManager {
  if (!manager) {
    serverSync = new MeetingServerSync();
    manager = new MeetingRecordingManager({
      captureHost: new MeetingCaptureWindow({
        isDev: !app.isPackaged,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
      }),
      createAsrRuntime: ({ scope, onTranscript, onStatus }) =>
        new MeetingAsrCoordinator({
          gateway: electronWsGateway,
          transcriptSink: onTranscript,
          sessionId: scope.sessionId,
          organizationId: scope.organizationId,
          onStatusChange: (status, errorMessage) => {
            void onStatus(status, errorMessage);
          },
        }),
      serverSync,
      onStatusChanged: (status) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send(MEETING_RECORDING_STATUS_CHANNEL, status);
          }
        }
      },
    });
    unsubscribeServerReconnect = electronWsGateway.onReconnect(() => {
      void manager?.retryActiveServerSync();
    });
  }
  return manager;
}

export function registerMeetingRecordingIpc(): void {
  void getManager()
    .recoverInterrupted()
    .catch(() => undefined);
  guardedHandle('meeting-recording:probe-storage', async () =>
    okResponse(await getManager().probeLocalStorage()),
  );
  guardedHandle(
    'meeting-recording:probe-media',
    async (_event, input: MeetingMediaProbeInput = {}) =>
      okResponse(await getManager().probeMedia(input)),
  );
  guardedHandle(
    'meeting-recording:probe-asr',
    async (_event, input: MeetingAsrProbeInput = {}) =>
      okResponse(
        await probeMeetingAsrReadiness(electronWsGateway, input.organizationId),
      ),
  );
  guardedHandle('meeting-recording:list-microphones', async () =>
    okResponse(await getManager().listMicrophones()),
  );
  guardedHandle('meeting-recording:list-system-audio-sources', async () =>
    okResponse(await getManager().listSystemAudioSources()),
  );
  guardedHandle(
    'meeting-recording:test-microphone',
    async (_event, input: MeetingMicrophoneTestInput = {}) =>
      okResponse(await getManager().testMicrophone(input)),
  );
  guardedHandle(
    'meeting-recording:switch-microphone',
    async (_event, input: SwitchMeetingMicrophoneInput) =>
      okResponse(await getManager().switchMicrophone(input)),
  );
  guardedHandle(
    'meeting-recording:switch-system-audio',
    async (_event, input: SwitchMeetingSystemAudioInput) =>
      okResponse(await getManager().switchSystemAudio(input)),
  );
  guardedHandle(
    'meeting-recording:report-microphone-test-level',
    async (_event, level: MeetingMicrophoneTestLevelEvent) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(MEETING_MICROPHONE_TEST_LEVEL_CHANNEL, level);
        }
      }
      return okResponse(null);
    },
  );
  guardedHandle(
    'meeting-recording:report-capture-level',
    async (_event, level: MeetingCaptureLevelEvent) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(MEETING_CAPTURE_LEVEL_CHANNEL, level);
        }
      }
      return okResponse(null);
    },
  );
  guardedHandle(
    'meeting-recording:prepare',
    async (_event, input: PrepareMeetingArchiveInput) =>
      okResponse(await getManager().prepare(input)),
  );
  guardedHandle(
    'meeting-recording:start',
    async (_event, scope: MeetingArchiveScope) =>
      okResponse(await getManager().start(scope)),
  );
  guardedHandle(
    'meeting-recording:stop',
    async (_event, scope: MeetingArchiveScope) =>
      okResponse(await getManager().stop(scope)),
  );
  guardedHandle(
    'meeting-recording:cancel',
    async (_event, scope: MeetingArchiveScope) =>
      okResponse(await getManager().cancel(scope)),
  );
  guardedHandle('meeting-recording:status', () =>
    okResponse(getManager().getStatus()),
  );
  guardedHandle(
    'meeting-recording:append-audio-chunk',
    async (_event, input: AppendMeetingAudioChunkInput) =>
      okResponse(await getManager().appendAudioChunk(input)),
  );
  guardedHandle(
    'meeting-recording:append-pcm-chunk',
    async (_event, input: AppendMeetingPcmChunkInput) => {
      getManager().appendPcmChunk(input);
      return okResponse(null);
    },
  );
  guardedHandle(
    'meeting-recording:append-transcript',
    async (
      _event,
      scope: MeetingArchiveScope,
      checkpoint: MeetingTranscriptCheckpoint,
    ) => {
      await getManager().appendTranscriptCheckpoint(scope, checkpoint);
      return okResponse(null);
    },
  );
  guardedHandle('meeting-recording:recover-interrupted', async () =>
    okResponse(await getManager().recoverInterrupted()),
  );
  guardedHandle(
    'meeting-recording:list-archives',
    async (_event, scope: MeetingArchiveListScope) =>
      okResponse(await getManager().listArchives(scope)),
  );
  guardedHandle(
    'meeting-recording:get-archive',
    async (_event, scope: MeetingArchiveScope) =>
      okResponse(await getManager().getArchive(scope)),
  );
  guardedHandle(
    'meeting-recording:set-copilot',
    async (_event, scope: MeetingArchiveScope, enabled: boolean) =>
      okResponse(await getManager().setCopilotEnabled(scope, enabled)),
  );
  guardedHandle(
    'meeting-recording:answer-copilot',
    async (
      _event,
      scope: MeetingArchiveScope,
      questionSegmentId: string,
    ) =>
      okResponse(
        await getManager().answerCopilotQuestion(scope, questionSegmentId),
      ),
  );
}

export async function flushActiveMeetingRecordingOnExit(): Promise<void> {
  await manager?.interruptForShutdown();
}

export function resetMeetingRecordingManagerForTests(): void {
  unsubscribeServerReconnect?.();
  unsubscribeServerReconnect = null;
  serverSync = null;
  manager = null;
}
