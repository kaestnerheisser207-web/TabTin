import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getUserDataPath } from '@tabtin/shared';

import {
  MEETING_ARCHIVE_SCHEMA_VERSION,
  type AppendMeetingAudioChunkInput,
  type MeetingArchiveLifecycleStatus,
  type MeetingArchiveManifestV1,
  type MeetingArchiveTrackManifest,
  type MeetingAudioSource,
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
  };
}

function parseManifest(raw: string): MeetingArchiveManifestV1 {
  const parsed = JSON.parse(raw) as Partial<MeetingArchiveManifestV1>;
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
  return parsed as MeetingArchiveManifestV1;
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
  ): Promise<MeetingArchiveManifestV1> {
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
      const manifest: MeetingArchiveManifestV1 = {
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
  }): Promise<MeetingArchiveManifestV1> {
    return parseManifest(await fs.readFile(this.manifestPath(scope), 'utf8'));
  }

  async listManifests(scope: {
    organizationId: string;
    userId: string;
  }): Promise<MeetingArchiveManifestV1[]> {
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
      .filter((manifest): manifest is MeetingArchiveManifestV1 =>
        Boolean(manifest),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
    manifest: MeetingArchiveManifestV1;
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
  }): Promise<MeetingArchiveManifestV1> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      const sessionDirectory = this.sessionDirectory(scope);

      for (const source of ['local', 'remote'] as const) {
        const track = manifest.tracks[source];
        if (!track.container || track.bytes === 0) continue;
        const trackDirectory = path.join(sessionDirectory, source);
        const partNames = (await fs.readdir(trackDirectory))
          .filter((name) => name.endsWith(`.${track.container}.part`))
          .sort();
        if (partNames.length === 0) {
          throw new Error(`meeting ${source} track has no recoverable parts`);
        }

        const finalName = `${source}.${track.container}`;
        const finalPath = path.join(sessionDirectory, finalName);
        const combinedPath = `${finalPath}.${randomUUID()}.combined`;
        const finalizedPath = `${finalPath}.${randomUUID()}.finalized`;
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

        try {
          if (writtenBytes !== track.bytes) {
            throw new Error(
              `meeting ${source} track byte count mismatch: expected=${track.bytes} actual=${writtenBytes}`,
            );
          }
          await this.finalizeMediaFile(
            combinedPath,
            finalizedPath,
            track.container,
          );
          const finalizedStat = await fs.stat(finalizedPath);
          if (finalizedStat.size === 0) {
            throw new Error(`meeting ${source} finalized track is empty`);
          }
          await fs.rename(finalizedPath, finalPath);
        } finally {
          await Promise.allSettled([
            fs.unlink(combinedPath),
            fs.unlink(finalizedPath),
          ]);
        }
        track.finalizedRelativePath = finalName;
        track.bytes = (await fs.stat(finalPath)).size;
        track.contentHash = await hashFile(finalPath);
      }

      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async appendTranscriptCheckpoint(
    scope: { organizationId: string; userId: string; sessionId: string },
    checkpoint: MeetingTranscriptCheckpoint,
  ): Promise<MeetingArchiveManifestV1> {
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

  async updateTranscriptionStatus(
    scope: { organizationId: string; userId: string; sessionId: string },
    status: MeetingArchiveManifestV1['transcriptionStatus'],
    errorMessage = '',
  ): Promise<MeetingArchiveManifestV1> {
    return this.enqueueSessionWrite(scope.sessionId, async () => {
      const manifestPath = this.manifestPath(scope);
      const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
      manifest.transcriptionStatus = status;
      manifest.transcriptionError = errorMessage;
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async updateCopilotEnabled(
    scope: { organizationId: string; userId: string; sessionId: string },
    enabled: boolean,
  ): Promise<MeetingArchiveManifestV1> {
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
  ): Promise<MeetingArchiveManifestV1> {
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
      await atomicWriteJson(manifestPath, manifest);
      return manifest;
    });
  }

  async updateServerSyncStatus(
    scope: { organizationId: string; userId: string; sessionId: string },
    status: MeetingArchiveManifestV1['serverSyncStatus'],
    errorMessage = '',
  ): Promise<MeetingArchiveManifestV1> {
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
  ): Promise<MeetingArchiveManifestV1> {
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

  async recoverInterrupted(): Promise<MeetingArchiveManifestV1[]> {
    const recovered: MeetingArchiveManifestV1[] = [];
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
            if (!INTERRUPTIBLE_STATES.has(manifest.lifecycleStatus)) continue;
            recovered.push(await this.updateLifecycle(scope, 'interrupted'));
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
