import { openAsBlob } from 'node:fs';

import {
  createOSSClient,
  withRetry,
  type OSSClient,
  type UploadResult,
} from '@muse/oss-client';

import { TokenManager } from '../auth.js';
import { API_BASE_URL } from '../config/api.js';

export type MeetingAudioUploadSource = 'local' | 'remote';

export interface MeetingAudioUploadInput {
  sessionId: string;
  organizationId: string;
  source: MeetingAudioUploadSource;
  filePath: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  fileHash?: string;
  signal?: AbortSignal;
  onPresigned?: (objectKey: string) => Promise<void>;
  onPutCompleted?: (objectKey: string) => Promise<void>;
}

export interface MeetingAudioConfirmInput {
  sessionId: string;
  organizationId: string;
  source: MeetingAudioUploadSource;
  objectKey: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  fileHash?: string;
  signal?: AbortSignal;
}

export interface MeetingAudioUploaderOptions {
  client?: OSSClient;
  fetch?: typeof fetch;
  openFileAsBlob?: typeof openAsBlob;
  maxRetries?: number;
}

function meetingTrackContextId(
  sessionId: string,
  source: MeetingAudioUploadSource,
): string {
  return `${sessionId}:${source}`;
}

export class MeetingAudioUploader {
  private readonly client: OSSClient;
  private readonly fetchImpl: typeof fetch;
  private readonly openFileAsBlob: typeof openAsBlob;
  private readonly maxRetries: number;

  constructor(options: MeetingAudioUploaderOptions = {}) {
    this.client =
      options.client ??
      createOSSClient({
        apiBaseUrl: API_BASE_URL,
        getToken: async () => {
          const token = await TokenManager.getAccessToken();
          if (!token) throw new Error('meeting audio upload is waiting for authentication');
          return token;
        },
      });
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.openFileAsBlob = options.openFileAsBlob ?? openAsBlob;
    this.maxRetries = Math.max(0, options.maxRetries ?? 1);
  }

  async uploadTrack(input: MeetingAudioUploadInput): Promise<UploadResult> {
    const contextId = meetingTrackContextId(input.sessionId, input.source);
    const presigned = await withRetry(
      () =>
        this.client.presign(input.fileName, input.fileSize, input.contentType, {
          folder: `meeting/${input.organizationId}/${input.sessionId}`,
          organizationId: input.organizationId,
          module: 'meeting',
          contextType: 'meeting_track',
          contextId,
          isPublic: false,
          fileHash: input.fileHash,
          hashAlgorithm: input.fileHash ? 'sha256' : undefined,
          signal: input.signal,
        }),
      this.maxRetries,
      input.signal,
    );

    if (presigned.instant && presigned.instantResult) {
      return presigned.instantResult;
    }

    await input.onPresigned?.(presigned.objectKey);
    const blob = await this.openFileAsBlob(input.filePath, {
      type: presigned.contentType || input.contentType,
    });
    if (blob.size !== input.fileSize) {
      throw new Error(
        `meeting audio file size changed before upload: expected=${input.fileSize} actual=${blob.size}`,
      );
    }

    await withRetry(
      async () => {
        const response = await this.fetchImpl(presigned.presignedUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': presigned.contentType || input.contentType,
          },
          body: blob,
          signal: input.signal,
        });
        if (!response.ok) {
          throw new Error(`meeting audio PUT failed with HTTP ${response.status}`);
        }
      },
      this.maxRetries,
      input.signal,
    );
    await input.onPutCompleted?.(presigned.objectKey);

    return this.confirmTrack({
      ...input,
      objectKey: presigned.objectKey,
    });
  }

  async confirmTrack(input: MeetingAudioConfirmInput): Promise<UploadResult> {
    return withRetry(
      () =>
        this.client.confirm(
          input.objectKey,
          input.fileName,
          input.fileSize,
          input.contentType,
          {
            organizationId: input.organizationId,
            module: 'meeting',
            contextType: 'meeting_track',
            contextId: meetingTrackContextId(input.sessionId, input.source),
            isPublic: false,
            fileHash: input.fileHash,
            hashAlgorithm: input.fileHash ? 'sha256' : undefined,
            signal: input.signal,
          },
        ),
      this.maxRetries,
      input.signal,
    );
  }
}

export { meetingTrackContextId };
