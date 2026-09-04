import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const translations = (await import('@/i18n/locales/zh-CN/meeting.json'))
    .default as Record<string, unknown>;
  const readTranslation = (key: string): string => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (current, segment) =>
          current && typeof current === 'object'
            ? (current as Record<string, unknown>)[segment]
            : undefined,
        translations,
      );
    return typeof value === 'string' ? value : key;
  };
  return { useTranslation: () => ({ t: readTranslation }) };
});

import { MeetingRecordsPage } from './MeetingRecordsPage';
import { MeetingRecordsSidebar } from './MeetingRecordsSidebar';
import { MeetingDetailSessionView } from './MeetingDetailSessionView';
import type { MeetingLocalArchive } from '@shared/meeting-recording-contract';
import { useAuthStore } from '@stores/useAuthStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';
import {
  SIDEBAR_LIST_ICON_SIZE,
  SIDEBAR_MENU_ICON_STROKE,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_INACTIVE,
} from '@components/layout/sidebarUi';
import {
  MeetingSessionView,
  resolveMeetingSessionSurface,
} from './MeetingSessionView';
import {
  MEETING_DETAIL_PREVIEW_ID,
  MEETING_LIVE_PREVIEW_ID,
  useMeetingViewNavigation,
} from './meetingViewNavigation';

function createMeetingArchive(
  storageStatus: 'synced' | 'deleted' = 'synced',
): MeetingLocalArchive {
  const audioDeleted = storageStatus === 'deleted';
  const track = (source: 'local' | 'remote') => ({
    source,
    status: 'completed' as const,
    nextSequence: 2,
    durationMs: 20_000,
    bytes: audioDeleted ? 0 : 100,
    sampleRate: 16_000,
    channelCount: 1,
    codec: 'opus',
    container: 'webm',
    lastCheckpointAt: '2026-08-26T00:00:20.000Z',
    finalizedRelativePath: audioDeleted ? null : `${source}.webm`,
    contentHash: audioDeleted ? '' : `${source}-hash`,
    storageStatus,
    fileRecordId: audioDeleted ? null : `${source}-file`,
    objectKey: audioDeleted ? '' : `meeting/${source}.webm`,
    uploadError: '',
    uploadAttempts: 1,
    lastUploadAttemptAt: '2026-08-26T00:00:20.000Z',
  });
  return {
    manifest: {
      schemaVersion: 2,
      sessionId: '11111111-1111-4111-8111-111111111111',
      organizationId: 'org-1',
      userId: 'user-1',
      projectId: null,
      projectName: '',
      title: '真实记录',
      brief: '',
      consentConfirmedAt: '2026-08-26T00:00:00.000Z',
      microphoneDeviceId: 'default',
      microphoneDeviceLabel: 'Default microphone',
      systemAudioSourceId: 'main-display',
      systemAudioSourceLabel: 'System audio',
      copilotInitiallyEnabled: false,
      copilotEnabled: false,
      copilotModelId: '',
      copilotModelLabel: '',
      transcriptionStatus: 'completed',
      transcriptRevision: 1,
      transcriptFinalCount: 1,
      transcriptRunId: 'transcript-run-1',
      transcriptionError: '',
      lifecycleStatus: 'stopped',
      createdAt: '2026-08-26T00:00:00.000Z',
      startedAt: '2026-08-26T00:00:00.000Z',
      endedAt: '2026-08-26T00:00:20.000Z',
      durationMs: 20_000,
      serverSyncStatus: 'synced',
      serverSyncError: '',
      tracks: { local: track('local'), remote: track('remote') },
    },
    audioUrls: audioDeleted
      ? {}
      : {
          local: 'muse-file:///local.webm',
          remote: 'muse-file:///remote.webm',
        },
    transcript: [
      {
        externalId: 'local-1',
        source: 'local',
        startMs: 2_000,
        endMs: 5_000,
        text: '保留的真实逐字稿。',
        isFinal: true,
        recordedAt: '2026-08-26T00:00:02.000Z',
      },
    ],
    copilotRecords: [],
  };
}

