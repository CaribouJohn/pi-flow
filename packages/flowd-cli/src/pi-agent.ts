import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { $ } from "bun";
import type { ModelId } from "./model-config.ts";

/**
 * Shared plumbing for the Pi role-agent adapters (#86 implementer, #87 reviewer).
 *
 * Both roles are `pi-coding-agent` sessions. The session creation is behind an
 * injectable {@link CodingSessionFactory} so the adapters' own logic (brief
 * fetch, prompt building, verdict capture, commit) is unit-testable without a
 * live model. The real factory wires `createAgentSession` per the SDK; its
 * runtime behaviour is verified by a live run (see RUNBOOK), since an LLM can't
 * be asserted in a unit test.
 */

/** The minimal slice of a `pi-coding-agent` session this code drives. */
export interface CodingSession {
  prompt(text: string): Promise<void>;
}

/** The SDK's own option types, so our seam can't drift from `createAgentSession`. */
type SessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

export interface CreateSessionOpts {
  model: ModelId;
  apiKey: string;
  cwd: string;
  /** Restrict built-in tools (e.g. read-only for the reviewer). Omit = defaults. */
  tools?: SessionOptions["tools"];
  /** Custom tools (e.g. the reviewer's submit_verdict), typed by the SDK. */
  customTools?: SessionOptions["customTools"];
}

export type CodingSessionFactory = (opts: CreateSessionOpts) => Promise<CodingSession>;

/** The real factory: wires a `pi-coding-agent` session with a per-call API key. */
export const realSessionFactory: CodingSessionFactory = async (opts) => {
  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey(opts.model.provider, opts.apiKey);
  const modelRegistry = ModelRegistry.create(authStorage);
  // find() accepts arbitrary provider/id strings (incl. custom models) — the
  // right call for a config-driven model identity.
  const model = modelRegistry.find(opts.model.provider, opts.model.id);
  if (model === undefined) {
    throw new Error(`unknown model ${opts.model.provider}/${opts.model.id}`);
  }
  const { session } = await createAgentSession({
    model,
    cwd: opts.cwd,
    sessionManager: SessionManager.inMemory(opts.cwd),
    authStorage,
    modelRegistry,
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.customTools !== undefined ? { customTools: opts.customTools } : {}),
  });
  return { prompt: (text: string) => session.prompt(text) };
};

/** Run `gh` and return stdout (default dependency for fetching slice briefs). */
export const realGh = async (args: string[]): Promise<string> => await $`gh ${args}`.text();

/** Check out a branch in the workdir (so the agent writes/commits on the slice branch). */
export const realCheckout = async (workdir: string, branch: string): Promise<void> => {
  await $`git -C ${workdir} checkout ${branch}`.quiet();
};

/** Commit all changes in a workdir; resolves false if there was nothing to commit. */
export const realCommit = async (workdir: string, message: string): Promise<boolean> => {
  const status = await $`git -C ${workdir} status --porcelain`.text();
  if (status.trim().length === 0) return false;
  await $`git -C ${workdir} add -A`.quiet();
  await $`git -C ${workdir} commit -m ${message}`.quiet();
  return true;
};
