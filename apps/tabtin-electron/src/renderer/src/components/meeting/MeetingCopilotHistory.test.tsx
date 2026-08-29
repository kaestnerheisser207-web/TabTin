import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MeetingCopilotRecord } from '@shared/meeting-recording-contract';

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
import { MeetingCopilotHistory } from './MeetingCopilotHistory';

const answerRecord = (
  questionSegmentId: string,
  question: string,
  answer: string,
): MeetingCopilotRecord => ({
  questionSegmentId,
  evaluatedAt: '2026-08-27T00:00:00.000Z',
  result: {
    status: 'answered',
    question,
    question_segment_id: questionSegmentId,
    answer,
    key_points: [],
    sources: [],
    reliability: 'medium',
    warning: '',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    latency_ms: 300,
  },
});

describe('MeetingCopilotHistory', () => {
  it('keeps earlier answers visible but collapsed while expanding the newest', () => {
    render(
      <MeetingCopilotHistory
        records={[
          answerRecord('question-1', 'First question', 'First answer'),
          answerRecord('question-2', 'Second question', 'Second answer'),
        ]}
      />,
    );

    const first = screen.getByRole('button', {
      name: '展开回答：First question',
    });
    const second = screen.getByRole('button', {
      name: '收起回答：Second question',
    });
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(second.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText('First answer')).toBeNull();
    expect(screen.getByText('Second answer')).toBeTruthy();

    fireEvent.click(first);

    expect(screen.getByText('First answer')).toBeTruthy();
    expect(screen.getByText('Second answer')).toBeTruthy();
  });

  it('renders a persisted clarification as terminal history', () => {
    render(
      <MeetingCopilotHistory
        records={[
          {
            ...answerRecord('clarify-0', '它为什么慢？', '旧 revision 回答'),
            candidateId: 'clarify-candidate',
            revision: 1,
          },
          {
            questionSegmentId: 'clarify-1',
            candidateId: 'clarify-candidate',
            revision: 2,
            evaluatedAt: '2026-08-27T00:00:00.000Z',
            result: {
              status: 'needs_clarification',
              question: '它为什么慢？',
              question_segment_id: 'clarify-1',
              clarifying_question: '你指的是转写延迟还是回答延迟？',
              reason_code: 'ambiguous_reference',
              uncertainty: '当前问题中的“慢”没有指明链路。',
              model: 'deepseek-v4-flash',
              provider: 'deepseek',
              latency_ms: 200,
            },
          },
        ]}
      />,
    );

    expect(screen.getByText('需要澄清')).toBeTruthy();
    expect(screen.getByText('它为什么慢？')).toBeTruthy();
    expect(screen.queryByText('旧 revision 回答')).toBeNull();
    expect(screen.getByText('你指的是转写延迟还是回答延迟？')).toBeTruthy();
    expect(
      screen.getByText('尚不确定：当前问题中的“慢”没有指明链路。'),
    ).toBeTruthy();
  });
});