describe('MeetingRecordsPage', () => {
  beforeEach(() => {
    useMeetingViewNavigation.getState().openLibrary();
  });

  it('uses the confirmed product wording and enters record setup', async () => {
    render(<MeetingRecordsPage />);

    expect(screen.getByRole('heading', { name: '会议记录' })).toBeTruthy();
    expect(
      screen.getByTestId('meeting-page-icon').getAttribute('class'),
    ).toContain('h-7 w-7');
    fireEvent.click(screen.getAllByRole('button', { name: '开始记录' })[0]!);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: '准备新记录' })).toBeTruthy(),
    );
    expect(
      screen.getByTestId('meeting-page-icon').getAttribute('class'),
    ).toContain('h-7 w-7');
    expect(
      screen.getByRole('heading', { name: '基本信息' }).className,
    ).toContain('text-title font-semibold');
    expect(screen.queryByText('发起会议')).toBeNull();
    expect(screen.getByText('会议 Copilot')).toBeTruthy();
  });

  it('redirects setup to an existing recording before showing the form', async () => {
    const previousTabtin = window.muse;
    const activeSessionId = '11111111-1111-4111-8111-111111111111';
    const recordingStatus = {
      active: true,
      manifest: {
        sessionId: activeSessionId,
        lifecycleStatus: 'recording',
      },
    };
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(recordingStatus)
      .mockImplementation(() => new Promise(() => undefined));
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        ...previousTabtin,
        meetingRecording: {
          getStatus,
          onStatusChanged: vi.fn(() => vi.fn()),
        },
      },
    });
    useMeetingViewNavigation.getState().openSetup();

    const rendered = render(<MeetingRecordsPage />);
    await waitFor(() =>
      expect(useMeetingViewNavigation.getState().view).toEqual({
        kind: 'session',
        sessionId: activeSessionId,
      }),
    );

    expect(screen.queryByRole('heading', { name: '准备新记录' })).toBeNull();
    rendered.unmount();
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: previousTabtin,
    });
  });

  it('keeps sidebar selection in the shared meeting navigation store', () => {
    render(<MeetingRecordsSidebar />);

    expect(
      screen.getByRole('navigation', { name: '会议记录' }).className,
    ).not.toContain('pt-0.5');
    expect(screen.queryByText('会议记录')).toBeNull();
    const library = screen.getByRole('button', { name: '全部记录' });
    const setup = screen.getByRole('button', { name: '准备新记录' });
    expect(library.getAttribute('aria-current')).toBe('page');
    for (const className of SIDEBAR_ROW_ACTIVE.split(' ')) {
      expect(library.className).toContain(className);
    }
    expect(library.className).toContain(SIDEBAR_ROW_FULL_WIDTH);
    for (const className of SIDEBAR_ROW_INACTIVE.split(' ')) {
      expect(setup.className).toContain(className);
    }
    const libraryIcon = library.querySelector('svg');
    expect(libraryIcon?.getAttribute('width')).toBe(
      String(SIDEBAR_LIST_ICON_SIZE),
    );
    expect(libraryIcon?.getAttribute('stroke-width')).toBe(
      String(SIDEBAR_MENU_ICON_STROKE),
    );
    expect(screen.queryByText('页面预览')).toBeNull();
    expect(screen.queryByRole('button', { name: '记录进行中' })).toBeNull();
    expect(screen.queryByRole('button', { name: '会后详情' })).toBeNull();

    fireEvent.click(setup);
    expect(useMeetingViewNavigation.getState().view).toEqual({ kind: 'setup' });
    expect(setup.getAttribute('aria-current')).toBe('page');
    for (const className of SIDEBAR_ROW_ACTIVE.split(' ')) {
      expect(setup.className).toContain(className);
    }
  });

  it('maps a session id to one session page with live or detail state', () => {
    expect(resolveMeetingSessionSurface(MEETING_LIVE_PREVIEW_ID)).toBe('live');
    expect(resolveMeetingSessionSurface(MEETING_DETAIL_PREVIEW_ID)).toBe(
      'detail',
    );
    expect(resolveMeetingSessionSurface('missing')).toBeNull();
  });

  it('shows independent audio, transcript and Copilot status in the live state', () => {
    render(
      <MeetingSessionView
        sessionId={MEETING_LIVE_PREVIEW_ID}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByTestId('meeting-records-live')).toBeTruthy();
    expect(
      screen.getByTestId('meeting-page-icon').getAttribute('class'),
    ).toContain('h-7 w-7');
    expect(screen.getByRole('heading', { name: '实时逐字稿' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '切换麦克风' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: '切换系统音频来源' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: '会议 Copilot' })).toBeTruthy();
    const copilotToggle = screen.getByRole('switch', {
      name: '会议 Copilot 开关',
    });
    expect(copilotToggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getAllByText('已关闭').length).toBeGreaterThan(0);
    expect(screen.queryByText('当前会议上下文')).toBeNull();

    fireEvent.click(copilotToggle);
    expect(copilotToggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getAllByText('Copilot 已就绪').length).toBeGreaterThan(0);
    expect(screen.getByText('当前会议上下文')).toBeTruthy();

    fireEvent.click(copilotToggle);
    expect(copilotToggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByText('当前会议上下文')).toBeNull();
    expect(screen.queryByText('发送到会议')).toBeNull();
  });

  it('shows a fact-first post-meeting detail without hiding partial completion', () => {
    render(
      <MeetingSessionView
        sessionId={MEETING_DETAIL_PREVIEW_ID}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByTestId('meeting-records-detail')).toBeTruthy();
    expect(
      screen.getByTestId('meeting-page-icon').getAttribute('class'),
    ).toContain('h-7 w-7');
    expect(screen.getByText(/部分完成 · 原始音频与逐字稿完整/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: '逐字稿与录音' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '录音' })).toBeNull();
    expect(screen.getByRole('tab', { name: /会议 Copilot/ })).toBeTruthy();
  });

  it('requires explicit confirmation and prevents duplicate audio deletion', async () => {
    let resolveDelete: (() => void) | undefined;
    const onDeleteAudio = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    render(
      <MeetingDetailSessionView
        archive={createMeetingArchive()}
        onDeleteAudio={onDeleteAudio}
        onDeleteArchive={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('删除会议内容')).toBeTruthy();
    expect(
      within(dialog).getByRole('radio', {
        name: /删除录音，保留文字/,
      }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('radio', { name: /删除完整记录/ }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        /麦克风与系统音频都会永久删除；逐字稿、会后分析、Copilot 记录和关联资料将保留/,
      ),
    ).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole('button', { name: '删除录音，保留文字' }),
    );
    expect(onDeleteAudio).toHaveBeenCalledOnce();
    const processing = within(dialog).getByRole('button', { name: /处理中/ });
    expect(processing.hasAttribute('disabled')).toBe(true);
    fireEvent.click(processing);
    expect(onDeleteAudio).toHaveBeenCalledOnce();

    await act(async () => resolveDelete?.());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the destructive confirmation open with an explicit failure', async () => {
    const onDeleted = vi.fn();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      render(
        <MeetingDetailSessionView
          archive={createMeetingArchive()}
          onDeleteAudio={vi.fn()}
          onDeleteArchive={vi
            .fn()
            .mockRejectedValue(new Error('provider unavailable'))}
          onDeleted={onDeleted}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('删除会议内容')).toBeTruthy();
      fireEvent.click(
        within(dialog).getByRole('radio', { name: /删除完整记录/ }),
      );
      fireEvent.click(
        within(dialog).getByRole('button', { name: '删除完整记录' }),
      );

      await waitFor(() =>
        expect(within(dialog).getByRole('alert').textContent).toContain(
          '删除完整记录失败，请重试: provider unavailable',
        ),
      );
      expect(onDeleted).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('shows local cleanup pending instead of claiming audio was deleted', () => {
    const archive = {
      ...createMeetingArchive('deleted'),
      localAudioCleanupPending: true,
    };

    render(
      <MeetingDetailSessionView
        archive={archive}
        onDeleteAudio={vi.fn()}
        onDeleteArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      '云端录音已删除，但此设备未能移除本地音频',
    );
    expect(screen.getByText('本地清理待重试')).toBeTruthy();
    expect(
      screen.queryByText('录音已删除，逐字稿、会后内容和关联资料仍然保留。'),
    ).toBeNull();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  });

  it('wires both deletion paths to the real archive scope and returns after full deletion', async () => {
    const previousTabtin = window.muse;
    const previousUser = useAuthStore.getState().user;
    const previousOrganization =
      useOrganizationStore.getState().selectedOrganization;
    const archive = createMeetingArchive();
    const emptyArchive = {
      ...archive,
      audioUrls: {},
      transcript: [],
      copilotRecords: [],
    };
    const deletedArchive = createMeetingArchive('deleted');
    const getArchive = vi
      .fn()
      .mockResolvedValueOnce(emptyArchive)
      .mockResolvedValueOnce(archive)
      .mockResolvedValueOnce(deletedArchive);
    const deleteArchiveAudio = vi.fn().mockResolvedValue(undefined);
    const deleteArchive = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        ...previousTabtin,
        meetingRecording: {
          ...previousTabtin.meetingRecording,
          getStatus: vi
            .fn()
            .mockResolvedValue({ active: false, manifest: null }),
          getArchive,
          deleteArchiveAudio,
          deleteArchive,
        },
      },
    });
    act(() => {
      useAuthStore.setState({
        user: {
          id: 'user-1',
          username: 'meeting-user',
          nickname: '会议用户',
          is_verified_email: false,
          is_verified_phone: false,
          date_joined: '2026-08-23T00:00:00.000Z',
          login_count: 1,
        },
      });
      useOrganizationStore.setState({
        selectedOrganization: {
          id: 'org-1',
          name: 'Meeting Org',
          type: 'team',
          owner_id: 'user-1',
          is_default: false,
          created_at: '2026-08-23T00:00:00.000Z',
          updated_at: '2026-08-23T00:00:00.000Z',
        },
      });
    });
    const onBack = vi.fn();

    try {
      render(
        <MeetingSessionView
          sessionId={archive.manifest.sessionId}
          onBack={onBack}
        />,
      );
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '删除' })).toBeTruthy(),
      );
      expect(getArchive).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: '删除录音，保留文字',
        }),
      );
      const expectedScope = {
        sessionId: archive.manifest.sessionId,
        organizationId: 'org-1',
        userId: 'user-1',
      };
      await waitFor(() =>
        expect(deleteArchiveAudio).toHaveBeenCalledWith(expectedScope),
      );
      await waitFor(() =>
        expect(
          screen.getByText('录音已删除，逐字稿、会后内容和关联资料仍然保留。'),
        ).toBeTruthy(),
      );
      const transcriptTab = screen.getByRole('tab', {
        name: '逐字稿与录音',
      });
      fireEvent.mouseDown(transcriptTab, { button: 0, ctrlKey: false });
      await waitFor(() =>
        expect(transcriptTab.getAttribute('aria-selected')).toBe('true'),
      );
      expect(screen.getByText('保留的真实逐字稿。')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: '删除完整记录',
        }),
      );
      await waitFor(() =>
        expect(deleteArchive).toHaveBeenCalledWith(expectedScope),
      );
      expect(onBack).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, 'tabtin', {
        configurable: true,
        value: previousTabtin,
      });
      act(() => {
        useAuthStore.setState({ user: previousUser });
        useOrganizationStore.setState({
          selectedOrganization: previousOrganization,
        });
      });
    }
  });

  it('seeks from a transcript timestamp and follows text during playback', async () => {
    const previousUser = useAuthStore.getState().user;
    act(() => {
      useAuthStore.setState({
        user: {
          id: 'user-real',
          nickname: '蛋壳王',
          username: 'shell-user',
          avatar: 'https://example.com/avatar.png',
          is_verified_email: false,
          is_verified_phone: false,
          date_joined: '2026-08-23T00:00:00.000Z',
          login_count: 9,
        },
      });
    });
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined);
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => undefined);
    const previousScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    const archive = {
      manifest: {
        title: '真实记录',
        createdAt: '2026-08-26T00:00:00.000Z',
        durationMs: 20_000,
        projectId: 'project-1',
        projectName: '面试准备',
        brief: '',
        transcriptionStatus: 'completed',
        transcriptionError: '',
        transcriptFinalCount: 2,
        copilotEnabled: false,
        tracks: {
          local: {
            status: 'completed',
            bytes: 100,
            sampleRate: 16_000,
          },
          remote: {
            status: 'completed',
            bytes: 100,
            sampleRate: 16_000,
          },
        },
      } as MeetingLocalArchive['manifest'],
      audioUrls: {
        local: 'muse-file:///local.webm',
        remote: 'muse-file:///remote.webm',
      },
      transcript: [
        {
          externalId: 'local-1',
          source: 'local',
          startMs: 2_000,
          endMs: 5_000,
          text: '第一段真实逐字稿。',
          isFinal: true,
          recordedAt: '2026-08-26T00:00:02.000Z',
        },
        {
          externalId: 'local-2',
          source: 'local',
          startMs: 12_000,
          endMs: 15_000,
          text: '第二段真实逐字稿。',
          isFinal: true,
          recordedAt: '2026-08-26T00:00:12.000Z',
        },
      ],
      copilotRecords: [
        {
          questionSegmentId: 'remote-question-1',
          evaluatedAt: '2026-08-26T00:00:16.000Z',
          result: {
            status: 'answered',
            question: '请解释哈希表的实现原理。',
            question_segment_id: 'remote-question-1',
            answer: '哈希表通过哈希函数把键映射到桶，并处理哈希冲突。',
            key_points: ['哈希函数', '冲突处理'],
            sources: [],
            reliability: 'high',
            warning: '',
            model: 'deepseek-v4-flash',
            provider: 'deepseek',
            latency_ms: 260,
          },
        },
      ],
    } as MeetingLocalArchive;

    try {
      render(<MeetingDetailSessionView archive={archive} />);
      expect(screen.getByText('面试准备')).toBeTruthy();
      expect(screen.queryByText('project-1')).toBeNull();
      const transcriptTab = screen.getByRole('tab', {
        name: '逐字稿与录音',
      });
      fireEvent.mouseDown(transcriptTab, { button: 0, ctrlKey: false });
      await waitFor(() =>
        expect(transcriptTab.getAttribute('aria-selected')).toBe('true'),
      );
      expect(screen.getAllByText('蛋壳王').length).toBeGreaterThan(0);
      expect(screen.getAllByAltText('蛋壳王').length).toBeGreaterThan(0);

      const localAudio = document.querySelectorAll('audio')[0]!;
      fireEvent.click(
        screen.getByRole('button', {
          name: '播放对应音段 00:00:02',
        }),
      );
      expect(localAudio.currentTime).toBe(2);
      expect(play).toHaveBeenCalled();

      fireEvent.change(screen.getByRole('slider', { name: '麦克风音轨' }), {
        target: { value: '5000' },
      });
      expect(localAudio.currentTime).toBe(5);

      localAudio.currentTime = 12;
      fireEvent.play(localAudio);
      fireEvent.timeUpdate(localAudio);
      expect(
        screen.getByText('第二段真实逐字稿。').closest('article')?.className,
      ).toContain('bg-accent/10');

      const copilotTab = screen.getByRole('tab', { name: '会议 Copilot' });
      fireEvent.mouseDown(copilotTab, { button: 0, ctrlKey: false });
      await waitFor(() =>
        expect(copilotTab.getAttribute('aria-selected')).toBe('true'),
      );
      expect(screen.getByText('请解释哈希表的实现原理。')).toBeTruthy();
      expect(
        screen.getByText('哈希表通过哈希函数把键映射到桶，并处理哈希冲突。'),
      ).toBeTruthy();
    } finally {
      play.mockRestore();
      pause.mockRestore();
      Element.prototype.scrollIntoView = previousScrollIntoView;
      act(() => {
        useAuthStore.setState({ user: previousUser });
      });
    }
  });
});
