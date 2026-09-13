/** Types for Agatho, the in-app assistant. Shared so the renderer renders proposals
 *  from the same metadata the model was shown (see ./agent-manifest). */

/** How much damage a capability can do, and therefore who decides to run it. */
export type RiskTier = 'read' | 'write' | 'destructive';

/** One capability call inside a proposal, already summarised for a human. */
export interface AgentAction {
  capability: string;
  /** One line naming exactly what will happen ("Delete branch vocscode/old-thing"). */
  summary: string;
  args: Record<string, unknown>;
}

/** A batch of gated calls waiting on the user. One step's worth, so "delete 7 branches" is one card. */
export interface AgentProposal {
  id: string;
  tier: 'write' | 'destructive';
  title: string;
  actions: AgentAction[];
  status: 'pending' | 'applied' | 'rejected' | 'failed' | 'cancelled';
  /** Outcome line per action once applied; same order as `actions`. */
  results?: string[];
}

/** One row in Agatho's transcript. */
export type AgentItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; capability: string; summary: string; ok: boolean; detail?: string }
  | { id: string; kind: 'proposal'; proposal: AgentProposal }
  | { id: string; kind: 'error'; text: string };

export interface AgentState {
  items: AgentItem[];
  busy: boolean;
  /** `provider/model` that answered, so a weak utility model is diagnosable rather than mysterious. */
  model?: string;
  /** Set when pi is not installed; the panel shows setup guidance instead of a dead textarea. */
  unavailable?: string;
}

export const AGENT_NAME = 'Agatho';

export const EMPTY_AGENT_STATE: AgentState = { items: [], busy: false };

/** Where the user is right now, sent with each message so "this project" resolves. */
export interface AgentClientContext {
  sessionId?: string;
  view?: string;
}
