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
});
