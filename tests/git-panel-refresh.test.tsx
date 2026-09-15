/** @vitest-environment jsdom */
/**
 * The Git panel's PR/issue data is stale by nature: GitHub-side changes are invisible until
 * something asks again. These tests pin that asking — eager load on open, a minute tick, a
 * hidden window that skips the tick and catches up on visibility, a turn-end refresh, and
 * silent failures that never wipe the last list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
(window as unknown as { harness: unknown }).harness = {
  platform: 'win32',
  invoke: invokeMock,
  on: vi.fn().mockReturnValue(() => undefined)
};

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RightPanel } from '../src/renderer/src/components/RightPanel';
import { useStore } from '../src/renderer/src/store';
import type { GitBranchOverview, GitIssue, GitIssueList, GitPullRequest, GitPullRequestList, SessionMeta } from '../src/shared/types';

const session = (status: SessionMeta['status'] = 'idle'): SessionMeta => ({
  id: 's1',
  title: 'test',
  createdAt: 1,
  updatedAt: 2,
  config: { harness: 'native', projectRoot: 'G:/proj/a', permissionMode: 'auto' },
  cwd: 'G:/proj/a',
  status,
  harnessRef: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, turns: 0 }
});

const OVERVIEW: GitBranchOverview = { isRepo: true, base: 'develop', branches: [{ name: 'develop', current: true, isBase: true, merged: false }], worktrees: [] };
/** The overview the panel reads; tests swap it to model a server-side change between refreshes. */
let overview: GitBranchOverview = OVERVIEW;
/** The repo's setup status, which carries the origin URL the housekeeping menu links to. */
let setupStatus: Record<string, unknown> = {};
const pr = (n: number, state: GitPullRequest['state'] = 'OPEN'): GitPullRequest => ({ number: n, title: `PR ${n}`, state, url: `https://github.com/o/r/pull/${n}` });
const issue = (n: number): GitIssue => ({ number: n, title: `Issue ${n}`, state: 'OPEN', url: `https://github.com/o/r/issues/${n}` });

let prs: GitPullRequest[] = [];
let issues: GitIssue[] = [];
let failPrs = false;

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
  prs = [];
  issues = [];
  failPrs = false;
  overview = OVERVIEW;
  setupStatus = {};
  useStore.setState({ panelTab: 'branches', gitPanelView: 'branches', toasts: [] });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'git:branchesOverview') return Promise.resolve(overview);
    if (channel === 'git:pullRequests') return failPrs ? Promise.reject(new Error('gh exploded')) : Promise.resolve({ prs: [...prs], fetchedAt: Date.now() } satisfies GitPullRequestList);
    if (channel === 'git:issues') return Promise.resolve({ issues: [...issues], fetchedAt: Date.now() } satisfies GitIssueList);
    if (channel === 'git:setupStatus') return Promise.resolve(setupStatus);
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Number of times one channel was invoked. */
const calls = (channel: string) => invokeMock.mock.calls.filter(([c]) => c === channel).length;
const prTab = () => screen.getByTitle('Pull requests on GitHub (via gh)');
const issueTab = () => screen.getByTitle('Issues on GitHub (via gh)');

