import { describe, expect, it, vi } from 'vitest';

import type { OSSClient } from '@tabtin/oss-client';

import { MeetingAudioUploader, meetingTrackContextId } from './MeetingAudioUploader';

function clientMock(): OSSClient {
  return {
    presign: vi.fn(),
    confirm: vi.fn(),
    upload: vi.fn(),
    retryPendingConfirms: vi.fn(),
  };
}

describe('MeetingAudioUploader', () => {
  it('uploads a private meeting track with its exact session/source context', async () => {
    const client = clientMock();
    vi.mocked(client.presign).mockResolvedValue({
      objectKey: 'meeting/org/session/local.webm',
      presignedUrl: 'https://upload.invalid/local',
      accessUrl: '',
      cdnUrl: '',
      contentType: 'audio/webm',
      expiresIn: 600,
    });
    vi.mocked(client.confirm).mockResolvedValue({
      fileId: 'file-1',
      fileName: 'local.webm',
      fileKey: 'meeting/org/session/local.webm',
      fileSize: 4,
      accessUrl: 'https://read.invalid/local',
      cdnUrl: '',
    });
    const onPresigned = vi.fn().mockResolvedValue(undefined);
    const onPutCompleted = vi.fn().mockResolvedValue(undefined);
    const uploader = new MeetingAudioUploader({
      client,
      fetch: vi.fn().mockResolvedValue(new Response('', { status: 200 })),
      openFileAsBlob: vi.fn().mockResolvedValue(new Blob(['test'], { type: 'audio/webm' })),
      maxRetries: 0,
    });

    const result = await uploader.uploadTrack({
      sessionId: 'session',
      organizationId: 'org',
      source: 'local',
      filePath: '/tmp/local.webm',
      fileName: 'local.webm',
      fileSize: 4,
      contentType: 'audio/webm',
      fileHash: 'abc',
      onPresigned,
      onPutCompleted,
    });

    expect(result.fileId).toBe('file-1');
    expect(client.presign).toHaveBeenCalledWith(
      'local.webm',
      4,
      'audio/webm',
      expect.objectContaining({
        module: 'meeting',
        contextType: 'meeting_track',
        contextId: 'session:local',
        isPublic: false,
        hashAlgorithm: 'sha256',
      }),
    );
    expect(client.confirm).toHaveBeenCalledWith(
      'meeting/org/session/local.webm',
      'local.webm',
      4,
      'audio/webm',
      expect.objectContaining({
        contextId: 'session:local',
        isPublic: false,
      }),
    );
    expect(onPresigned).toHaveBeenCalledBefore(onPutCompleted);
  });

  it('returns an instant private hit without opening or uploading the file', async () => {
    const client = clientMock();
    vi.mocked(client.presign).mockResolvedValue({
      objectKey: 'existing.webm',
      presignedUrl: '',
      accessUrl: '',
      cdnUrl: '',
      contentType: 'audio/webm',
      expiresIn: 0,
      instant: true,
      instantResult: {
        fileId: 'file-existing',
        fileName: 'remote.webm',
        fileKey: 'existing.webm',
        fileSize: 4,
        accessUrl: 'https://read.invalid/existing',
        cdnUrl: '',
        instant: true,
      },
    });
    const fetchImpl = vi.fn();
    const openFileAsBlob = vi.fn();
    const uploader = new MeetingAudioUploader({
      client,
      fetch: fetchImpl,
      openFileAsBlob,
      maxRetries: 0,
    });

    const result = await uploader.uploadTrack({
      sessionId: 'session',
      organizationId: 'org',
      source: 'remote',
      filePath: '/tmp/remote.webm',
      fileName: 'remote.webm',
      fileSize: 4,
      contentType: 'audio/webm',
    });

    expect(result.fileId).toBe('file-existing');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(openFileAsBlob).not.toHaveBeenCalled();
    expect(client.confirm).not.toHaveBeenCalled();
  });

  it('rejects a file that changed after finalization', async () => {
    const client = clientMock();
    vi.mocked(client.presign).mockResolvedValue({
      objectKey: 'new.webm',
      presignedUrl: 'https://upload.invalid/new',
      accessUrl: '',
      cdnUrl: '',
      contentType: 'audio/webm',
      expiresIn: 600,
    });
    const fetchImpl = vi.fn();
    const uploader = new MeetingAudioUploader({
      client,
      fetch: fetchImpl,
      openFileAsBlob: vi.fn().mockResolvedValue(new Blob(['changed'])),
      maxRetries: 0,
    });

    await expect(
      uploader.uploadTrack({
        sessionId: 'session',
        organizationId: 'org',
        source: 'local',
        filePath: '/tmp/local.webm',
        fileName: 'local.webm',
        fileSize: 4,
        contentType: 'audio/webm',
      }),
    ).rejects.toThrow('file size changed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses a stable context id', () => {
    expect(meetingTrackContextId('session-id', 'remote')).toBe('session-id:remote');
  });
});
