/** Agatho: the in-app assistant. A small tool-calling loop over the native provider drivers
 *  whose only reach into the app is the capability allowlist (shared/agent-manifest.ts).
 *
 *  Everything that changes state is proposed, not applied: one step's gated calls become a
 *  single proposal the user approves as a batch, and the loop waits for that decision. */
import type { AgentClientContext, AgentItem, AgentProposal, AgentState } from '../../shared/agent';
import type { AppSettings, SessionMeta } from '../../shared/types';
import type { NativeMessage } from '../harness/native/drivers';
import { anthropicStep, isAnthropicProvider, openaiStep } from '../harness/native/drivers';
import { resolveProviderApiKey } from '../models/providers';
import { errorMessage, shortId } from '../util/async';
import { contextBlock, systemPrompt } from './context';
import { selectBackgroundModel } from './model';
import { agentToolDefs, capabilityFor, runCapability, summarize, tierOf } from './tools';

/** Tool-calling rounds in one turn; enough to read, propose and confirm without looping forever. */
const MAX_STEPS = 12;
/** Wall clock for one turn, excluding time spent waiting on the user. */
const TURN_BUDGET_MS = 5 * 60_000;
/** A proposal nobody answers eventually declines itself rather than pinning the loop open. */
const APPROVAL_TIMEOUT_MS = 15 * 60_000;
/** Gated calls in one batch; a model asking for more than this has lost the plot. */
const MAX_BATCH = 25;
/** Provider messages retained across turns. */
const MAX_HISTORY = 80;
/** Streaming re-renders are batched to this interval. */
const PUSH_INTERVAL_MS = 60;

export interface AgathoDeps {
  getSettings(): AppSettings;
  listSessions(): SessionMeta[];
  getSession(id: string): SessionMeta | undefined;
  getSecret(providerId: string): Promise<string | undefined>;
  /** The handler registry, bound late (the registry owns this agent). */
  invoke(channel: string, req: unknown): Promise<unknown>;
  push(state: AgentState): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export class Agatho {
  private items: AgentItem[] = [];
  private history: NativeMessage[] = [];
  private busy = false;
  private model?: string;
  private abort?: AbortController;
  private pending?: { proposal: AgentProposal; decide: (approve: boolean) => void };
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: AgathoDeps) {}

  state(): AgentState {
    const s = this.deps.getSettings();
    const picked = selectBackgroundModel(s.providers, s.agentModel, s.utilityModel);
    return {
      items: this.items,
      busy: this.busy,
      model: this.model,
      unavailable: picked ? undefined : 'No provider is configured yet. Add an API key under Settings → Providers, then pick a model for Agatho.'
    };
  }

  reset(): void {
    this.cancel();
    this.items = [];
    this.history = [];
    this.model = undefined;
    this.pushNow();
  }

  cancel(): void {
    this.abort?.abort();
    if (this.pending) {
      this.pending.proposal.status = 'cancelled';
      const decide = this.pending.decide;
      this.pending = undefined;
      decide(false);
    }
    this.pushNow();
  }

  resolveProposal(proposalId: string, approve: boolean): void {
    if (!this.pending || this.pending.proposal.id !== proposalId) return;
    const decide = this.pending.decide;
    this.pending = undefined;
    decide(approve);
  }

  async send(text: string, client?: AgentClientContext): Promise<void> {
    const message = text.trim();
    if (!message) return;
    if (this.busy) {
      this.add({ id: shortId('e'), kind: 'error', text: 'Agatho is still working on the previous message. Stop it first.' });
      return;
    }
    this.add({ id: shortId('u'), kind: 'user', text: message });

    const settings = this.deps.getSettings();
    const picked = selectBackgroundModel(settings.providers, settings.agentModel, settings.utilityModel);
    if (!picked) {
      this.add({ id: shortId('e'), kind: 'error', text: 'No usable provider. Add an API key under Settings → Providers.' });
      return;
    }
    this.model = `${picked.provider.id}/${picked.model}`;

    const sessions = this.deps.listSessions();
    const active = client?.sessionId ? this.deps.getSession(client.sessionId) : undefined;
    const system = systemPrompt(contextBlock({ settings, sessions, active, client }));
    const tools = agentToolDefs();
    const apiKey = await resolveProviderApiKey(picked.provider, this.deps.getSecret);
    const step = isAnthropicProvider(picked.provider) ? anthropicStep : openaiStep;

    this.history.push({ role: 'user', text: message });
    this.trimHistory();
    this.busy = true;
    const abort = new AbortController();
    this.abort = abort;
    const deadline = Date.now() + TURN_BUDGET_MS;
    this.pushNow();

    try {
      for (let round = 0; round < MAX_STEPS; round++) {
        if (Date.now() > deadline) {
          this.add({ id: shortId('e'), kind: 'error', text: 'Stopped: this turn ran too long.' });
          break;
        }
        const assistantId = shortId('a');
        let streamed = '';
        const res = await step({
          provider: picked.provider,
          apiKey,
          model: picked.model,
          system,
          history: this.history,
          tools,
          signal: abort.signal,
          onText: (delta) => {
            streamed += delta;
            this.setAssistant(assistantId, streamed);
          },
          onReasoning: () => undefined
        });

        const finalText = res.text || streamed;
        if (finalText.trim()) this.setAssistant(assistantId, finalText);
        else this.remove(assistantId);
        this.history.push({
          role: 'assistant',
          text: res.text,
          toolCalls: res.toolCalls,
          anthropicContent: res.rawContent,
          anthropicModel: picked.model
        });

        if (!res.toolCalls.length) {
          // A model too weak to call tools will answer in prose; that is a normal outcome, not a crash.
          if (!finalText.trim()) this.add({ id: shortId('e'), kind: 'error', text: `${this.model} returned an empty reply.` });
          break;
        }
        if (round === MAX_STEPS - 1) {
          this.add({ id: shortId('e'), kind: 'error', text: 'Stopped: too many steps in one turn.' });
          break;
        }
        await this.runCalls(res.toolCalls, settings);
        this.trimHistory();
        if (abort.signal.aborted) break;
      }
    } catch (e) {
      if (abort.signal.aborted) this.add({ id: shortId('e'), kind: 'error', text: 'Stopped.' });
      else {
        const detail = errorMessage(e);
        this.deps.log('warn', `agatho turn failed: ${detail}`);
        this.add({ id: shortId('e'), kind: 'error', text: detail });
      }
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.pushNow();
    }
  }

