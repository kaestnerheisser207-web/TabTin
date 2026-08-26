import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMeetingReadiness } from './useMeetingReadiness';

describe('useMeetingReadiness privacy boundary', () => {
  const probeStorage = vi.fn().mockResolvedValue({
    ok: true,
    rootPath: '/tmp/meeting',
    availableBytes: 1024,
  });
  const listMicrophones = vi.fn().mockResolvedValue([
    {
      deviceId: 'default',
      groupId: 'group-1',
      label: 'Default microphone',
      isDefault: true,
    },
  ]);
  const probeMedia = vi.fn().mockResolvedValue({
    local: { available: true, deviceLabel: 'Default microphone' },
    remote: { available: true, deviceLabel: 'System audio' },
    microphones: [],
  });
  const probeAsr = vi.fn().mockResolvedValue({
    ready: true,
    provider: 'byteplus',
    resourceId: 'volc.seedasr.sauc.duration',
    wsEndpoint: 'bigmodel_async',
  });
  const previousTabtin = window.tabtin;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        meetingRecording: {
          probeStorage,
          listMicrophones,
          probeMedia,
          probeAsr,
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: previousTabtin,
    });
  });

  it('enumerates devices and storage on mount without opening audio capture', async () => {
    const { result } = renderHook(() => useMeetingReadiness('default'));

    await waitFor(() =>
      expect(result.current.snapshot.localStorage).toBe('ready'),
    );
    expect(probeStorage).toHaveBeenCalledTimes(1);
    expect(probeMedia).not.toHaveBeenCalled();
    expect(result.current.snapshot).toMatchObject({
      microphone: 'idle',
      systemAudio: 'idle',
      localStorage: 'ready',
      realtimeTranscript: 'ready',
      realtimeTranscriptDetail: 'byteplus · bigmodel_async',
      microphones: [expect.objectContaining({ deviceId: 'default' })],
    });
  });

  it('opens media only after an explicit readiness refresh', async () => {
    const { result } = renderHook(() => useMeetingReadiness('default'));
    await waitFor(() => expect(listMicrophones).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh('mic-2');
    });

    expect(probeMedia).toHaveBeenCalledWith({ microphoneDeviceId: 'mic-2' });
    expect(probeAsr).toHaveBeenCalledWith({ organizationId: undefined });
    expect(result.current.snapshot).toMatchObject({
      microphone: 'ready',
      systemAudio: 'ready',
    });
  });

  it('shows ASR configuration failure without marking local media unavailable', async () => {
    probeAsr.mockResolvedValueOnce({
      ready: false,
      provider: 'byteplus',
      reason: 'not_configured',
      message: '语音识别服务未配置，请联系管理员',
    });

    const { result } = renderHook(() =>
      useMeetingReadiness('default', 'organization-1'),
    );

    await waitFor(() =>
      expect(result.current.snapshot.realtimeTranscript).toBe('failed'),
    );
    expect(result.current.snapshot).toMatchObject({
      microphone: 'idle',
      systemAudio: 'idle',
      localStorage: 'ready',
      realtimeTranscriptDetail: '语音识别服务未配置，请联系管理员',
    });
    expect(probeAsr).toHaveBeenCalledWith({
      organizationId: 'organization-1',
    });
  });

  it('keeps a gateway timeout in connecting state and retries automatically', async () => {
    vi.useFakeTimers();
    probeAsr
      .mockResolvedValueOnce({
        ready: false,
        provider: 'byteplus',
        reason: 'gateway_error',
        message: 'request timeout',
      })
      .mockResolvedValueOnce({
        ready: true,
        provider: 'byteplus',
        wsEndpoint: 'bigmodel_async',
      });

    const { result } = renderHook(() =>
      useMeetingReadiness('default', 'organization-1'),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.snapshot).toMatchObject({
      realtimeTranscript: 'checking',
      realtimeTranscriptDetail: 'request timeout',
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      await Promise.resolve();
    });
    expect(result.current.snapshot).toMatchObject({
      realtimeTranscript: 'ready',
      realtimeTranscriptDetail: 'byteplus · bigmodel_async',
    });
  });

  it('checks system audio without requesting the microphone', async () => {
    const { result } = renderHook(() => useMeetingReadiness('default'));
    await waitFor(() => expect(listMicrophones).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.checkSystemAudio();
    });

    expect(probeMedia).toHaveBeenCalledWith({ sources: ['remote'] });
    expect(result.current.snapshot.systemAudio).toBe('ready');
    expect(result.current.snapshot.microphone).toBe('idle');
  });

  it('uses the explicit microphone test result as readiness evidence', async () => {
    const { result } = renderHook(() => useMeetingReadiness('default'));
    await waitFor(() => expect(listMicrophones).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.applyMicrophoneTestResult({
        available: true,
        deviceId: 'default',
        deviceLabel: 'Default microphone',
        measuredFrames: 80,
        nonSilentFrames: 50,
        maxRms: 0.122,
      });
    });

    expect(result.current.snapshot).toMatchObject({
      microphone: 'ready',
      microphoneDetail: 'Default microphone',
    });
  });
});
