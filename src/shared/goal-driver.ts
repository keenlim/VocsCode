/** Who answers `/goal`: the harness's own goal command when it has one, otherwise the app's session goal. */

import type { TranscriptItem } from './types';

/**
 * A harness's own goal command, or null when `/goal` should stay with the app.
 *
 * `advertised` is what the running harness itself offers for `/goal` — slash command names and their
 * aliases, lower-cased by the transport (Claude's `supportedCommands()`). It is the authoritative
 * answer: once the harness has told us what it accepts, a list without `goal` means `goal` really is
 * the app's. Only when the harness has said nothing yet (it starts on the first send, so a brand-new
 * session has no list) does `installed` — a `goal` command found on disk — stand in for it.
 */
export function nativeGoalCommand(input: { preferHarness: boolean; advertised?: readonly string[]; installed?: boolean }): string | null {
  if (!input.preferHarness) return null;
  if (input.advertised?.length) return goalIn(input.advertised) ? 'goal' : null;
  return input.installed ? 'goal' : null;
}

/**
 * True when `/goal` resolves to a goal the harness owns. Namespaced commands are deliberately not a
 * match: a plugin's `my-plugin:goal` is reached as `/my-plugin:goal`, which the app never intercepts.
 */
export function goalIn(commands: readonly string[]): boolean {
  return commands.some((c) => c.toLowerCase() === 'goal');
}

/** One `/<command> …` the user sent, as it went to the harness. */
export interface NativeGoalCommand {
  /** Transcript item it came from, so a list keyed by it stays stable across re-renders. */
  id: string;
  /** The command name as typed, e.g. `/goal`. */
  command: string;
  /** Everything after the command name, verbatim; empty when the command carried no argument. */
  argument: string;
  ts: number;
}

/**
 * Every `/<command> …` in a session's transcript, oldest first.
 *
 * When the harness owns the command the app never sees its goal state — the harness keeps that to
 * itself — so this is what the Goal panel has to work from: the commands the session actually sent,
 * read back out of the app's own transcript (the creation kickoff and every composer send both land
 * there as a user item). The result stays verbatim on purpose. The app cannot know any given
 * harness's control surface, so it never guesses that `argument` is an objective: `/goal pause` is
 * reported as the command it was, not captioned as a goal.
 */
export function nativeGoalCommands(items: readonly TranscriptItem[], command: string): NativeGoalCommand[] {
  const wanted = `/${command.toLowerCase()}`;
  const found: NativeGoalCommand[] = [];
  for (const item of items) {
    if (item.kind !== 'user') continue;
    const text = item.text.trim();
    if (!text.startsWith('/')) continue;
    const split = text.search(/\s/);
    const name = split < 0 ? text : text.slice(0, split);
    // The whole first token has to match: `/goalpost …` is a different command.
    if (name.toLowerCase() !== wanted) continue;
    found.push({ id: item.id, command: name, argument: split < 0 ? '' : text.slice(split).trim(), ts: item.ts });
  }
  return found;
}
