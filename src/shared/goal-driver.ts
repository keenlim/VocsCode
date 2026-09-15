/** Who answers `/goal`: the harness's own goal command when it has one, otherwise the app's session goal. */

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
