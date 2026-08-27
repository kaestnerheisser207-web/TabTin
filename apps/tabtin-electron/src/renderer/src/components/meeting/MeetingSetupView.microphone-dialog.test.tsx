import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}));

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: unknown) => unknown) =>
    selector({ selectedOrganization: { id: 'org-1' } }),
}));

vi.mock('@/services/projectApi', () => ({
  ProjectApiService: {
    listProjects: vi.fn().mockResolvedValue({ projects: [] }),
  },
}));

vi.mock('@/services/organizationLlmApi', () => ({
  OrganizationLlmApiService: {
    listModels: vi.fn().mockResolvedValue({
      models: [
        {
          id: 'model-flash',
          name: 'deepseek-v4-flash',
          display_name: 'DeepSeek V4 Flash',
          provider: 'deepseek',
          provider_display_name: 'DeepSeek',
          provider_routing_enabled: true,
          capability_domain: 'chat',
          wave_status: 'ready',
          max_tokens: 32_000,
          supports_streaming: true,
          supports_vision: false,
          cost_per_1k_tokens: 0,
        },
      ],
      total: 1,
      default_model_id: 'model-flash',
    }),
  },
}));

import type {
  MeetingMicrophoneTestLevelEvent,
  MeetingMicrophoneTestResult,
  MeetingRecordingStatus,
} from '@shared/meeting-recording-contract';
import { MeetingRecordsSidebar } from './MeetingRecordsSidebar';
import { MeetingSetupView } from './MeetingSetupView';