describe('Git panel background refresh', () => {
  it('loads the PR and issue counts on open and re-pulls them on the minute tick', async () => {
    prs = [pr(1), pr(2), pr(3, 'MERGED')];
    issues = [issue(7), issue(8)];
    render(<RightPanel session={session()} />);
    await act(async () => {});
    expect(prTab().textContent).toContain('2');
    expect(issueTab().textContent).toContain('2');

    prs = [pr(1), pr(2), pr(3, 'MERGED'), pr(4)];
    issues = [issue(7), issue(8), issue(9)];
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(prTab().textContent).toContain('3');
    expect(issueTab().textContent).toContain('3');
    expect(calls('git:branchesOverview')).toBe(2);
  });

  it('skips timer polls while the window is hidden and catches up on visibility', async () => {
    prs = [pr(1)];
    render(<RightPanel session={session()} />);
    await act(async () => {});
    const before = calls('git:pullRequests');

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(calls('git:pullRequests')).toBe(before);

    prs = [pr(1), pr(2)];
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(calls('git:pullRequests')).toBe(before + 1);
    expect(prTab().textContent).toContain('2');
  });

  it('refreshes once a turn ends so an agent-created PR lands without waiting for the timer', async () => {
    prs = [pr(1)];
    const view = render(<RightPanel session={session('running')} />);
    await act(async () => {});
    const before = calls('git:pullRequests');

    prs = [pr(1), pr(2)];
    view.rerender(<RightPanel session={session('idle')} />);
    // The refresh is throttled against the mount pull, so it fires on the 20s mark, not the 60s tick.
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(calls('git:pullRequests')).toBe(before + 1);
    expect(prTab().textContent).toContain('2');
  });

  it('keeps the last list when a background pull fails, without an error toast', async () => {
    prs = [pr(1)];
    render(<RightPanel session={session()} />);
    await act(async () => {});
    failPrs = true;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(prTab().textContent).toContain('1');
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('re-syncs remote refs on Refresh, and only on Refresh', async () => {
    render(<RightPanel session={session()} />);
    await act(async () => {});
    // Opening the tab reads local state: no network on mount, and none on the minute tick either.
    expect(calls('git:fetchPrune')).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(calls('git:branchesOverview')).toBe(2);
    expect(calls('git:fetchPrune')).toBe(0);

    // The refresh button is what reaches the remote, and it must do so before re-reading the list —
    // without the prune, a branch deleted on the server keeps its stale ref and the read changes nothing.
    await act(async () => {
      fireEvent.click(screen.getByTitle(/^Refresh/));
    });
    const order = invokeMock.mock.calls.map(([c]) => c as string);
    expect(order.indexOf('git:fetchPrune')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('git:fetchPrune')).toBeLessThan(order.lastIndexOf('git:branchesOverview'));
    expect(calls('git:branchesOverview')).toBe(3);
  });

  it('marks a branch deleted on the server instead of reading as live', async () => {
    overview = {
      isRepo: true,
      base: 'develop',
      branches: [
        { name: 'develop', current: true, isBase: true, merged: false },
        { name: 'feature/widget', current: false, isBase: false, merged: false, upstream: 'origin/feature/widget' },
        { name: 'feature/ghost', current: false, isBase: false, merged: false, upstream: 'origin/feature/ghost', upstreamGone: true }
      ],
      worktrees: []
    };
    render(<RightPanel session={session()} />);
    await act(async () => {});

    const gone = screen.getByText('Deleted on origin').closest('.branch-row')!;
    expect(gone.textContent).toContain('feature/ghost');
    expect(gone.textContent).not.toContain('synced');
    const live = screen.getByText('feature/widget').closest('.branch-row')!;
    expect(live.textContent).toContain('synced');
    expect(live.textContent).not.toContain('Deleted on origin');
  });

  it('offers the server-side branch list from the housekeeping menu', async () => {
    setupStatus = {
      isRepo: true,
      hasCommits: true,
      published: true,
      pushed: true,
      remote: 'https://github.com/acme/repo.git',
      identity: { name: 'e2e', email: 'e2e@example.com' },
      gh: { installed: true, authenticated: true }
    };
    render(<RightPanel session={session()} />);
    await act(async () => {});

    fireEvent.click(screen.getByTitle('Housekeeping'));
    fireEvent.click(screen.getByText('Open branches on GitHub'));
    expect(invokeMock).toHaveBeenCalledWith('app:openExternal', { url: 'https://github.com/acme/repo/branches' });
  });

  it('stops polling when the panel unmounts', async () => {
    prs = [pr(1)];
    const view = render(<RightPanel session={session()} />);
    await act(async () => {});
    view.unmount();
    const before = calls('git:pullRequests');
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(calls('git:pullRequests')).toBe(before);
  });

  it('comes back on the GitHub list the user was reading when the panel is mounted again', async () => {
    issues = [issue(7)];
    const panel = render(<RightPanel session={session()} />);
    await act(async () => {});
    await act(async () => {
      issueTab().click();
    });
    expect(screen.getByRole('button', { name: 'Read issue #7: Issue 7' })).toBeTruthy();

    // A session switch can unmount the panel for a frame: the started session becomes active before
    // the store has been told about it, so the panel has no session and is dropped. Whatever the
    // user was looking at has to be there when it comes back — starting a session from a PR row
    // must not silently send the Git panel back to Branches.
    panel.unmount();
    render(<RightPanel session={session()} />);
    await act(async () => {});
    expect(issueTab().className).toContain('active');
    expect(screen.getByRole('button', { name: 'Read issue #7: Issue 7' })).toBeTruthy();
  });
});
