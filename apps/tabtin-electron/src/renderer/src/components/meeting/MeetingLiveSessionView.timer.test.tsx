import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MeetingCaptureDevicesChangedEvent,
  MeetingCaptureSourceNoticeEvent,
  MeetingRecordingStatus,
  MeetingTranscriptCheckpoint,
  MeetingTranscriptChangedEvent,
} from '@shared/meeting-recording-contract';

const logDebug = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());

vi.mock('@/utils/logger', () => ({
  logger: {
    log: vi.fn(),
    debug: vi.fn(),
    info: logInfo,
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    log: vi.fn(),
    debug: logDebug,
    info: logInfo,
    warn: vi.fn(),
    error: vi.fn(),
  }),
  perf: { start: vi.fn(), end: vi.fn() },
}));

vi.mock('react-i18next', async () => {
  const translations = (await import('@/i18n/locales/zh-CN/meeting.json'))
    .default as Record<string, unknown>;
  const readTranslation = (
    key: string,
    params?: Record<string, unknown>,
  ): string => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (current, segment) =>
          current && typeof current === 'object'
            ? (current as Record<string, unknown>)[segment]
            : undefined,
        translations,
      );
    if (typeof value !== 'string') return key;
    return Object.entries(params ?? {}).reduce(
      (text, [name, replacement]) =>
        text.replace(`{{${name}}}`, String(replacement)),
      value,
    );
  };
  return { useTranslation: () => ({ t: readTranslation }) };
});

import { MeetingLiveSessionView } from './MeetingLiveSessionView';

