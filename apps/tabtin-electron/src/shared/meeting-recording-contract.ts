export const MEETING_ARCHIVE_SCHEMA_VERSION = 2 as const;

export type MeetingAudioSource = 'local' | 'remote';
export type MeetingArchiveLifecycleStatus =
  | 'draft'
  | 'preparing'
  | 'recording'
  | 'stopped'
  | 'cancelled'
  | 'interrupted';

export type MeetingArchiveTrackStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'missing';

export interface MeetingArchiveTrackManifest {
  source: MeetingAudioSource;
  status: MeetingArchiveTrackStatus;
  nextSequence: number;
  durationMs: number;
  bytes: number;
  sampleRate: number;
  channelCount: number;
  codec: string;
  container: string;
  lastCheckpointAt: string | null;
  finalizedRelativePath: string | null;
  contentHash: string;
  storageStatus:
    | 'local_only'
    | 'pending'
    | 'uploading'
    | 'confirming'
    | 'synced'
    | 'failed'
    | 'deleted';
  fileRecordId: string | null;
  objectKey: string;
  uploadError: string;
  uploadAttempts: number;
  lastUploadAttemptAt: string | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface MeetingArchiveManifestV2 {
  schemaVersion: typeof MEETING_ARCHIVE_SCHEMA_VERSION;
  sessionId: string;
  organizationId: string;
  userId: string;
  projectId: string | null;
  projectName?: string;
  title: string;
  brief: string;
  consentConfirmedAt: string;
  microphoneDeviceId: string;
  microphoneDeviceLabel: string;
  systemAudioSourceId: string;
  systemAudioSourceLabel: string;
  copilotInitiallyEnabled: boolean;
  copilotEnabled: boolean;
  copilotModelId?: string;
  copilotModelLabel?: string;
  transcriptionStatus:
    | 'idle'
    | 'connecting'
    | 'active'
    | 'recovering'
    | 'completed'
    | 'partial'
    | 'failed';
  transcriptRevision: number;
  transcriptFinalCount: number;
  transcriptRunId: string;
  transcriptionError: string;
  lifecycleStatus: MeetingArchiveLifecycleStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  serverSyncStatus: 'pending' | 'synced' | 'failed';
  serverSyncError: string;
  tracks: Record<MeetingAudioSource, MeetingArchiveTrackManifest>;
}

export interface PrepareMeetingArchiveInput {
  sessionId: string;
  organizationId: string;
  userId: string;
  projectId?: string | null;
  projectName?: string;
  title: string;
  brief?: string;
  consentConfirmed: boolean;
  copilotEnabled?: boolean;
  copilotModelId?: string;
  copilotModelLabel?: string;
  microphoneDeviceId?: string;
  microphoneDeviceLabel?: string;
}

export interface AppendMeetingAudioChunkInput {
  sessionId: string;
  organizationId: string;
  userId: string;
  source: MeetingAudioSource;
  bytes: Uint8Array;
  durationMs: number;
  sampleRate: number;
  channelCount: number;
  codec: string;
  container: string;
}

export interface AppendMeetingPcmChunkInput extends MeetingArchiveScope {
  source: MeetingAudioSource;
  bytes: Uint8Array;
  sampleRate: 16000;
  channelCount: 1;
}

export interface MeetingTranscriptCheckpoint {
  externalId: string;
  source: MeetingAudioSource;
  speakerKey?: string;
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
  confidence?: number | null;
  recordedAt: string;
}

export interface MeetingStorageProbeResult {
  ok: boolean;
  rootPath: string;
  availableBytes: number | null;
  errorCode?: 'not_writable' | 'readback_failed' | 'unknown';
  errorMessage?: string;
}

export interface MeetingMediaSourceProbe {
  available: boolean;
  trackState?: MediaStreamTrackState;
  deviceId?: string;
  deviceLabel?: string;
  sampleRate?: number;
  channelCount?: number;
  errorName?: string;
  errorMessage?: string;
}

export interface MeetingMicrophoneDevice {
  deviceId: string;
  groupId: string;
  label: string;
  isDefault: boolean;
}

export interface MeetingSystemAudioSource {
  sourceId: string;
  label: string;
  isDefault: boolean;
}

export interface MeetingCaptureSourceSelection {
  source: MeetingAudioSource;
  sourceId: string;
  label: string;
}

export interface MeetingMediaProbeInput {
  microphoneDeviceId?: string;
  sources?: MeetingAudioSource[];
}

export interface MeetingMediaProbeResult {
  local: MeetingMediaSourceProbe;
  remote: MeetingMediaSourceProbe;
  microphones: MeetingMicrophoneDevice[];
}

export interface MeetingAsrProbeInput {
  organizationId?: string;
}

export interface MeetingAsrProbeResult {
  ready: boolean;
  provider: string;
  reason?:
    | 'not_configured'
    | 'credential_error'
    | 'gateway_error'
    | 'internal_error';
  message?: string;
  resourceId?: string;
  wsEndpoint?: string;
}

export interface MeetingMicrophoneTestInput {
  microphoneDeviceId?: string;
  durationMs?: number;
}

export interface MeetingMicrophoneTestLevelEvent {
  deviceId: string;
  deviceLabel: string;
  active: boolean;
  elapsedMs: number;
  rms: number;
  maxRms: number;
  nonSilentFrames: number;
}

export interface MeetingMicrophoneTestResult {
  available: boolean;
  deviceId: string;
  deviceLabel: string;
  measuredFrames: number;
  nonSilentFrames: number;
  maxRms: number;
  errorName?: string;
  errorMessage?: string;
}

export interface MeetingArchiveScope {
  sessionId: string;
  organizationId: string;
  userId: string;
}

export interface MeetingCaptureLevelEvent extends MeetingArchiveScope {
  source: MeetingAudioSource;
  rms: number;
}

export interface MeetingCopilotAnswerSource {
  id: string;
  kind: 'transcript' | 'meeting_brief' | 'project_resource';
  title: string;
  excerpt: string;
  resource_type: string;
  resource_id: string;
}

export type MeetingCopilotAnswerResult =
  | {
      status: 'answered';
      question: string;
      question_segment_id: string;
      answer: string;
      key_points: string[];
      sources: MeetingCopilotAnswerSource[];
      reliability: 'high' | 'medium' | 'low';
      warning: string;
      model: string;
      provider: string;
      latency_ms: number;
    }
  | {
      status:
        | 'disabled'
        | 'unavailable'
        | 'no_question'
        | 'no_action'
        | 'failed';
      message: string;
      error_code?: string;
      candidate_segment_id?: string;
    };

export interface MeetingCopilotRecord {
  questionSegmentId: string;
  evaluatedAt: string;
  result: MeetingCopilotAnswerResult;
}

export interface SwitchMeetingMicrophoneInput extends MeetingArchiveScope {
  deviceId: string;
}

export interface SwitchMeetingSystemAudioInput extends MeetingArchiveScope {
  sourceId: string;
}

export interface MeetingRecordingStatus {
  active: boolean;
  manifest: MeetingArchiveManifestV2 | null;
}

export interface MeetingArchiveListScope {
  organizationId: string;
  userId: string;
}

export interface MeetingLocalArchive {
  manifest: MeetingArchiveManifestV2;
  audioUrls: Partial<Record<MeetingAudioSource, string>>;
  transcript: MeetingTranscriptCheckpoint[];
  copilotRecords: MeetingCopilotRecord[];
}

export const MEETING_RECORDING_STATUS_CHANNEL =
  'meeting-recording:status-changed';
export const MEETING_MICROPHONE_TEST_LEVEL_CHANNEL =
  'meeting-recording:microphone-test-level';
export const MEETING_CAPTURE_LEVEL_CHANNEL = 'meeting-recording:capture-level';
