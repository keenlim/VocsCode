/** The rule that decides who answers `/goal` in a session: the harness's own command when it has one,
 *  otherwise the app's goal engine (see src/shared/goal-driver.ts). */
import { describe, expect, it } from 'vitest';
import { goalIn, nativeGoalCommand } from '../src/shared/goal-driver';

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