describe('MeetingSetupView microphone dialog', () => {
  const previousTabtin = window.tabtin;
  let levelListener:
    | ((event: MeetingMicrophoneTestLevelEvent) => void)
    | undefined;
  let resolveTest: ((result: MeetingMicrophoneTestResult) => void) | undefined;
  let statusListener: ((status: MeetingRecordingStatus) => void) | undefined;
  const testMicrophone = vi.fn(
    () =>
      new Promise<MeetingMicrophoneTestResult>((resolve) => {
        resolveTest = resolve;
      }),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    levelListener = undefined;
    statusListener = undefined;
    resolveTest = undefined;
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        meetingRecording: {
          probeStorage: vi.fn().mockResolvedValue({
            ok: false,
            rootPath: '/tmp/meetings',
            availableBytes: null,
            errorCode: 'TEST_ONLY_STORAGE_PROBE_FAILURE',
          }),
          listMicrophones: vi.fn().mockResolvedValue([
            {
              deviceId: 'default',
              groupId: 'group-1',
              label: 'Default microphone',
              isDefault: true,
            },
          ]),
          probeMedia: vi.fn(),
          probeAsr: vi.fn().mockResolvedValue({
            ready: true,
            provider: 'byteplus',
            wsEndpoint: 'bigmodel_async',
          }),
          testMicrophone,
          getStatus: vi.fn().mockResolvedValue({
            active: false,
            manifest: null,
          }),
          prepare: vi.fn().mockResolvedValue({ active: true, manifest: {} }),
          start: vi.fn().mockResolvedValue({ active: true, manifest: {} }),
          onStatusChanged: vi.fn((listener) => {
            statusListener = listener;
            return () => {
              statusListener = undefined;
            };
          }),
          onMicrophoneTestLevel: vi.fn((listener) => {
            levelListener = listener;
            return () => {
              levelListener = undefined;
            };
          }),
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: previousTabtin,
    });
  });

  it('shows live speaking feedback and then the final result', async () => {
    render(
      <MeetingSetupView
        onBack={vi.fn()}
        onStarted={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '测试麦克风' })).toBeTruthy(),
    );
    expect(screen.getByText('配置可用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '测试麦克风' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByTestId('microphone-level-bar')).toHaveLength(40);

    act(() => {
      levelListener?.({
        deviceId: 'default',
        deviceLabel: 'Default microphone',
        active: true,
        elapsedMs: 500,
        rms: 0.02,
        maxRms: 0.02,
        nonSilentFrames: 10,
      });
    });
    expect(screen.getByTestId('microphone-speaking-state').textContent).toBe(
      '正在说话',
    );

    await act(async () => {
      resolveTest?.({
        available: true,
        deviceId: 'default',
        deviceLabel: 'Default microphone',
        measuredFrames: 80,
        nonSilentFrames: 50,
        maxRms: 0.122,
      });
    });

    expect(screen.getByText('麦克风输入正常')).toBeTruthy();
    expect(screen.getByText('0.122')).toBeTruthy();
  });

  it('allows starting without running microphone or system-audio tests', async () => {
    render(<MeetingSetupView onBack={vi.fn()} onStarted={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('记录标题'), {
      target: { value: '无需测试即可开始' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '确认参会者已知情并同意录音和转写',
      }),
    );

    const start = screen.getByRole('button', { name: '开始记录' });
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false));
    expect(window.tabtin.meetingRecording.probeMedia).not.toHaveBeenCalled();
    expect(testMicrophone).not.toHaveBeenCalled();
  });

  it('returns to an active recording instead of preparing a second session', async () => {
    const activeSessionId = '11111111-1111-4111-8111-111111111111';
    vi.mocked(window.tabtin.meetingRecording.getStatus).mockResolvedValue({
      active: true,
      manifest: {
        sessionId: activeSessionId,
        lifecycleStatus: 'recording',
      },
    });
    const onStarted = vi.fn();
    render(<MeetingSetupView onBack={vi.fn()} onStarted={onStarted} />);

    fireEvent.change(screen.getByLabelText('记录标题'), {
      target: { value: '不应创建的新记录' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '确认参会者已知情并同意录音和转写',
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: '开始记录' })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '开始记录' }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(activeSessionId));
    expect(window.tabtin.meetingRecording.prepare).not.toHaveBeenCalled();
    expect(window.tabtin.meetingRecording.start).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/another meeting recording is already active/),
    ).toBeNull();
  });

  it('shows the active-recording entry only until the recording ends', async () => {
    const activeSessionId = '11111111-1111-4111-8111-111111111111';
    vi.mocked(window.tabtin.meetingRecording.getStatus).mockResolvedValue({
      active: true,
      manifest: {
        sessionId: activeSessionId,
        lifecycleStatus: 'recording',
      },
    });
    render(<MeetingRecordsSidebar />);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '记录进行中' }),
      ).toBeTruthy(),
    );
    act(() => {
      statusListener?.({
        active: false,
        manifest: {
          sessionId: activeSessionId,
          lifecycleStatus: 'stopped',
        },
      } as MeetingRecordingStatus);
    });

    expect(screen.queryByRole('button', { name: '记录进行中' })).toBeNull();
  });

  it('translates a prepare race into a plain business message', async () => {
    vi.mocked(window.tabtin.meetingRecording.getStatus).mockResolvedValue({
      active: false,
      manifest: null,
    });
    vi.mocked(window.tabtin.meetingRecording.prepare).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'meeting-recording:prepare': " +
          'Error: another meeting recording is already active',
      ),
    );
    render(<MeetingSetupView onBack={vi.fn()} onStarted={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('记录标题'), {
      target: { value: '并发竞态测试' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '确认参会者已知情并同意录音和转写',
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: '开始记录' })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '开始记录' }));

    await waitFor(() =>
      expect(window.tabtin.meetingRecording.prepare).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/已有一条记录正在进行，请先继续或结束该记录/),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByText(/another meeting recording is already active/),
    ).toBeNull();
  });

  it('keeps Copilot off by default and stores the model after explicit enablement', async () => {
    const onStarted = vi.fn();
    render(<MeetingSetupView onBack={vi.fn()} onStarted={onStarted} />);

    await waitFor(() =>
      expect(
        screen.getByRole('combobox', {
          name: '会议 Copilot 回答模型',
        }),
      ).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText('记录标题'), {
      target: { value: 'Copilot 模型选择' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '确认参会者已知情并同意录音和转写',
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole('switch', { name: '启用会议 Copilot' })
          .getAttribute('aria-checked'),
      ).toBe('false'),
    );
    fireEvent.click(screen.getByRole('switch', { name: '启用会议 Copilot' }));
    expect(
      screen
        .getByRole('switch', { name: '启用会议 Copilot' })
        .getAttribute('aria-checked'),
    ).toBe('true');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始记录' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.tabtin.meetingRecording.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        copilotEnabled: true,
        copilotModelId: 'model-flash',
        copilotModelLabel: 'DeepSeek V4 Flash',
      }),
    );
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it('reuses the prepared session when media capture start is retried', async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce({
        message:
          'system audio capture failed: NotAllowedError: permission denied',
      })
      .mockResolvedValue({ active: true, manifest: {} });
    Object.assign(window.tabtin.meetingRecording, { start });
    const onStarted = vi.fn();
    render(<MeetingSetupView onBack={vi.fn()} onStarted={onStarted} />);

    fireEvent.change(screen.getByLabelText('记录标题'), {
      target: { value: 'Retry capture' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '确认参会者已知情并同意录音和转写',
      }),
    );
    const startButton = screen.getByRole('button', { name: '开始记录' });

    await act(async () => {
      fireEvent.click(startButton);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.getByText(
        /system audio capture failed: NotAllowedError: permission denied/,
      ),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(startButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    const prepare = vi.mocked(window.tabtin.meetingRecording.prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]?.[0].sessionId).toBe(
      prepare.mock.calls[0]?.[0].sessionId,
    );
    expect(onStarted).toHaveBeenCalledOnce();
  });
});
