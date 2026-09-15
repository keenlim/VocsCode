/** The rule that decides who answers `/goal` in a session: the harness's own command when it has one,
 *  otherwise the app's goal engine (see src/shared/goal-driver.ts). */
import { describe, expect, it } from 'vitest';
import { goalIn, nativeGoalCommand, nativeGoalCommands } from '../src/shared/goal-driver';
import type { TranscriptItem } from '../src/shared/types';

const user = (id: string, text: string, ts: number): TranscriptItem => ({ id, kind: 'user', ts, text });
const assistant = (id: string, text: string, ts: number): TranscriptItem => ({ id, kind: 'assistant', ts, text });

describe('goalIn', () => {
  it('matches the exact command name, whatever its case', () => {
    expect(goalIn(['compact', 'goal'])).toBe(true);
    expect(goalIn(['GOAL'])).toBe(true);
  });

  it('does not match a namespaced command: /my-plugin:goal is reached by its full name, which the app never intercepts', () => {
    expect(goalIn(['my-plugin:goal'])).toBe(false);
  });

  it('does not match a name that merely starts or ends with goal', () => {
    expect(goalIn(['goalify', 'my-goal', 'goals'])).toBe(false);
  });
});

describe('nativeGoalCommand', () => {
  it('hands /goal to the harness when the harness advertises it', () => {
    expect(nativeGoalCommand({ preferHarness: true, advertised: ['compact', 'goal'] })).toBe('goal');
  });

  it('keeps /goal with the app once the harness has advertised a list without it', () => {
    // The advertised list is authoritative: a running harness that does not offer `goal` means the
    // app's engine is the right answer, even when a goal skill happens to sit on disk.
    expect(nativeGoalCommand({ preferHarness: true, advertised: ['compact', 'help'], installed: true })).toBeNull();
  });

  it('falls back to the installed command before the harness has said anything', () => {
    expect(nativeGoalCommand({ preferHarness: true, installed: true })).toBe('goal');
    expect(nativeGoalCommand({ preferHarness: true, installed: false })).toBeNull();
    expect(nativeGoalCommand({ preferHarness: true })).toBeNull();
  });

  it('leaves /goal with the app when the preference is off, whatever the harness offers', () => {
    expect(nativeGoalCommand({ preferHarness: false, advertised: ['goal'], installed: true })).toBeNull();
  });
});

describe('nativeGoalCommands', () => {
  it('reads back the goal commands a session sent, oldest first', () => {
    const items = [
      user('u1', '/goal ship the release', 10),
      assistant('a1', 'Goal set.', 11),
      user('u2', 'anything else?', 12),
      user('u3', '/goal ship the release by Friday', 20)
    ];

    expect(nativeGoalCommands(items, 'goal')).toEqual([
      { id: 'u1', command: '/goal', argument: 'ship the release', ts: 10 },
      { id: 'u3', command: '/goal', argument: 'ship the release by Friday', ts: 20 }
    ]);
  });

  it('keeps the argument verbatim, including inner spacing, newlines and a token flag', () => {
    expect(nativeGoalCommands([user('u1', '/goal --tokens 250K  ship  it\nand then some', 1)], 'goal')).toEqual([
      { id: 'u1', command: '/goal', argument: '--tokens 250K  ship  it\nand then some', ts: 1 }
    ]);
  });

  it('reports a bare command with no argument rather than inventing one', () => {
    expect(nativeGoalCommands([user('u1', '/goal', 1)], 'goal')).toEqual([{ id: 'u1', command: '/goal', argument: '', ts: 1 }]);
  });

  it('never captions a control sub-command as an objective: /goal pause is returned as sent', () => {
    // The app cannot know any harness's control surface, so it reports the command line and nothing
    // more. `/goal pause` is a pause, not an objective named "pause".
    expect(nativeGoalCommands([user('u1', '/goal pause', 1)], 'goal')).toEqual([{ id: 'u1', command: '/goal', argument: 'pause', ts: 1 }]);
  });

  it('matches the command name case-insensitively, as the composer does', () => {
    expect(nativeGoalCommands([user('u1', '/GOAL ship it', 1)], 'goal')).toEqual([{ id: 'u1', command: '/GOAL', argument: 'ship it', ts: 1 }]);
  });

  it('ignores a longer command that merely starts with the name', () => {
    expect(nativeGoalCommands([user('u1', '/goalpost ship it', 1)], 'goal')).toEqual([]);
  });

  it('ignores the command name appearing anywhere but the start of a user message', () => {
    const items = [user('u1', 'run /goal ship it', 1), user('u2', 'mid\n/goal ship it', 2), assistant('a1', '/goal ship it', 3)];
    expect(nativeGoalCommands(items, 'goal')).toEqual([]);
  });

  it('follows the session command name rather than assuming `goal`', () => {
    const items = [user('u1', '/objective ship it', 1), user('u2', '/goal ship it', 2)];
    expect(nativeGoalCommands(items, 'objective')).toEqual([{ id: 'u1', command: '/objective', argument: 'ship it', ts: 1 }]);
  });

  it('returns nothing for a session that never sent the command', () => {
    expect(nativeGoalCommands([], 'goal')).toEqual([]);
    expect(nativeGoalCommands([user('u1', 'hello', 1)], 'goal')).toEqual([]);
  });
});
