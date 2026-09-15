/**
 * Routing `/goal` from the composer: on a session whose harness owns the command it is prompt text
 * and reaches the harness verbatim; everywhere else the app's goal engine answers it as before.
 */
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

// Stub the preload bridge before any renderer module runs.
const invokeMock = vi.fn().mockResolvedValue({ ok: true });
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { fireEvent, render, waitFor } from '@testing-library/react';
import { Composer } from '../src/renderer/src/components/Composer';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';

const base = {
  id: 's1',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  cwd: '.',
  status: 'idle',
  harnessRef: {} as SessionMeta['harnessRef'],
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }
} as unknown as SessionMeta;

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ ...base, config: { harness: 'claude', cwd: '.', permissionMode: 'default' }, ...over }) as SessionMeta;

/** Renders a composer for the given session and submits one line through it. */
function submit(s: SessionMeta, line: string): void {
  const { container } = render(<Composer session={s} />);
  const ta = container.querySelector('textarea') as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: line } });
  fireEvent.keyDown(ta, { key: 'Enter' });
}

/** One composer, several lines submitted through it in order. */
function submitAll(s: SessionMeta, lines: string[]): HTMLTextAreaElement {
  const { container } = render(<Composer session={s} />);
  const ta = container.querySelector('textarea') as HTMLTextAreaElement;
  for (const line of lines) {
    fireEvent.change(ta, { target: { value: line } });
    fireEvent.keyDown(ta, { key: 'Enter' });
  }
  return ta;
}

describe('composer /goal routing', () => {
  it('sends /goal to the harness verbatim when the harness owns it, and never drives the app goal', async () => {
    invokeMock.mockClear();
    useStore.setState({ toasts: [] });
    submit(session({ nativeGoal: 'goal' }), '/goal ship it today');

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:send', expect.anything()));
    expect(invokeMock).toHaveBeenCalledWith('sessions:send', expect.objectContaining({ id: 's1', input: expect.objectContaining({ text: '/goal ship it today' }) }));
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:goal', expect.anything());
    // The user is told who took the command, and the Goal panel shows the delegated state.
    expect(useStore.getState().toasts.some((t) => t.text.includes('answers /goal itself'))).toBe(true);
    expect(useStore.getState().panelTab).toBe('goal');
  });

  it('drives the app goal when the session harness has no goal of its own', async () => {
    invokeMock.mockClear();
    useStore.setState({ toasts: [] });
    submit(session(), '/goal ship it today');

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('sessions:goal', { id: 's1', action: 'set', objective: 'ship it today' }));
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:send', expect.anything());
  });

  it('forwards every goal subcommand to the harness, including the ones the app also knows', async () => {
    invokeMock.mockClear();
    useStore.setState({ toasts: [] });
    const lines = ['/goal', '/goal status', '/goal pause', '/goal clear'];
    submitAll(session({ nativeGoal: 'goal' }), lines);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(lines.length));
    expect(invokeMock.mock.calls.map((c) => c[1].input.text)).toEqual(lines);
    expect(invokeMock).not.toHaveBeenCalledWith('sessions:goal', expect.anything());
  });
});
