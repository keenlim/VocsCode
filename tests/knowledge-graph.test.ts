/** The shared relation graph and label helpers: pure functions over pages, no I/O. */
import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeGraph,
  expandKnowledgeQuery,
  graphNeighbours,
  normalizeLabel,
  normalizeLabels,
  type KnowledgePage
} from '../src/shared/knowledge';

function page(id: string, over: Partial<KnowledgePage['meta']> = {}, body = 'body'): KnowledgePage {
  return {
    meta: {
      id,
      title: id,
      kind: 'concept',
      status: 'current',
      scope: 'repo',
      keywords: [],
      labels: [],
      sources: [],
      anchors: [],
      related: [],
      supersedes: [],
      contradicts: [],
      ...over
    },
    body,
    path: `${id}.md`
  };
}

describe('labels', () => {
  it('normalizes case, punctuation and surrounding space', () => {
    expect(normalizeLabel('  Auth & Security  ')).toBe('auth-security');
    expect(normalizeLabel('PTY__Guard')).toBe('pty-guard');
    expect(normalizeLabel('!!!')).toBe('');
  });

  it('de-duplicates, drops empties and caps the count', () => {
    expect(normalizeLabels(['A', 'a', 'B!!', ' ', ''])).toEqual(['a', 'b']);
    expect(normalizeLabels(Array.from({ length: 40 }, (_, i) => `label-${i}`))).toHaveLength(24);
  });
});

describe('buildKnowledgeGraph', () => {
  const a = page('architecture/a', { related: ['architecture/b'], labels: ['harness'] });
  const b = page('architecture/b', { labels: ['harness'] });
  const c = page('architecture/c', { anchors: [{ file: 'src/main/index.ts' }] }, 'See [[architecture/a]].');
  const d = page('architecture/d', { anchors: [{ file: 'src/main/index.ts' }] });

  it('adds authored edges with their documented weights', () => {
    const g = buildKnowledgeGraph([a, b, page('architecture/old', { supersedes: ['architecture/a'], contradicts: ['architecture/b'] })]);
    expect(g.edges.find((e) => e.type === 'related')).toMatchObject({ from: 'architecture/a', to: 'architecture/b', weight: 2 });
    expect(g.edges.find((e) => e.type === 'supersedes')).toMatchObject({ weight: 3 });
    expect(g.edges.find((e) => e.type === 'contradicts')).toMatchObject({ weight: 3 });
  });

  it('adds derived edges from shared anchors, shared labels and wikilinks', () => {
    const g = buildKnowledgeGraph([a, b, c, d]);
    expect(g.edges.some((e) => e.type === 'anchor' && e.from === 'architecture/c' && e.to === 'architecture/d')).toBe(true);
    expect(g.edges.some((e) => e.type === 'label' && [e.from, e.to].sort().join() === 'architecture/a,architecture/b')).toBe(true);
    expect(g.edges.some((e) => e.type === 'link' && e.from === 'architecture/c' && e.to === 'architecture/a')).toBe(true);
  });

  it('drops unknown targets and self edges, and counts degree', () => {
    const g = buildKnowledgeGraph([page('x', { related: ['x', 'missing'] })]);
    expect(g.edges).toHaveLength(0);
    expect(g.nodes[0].degree).toBe(0);
  });

  it('is empty for an empty wiki', () => {
    const g = buildKnowledgeGraph([]);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});

describe('graphNeighbours / expandKnowledgeQuery', () => {
  it('returns edges in both directions for one page', () => {
    const g = buildKnowledgeGraph([page('a', { related: ['b'] }), page('b')]);
    expect(graphNeighbours(g, 'a')).toHaveLength(1);
    expect(graphNeighbours(g, 'b')).toHaveLength(1);
  });

  it('boosts neighbours with decay by distance, and never the seeds', () => {
    const g = buildKnowledgeGraph([page('a', { related: ['b'] }), page('b', { related: ['c'] }), page('c')]);
    const boost = expandKnowledgeQuery(g, ['a'], 2, 0.5);
    expect(boost.has('a')).toBe(false);
    expect(boost.get('b')).toBeGreaterThan(0);
    expect(boost.get('c')).toBeGreaterThan(0);
    expect(boost.get('c')).toBeLessThan(boost.get('b')!);
  });

  it('reaches a page that shares only a label, with no authored relation', () => {
    const g = buildKnowledgeGraph([page('a', { labels: ['pty'] }), page('b', { labels: ['pty'] })]);
    expect(expandKnowledgeQuery(g, ['a']).has('b')).toBe(true);
  });
});
