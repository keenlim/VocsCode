/**
 * Agatho's floating panel. What matters here is that a proposal is legible before it is
 * approved — every target named, destructive batches marked — and that approving goes through
 * the confirm dialog rather than straight to the main process.
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Agatho } from '../src/renderer/src/components/Agatho';
import { ConfirmHost } from '../src/renderer/src/components/ui';
import { useStore } from '../src/renderer/src/store';
import type { AgentItem, AgentState } from '../src/shared/agent';
import type { AppSettings } from '../src/shared/types';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, on: () => () => undefined, isMac: false, modKey: 'Ctrl', platform: 'win32', isWeb: false }));

function setup(items: AgentItem[], agentState: Partial<AgentState> = {}, agentSettings: AppSettings['agent'] = { enabled: true, collapsed: false }) {
  useStore.setState({
    settings: { agent: agentSettings, onboardingDone: true } as unknown as AppSettings,
    agent: { items, busy: false, ...agentState },
    activeId: 's1',
    view: 'mcp'
  } as never);
  return render(
    <>
      <Agatho />
      <ConfirmHost />
    </>
  );
}

const deleteProposal: AgentItem = {
  id: 'i1',
  kind: 'proposal',
  proposal: {
    id: 'p1',
    tier: 'destructive',
    title: '3 changes',
    status: 'pending',
    actions: [
      { capability: 'delete_branch', summary: 'Delete branch feature-a', args: {} },
      { capability: 'delete_branch', summary: 'Delete branch feature-b', args: {} },
      { capability: 'delete_branch', summary: 'Delete branch feature-c', args: {} }
    ]
  }
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('Agatho panel', () => {
  it('collapses to an avatar and stays hidden when switched off', () => {
    const { unmount } = setup([], {}, { enabled: true, collapsed: true });
    expect(screen.getByLabelText('Open Agatho')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Ask Agatho…')).toBeNull();
    unmount();
    setup([], {}, { enabled: false, collapsed: false });
    expect(screen.queryByLabelText('Agatho')).toBeNull();
  });

  it('names every target of a destructive batch before it is approved', () => {
    setup([deleteProposal]);
    expect(screen.getByText('Delete branch feature-a')).toBeTruthy();
    expect(screen.getByText('Delete branch feature-b')).toBeTruthy();
    expect(screen.getByText('Delete branch feature-c')).toBeTruthy();
    expect(screen.getByText('Apply all 3')).toBeTruthy();
  });

  it('asks for confirmation before applying a destructive batch, and sends nothing if refused', async () => {
    setup([deleteProposal]);
    fireEvent.click(screen.getByText('Apply all 3'));
    await act(async () => undefined);
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    await act(async () => undefined);
    expect(invoke).not.toHaveBeenCalledWith('agent:resolve', expect.anything());
  });

  it('resolves the proposal once the confirmation is accepted', async () => {
    setup([deleteProposal]);
    fireEvent.click(screen.getByText('Apply all 3'));
    await act(async () => undefined);
    fireEvent.click(screen.getByText('Apply'));
    await act(async () => undefined);
    expect(invoke).toHaveBeenCalledWith('agent:resolve', { proposalId: 'p1', approve: true });
  });

  it('declines without a confirmation dialog', async () => {
    setup([deleteProposal]);
    fireEvent.click(screen.getByText('Decline'));
    await act(async () => undefined);
    expect(invoke).toHaveBeenCalledWith('agent:resolve', { proposalId: 'p1', approve: false });
  });

  it('sends the focused session as context so "this project" resolves', async () => {
    setup([]);
    fireEvent.change(screen.getByPlaceholderText('Ask Agatho…'), { target: { value: 'which branches are stale?' } });
    fireEvent.click(screen.getByLabelText('Send'));
    await act(async () => undefined);
    expect(invoke).toHaveBeenCalledWith('agent:send', { text: 'which branches are stale?', context: { sessionId: 's1', view: 'mcp' } });
  });

  it('shows setup guidance instead of a dead textarea when no provider is configured', () => {
    setup([], { unavailable: 'No provider is configured yet.' });
    expect(screen.getByText('No provider is configured yet.')).toBeTruthy();
  });

  it('shows which model answered', () => {
    setup([{ id: 'a1', kind: 'assistant', text: 'Done.' }], { model: 'anthropic/claude-haiku-4-5' });
    expect(screen.getByText('anthropic/claude-haiku-4-5')).toBeTruthy();
  });
});

describe('Agatho panel placement', () => {
  /** The panel is fixed-position and anchored by its bottom edge; jsdom has no layout engine. */
  const viewport = (w: number, h: number) => {
    for (const [key, value] of [
      ['innerWidth', w],
      ['innerHeight', h]
    ] as const) {
      Object.defineProperty(window, key, { value, configurable: true });
    }
  };

  it('parks bottom-right and anchors by the bottom edge, so the transcript grows upward', () => {
    viewport(1024, 800);
    setup([], {}, { enabled: true, collapsed: false });
    const panel = screen.getByRole('dialog') as HTMLElement;
    // 800 - 52 (avatar) - 24 (park margin) = 724: the panel's foot stays 24px up, whatever it holds.
    expect(panel.style.bottom).toBe('24px');
    expect(panel.style.left).toBe('640px');
    expect(panel.style.top).toBe('');
  });

  it('grows upward without moving its foot as the transcript fills up', () => {
    viewport(1024, 800);
    const items: AgentItem[] = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, kind: 'assistant', text: `line ${i}` }));
    const { unmount } = setup(items, {}, { enabled: true, collapsed: false });
    const panel = screen.getByRole('dialog') as HTMLElement;
    expect(panel.style.bottom).toBe('24px');
    expect(screen.getAllByText(/^line /)).toHaveLength(40);
    unmount();
    setup([], {}, { enabled: true, collapsed: false });
    expect((screen.getByRole('dialog') as HTMLElement).style.bottom).toBe('24px');
  });

  it('lets the user drag the panel all the way to the bottom instead of reserving a full panel height', () => {
    viewport(1024, 800);
    // The bottom-most reachable spot for the avatar; the old clamp reserved 460px of panel height
    // and stopped the panel hundreds of pixels short of here.
    setup([], {}, { enabled: true, collapsed: false, x: 40, y: 800 - 52 - 8 });
    const panel = screen.getByRole('dialog') as HTMLElement;
    expect(panel.style.bottom).toBe('8px');
    expect(panel.style.left).toBe('40px');
  });

  it('keeps the avatar in reach when the stored position is off the bottom of a shorter window', () => {
    viewport(1024, 600);
    setup([], {}, { enabled: true, collapsed: true, x: 9000, y: 5000 });
    const avatar = screen.getByLabelText('Open Agatho') as HTMLElement;
    expect(avatar.style.bottom).toBe('8px');
    expect(avatar.style.left).toBe(`${1024 - 52 - 8}px`);
  });
});
