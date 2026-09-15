// The live-session count shares the title row with the wordmark instead of claiming a row of its
// own. jsdom has no layout engine, so the margin that keeps it off the wordmark is asserted as text
// in tests/review-fixes.test.ts; here the placement in the DOM is the production boundary.
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

describe('sidebar running count', () => {
  it('renders beside the wordmark on the header row, not on a row of its own', () => {
    const { container } = renderSidebar(['running', 'running']);
    const header = headerRow(container);

    expect([...header.children].map((el) => el.classList[0])).toEqual(['brand', 'sidebar-running', 'sidebar-top-actions']);
    expect((header.querySelector('.sidebar-running .badge') as HTMLElement).textContent).toBe('2 running');
    // Nothing is left behind below the header, where the count used to have its own row.
    expect(container.querySelector('.sidebar-summary')).toBeNull();
  });

  it('shows no count when nothing is running', () => {
    const { container } = renderSidebar(['idle']);
    expect(container.querySelector('.sidebar-running')).toBeNull();
    expect(container.querySelector('.sidebar-summary')).toBeNull();
  });

  it('keeps the awaiting-approval badge on its own row below the header', () => {
    // Pairing both badges in the header squeezes the row at the sidebar's 200px minimum, and an
    // approval is an alert that reads better on its own line.
    const { container } = renderSidebar(['awaiting', 'running']);
    const header = headerRow(container);
    const summary = container.querySelector('.sidebar-summary') as HTMLElement;

    expect((header.querySelector('.sidebar-running .badge') as HTMLElement).textContent).toBe('1 running');
    expect(header.contains(summary)).toBe(false);
    expect(summary.textContent).toBe('1 awaiting approval');
  });
});
