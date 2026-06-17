import type { BoardSnapshot } from "@pi-flow/flowd-cli/board-snapshot";
import { Electroview } from "electrobun/view";
import type { DashboardRPC } from "shared/rpc";

// The typed RPC client the webview uses (mirrors Hiss's src/mainview/lib/
// electrobun.ts). Defines the Electroview RPC with no inbound handlers (the
// webview only makes outbound requests) and exposes a thin typed `api` wrapper.
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
  /** Liveness probe — returns the Bun-side string (#206). */
  ping: (): Promise<{ message: string }> => rpc.request.ping({}),
  /** Fetch the live board snapshot (tracking parents + slices + liveness). */
  getBoard: (): Promise<BoardSnapshot> => rpc.request.getBoard({}),
  /** Open a ticket URL in the OS browser (external click-through). */
  openTicket: (url: string): Promise<void> => rpc.request.openTicket({ url }),
};
