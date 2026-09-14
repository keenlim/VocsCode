/** The project-agent view the renderer reads: definitions on disk, templates, and git state. */
import type { AgentFileFields } from './agent-files';

export interface ProjectAgent extends AgentFileFields {
  /** Absolute path of the definition file. */
  path: string;
  /** Committed (or staged) in this repo, so the whole team gets it. */
  tracked: boolean;
  /** Matched by the repo's ignore rules. */
  ignored: boolean;
}

export interface AgentTemplate extends AgentFileFields {
  prompt: string;
  /** Where it was read from; the UI labels these as shipped with Vocs Code. */
  source: string;
}

export interface ProjectAgentInfo {
  agents: ProjectAgent[];
  templates: AgentTemplate[];
  /** False when git is unavailable or the folder is not a repository. */
  git: boolean;
  /** True when the project's ignore rule is in place. */
  ignored: boolean;
}
