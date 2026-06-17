import { Electroview } from "electrobun/view";
import type { DashboardRPC } from "shared/rpc";

// The typed RPC client the webview uses (mirrors Hiss's src/mainview/lib/
// electrobun.ts). Defines the Electroview RPC with no inbound handlers (the
// shell only makes outbound requests) and exposes a thin typed `api` wrapper.
const rpc = Electroview.defineRPC<DashboardRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {},
    messages: {},
  },
});

export const electroview = new Electroview({ rpc });

/** Typed calls into the Bun main process. */
export const api = {
  /** Liveness probe — returns the Bun-side string the page renders (#206). */
  ping: (): Promise<{ message: string }> => rpc.request.ping({}),
};
