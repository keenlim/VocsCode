/**
 * The global MCP page's built-in GitNexus section: the two serving modes and the save.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { McpView } from '../src/renderer/src/components/McpView';
import { useStore } from '../src/renderer/src/store';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ invoke, isMac: false, modKey: 'Ctrl' }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  useStore.setState({ settings: { mcpServers: [], mcpProjectState: {}, gitnexus: { mode: 'per-repo' } } as never });
});
afterEach(cleanup);

describe('MCP page GitNexus mode', () => {
  it('offers both serving modes and saves the chosen one', async () => {
    await act(async () => {
      render(<McpView />);
    });
    expect(screen.getByText('GitNexus')).toBeTruthy();
    expect(screen.getByText('Per-repo servers')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('One shared server'));
    });
    expect(invoke).toHaveBeenCalledWith('settings:update', { gitnexus: { mode: 'shared' } });
  });
});
