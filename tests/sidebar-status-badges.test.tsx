// Every status count shares the title row with the wordmark instead of claiming a row of its own.
// jsdom has no layout engine, so the rules that decide whether the badges sit side by side or stack
// — and the margin that keeps them off the wordmark — are asserted as text in
// tests/review-fixes.test.ts; here the placement in the DOM is the production boundary.
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn().mockResolvedValue({});
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { render } from '@testing-library/react';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { useStore } from '../src/renderer/src/store';
import type { SessionMeta, SessionStatus } from '../src/shared/types';

const settings = { folders: [], sidebarWidth: 280, panelWidth: 420 } as never;

const session = (patch: Partial<SessionMeta>): SessionMeta => ({
  id: 's1',
  title: 'Auto title',
  createdAt: 1,
  updatedAt: 2,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'auto' },
  cwd: 'G:/proj/a',
  status: 'idle',
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 },
  ...patch
});

function renderSidebar(statuses: SessionStatus[]) {
  useStore.setState({
    sessions: statuses.map((status, i) => session({ id: `s${i}`, status })),
    settings,
    activeId: 's0',
    view: 'chat'
  });
  return render(<Sidebar />);
}

const headerRow = (container: HTMLElement) => container.querySelector('.sidebar-top') as HTMLElement;
/** Both counts, in render order, as label → text. */
const countedBadges = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('.sidebar-status .badge')].map((el) => (el.textContent ?? '').trim());

describe('sidebar status badges', () => {
  it('renders every count in the header row beside the wordmark, not on a row of its own', () => {
    const { container } = renderSidebar(['running', 'running', 'awaiting']);
    const header = headerRow(container);

    expect([...header.children].map((el) => el.classList[0])).toEqual(['brand', 'sidebar-status', 'sidebar-top-actions']);
    expect(countedBadges(container)).toEqual(['2 running', '1 awaiting']);
    // Nothing is left behind below the header, where a count used to have its own row.
    expect(container.querySelector('.sidebar-summary')).toBeNull();
  });

  it('shows no badge cluster when there is nothing to count', () => {
    const { container } = renderSidebar(['idle', 'stopped']);
    expect(container.querySelector('.sidebar-status')).toBeNull();
    expect(container.querySelector('.sidebar-summary')).toBeNull();
  });

  it('shows only the counts that are non-zero', () => {
    const { container } = renderSidebar(['awaiting']);
    expect(countedBadges(container)).toEqual(['1 awaiting']);
  });

  it('keeps the full wording of a shortened count in its tooltip', () => {
    const { container } = renderSidebar(['awaiting', 'awaiting']);
    const badge = container.querySelectorAll('.sidebar-status .badge')[0] as HTMLElement;
    // The header is narrow, so the label is shortened — the tooltip is where the wording survives.
    expect(badge.textContent).toBe('2 awaiting');
    expect(badge.getAttribute('title')).toBe('2 sessions awaiting approval');
  });
});
