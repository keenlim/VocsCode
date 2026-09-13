/**
 * The global MCP page's built-in GitNexus section: one shared server, scoped per repo.
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
  useStore.setState({ settings: { mcpServers: [], mcpProjectState: {} } as never });
});
afterEach(cleanup);

describe('MCP page GitNexus section', () => {
  it('describes the one shared server and leaves the per-repo switch to the panel tab', async () => {
    await act(async () => {
      render(<McpView />);
    });
    expect(screen.getByText('GitNexus')).toBeTruthy();
    expect(screen.getByText(/One GitNexus process serves every indexed repo/)).toBeTruthy();
    // The serving mode is no longer a choice, so the page writes no such setting.
    expect(screen.queryByText('Per-repo servers')).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('settings:update', expect.objectContaining({ gitnexus: expect.anything() }));
  });
});
