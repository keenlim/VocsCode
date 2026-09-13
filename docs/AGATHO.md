# Agatho

Status: **P0 shipped.** A floating in-app assistant that drives Vocs Code itself — setting up MCP servers, starting sessions, tidying branches — through a fixed allowlist of app capabilities.

The name is from the *agathos daimon*, the benevolent household spirit of Greek religion: something that lives with you and does small useful things.

## Why it exists

Configuring an MCP server by hand means knowing the transport, the command line or endpoint, and which environment variable holds the token. That is a lot of ceremony for "set up this server". Agatho turns it into a sentence — and the same machinery generalises, because everything the user can do in this app is already an IPC channel.

## Shape

```
src/shared/agent.ts            transcript, proposal and state types
src/shared/agent-manifest.ts   THE ALLOWLIST — one entry per capability
src/main/agents/model.ts       which provider/model answers (shared with session titles)
src/main/agents/context.ts     system prompt + per-turn app context
src/main/agents/tools.ts       manifest -> tool defs; runs one capability
src/main/agents/index.ts       the loop: stream, gate, apply, confirm
src/renderer/src/components/Agatho.tsx   the floating panel
```

The loop is ~80 lines over `anthropicStep` / `openaiStep` (`src/main/harness/native/drivers.ts`), the same provider-neutral step functions the native harness uses. It has no shell, no filesystem and no network of its own.

## The allowlist is the security boundary

`handlers.ts` is a transport-agnostic registry serving 100+ channels — including `secrets:set` and `terminal:input`, which is raw keystrokes into a live PTY. Handing a model `registry.invoke` would be handing it a remote shell. So the default is closed:

- A capability exists in `AGENT_CAPABILITIES` or it does not exist. An unknown tool name is refused before dispatch and logged.
- Each entry carries its own JSON Schema, a **risk tier**, a one-line human summary and an optional projection that trims the channel's reply.
- Tiers: `read` runs immediately; `write` and `destructive` become a **proposal** the user approves. Destructive proposals additionally route through the confirm dialog, listing every target by name.
- The tier is a function of the request, not just the channel. An `http` MCP probe is a network read; a **stdio** probe runs a command line the model chose, so it is gated.
- Projections keep payloads out of the prompt as well as the context: `get_app_settings` deliberately drops the provider table.
- Secrets never reach the model. Agatho learns only that `${GITHUB_TOKEN}` is *required*; the value goes from the renderer to the OS keychain and never enters the transcript, the history or a provider request.
- `agent:*` is blocked on the WebSocket transport (`isRemoteBlocked` in `web-server.ts`), which otherwise forwards every channel.

## Adding a capability

Append an entry to `AGENT_CAPABILITIES`:

```ts
{
  name: 'rename_session',
  channel: 'sessions:rename',
  description: "Change a session's title.",
  parameters: { type: 'object', properties: { … }, required: […], additionalProperties: false },
  tier: () => 'write',
  summarize: (a) => `Rename a session to "${a.title}"`,
  request: (a) => ({ id: a.session_id, title: a.title }),
  project: () => ({ ok: true })
}
```

Rules of thumb:

- Prefer a channel that already narrows the blast radius over a general one. Global MCP servers go through `mcp:import` (merge by id) rather than `settings:update`, which would expose all of settings.
- `description` is the model's only documentation. Say what the tool is for and what to read first.
- Give bulky replies a `project`, or the model's context fills with session metadata.
- Anything that deletes, pushes, merges or spends money is `destructive`.

`tests/agatho.test.ts` asserts the boundary: no forbidden channel is reachable, nothing gated runs unapproved, and `tests/handler-registry.test.ts` proves every allowlisted channel actually exists.

## Model

`settings.agentModel`, falling back to `settings.utilityModel`, falling back to the first usable provider's default. Picking correctly among a dozen capabilities is a harder job than naming a session, so a flash-tier model may struggle — the panel shows which model answered, and a prose-only reply (no tool call) is handled as a normal outcome rather than an error.

## Not yet

- Repo-scoped chat on the right-panel MCP tab (the component takes a scope prop cleanly).
- Conversation persistence across restarts; today the transcript is in-memory.
- A second persona. The runtime is general, but one assistant that can do more beats several that each do less.
