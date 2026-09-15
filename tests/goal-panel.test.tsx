/**
 * The Goal panel on a session whose harness owns `/goal`: it must show who has the command instead of
 * offering controls that would start a second, competing app-side goal.
 */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined),
  isMac: false,
  modKey: 'Ctrl',
  platform: 'win32',
  isWeb: false,
  webShim: vi.fn()
}));

import { cleanup, render, screen } from '@testing-library/react';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta } from '../src/shared/types';

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 's1',
    title: 'test',
    createdAt: 1,
    updatedAt: 2,
    config: { harness: 'claude', projectRoot: 'G:/proj/a', permissionMode: 'auto' },
    cwd: 'G:/proj/a',
    status: 'idle',
    harnessRef: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
    ...over
  }) as SessionMeta;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  useStore.setState({ panelTab: 'goal', panelBottomTab: 'mcp', panelBottomOpened: [], toasts: [] });
});

afterEach(cleanup);

describe('goal panel with a harness-owned /goal', () => {
  it('says the harness answers /goal and offers no app-side controls', () => {
    render(<RightPanel session={session({ nativeGoal: 'goal' })} />);

    expect(screen.getByText(/belongs to Claude Agent SDK in this session/)).toBeTruthy();
    expect(screen.getByText(/Settings → Goal defaults/)).toBeTruthy();
    expect(document.querySelector('.goal code')?.textContent).toBe('/goal');
    // No objective field, no Set/Restart goal, no pause/clear: the app runs no goal here.
    expect(screen.queryByText('Set goal')).toBeNull();
    expect(screen.queryByText('Restart goal')).toBeNull();
    expect(screen.queryByText('Iteration guard')).toBeNull();
    expect(document.querySelector('.goal textarea')).toBeNull();
  });

  it('keeps the app controls when the session goal belongs to the app', () => {
    render(<RightPanel session={session()} />);

    expect(screen.getByText('Set goal')).toBeTruthy();
    expect(screen.getByText('Iteration guard')).toBeTruthy();
    expect(document.querySelector('.goal textarea')).toBeTruthy();
  });
});
