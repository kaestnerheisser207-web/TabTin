import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingRecordingStatus } from '@shared/meeting-recording-contract';

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
  let statusListener:
    | ((status: MeetingRecordingStatus) => void)
    | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    captureLevelListener = undefined;
    statusListener = undefined;
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
          onCaptureLevel: vi.fn((listener) => {
            captureLevelListener = listener;
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
    expect(
      screen.getByText('实时转写尚未连接；原始音频继续保存'),
    ).toBeTruthy();
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

    expect(
      screen.getByText('正在保存音频、逐字稿和恢复点…'),
    ).toBeTruthy();
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

  it('does not send the local microphone answer back to Copilot', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const answerCopilotQuestion = vi.fn();
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
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(answerCopilotQuestion).not.toHaveBeenCalled();
  });

  it('keeps an in-flight remote turn evaluated across stale archive refreshes', async () => {
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
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getArchive).toHaveBeenCalledTimes(2);

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

  it('analyzes the newest completed turn after an earlier AI request finishes', async () => {
    const initialStatus = await window.tabtin.meetingRecording.getStatus();
    initialStatus.manifest!.copilotEnabled = true;
    const firstTurn = {
      externalId: 'turn-1',
      source: 'remote' as const,
      startMs: 1_000,
      endMs: 2_000,
      text: 'Opening the document now.',
      isFinal: true,
      recordedAt: '2026-08-26T00:00:00.000Z',
    };
    const secondTurn = {
      ...firstTurn,
      externalId: 'turn-2',
      startMs: 3_000,
      endMs: 4_000,
      text: 'Explain the hash map implementation principles.',
    };
    const getArchive = vi
      .fn()
      .mockResolvedValueOnce({ transcript: [firstTurn] })
      .mockResolvedValue({ transcript: [firstTurn, secondTurn] });
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
    });
    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
    });
    expect(getArchive).toHaveBeenCalledTimes(2);
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