  /* ---------------------------------------------------------------- */

  /** Runs one step's tool calls: reads immediately, everything else behind one approval. */
  private async runCalls(calls: { id: string; name: string; args: Record<string, unknown> }[], settings: AppSettings): Promise<void> {
    const planned = calls.map((call) => {
      const cap = capabilityFor(call.name);
      const badArgs = !!call.args && typeof call.args === 'object' && '__parseError' in call.args;
      return { call, cap, badArgs, tier: cap && !badArgs ? tierOf(cap, call.args) : ('read' as const) };
    });

    const gated = planned.filter((p) => p.cap && !p.badArgs && p.tier !== 'read');
    let approved = false;
    let proposal: AgentProposal | undefined;
    if (gated.length) {
      if (gated.length > MAX_BATCH) {
        for (const p of planned) this.toolResult(p.call.id, 'Declined: too many changes were requested at once. Propose them in smaller batches.', true);
        return;
      }
      const destructive = gated.some((p) => p.tier === 'destructive');
      proposal = {
        id: shortId('p'),
        tier: destructive ? 'destructive' : 'write',
        title: gated.length === 1 ? summarize(gated[0].cap!, gated[0].call.args) : `${gated.length} changes`,
        actions: gated.map((p) => ({ capability: p.cap!.name, summary: summarize(p.cap!, p.call.args), args: p.call.args })),
        status: 'pending'
      };
      this.add({ id: shortId('i'), kind: 'proposal', proposal });
      approved = await this.awaitDecision(proposal);
      proposal.status = approved ? 'applied' : this.abort?.signal.aborted ? 'cancelled' : 'rejected';
      proposal.results = [];
      this.pushNow();
    }

    const ctx = { settings };
    for (const p of planned) {
      if (!p.cap) {
        this.deps.log('warn', `agatho asked for an unknown tool: ${p.call.name}`);
        this.toolResult(p.call.id, `Unknown tool "${p.call.name}". Use only the tools you were given.`, true);
        continue;
      }
      if (p.badArgs) {
        this.toolResult(p.call.id, 'Arguments were not valid JSON. Send them again.', true);
        continue;
      }
      const gatedCall = p.tier !== 'read';
      if (gatedCall && !approved) {
        this.toolResult(p.call.id, 'The user declined this action.', true);
        proposal?.results?.push('Declined');
        continue;
      }
      const outcome = await runCapability(p.cap, p.call.args, ctx, this.deps.invoke);
      this.toolResult(p.call.id, outcome.detail, !outcome.ok);
      if (gatedCall) {
        proposal?.results?.push(outcome.ok ? 'Done' : outcome.detail);
        if (!outcome.ok && proposal) proposal.status = 'failed';
      } else {
        this.add({ id: shortId('t'), kind: 'tool', capability: p.cap.name, summary: summarize(p.cap, p.call.args), ok: outcome.ok, detail: outcome.ok ? undefined : outcome.detail });
      }
      this.pushNow();
    }
  }

  private awaitDecision(proposal: AgentProposal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.proposal.id === proposal.id) {
          this.pending = undefined;
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      this.pending = {
        proposal,
        decide: (approve) => {
          clearTimeout(timer);
          resolve(approve);
        }
      };
    });
  }

  private toolResult(toolCallId: string, content: string, isError: boolean): void {
    this.history.push({ role: 'tool', toolCallId, name: '', content, isError: isError || undefined });
  }

  private add(item: AgentItem): void {
    this.items = [...this.items, item];
    this.pushNow();
  }

  private remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
    this.pushNow();
  }

  private setAssistant(id: string, text: string): void {
    const idx = this.items.findIndex((i) => i.id === id);
    const item: AgentItem = { id, kind: 'assistant', text };
    this.items = idx >= 0 ? this.items.map((i, n) => (n === idx ? item : i)) : [...this.items, item];
    this.schedulePush();
  }

  /** Keeps whole turns: history always starts at a user message so tool results keep their call. */
  private trimHistory(): void {
    if (this.history.length <= MAX_HISTORY) return;
    let i = this.history.length - MAX_HISTORY;
    while (i < this.history.length && this.history[i].role !== 'user') i++;
    if (i < this.history.length) this.history = this.history.slice(i);
  }

  private schedulePush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.deps.push(this.state());
    }, PUSH_INTERVAL_MS);
  }

  private pushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.deps.push(this.state());
  }
}
