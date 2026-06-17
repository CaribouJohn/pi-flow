import type { RPCSchema } from "electrobun";

/**
 * The typed RPC seam between the Bun main process and the React webview — the
 * contract both sides import (mirrors Hiss's shared/rpc.ts). This is the SHELL
 * scaffold (#206): one method, `ping`, proving the Mainview↔Bun round-trip end
 * to end. Board / flowd data land in later slices.
 */
export type DashboardRPC = {
  bun: RPCSchema<{
    requests: {
      /** Liveness probe — the webview calls this on mount; the Bun side answers
       *  with an identifiable string the webview renders. Proves the socket. */
      ping: { params: Record<string, never>; response: { message: string } };
    };
    messages: Record<string, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: Record<string, never>;
  }>;
};
