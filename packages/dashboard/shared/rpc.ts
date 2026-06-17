// Type-only import — erased at build. The webview bundle (vite) MUST NOT pull
// node-only code (node:fs, gh/git adapters) from flowd-cli; `import type`
// guarantees the symbol is a compile-time type and leaves nothing in the bundle.
import type { BoardSnapshot } from "@pi-flow/flowd-cli/board-snapshot";
import type { RPCSchema } from "electrobun";

/**
 * The typed RPC seam between the Bun main process and the React webview — the
 * contract both sides import (mirrors Hiss's shared/rpc.ts). Slice #208 adds the
 * read-only board data plane: `getBoard` fetches the live snapshot; `openTicket`
 * opens a ticket URL in the OS browser (click-through is external — the webview
 * never navigates itself to github).
 */
export type DashboardRPC = {
  bun: RPCSchema<{
    requests: {
      /** Liveness probe — the webview calls this on mount; the Bun side answers
       *  with an identifiable string the webview renders. Proves the socket. */
      ping: { params: Record<string, never>; response: { message: string } };
      /** Fetch the live board snapshot (tracking parents + slices + liveness)
       *  by loading the flowd config and calling `fetchBoardSnapshot`. */
      getBoard: { params: Record<string, never>; response: BoardSnapshot };
      /** Open a ticket URL in the OS default browser (click-through). The
       *  webview passes the URL; the Bun side spawns the OS opener. */
      openTicket: { params: { url: string }; response: undefined };
    };
    messages: Record<string, never>;
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: Record<string, never>;
  }>;
};
