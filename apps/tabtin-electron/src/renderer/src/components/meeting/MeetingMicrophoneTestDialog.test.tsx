import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  MeetingMicrophoneTestDialog,
  type MeetingMicrophoneTestDialogProps,
  type MeetingMicrophoneTestPhase,
} from './MeetingMicrophoneTestDialog';

function props(
  overrides: Partial<MeetingMicrophoneTestDialogProps> = {},
): MeetingMicrophoneTestDialogProps {
  return {
    open: true,
    deviceLabel: 'Studio Microphone',
    phase: 'idle',
    levels: [],
    maxRms: 0,
    onStart: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('MeetingMicrophoneTestDialog', () => {
  it('switches the live announcement at the speaking RMS threshold', () => {
    const initial = props({ phase: 'listening', levels: [0.0059] });
    const { rerender } = render(<MeetingMicrophoneTestDialog {...initial} />);

    expect(
      screen.getByTestId('microphone-speaking-state').textContent,
    ).toContain('Please start speaking');

    rerender(
      <MeetingMicrophoneTestDialog {...initial} levels={[0.0059, 0.006]} />,
    );

    expect(
      screen.getByTestId('microphone-speaking-state').textContent,
    ).toContain('Speaking detected');
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe(
      '0.006',
    );
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toBe(
      'Peak RMS: 0.006',
    );
  });

  it('renders a rolling 40-bar waveform with clamped visual heights', () => {
    render(
      <MeetingMicrophoneTestDialog
        {...props({ phase: 'listening', levels: [0, 0.015, 0.03, 2] })}
      />,
    );

    const bars = screen.getAllByTestId('microphone-level-bar');
    expect(bars).toHaveLength(40);
    expect(bars.at(-4)?.style.height).toBe('8%');
    expect(bars.at(-3)?.style.height).toBe('54%');
    expect(bars.at(-2)?.style.height).toBe('100%');
    expect(bars.at(-1)?.style.height).toBe('100%');
    expect(bars.at(-1)?.className).toContain('motion-reduce:transition-none');
  });

  it.each<{
    phase: Extract<MeetingMicrophoneTestPhase, 'heard' | 'silent' | 'failed'>;
    title: string;
  }>([
    { phase: 'heard', title: 'Microphone detected' },
    { phase: 'silent', title: 'No voice detected' },
    { phase: 'failed', title: 'Microphone test failed' },
  ])('shows the $phase final result and RMS', ({ phase, title }) => {
    render(
      <MeetingMicrophoneTestDialog {...props({ phase, maxRms: 0.0126 })} />,
    );

    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText('0.013')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test again' })).toBeTruthy();
  });

  it('starts, retries, and closes through explicit buttons', () => {
    const onStart = vi.fn();
    const onClose = vi.fn();
    const initial = props({ onStart, onClose });
    const { rerender } = render(<MeetingMicrophoneTestDialog {...initial} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start test' }));
    expect(onStart).toHaveBeenCalledTimes(1);

    rerender(<MeetingMicrophoneTestDialog {...initial} phase="heard" />);
    fireEvent.click(screen.getByRole('button', { name: 'Test again' }));
    expect(onStart).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
