import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getUserDataPath } from '@tabtin/shared';

import {
  MEETING_ARCHIVE_SCHEMA_VERSION,
  type AppendMeetingAudioChunkInput,
  type MeetingArchiveLifecycleStatus,
  type MeetingArchiveManifestV2,
  type MeetingArchiveTrackManifest,
  type MeetingAudioSource,
  type MeetingCopilotAnswerResult,
  type MeetingCopilotRecord,
  type MeetingStorageProbeResult,
  type MeetingTranscriptCheckpoint,
  type PrepareMeetingArchiveInput,
} from '../../shared/meeting-recording-contract';

const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/;
const INTERRUPTIBLE_STATES = new Set<MeetingArchiveLifecycleStatus>([
  'preparing',
  'recording',
]);

function requireSafeSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized !== value ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('..') ||
    !SAFE_SEGMENT.test(normalized)
  ) {
    throw new Error(`invalid ${label}`);
  }
  return normalized;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function extensionFor(container: string): string {
  const normalized = container.trim().toLowerCase().replace(/^\./, '');
  if (!normalized || !/^[a-z0-9]{1,12}$/.test(normalized)) {
    throw new Error('invalid audio container');
  }
  return normalized;
}

async function durableWrite(
  filePath: string,
  bytes: Uint8Array,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const payload = new TextEncoder().encode(
    `${JSON.stringify(value, null, 2)}\n`,
  );
  try {
    await durableWrite(temporaryPath, payload);
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function durableAppend(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, 'a');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function createTrack(source: MeetingAudioSource): MeetingArchiveTrackManifest {
  return {
    source,
    status: 'pending',
    nextSequence: 1,
    durationMs: 0,
    bytes: 0,
    sampleRate: 0,
    channelCount: 0,
    codec: '',
    container: '',
    lastCheckpointAt: null,
    finalizedRelativePath: null,
    contentHash: '',
    storageStatus: 'local_only',
    fileRecordId: null,
    objectKey: '',
    uploadError: '',
    uploadAttempts: 0,
    lastUploadAttemptAt: null,
  };
}

function parseManifest(raw: string): MeetingArchiveManifestV2 {
  const parsed = JSON.parse(raw) as Partial<MeetingArchiveManifestV2>;
  if (
    parsed.schemaVersion !== MEETING_ARCHIVE_SCHEMA_VERSION ||
    typeof parsed.sessionId !== 'string' ||
    typeof parsed.organizationId !== 'string' ||
    typeof parsed.userId !== 'string' ||
    !parsed.tracks?.local ||
    !parsed.tracks.remote
  ) {
    throw new Error('unsupported or corrupt meeting archive manifest');
  }
  return parsed as MeetingArchiveManifestV2;
}

export interface MeetingArchiveStoreOptions {
  rootPath?: string;
  now?: () => Date;
  finalizeMediaFile?: (
    inputPath: string,
    outputPath: string,
    container: string,
  ) => Promise<void>;
}

async function hashFile(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest('hex');
}

async function defaultFinalizeMediaFile(
  inputPath: string,
  outputPath: string,
  container: string,
): Promise<void> {
  if (container !== 'webm') {
    await fs.copyFile(inputPath, outputPath);
    return;
  }
  const {
    Conversion,
    FilePathSource,
    FilePathTarget,
    Input,
    Output,
    WebMInputFormat,
    WebMOutputFormat,
  } = await import('mediabunny');
  const input = new Input({
    formats: [new WebMInputFormat()],
    source: new FilePathSource(inputPath),
  });
  try {
    const output = new Output({
      format: new WebMOutputFormat(),
      target: new FilePathTarget(outputPath),
    });
    const conversion = await Conversion.init({
      input,
      output,
      video: { discard: true },
      audio: { codec: 'opus' },
      showWarnings: false,
    });
    if (!conversion.isValid) {
      throw new Error('meeting WebM remux is not supported for this track');
    }
    await conversion.execute();
  } finally {
    input.dispose();
  }
}

export class MeetingArchiveStore {
  private readonly rootPath: string;
  private readonly now: () => Date;
  private readonly finalizeMediaFile: NonNullable<
    MeetingArchiveStoreOptions['finalizeMediaFile']
  >;
  private readonly writeChains = new Map<string, Promise<unknown>>();
  private readonly finalTranscriptText = new Map<string, Map<string, string>>();

  constructor(options: MeetingArchiveStoreOptions = {}) {
    this.rootPath = options.rootPath ?? getUserDataPath('meeting-recordings');
    this.now = options.now ?? (() => new Date());
    this.finalizeMediaFile =
      options.finalizeMediaFile ?? defaultFinalizeMediaFile;
  }

  getRootPath(): string {
    return this.rootPath;
  }

  private sessionDirectory(scope: {
    organizationId: string;
    userId: string;
    sessionId: string;
  }): string {
    return path.join(
      this.rootPath,
      requireSafeSegment(scope.organizationId, 'organizationId'),
      requireSafeSegment(scope.userId, 'userId'),
      requireSafeSegment(scope.sessionId, 'sessionId'),
    );
  }

  private manifestPath(scope: {
    organizationId: string;
    userId: string;
    sessionId: string;
  }): string {
    return path.join(this.sessionDirectory(scope), 'manifest.json');
  }

  private enqueueSessionWrite<T>(
    sessionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = requireSafeSegment(sessionId, 'sessionId');
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.writeChains.set(key, current);
    const release = () => {
      if (this.writeChains.get(key) === current) this.writeChains.delete(key);
    };
    void current.then(release, release);
    return current;
  }

  async prepare(
    input: PrepareMeetingArchiveInput,
  ): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(input.sessionId, async () => {
      const manifestPath = this.manifestPath(input);
      try {
        return parseManifest(await fs.readFile(manifestPath, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const timestamp = this.now().toISOString();
      if (!input.consentConfirmed) {
        throw new Error('meeting recording consent is required');
      }
      const manifest: MeetingArchiveManifestV2 = {
        schemaVersion: MEETING_ARCHIVE_SCHEMA_VERSION,
        sessionId: requireSafeSegment(input.sessionId, 'sessionId'),
        organizationId: requireSafeSegment(
          input.organizationId,
          'organizationId',
        ),
        userId: requireSafeSegment(input.userId, 'userId'),
        projectId: input.projectId
          ? requireSafeSegment(input.projectId, 'projectId')
          : null,
        projectName: input.projectName?.trim() || '',
        title: input.title.trim(),
        brief: input.brief?.trim() || '',
        consentConfirmedAt: timestamp,
        microphoneDeviceId: input.microphoneDeviceId?.trim() || 'default',
        microphoneDeviceLabel: input.microphoneDeviceLabel?.trim() || '',
        systemAudioSourceId: 'main-display',
        systemAudioSourceLabel: 'System audio',
        copilotInitiallyEnabled: input.copilotEnabled === true,
        copilotEnabled: input.copilotEnabled === true,
        copilotModelId: input.copilotModelId ?? '',
        copilotModelLabel: input.copilotModelLabel ?? '',
        transcriptionStatus: 'idle',
        transcriptRevision: 0,
        transcriptFinalCount: 0,
        transcriptRunId: randomUUID(),
        transcriptionError: '',
        lifecycleStatus: 'draft',
        createdAt: timestamp,
        startedAt: null,
        endedAt: null,
        durationMs: 0,
        serverSyncStatus: 'pending',
        serverSyncError: '',
        tracks: {
          local: createTrack('local'),
          remote: createTrack('remote'),
        },
      };
      const directory = this.sessionDirectory(input);
      await Promise.all([
        fs.mkdir(path.join(directory, 'local'), { recursive: true }),
        fs.mkdir(path.join(directory, 'remote'), { recursive: true }),
      ]);
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async readManifest(scope: {
    organizationId: string;
    userId: string;
    sessionId: string;
  }): Promise<MeetingArchiveManifestV2> {
    return parseManifest(await fs.readFile(this.manifestPath(scope), 'utf8'));
  }

  async listManifests(scope: {
    organizationId: string;
    userId: string;
  }): Promise<MeetingArchiveManifestV2[]> {
    const directory = path.join(
      this.rootPath,
      requireSafeSegment(scope.organizationId, 'organizationId'),
      requireSafeSegment(scope.userId, 'userId'),
    );
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch(() => []);
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.readManifest({
              ...scope,
              sessionId: entry.name,
            });
          } catch {
            return null;
          }
        }),
    );
    return manifests
      .filter((manifest): manifest is MeetingArchiveManifestV2 =>
        Boolean(manifest),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listAllManifests(): Promise<MeetingArchiveManifestV2[]> {
    const manifests: MeetingArchiveManifestV2[] = [];
    const organizationDirectories = await fs
      .readdir(this.rootPath, { withFileTypes: true })
      .catch(() => []);
    for (const organizationEntry of organizationDirectories) {
      if (!organizationEntry.isDirectory() || organizationEntry.name.startsWith('.'))
        continue;
      const organizationId = organizationEntry.name;
      const userDirectories = await fs
        .readdir(path.join(this.rootPath, organizationId), { withFileTypes: true })
        .catch(() => []);
      for (const userEntry of userDirectories) {
        if (!userEntry.isDirectory()) continue;
        const userId = userEntry.name;
        const sessionDirectories = await fs
          .readdir(path.join(this.rootPath, organizationId, userId), {
            withFileTypes: true,
          })
          .catch(() => []);
        for (const sessionEntry of sessionDirectories) {
          if (!sessionEntry.isDirectory()) continue;
          try {
            manifests.push(
              await this.readManifest({
                organizationId,
                userId,
                sessionId: sessionEntry.name,
              }),
            );
          } catch {
            // Unsupported/corrupt archives remain untouched for diagnostics.
          }
        }
      }
    }
    return manifests.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  resolveSessionFile(
    scope: { organizationId: string; userId: string; sessionId: string },
    relativeName: string,
  ): string {
    const safeName = requireSafeSegment(relativeName, 'relativeName');
    return path.join(this.sessionDirectory(scope), safeName);
  }

  async appendAudioChunk(input: AppendMeetingAudioChunkInput): Promise<{
    relativePath: string;
    sequence: number;
    manifest: MeetingArchiveManifestV2;
  }> {
    return this.enqueueSessionWrite(input.sessionId, async () => {
      requireNonNegativeInteger(input.durationMs, 'durationMs');
      requireNonNegativeInteger(input.sampleRate, 'sampleRate');
      requireNonNegativeInteger(input.channelCount, 'channelCount');
      if (input.bytes.byteLength === 0)
        throw new Error('audio chunk must not be empty');

      const manifestPath = this.manifestPath(input);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      const track = manifest.tracks[input.source];
      const sequence = track.nextSequence;
      const extension = extensionFor(input.container);
      const fileName = `${String(sequence).padStart(8, '0')}.${extension}.part`;
      const relativePath = `${input.source}/${fileName}`;
      const finalPath = path.join(this.sessionDirectory(input), relativePath);
      const temporaryPath = `${finalPath}.${randomUUID()}.part`;

      try {
        await durableWrite(temporaryPath, input.bytes);
        await fs.rename(temporaryPath, finalPath);
      } finally {
        await fs.unlink(temporaryPath).catch(() => {});
      }

      const checkpointAt = this.now().toISOString();
      track.status = 'active';
      track.nextSequence += 1;
      track.durationMs += input.durationMs;
      track.bytes += input.bytes.byteLength;
      track.sampleRate = input.sampleRate;
      track.channelCount = input.channelCount;
      track.codec = input.codec;
      track.container = extension;
      track.lastCheckpointAt = checkpointAt;
      manifest.durationMs = Math.max(
        manifest.tracks.local.durationMs,
        manifest.tracks.remote.durationMs,
      );
      await atomicWriteJson(manifestPath, manifest);
      return { relativePath, sequence, manifest };
    });
  }

  async finalizeAudioTracks(scope: {
    organizationId: string;
    userId: string;
    sessionId: string;
  }, options: {
    reconcileParts?: boolean;
    bestEffort?: boolean;
  } = {}): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      const sessionDirectory = this.sessionDirectory(scope);

      for (const source of ['local', 'remote'] as const) {
        const track = manifest.tracks[source];
        const trackDirectory = path.join(sessionDirectory, source);
        const directoryNames = await fs.readdir(trackDirectory).catch(() => []);
        const inferredContainer = directoryNames
          .map((name) => name.match(/^\d{8}\.([a-z0-9]{1,12})\.part$/)?.[1])
          .find(Boolean);
        const container = track.container || inferredContainer;
        if (!container) continue;
        track.container = container;
        const partNames = directoryNames
          .filter((name) => {
            const match = name.match(
              /^(\d{8})\.([a-z0-9]{1,12})\.part$/,
            );
            return match?.[2] === container;
          })
          .sort();
        const finalName = `${source}.${container}`;
        const finalPath = path.join(sessionDirectory, finalName);
        const existingFinal = await fs.stat(finalPath).catch(() => null);
        if (existingFinal?.isFile() && existingFinal.size > 0) {
          track.finalizedRelativePath = finalName;
          track.bytes = existingFinal.size;
          track.contentHash = await hashFile(finalPath);
          if (manifest.lifecycleStatus === 'interrupted') {
            track.status = 'interrupted';
          }
          await atomicWriteJson(manifestPath, manifest);
          continue;
        }
        if (partNames.length === 0) {
          if (track.bytes === 0) continue;
          const error = new Error(
            `meeting ${source} track has no recoverable parts`,
          );
          if (!options.bestEffort) throw error;
          track.status = 'failed';
          track.errorCode = 'finalize_failed';
          track.errorMessage = error.message;
          await atomicWriteJson(manifestPath, manifest);
          continue;
        }

        const combinedPath = `${finalPath}.${randomUUID()}.combined`;
        const finalizedPath = `${finalPath}.${randomUUID()}.finalized`;
        try {
          let writtenBytes = 0;
          const output = await fs.open(combinedPath, 'wx');
          try {
            for (const partName of partNames) {
              const bytes = await fs.readFile(
                path.join(trackDirectory, partName),
              );
              writtenBytes += bytes.byteLength;
              await output.write(bytes);
            }
            await output.sync();
          } finally {
            await output.close();
          }

          if (writtenBytes !== track.bytes) {
            if (!options.reconcileParts) {
              throw new Error(
                `meeting ${source} track byte count mismatch: expected=${track.bytes} actual=${writtenBytes}`,
              );
            }
            track.bytes = writtenBytes;
            const lastSequence = Number.parseInt(
              partNames.at(-1)?.slice(0, 8) ?? '0',
              10,
            );
            track.nextSequence = Math.max(track.nextSequence, lastSequence + 1);
          }
          await this.finalizeMediaFile(
            combinedPath,
            finalizedPath,
            container,
          );
          const finalizedStat = await fs.stat(finalizedPath);
          if (finalizedStat.size === 0) {
            throw new Error(`meeting ${source} finalized track is empty`);
          }
          await fs.rename(finalizedPath, finalPath);
          track.finalizedRelativePath = finalName;
          track.bytes = finalizedStat.size;
          track.contentHash = await hashFile(finalPath);
          if (manifest.lifecycleStatus === 'interrupted') {
            track.status = 'interrupted';
          }
          delete track.errorCode;
          delete track.errorMessage;
          await atomicWriteJson(manifestPath, manifest);
        } catch (error) {
          if (!options.bestEffort) throw error;
          track.status = 'failed';
          track.errorCode = 'finalize_failed';
          track.errorMessage =
            error instanceof Error ? error.message : String(error);
          await atomicWriteJson(manifestPath, manifest);
        } finally {
          await Promise.allSettled([
            fs.unlink(combinedPath),
            fs.unlink(finalizedPath),
          ]);
        }
      }

      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async appendTranscriptCheckpoint(
    scope: { organizationId: string; userId: string; sessionId: string },
    checkpoint: MeetingTranscriptCheckpoint,
  ): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      requireNonNegativeInteger(checkpoint.startMs, 'startMs');
      requireNonNegativeInteger(checkpoint.endMs, 'endMs');
      if (checkpoint.endMs < checkpoint.startMs) {
        throw new Error('transcript checkpoint endMs must not precede startMs');
      }
      const transcriptPath = path.join(
        this.sessionDirectory(scope),
        'transcript.jsonl',
      );
      let finalIndex = this.finalTranscriptText.get(scope.sessionId);
      if (!finalIndex) {
        finalIndex = new Map<string, string>();
        const existingRaw = await fs
          .readFile(transcriptPath, 'utf8')
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
            throw error;
          });
        for (const line of existingRaw.split('\n').filter(Boolean)) {
          const existing = JSON.parse(line) as MeetingTranscriptCheckpoint;
          if (existing.isFinal) {
            finalIndex.set(existing.externalId, existing.text);
          }
        }
        this.finalTranscriptText.set(scope.sessionId, finalIndex);
      }
      const finalText = finalIndex.get(checkpoint.externalId);
      if (finalText !== undefined) {
        if (!checkpoint.isFinal || finalText !== checkpoint.text) {
          throw new Error('final transcript checkpoint cannot be overwritten');
        }
        return parseManifest(
          await fs.readFile(this.manifestPath(scope), 'utf8'),
        );
      }
      await durableAppend(transcriptPath, `${JSON.stringify(checkpoint)}\n`);
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      manifest.transcriptRevision += 1;
      if (checkpoint.isFinal) {
        finalIndex.set(checkpoint.externalId, checkpoint.text);
        manifest.transcriptFinalCount += 1;
      }
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async readTranscript(scope: {
    organizationId: string;
    userId: string;
    sessionId: string;
  }): Promise<MeetingTranscriptCheckpoint[]> {
    const transcriptPath = path.join(
      this.sessionDirectory(scope),
      'transcript.jsonl',
    );
    const raw = await fs.readFile(transcriptPath, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    if (!raw.trim()) return [];
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MeetingTranscriptCheckpoint);
  }

  async appendCopilotRecord(
    scope: { organizationId: string; userId: string; sessionId: string },
    result: MeetingCopilotAnswerResult,
  ): Promise<MeetingCopilotRecord> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const questionSegmentId =
        result.status === 'answered'
          ? result.question_segment_id
          : result.status === 'no_action'
            ? result.candidate_segment_id
            : undefined;
      if (!questionSegmentId) {
        throw new Error('Copilot record requires a question segment');
      }
      const normalizedQuestionSegmentId = questionSegmentId.trim();
      if (
        !normalizedQuestionSegmentId ||
        normalizedQuestionSegmentId !== questionSegmentId ||
        normalizedQuestionSegmentId.length > 512
      ) {
        throw new Error('invalid Copilot question segment');
      }
      const record: MeetingCopilotRecord = {
        questionSegmentId: normalizedQuestionSegmentId,
        evaluatedAt: this.now().toISOString(),
        result,
      };
      const recordPath = path.join(
        this.sessionDirectory(scope),
        'copilot.jsonl',
      );
      await durableAppend(recordPath, `${JSON.stringify(record)}\n`);
      return record;
    });
  }

  async readCopilotRecords(scope: {
    organizationId: string;
    userId: string;
    sessionId: string;
  }): Promise<MeetingCopilotRecord[]> {
    const recordPath = path.join(
      this.sessionDirectory(scope),
      'copilot.jsonl',
    );
    const raw = await fs.readFile(recordPath, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    const latestByQuestion = new Map<string, MeetingCopilotRecord>();
    const lines = raw.split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let record: MeetingCopilotRecord;
      try {
        record = JSON.parse(line) as MeetingCopilotRecord;
      } catch (error) {
        const isInterruptedTail =
          index === lines.length - 1 && !raw.endsWith('\n');
        if (isInterruptedTail) continue;
        throw error;
      }
      if (!record.questionSegmentId || !record.result) continue;
      latestByQuestion.set(record.questionSegmentId, record);
    }
    return [...latestByQuestion.values()];
  }

  async updateTranscriptionStatus(
    scope: { organizationId: string; userId: string; sessionId: string },
    status: MeetingArchiveManifestV2['transcriptionStatus'],
    errorMessage = '',
  ): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      manifest.transcriptionStatus = status;
      manifest.transcriptionError = errorMessage;
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async updateTrackUploadState(
    scope: { organizationId: string; userId: string; sessionId: string },
    source: MeetingAudioSource,
    patch: Partial<
      Pick<
        MeetingArchiveTrackManifest,
        | 'storageStatus'
        | 'fileRecordId'
        | 'objectKey'
        | 'uploadError'
        | 'uploadAttempts'
        | 'lastUploadAttemptAt'
      >
    >,
  ): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      const track = manifest.tracks[source];
      Object.assign(track, patch);
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async deleteAudioFiles(scope: {
    organizationId: string;
    userId: string;
    sessionId: string;
  }): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      const sessionDirectory = this.sessionDirectory(scope);
      for (const source of ['local', 'remote'] as const) {
        const track = manifest.tracks[source];
        if (track.finalizedRelativePath) {
          await fs
            .unlink(path.join(sessionDirectory, track.finalizedRelativePath))
            .catch(() => undefined);
        }
        await fs
          .rm(path.join(sessionDirectory, source), {
            recursive: true,
            force: true,
          })
          .catch(() => undefined);
        track.storageStatus = 'deleted';
        track.fileRecordId = null;
        track.objectKey = '';
        track.uploadError = '';
        track.finalizedRelativePath = null;
        track.bytes = 0;
        track.contentHash = '';
      }
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async deleteArchive(scope: {
    organizationId: string;
    userId: string;
    sessionId: string;
  }): Promise<void> {
    await this.enqueueSessionWrite(scope.sessionId, async () => {
      await fs.rm(this.sessionDirectory(scope), { recursive: true, force: true });
    });
    this.finalTranscriptText.delete(scope.sessionId);
  }

  async updateCopilotEnabled(
    scope: { organizationId: string; userId: string; sessionId: string },
    enabled: boolean,
  ): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      manifest.copilotEnabled = enabled;
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async updateCaptureSource(
    scope: { organizationId: string; userId: string; sessionId: string },
    source: MeetingAudioSource,
    sourceId: string,
    label: string,
  ): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      if (source === 'local') {
        manifest.microphoneDeviceId = sourceId;
        manifest.microphoneDeviceLabel = label;
      } else {
        manifest.systemAudioSourceId = sourceId;
        manifest.systemAudioSourceLabel = label;
      }
      const track = manifest.tracks[source];
      if (manifest.lifecycleStatus === 'recording') track.status = 'active';
      delete track.errorCode;
      delete track.errorMessage;
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async markCaptureSourceUnavailable(
    scope: { organizationId: string; userId: string; sessionId: string },
    source: MeetingAudioSource,
    errorCode: string,
    errorMessage: string,
  ): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      const track = manifest.tracks[source];
      track.status = 'failed';
      track.errorCode = errorCode;
      track.errorMessage = errorMessage;
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async updateServerSyncStatus(
    scope: { organizationId: string; userId: string; sessionId: string },
    status: MeetingArchiveManifestV2['serverSyncStatus'],
    errorMessage = '',
  ): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      manifest.serverSyncStatus = status;
      manifest.serverSyncError = errorMessage;
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async updateLifecycle(
    scope: { organizationId: string; userId: string; sessionId: string },
    lifecycleStatus: MeetingArchiveLifecycleStatus,
  ): Promise<MeetingArchiveManifestV2> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      const now = this.now().toISOString();
      manifest.lifecycleStatus = lifecycleStatus;
      if (lifecycleStatus === 'recording' && manifest.startedAt === null) {
        manifest.startedAt = now;
      }
      if (lifecycleStatus === 'stopped' || lifecycleStatus === 'cancelled') {
        manifest.endedAt = now;
        manifest.copilotEnabled = false;
      }
      for (const track of Object.values(manifest.tracks)) {
        if (lifecycleStatus === 'recording') track.status = 'active';
        if (lifecycleStatus === 'stopped' && track.status !== 'failed') {
          track.status = track.bytes > 0 ? 'completed' : 'missing';
        }
        if (lifecycleStatus === 'interrupted' && track.status !== 'failed') {
          track.status = track.bytes > 0 ? 'interrupted' : 'missing';
        }
      }
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async recoverInterrupted(): Promise<MeetingArchiveManifestV2[]> {
    const recovered: MeetingArchiveManifestV2[] = [];
    const organizationDirectories = await fs
      .readdir(this.rootPath, {
        withFileTypes: true,
      })
      .catch(() => []);
    for (const organizationEntry of organizationDirectories) {
      if (!organizationEntry.isDirectory()) continue;
      const organizationId = organizationEntry.name;
      const userDirectories = await fs
        .readdir(path.join(this.rootPath, organizationId), {
          withFileTypes: true,
        })
        .catch(() => []);
      for (const userEntry of userDirectories) {
        if (!userEntry.isDirectory()) continue;
        const userId = userEntry.name;
        const sessionDirectories = await fs
          .readdir(path.join(this.rootPath, organizationId, userId), {
            withFileTypes: true,
          })
          .catch(() => []);
        for (const sessionEntry of sessionDirectories) {
          if (!sessionEntry.isDirectory()) continue;
          const scope = {
            organizationId,
            userId,
            sessionId: sessionEntry.name,
          };
          try {
            const manifest = await this.readManifest(scope);
            if (INTERRUPTIBLE_STATES.has(manifest.lifecycleStatus)) {
              recovered.push(await this.updateLifecycle(scope, 'interrupted'));
              continue;
            }
            if (
              manifest.lifecycleStatus === 'interrupted'
            ) {
              const hasRecoverableParts = (
                await Promise.all(
                  (['local', 'remote'] as const).map(async (source) => {
                    if (manifest.tracks[source].finalizedRelativePath) {
                      return false;
                    }
                    const names = await fs
                      .readdir(path.join(this.sessionDirectory(scope), source))
                      .catch(() => []);
                    return names.some((name) =>
                      /^\d{8}\.[a-z0-9]{1,12}\.part$/.test(name),
                    );
                  }),
                )
              ).some(Boolean);
              if (hasRecoverableParts) recovered.push(manifest);
            }
          } catch {
            // A corrupt directory is left untouched for diagnostics and manual recovery.
          }
        }
      }
    }
    return recovered;
  }

  async probeLocalStorage(): Promise<MeetingStorageProbeResult> {
    const probeDirectory = path.join(this.rootPath, '.probe');
    const sourcePath = path.join(probeDirectory, `${randomUUID()}.tmp`);
    const finalPath = `${sourcePath}.ok`;
    const payload = new TextEncoder().encode('tabtin-meeting-storage-probe');
    try {
      await durableWrite(sourcePath, payload);
      await fs.rename(sourcePath, finalPath);
      const readback = await fs.readFile(finalPath);
      if (!readback.equals(Buffer.from(payload))) {
        return {
          ok: false,
          rootPath: this.rootPath,
          availableBytes: null,
          errorCode: 'readback_failed',
          errorMessage: 'meeting storage readback did not match written bytes',
        };
      }
      const stats = await fs.statfs(this.rootPath).catch(() => null);
      return {
        ok: true,
        rootPath: this.rootPath,
        availableBytes: stats ? stats.bavail * stats.bsize : null,
      };
    } catch (error) {
      return {
        ok: false,
        rootPath: this.rootPath,
        availableBytes: null,
        errorCode: 'not_writable',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await Promise.allSettled([fs.unlink(sourcePath), fs.unlink(finalPath)]);
    }
  }
}