describe('MeetingLiveSessionView timer', () => {
  const previousTabtin = window.tabtin;
  const sessionId = '11111111-1111-4111-8111-111111111111';
  let captureLevelListener:
    | ((event: {
        sessionId: string;
        organizationId: string;
        userId: string;
        source: 'local' | 'remote';
        rms: number;
      }) => void)
    | undefined;
  let statusListener: ((status: MeetingRecordingStatus) => void) | undefined;
  let transcriptListener:
    | ((event: MeetingTranscriptChangedEvent) => void)
    | undefined;
  let captureDevicesChangedListener:
    | ((event: MeetingCaptureDevicesChangedEvent) => void)
    | undefined;
  let captureSourceNoticeListener:
    | ((event: MeetingCaptureSourceNoticeEvent) => void)
    | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    logDebug.mockReset();
    logInfo.mockReset();
    captureLevelListener = undefined;
    statusListener = undefined;
    transcriptListener = undefined;
    captureDevicesChangedListener = undefined;
    captureSourceNoticeListener = undefined;
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        meetingRecording: {
          getStatus: vi.fn().mockResolvedValue({
            active: true,
            manifest: {
              sessionId,
              organizationId: 'org-1',
              userId: 'user-1',
              title: 'Timer test',
              durationMs: 0,
              lifecycleStatus: 'recording',
              copilotEnabled: false,
              microphoneDeviceId: 'default',
              microphoneDeviceLabel: 'Default microphone',
              systemAudioSourceId: 'main-display',
              systemAudioSourceLabel: 'System audio (main display)',
              transcriptRevision: 0,
              transcriptionStatus: 'active',
              transcriptionError: '',
              tracks: {
                local: { status: 'active', bytes: 1, sampleRate: 48_000 },
                remote: { status: 'active', bytes: 1, sampleRate: 48_000 },
              },
            },
          }),
          onStatusChanged: vi.fn((listener) => {
            statusListener = listener;
            return vi.fn();
          }),
          onTranscriptChanged: vi.fn((listener) => {
            transcriptListener = listener;
            return vi.fn();
          }),
          onCaptureLevel: vi.fn((listener) => {
            captureLevelListener = listener;
            return vi.fn();
          }),
          onCaptureDevicesChanged: vi.fn((listener) => {
            captureDevicesChangedListener = listener;
            return vi.fn();
          }),
          onCaptureSourceNotice: vi.fn((listener) => {
            captureSourceNoticeListener = listener;
            return vi.fn();
          }),
          getArchive: vi.fn().mockResolvedValue({ transcript: [] }),
          listMicrophones: vi.fn().mockResolvedValue([]),
          listSystemAudioSources: vi.fn().mockResolvedValue([]),
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

  it('advances the visible duration every second between five-second checkpoints', async () => {
    render(<MeetingLiveSessionView sessionId={sessionId} onBack={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/00:00:00/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(/00:00:01/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(/00:00:02/)).toBeTruthy();
  });

  it('distinguishes an active empty transcript from a connecting ASR stream', async () => {
    const activeStatus = await window.tabtin.meetingRecording.getStatus();
    const { unmount } = render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={activeStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('等待会议内容…')).toBeTruthy();
    unmount();

    const connectingStatus = {
      ...activeStatus,
      manifest: {
        ...activeStatus.manifest!,
        transcriptionStatus: 'connecting' as const,
      },
    };
    vi.mocked(window.tabtin.meetingRecording.getStatus).mockResolvedValueOnce(
      connectingStatus,
    );
    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={connectingStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('实时转写尚未连接；原始音频继续保存')).toBeTruthy();
  });

  it('applies live transcript increments without reloading the full archive', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    let resolveArchive!: (archive: {
      transcript: MeetingTranscriptCheckpoint[];
      copilotRecords: [];
    }) => void;
    const getArchive = vi.fn(
      () =>
        new Promise<{
          transcript: MeetingTranscriptCheckpoint[];
          copilotRecords: [];
        }>((resolve) => {
          resolveArchive = resolve;
        }),
    );
    Object.assign(window.tabtin.meetingRecording, { getArchive });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const scope = {
      sessionId,
      organizationId: 'org-1',
      userId: 'user-1',
    };
    act(() => {
      statusListener?.({
        ...initialStatus,
        manifest: { ...initialStatus.manifest!, transcriptRevision: 1 },
      });
      transcriptListener?.({
        ...scope,
        checkpoint: {
          externalId: 'live-1',
          source: 'remote',
          startMs: 1_000,
          endMs: 1_500,
          text: '第一段实时逐字稿',
          isFinal: false,
          recordedAt: '2026-08-28T00:00:00.000Z',
        },
      });
      statusListener?.({
        ...initialStatus,
        manifest: { ...initialStatus.manifest!, transcriptRevision: 2 },
      });
      transcriptListener?.({
        ...scope,
        checkpoint: {
          externalId: 'live-1',
          source: 'remote',
          startMs: 1_000,
          endMs: 2_000,
          text: '第一段实时逐字稿已经完成',
          isFinal: true,
          recordedAt: '2026-08-28T00:00:01.000Z',
        },
      });
    });

    await act(async () => {
      resolveArchive({
        transcript: [
          {
            externalId: 'live-1',
            source: 'remote',
            startMs: 1_000,
            endMs: 1_200,
            text: '归档中的旧版本',
            isFinal: false,
            recordedAt: '2026-08-28T00:00:00.000Z',
          },
        ],
        copilotRecords: [],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      transcriptListener?.({
        ...scope,
        checkpoint: {
          externalId: 'live-1',
          source: 'remote',
          startMs: 1_000,
          endMs: 1_600,
          text: '迟到的非最终版本',
          isFinal: false,
          recordedAt: '2026-08-28T00:00:02.000Z',
        },
      });
    });

    expect(screen.getAllByText('第一段实时逐字稿已经完成')).toHaveLength(1);
    expect(screen.queryByText('归档中的旧版本')).toBeNull();
    expect(screen.queryByText('迟到的非最终版本')).toBeNull();
    expect(getArchive).toHaveBeenCalledTimes(1);
  });

  it('trusts the bridge switch deadline and hides raw IPC failures', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    const rawError =
      "Error invoking remote method 'meeting-recording:switch-microphone': capture timed out";
    let rejectSwitch!: (error: Error) => void;
    const switchMicrophone = vi.fn(
      () =>
        new Promise<MeetingRecordingStatus>((_, reject) => {
          rejectSwitch = reject;
        }),
    );
    Object.assign(window.tabtin.meetingRecording, {
      listMicrophones: vi.fn().mockResolvedValue([
        {
          deviceId: 'default',
          groupId: '',
          label: 'Default microphone',
          isDefault: true,
        },
        {
          deviceId: 'usb-microphone',
          groupId: 'usb',
          label: 'USB microphone',
          isDefault: false,
        },
      ]),
      switchMicrophone,
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.pointerDown(screen.getByRole('button', { name: '切换麦克风' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: 'USB microphone' }),
    );
    expect(switchMicrophone).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(15_000));
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      rejectSwitch(new Error(rawError));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('alert').textContent).toBe(
      '切换麦克风失败，原麦克风仍在使用',
    );
    expect(screen.queryByText(rawError)).toBeNull();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
  });

  it('refreshes device choices and reports scoped fallback outcomes without switching', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    const listMicrophones = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary device enumeration failure'))
      .mockResolvedValue([]);
    const listSystemAudioSources = vi.fn().mockResolvedValue([]);
    const switchMicrophone = vi.fn();
    const switchSystemAudio = vi.fn();
    Object.assign(window.tabtin.meetingRecording, {
      listMicrophones,
      listSystemAudioSources,
      switchMicrophone,
      switchSystemAudio,
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listMicrophones).toHaveBeenCalledTimes(1);
    expect(listSystemAudioSources).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toBe(
      '无法加载音频来源，当前音频来源仍在继续记录',
    );

    await act(async () => {
      captureDevicesChangedListener?.({
        changedAt: '2026-08-28T00:00:00.000Z',
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listMicrophones).toHaveBeenCalledTimes(2);
    expect(listSystemAudioSources).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText('无法加载音频来源，当前音频来源仍在继续记录'),
    ).toBeNull();
    expect(switchMicrophone).not.toHaveBeenCalled();
    expect(switchSystemAudio).not.toHaveBeenCalled();

    act(() => {
      captureSourceNoticeListener?.({
        sessionId: 'other-session',
        organizationId: 'org-1',
        userId: 'user-1',
        source: 'local',
        kind: 'fallback_failed',
        previousLabel: 'USB microphone',
      });
    });
    expect(screen.queryByText(/麦克风不可用/)).toBeNull();

    act(() => {
      captureSourceNoticeListener?.({
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
        source: 'local',
        kind: 'fallback_succeeded',
        previousLabel: 'USB microphone',
        currentLabel: 'MacBook microphone',
      });
    });
    expect(screen.getByRole('status').textContent).toBe(
      '麦克风已断开，已切换到 MacBook microphone',
    );

    act(() => {
      captureSourceNoticeListener?.({
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
        source: 'local',
        kind: 'fallback_failed',
        previousLabel: 'MacBook microphone',
      });
    });
    expect(screen.getByRole('alert').textContent).toBe(
      '麦克风不可用，系统音频和录音仍在继续',
    );
  });

  it('keeps source switching and stop enabled from the parent-confirmed active status', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    const stop = vi.fn().mockResolvedValue(initialStatus);
    Object.assign(window.tabtin.meetingRecording, { stop });
    const onBack = vi.fn();
    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={onBack}
        initialStatus={initialStatus}
      />,
    );

    expect(screen.queryByRole('button', { name: '暂停' })).toBeNull();
    expect(
      screen.getByRole('button', { name: '结束记录' }).hasAttribute('disabled'),
    ).toBe(false);
    expect(
      screen
        .getByRole('button', { name: '切换麦克风' })
        .hasAttribute('disabled'),
    ).toBe(false);
    expect(
      screen
        .getByRole('button', { name: '切换系统音频来源' })
        .hasAttribute('disabled'),
    ).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '结束记录' }));
      await Promise.resolve();
    });
    expect(stop).not.toHaveBeenCalled();
    expect(screen.getByText('要结束这条会议记录吗？')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认结束' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalledWith({
      sessionId,
      organizationId: 'org-1',
      userId: 'user-1',
    });
    expect(onBack).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('shows archive-saving progress until stopping finishes', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    let resolveStop!: (status: typeof initialStatus) => void;
    const stop = vi.fn(
      () =>
        new Promise<typeof initialStatus>((resolve) => {
          resolveStop = resolve;
        }),
    );
    Object.assign(window.tabtin.meetingRecording, { stop });
    const onBack = vi.fn();
    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={onBack}
        initialStatus={initialStatus}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '结束记录' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认结束' }));
      await Promise.resolve();
    });

    expect(screen.getByText('正在保存音频、逐字稿和恢复点…')).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled();

    await act(async () => {
      resolveStop(initialStatus);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('drives microphone and system audio glyphs from real capture levels', async () => {
    render(<MeetingLiveSessionView sessionId={sessionId} onBack={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const microphoneLevel = screen.getByTestId('meeting-audio-level-local');
    const systemLevel = screen.getByTestId('meeting-audio-level-remote');
    expect(microphoneLevel.getAttribute('data-rms')).toBe('0.000');
    expect(systemLevel.getAttribute('data-rms')).toBe('0.000');
    expect(systemLevel.querySelector('svg')?.getAttribute('class')).toContain(
      'lucide-volume-2',
    );

    act(() => {
      captureLevelListener?.({
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
        source: 'local',
        rms: 0.125,
      });
      captureLevelListener?.({
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
        source: 'remote',
        rms: 0.25,
      });
    });
    expect(microphoneLevel.getAttribute('data-rms')).toBe('0.125');
    expect(systemLevel.getAttribute('data-rms')).toBe('0.250');

    act(() => vi.advanceTimersByTime(450));
    expect(microphoneLevel.getAttribute('data-rms')).toBe('0.000');
    expect(systemLevel.getAttribute('data-rms')).toBe('0.000');
  });

  it('automatically asks AI to interpret a declarative question without regex gating', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const getArchive = vi.fn().mockResolvedValue({
      transcript: [
        {
          externalId: 'remote-question-1',
          source: 'remote',
          startMs: 1_000,
          endMs: 2_000,
          text: 'Hash map implementation principles.',
          isFinal: true,
          recordedAt: '2026-08-26T00:00:00.000Z',
        },
      ],
    });
    const answerCopilotQuestion = vi.fn().mockResolvedValue({
      status: 'answered',
      question: 'Hash map implementation principles.',
      question_segment_id: 'remote-question-1',
      answer: '需要先核对项目计划，再确认是否承诺下周五交付。',
      key_points: ['不要承诺未经确认的日期'],
      sources: [
        {
          id: 'meeting:brief',
          kind: 'meeting_brief',
          title: '会前 Brief',
          excerpt: '日期需要核实',
          resource_type: '',
          resource_id: '',
        },
      ],
      reliability: 'medium',
      warning: '当前没有可用的 Project 资料。',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      latency_ms: 420,
    });
    Object.assign(window.tabtin.meetingRecording, {
      getArchive,
      answerCopilotQuestion,
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getAllByText('Hash map implementation principles.'),
    ).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(answerCopilotQuestion).toHaveBeenCalledWith(
      {
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
      },
      'remote-question-1',
    );
    expect(
      screen.getByText('需要先核对项目计划，再确认是否承诺下周五交付。'),
    ).toBeTruthy();
    expect(screen.getByText('可靠性：中')).toBeTruthy();
    expect(screen.getByText('会前 Brief')).toBeTruthy();
  });

  it('sends a local statement to the model and accepts no_action', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const answerCopilotQuestion = vi.fn().mockResolvedValue({
      status: 'no_action',
      message: 'No answer needed.',
      candidate_segment_id: 'local-answer-1',
    });
    Object.assign(window.tabtin.meetingRecording, {
      getArchive: vi.fn().mockResolvedValue({
        transcript: [
          {
            externalId: 'local-answer-1',
            source: 'local',
            startMs: 1_000,
            endMs: 2_000,
            text: '哈希表通过哈希函数把键映射到桶。',
            isFinal: true,
            recordedAt: '2026-08-27T00:00:00.000Z',
          },
        ],
        copilotRecords: [],
      }),
      answerCopilotQuestion,
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(answerCopilotQuestion).toHaveBeenCalledWith(
      {
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
      },
      'local-answer-1',
    );
    expect(logInfo).toHaveBeenCalledWith(
      'copilot_latency',
      expect.objectContaining({
        externalId: 'local-answer-1',
        source: 'local',
        trigger: 'auto',
        status: 'no_action',
        finalToRequestStartMs: expect.any(Number),
        requestDurationMs: expect.any(Number),
        finalToResultUiMs: expect.any(Number),
      }),
    );
    const latencyPayload = logInfo.mock.calls.find(
      ([event]) => event === 'copilot_latency',
    )?.[1] as Record<string, unknown>;
    expect(latencyPayload).not.toHaveProperty('text');
  });

  it('automatically submits a clear local question', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const answerCopilotQuestion = vi.fn().mockResolvedValue({
      status: 'answered',
      question: '这个接口为什么会超时？',
      question_segment_id: 'local-question-1',
      answer: '先检查设备切换事务是否阻塞。',
      key_points: [],
      sources: [],
      reliability: 'medium',
      warning: '',
      model: 'test-model',
      provider: 'test-provider',
      latency_ms: 10,
    });
    Object.assign(window.tabtin.meetingRecording, {
      getArchive: vi.fn().mockResolvedValue({
        transcript: [
          {
            externalId: 'local-question-1',
            source: 'local',
            startMs: 1_000,
            endMs: 2_000,
            text: '这个接口为什么会超时？',
            isFinal: true,
            recordedAt: '2026-08-27T00:00:00.000Z',
          },
        ],
        copilotRecords: [],
      }),
      answerCopilotQuestion,
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(answerCopilotQuestion).toHaveBeenCalledWith(
      {
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
      },
      'local-question-1',
    );
  });

  it('restores clarification history without requesting the candidate again', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const shortTurn = {
      externalId: 'clarify-local-1',
      source: 'local' as const,
      startMs: 1_000,
      endMs: 2_000,
      text: '它为什么',
      isFinal: true,
      recordedAt: '2026-08-27T00:00:01.000Z',
    };
    const turn = {
      ...shortTurn,
      externalId: 'clarify-local-2',
      startMs: 1_100,
      endMs: 2_500,
      text: '它为什么这么慢？',
      recordedAt: '2026-08-27T00:00:02.000Z',
    };
    const clarification = {
      status: 'needs_clarification' as const,
      question: turn.text,
      question_segment_id: turn.externalId,
      clarifying_question: '你指的是转写延迟还是回答延迟？',
      reason_code: 'ambiguous_reference',
      model: 'test-model',
      provider: 'test-provider',
      latency_ms: 10,
    };
    const answerCopilotQuestion = vi.fn().mockResolvedValue(clarification);
    const getArchive = vi.fn().mockResolvedValue({
      transcript: [shortTurn, turn],
      copilotRecords: [],
    });
    Object.assign(window.tabtin.meetingRecording, {
      getArchive,
      answerCopilotQuestion,
    });

    const first = render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getAllByText('你指的是转写延迟还是回答延迟？').length,
    ).toBeGreaterThan(0);
    expect(answerCopilotQuestion).toHaveBeenCalledWith(
      {
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
      },
      'clarify-local-2',
    );
    first.unmount();
    answerCopilotQuestion.mockClear();
    getArchive.mockResolvedValue({
      transcript: [shortTurn, turn],
      copilotRecords: [
        {
          questionSegmentId: turn.externalId,
          evaluatedAt: '2026-08-27T00:00:02.000Z',
          result: clarification,
        },
      ],
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(answerCopilotQuestion).not.toHaveBeenCalled();
    expect(
      screen.getAllByText('你指的是转写延迟还是回答延迟？').length,
    ).toBeGreaterThan(0);
  });

  it('submits the latest final turn when analyze now is clicked', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const answerCopilotQuestion = vi.fn().mockResolvedValue({
      status: 'no_action',
      message: 'No answer needed.',
      candidate_segment_id: 'local-manual-1',
    });
    Object.assign(window.tabtin.meetingRecording, {
      getArchive: vi.fn().mockResolvedValue({
        transcript: [
          {
            externalId: 'local-manual-1',
            source: 'local',
            startMs: 1_000,
            endMs: 2_000,
            text: '先继续记录。',
            isFinal: true,
            recordedAt: '2026-08-27T00:00:00.000Z',
          },
          {
            externalId: 'remote-partial-1',
            source: 'remote',
            startMs: 2_100,
            endMs: 2_500,
            text: '尚未结束',
            isFinal: false,
            recordedAt: '2026-08-27T00:00:01.000Z',
          },
        ],
        copilotRecords: [],
      }),
      answerCopilotQuestion,
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: '立即分析当前内容' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(answerCopilotQuestion).toHaveBeenCalledWith(
      {
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
      },
      'local-manual-1',
    );
    expect(logInfo).toHaveBeenCalledWith(
      'copilot_latency',
      expect.objectContaining({ trigger: 'manual' }),
    );
  });

  it('manual analysis prefers the latest unevaluated final before retrying', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const answerCopilotQuestion = vi.fn((_, externalId: string) =>
      Promise.resolve({
        status: 'no_action' as const,
        message: 'No answer needed.',
        candidate_segment_id: externalId,
      }),
    );
    Object.assign(window.tabtin.meetingRecording, {
      getArchive: vi.fn().mockResolvedValue({
        transcript: [
          {
            externalId: 'manual-unevaluated',
            source: 'local',
            startMs: 1_000,
            endMs: 1_500,
            text: 'Still needs evaluation.',
            isFinal: true,
            recordedAt: '2026-08-27T00:00:01.000Z',
          },
          {
            externalId: 'manual-latest-evaluated',
            source: 'remote',
            startMs: 2_000,
            endMs: 2_500,
            text: 'Already evaluated.',
            isFinal: true,
            recordedAt: '2026-08-27T00:00:02.000Z',
          },
        ],
        copilotRecords: [
          {
            questionSegmentId: 'manual-latest-evaluated',
            evaluatedAt: '2026-08-27T00:00:03.000Z',
            result: {
              status: 'no_action',
              message: 'Already evaluated.',
              candidate_segment_id: 'manual-latest-evaluated',
            },
          },
        ],
      }),
      answerCopilotQuestion,
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const analyzeNow = screen.getByRole('button', {
      name: '立即分析当前内容',
    });
    fireEvent.click(analyzeNow);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(analyzeNow);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      answerCopilotQuestion.mock.calls.map(([, externalId]) => externalId),
    ).toEqual(['manual-unevaluated', 'manual-latest-evaluated']);
  });

  it('does not backfill finals from a disabled Copilot window', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const answerCopilotQuestion = vi.fn((_, externalId: string) =>
      Promise.resolve({
        status: 'no_action' as const,
        message: 'No answer needed.',
        candidate_segment_id: externalId,
      }),
    );
    const final = (
      externalId: string,
      recordedAt: string,
    ): MeetingTranscriptCheckpoint => ({
      externalId,
      source: externalId === 'disabled-b' ? 'local' : 'remote',
      startMs: Date.parse(recordedAt) % 10_000,
      endMs: (Date.parse(recordedAt) % 10_000) + 500,
      text: externalId,
      isFinal: true,
      recordedAt,
    });
    Object.assign(window.tabtin.meetingRecording, {
      getArchive: vi.fn().mockResolvedValue({
        transcript: [final('queued-a', '2026-08-27T00:00:01.000Z')],
        copilotRecords: [],
      }),
      answerCopilotQuestion,
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      statusListener?.({
        ...initialStatus,
        manifest: { ...initialStatus.manifest!, copilotEnabled: false },
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      transcriptListener?.({
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
        checkpoint: final('disabled-b', '2026-08-27T00:00:02.000Z'),
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      statusListener?.({
        ...initialStatus,
        manifest: { ...initialStatus.manifest!, copilotEnabled: true },
      });
    });
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(answerCopilotQuestion).not.toHaveBeenCalled();

    act(() => {
      transcriptListener?.({
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
        checkpoint: final('enabled-c', '2026-08-27T00:00:03.000Z'),
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      answerCopilotQuestion.mock.calls.map(([, externalId]) => externalId),
    ).toEqual(['enabled-c']);

    fireEvent.click(screen.getByRole('button', { name: '立即分析当前内容' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      answerCopilotQuestion.mock.calls.map(([, externalId]) => externalId),
    ).toEqual(['enabled-c', 'disabled-b']);
  });

  it('drops the old final queue when the rendered session changes', async () => {
    const firstStatus = await window.tabtin.meetingRecording.getStatus();
    firstStatus.manifest!.copilotEnabled = true;
    const secondSessionId = '22222222-2222-4222-8222-222222222222';
    const secondStatus: MeetingRecordingStatus = {
      ...firstStatus,
      manifest: {
        ...firstStatus.manifest!,
        sessionId: secondSessionId,
        organizationId: 'org-2',
        userId: 'user-2',
        copilotEnabled: true,
      },
    };
    const firstFinal: MeetingTranscriptCheckpoint = {
      externalId: 'old-session-final',
      source: 'remote',
      startMs: 1_000,
      endMs: 1_500,
      text: 'Old session content.',
      isFinal: true,
      recordedAt: '2026-08-27T00:00:01.000Z',
    };
    const secondFinal: MeetingTranscriptCheckpoint = {
      externalId: 'new-session-final',
      source: 'local',
      startMs: 500,
      endMs: 900,
      text: 'New session content.',
      isFinal: true,
      recordedAt: '2026-08-27T00:00:02.000Z',
    };
    const getStatus = vi.mocked(window.tabtin.meetingRecording.getStatus);
    getStatus.mockResolvedValue(firstStatus);
    const getArchive = vi.fn((scope: { sessionId: string }) =>
      Promise.resolve({
        transcript:
          scope.sessionId === secondSessionId ? [secondFinal] : [firstFinal],
        copilotRecords: [],
      }),
    );
    const answerCopilotQuestion = vi.fn().mockResolvedValue({
      status: 'no_action',
      message: 'No answer needed.',
      candidate_segment_id: 'new-session-final',
    });
    Object.assign(window.tabtin.meetingRecording, {
      getArchive,
      answerCopilotQuestion,
    });

    const { rerender } = render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={firstStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    getStatus.mockResolvedValue(secondStatus);
    rerender(
      <MeetingLiveSessionView
        sessionId={secondSessionId}
        onBack={vi.fn()}
        initialStatus={secondStatus}
      />,
    );
    await act(async () => {
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(answerCopilotQuestion).toHaveBeenCalledTimes(1);
    expect(answerCopilotQuestion).toHaveBeenCalledWith(
      {
        sessionId: secondSessionId,
        organizationId: 'org-2',
        userId: 'user-2',
      },
      'new-session-final',
    );
  });

  it('keeps an in-flight remote turn evaluated across transcript status increments', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const remoteTurn = {
      externalId: 'remote-pending-1',
      source: 'remote' as const,
      startMs: 1_000,
      endMs: 2_000,
      text: 'Explain red-black trees.',
      isFinal: true,
      recordedAt: '2026-08-27T00:00:00.000Z',
    };
    const getArchive = vi.fn().mockResolvedValue({
      transcript: [remoteTurn],
      copilotRecords: [],
    });
    let resolveAnswer!: (result: {
      status: 'no_action';
      message: string;
      candidate_segment_id: string;
    }) => void;
    const answerCopilotQuestion = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveAnswer = resolve;
        }),
    );
    Object.assign(window.tabtin.meetingRecording, {
      getArchive,
      answerCopilotQuestion,
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(answerCopilotQuestion).toHaveBeenCalledTimes(1);

    act(() => {
      statusListener?.({
        ...initialStatus,
        manifest: {
          ...initialStatus.manifest!,
          transcriptRevision: 2,
        },
      });
      transcriptListener?.({
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
        checkpoint: {
          ...remoteTurn,
          text: 'Explain red-black',
          isFinal: false,
          recordedAt: '2026-08-27T00:00:01.000Z',
        },
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getArchive).toHaveBeenCalledTimes(1);
    expect(answerCopilotQuestion).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAnswer({
        status: 'no_action',
        message: 'No answer needed.',
        candidate_segment_id: remoteTurn.externalId,
      });
      await Promise.resolve();
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(answerCopilotQuestion).toHaveBeenCalledTimes(1);
  });

  it('drops a stale pending result and evaluates the merged revision', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const first = {
      externalId: 'dirty-first',
      source: 'local' as const,
      startMs: 1_000,
      endMs: 2_000,
      text: '你确认一下到底是',
      isFinal: true,
      recordedAt: '2026-08-27T00:00:01.000Z',
    };
    let resolveFirst!: (result: {
      status: 'answered';
      question: string;
      question_segment_id: string;
      answer: string;
      key_points: string[];
      sources: [];
      reliability: 'low';
      warning: string;
      model: string;
      provider: string;
      latency_ms: number;
    }) => void;
    const answerCopilotQuestion = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        status: 'answered',
        question: '完整问题',
        question_segment_id: 'dirty-second',
        answer: '新 revision 的回答',
        key_points: [],
        sources: [],
        reliability: 'low',
        warning: '',
        model: 'test',
        provider: 'test',
        latency_ms: 1,
      });
    Object.assign(window.tabtin.meetingRecording, {
      getArchive: vi.fn().mockResolvedValue({
        transcript: [first],
        copilotRecords: [],
      }),
      answerCopilotQuestion,
    });
    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(answerCopilotQuestion).toHaveBeenCalledTimes(1);

    act(() => {
      transcriptListener?.({
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
        checkpoint: {
          ...first,
          externalId: 'dirty-second',
          startMs: 2_500,
          endMs: 4_000,
          text: 'VPS 慢还是云服务返回慢？',
          recordedAt: '2026-08-27T00:00:02.000Z',
        },
      });
    });
    await act(async () => {
      resolveFirst({
        status: 'answered',
        question: '不完整问题',
        question_segment_id: 'dirty-first',
        answer: '旧 revision 的回答',
        key_points: [],
        sources: [],
        reliability: 'low',
        warning: '',
        model: 'test',
        provider: 'test',
        latency_ms: 1,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('旧 revision 的回答')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      answerCopilotQuestion.mock.calls.map(([, externalId]) => externalId),
    ).toEqual(['dirty-first', 'dirty-second']);
    expect(screen.getByText('新 revision 的回答')).toBeTruthy();
  });

  it('re-evaluates a candidate only after wait_for_more gains a revision', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const first = {
      externalId: 'wait-first',
      source: 'local' as const,
      startMs: 1_000,
      endMs: 2_000,
      text: '它是怎么构造的？',
      isFinal: true,
      recordedAt: '2026-08-27T00:00:01.000Z',
    };
    const answerCopilotQuestion = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'wait_for_more',
        message: 'Need more context.',
        candidate_segment_id: 'wait-first',
      })
      .mockResolvedValueOnce({
        status: 'no_action',
        message: 'No direct answer needed.',
        candidate_segment_id: 'wait-second',
      });
    Object.assign(window.tabtin.meetingRecording, {
      getArchive: vi.fn().mockResolvedValue({
        transcript: [first],
        copilotRecords: [],
      }),
      answerCopilotQuestion,
    });
    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(answerCopilotQuestion).toHaveBeenCalledTimes(1);
    act(() => {
      transcriptListener?.({
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
        checkpoint: {
          ...first,
          externalId: 'wait-second',
          startMs: 2_000,
          endMs: 3_000,
          text: '它内部结构是什么样子的？',
          recordedAt: '2026-08-27T00:00:02.000Z',
        },
      });
    });
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      answerCopilotQuestion.mock.calls.map(([, externalId]) => externalId),
    ).toEqual(['wait-first', 'wait-second']);
  });

  it('evaluates every initial final in recordedAt order', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const answerCopilotQuestion = vi.fn((_, externalId: string) =>
      Promise.resolve({
        status: 'no_action' as const,
        message: 'No answer needed.',
        candidate_segment_id: externalId,
      }),
    );
    Object.assign(window.tabtin.meetingRecording, {
      getArchive: vi.fn().mockResolvedValue({
        transcript: [
          {
            externalId: 'initial-third',
            source: 'remote',
            startMs: 500,
            endMs: 900,
            text: 'Third final.',
            isFinal: true,
            recordedAt: '2026-08-27T00:00:03.000Z',
          },
          {
            externalId: 'initial-first',
            source: 'local',
            startMs: 4_000,
            endMs: 4_500,
            text: 'First final.',
            isFinal: true,
            recordedAt: '2026-08-27T00:00:01.000Z',
          },
          {
            externalId: 'initial-second',
            source: 'remote',
            startMs: 2_000,
            endMs: 2_500,
            text: 'Second final.',
            isFinal: true,
            recordedAt: '2026-08-27T00:00:02.000Z',
          },
        ],
        copilotRecords: [],
      }),
      answerCopilotQuestion,
    });

    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(
      answerCopilotQuestion.mock.calls.map(([, externalId]) => externalId),
    ).toEqual(['initial-first', 'initial-second', 'initial-third']);
  });

  it('queues a later cross-source final even when its startMs is smaller', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const firstTurn = {
      externalId: 'turn-1',
      source: 'remote' as const,
      startMs: 3_000,
      endMs: 4_000,
      text: 'Opening the document now.',
      isFinal: true,
      recordedAt: '2026-08-26T00:00:00.000Z',
    };
    const secondTurn = {
      ...firstTurn,
      externalId: 'turn-2',
      source: 'local' as const,
      startMs: 1_000,
      endMs: 2_000,
      text: 'Explain the hash map implementation principles.',
      recordedAt: '2026-08-26T00:00:02.000Z',
    };
    const getArchive = vi.fn().mockResolvedValue({ transcript: [firstTurn] });
    let resolveFirst!: (result: {
      status: 'no_action';
      message: string;
      candidate_segment_id: string;
    }) => void;
    const answerCopilotQuestion = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({
        status: 'no_action',
        message: 'Context synchronized.',
        candidate_segment_id: 'turn-2',
      });
    Object.assign(window.tabtin.meetingRecording, {
      getArchive,
      answerCopilotQuestion,
    });
    render(
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={vi.fn()}
        initialStatus={initialStatus}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });
    expect(answerCopilotQuestion).toHaveBeenCalledTimes(1);

    act(() => {
      statusListener?.({
        ...initialStatus,
        manifest: {
          ...initialStatus.manifest!,
          transcriptRevision: 2,
        },
      });
      transcriptListener?.({
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
        checkpoint: secondTurn,
      });
    });
    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
    });
    expect(getArchive).toHaveBeenCalledTimes(1);
    expect(answerCopilotQuestion).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({
        status: 'no_action',
        message: 'Context synchronized.',
        candidate_segment_id: 'turn-1',
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(answerCopilotQuestion).toHaveBeenLastCalledWith(
      {
        sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
      },
      'turn-2',
    );
  });
});
