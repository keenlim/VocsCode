/**
 * The AGENTS.md snippet the MCP panel offers for copying, held to the repo carrying its own copy.
 *
 * The panel tells users to paste this snippet into their AGENTS.md, and this repo does exactly
 * that — so the shipped text and the rules agents actually load here have to stay one text. They
 * can drift silently otherwise: the snippet is the constant, AGENTS.md is hand-written prose, and
 * nothing else in the suite reads AGENTS.md off disk.
 *
 * Node environment on purpose. The panel's own suite (`mcp-tab.test.tsx`) runs under jsdom, which
 * externalizes `node:fs` — and the other snippet assertions already live there.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMORY_GUIDE_MARKDOWN } from '../src/shared/memory-guide';

describe('AGENTS.md memory snippet', () => {
  it('is the text this repo actually carries in its own AGENTS.md', () => {
    // Line endings are normalized: the constant is LF, a Windows checkout of AGENTS.md is CRLF.
    const agentsMd = readFileSync(path.resolve(__dirname, '..', 'AGENTS.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(agentsMd).toContain(MEMORY_GUIDE_MARKDOWN);
  });
});
