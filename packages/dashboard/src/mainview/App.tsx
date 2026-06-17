import { useEffect, useState } from "react";
import { api } from "./lib/electrobun.ts";

// The entire shell UI (#206): call the Bun-side `ping` RPC on mount and render
// the returned string. This is the visible proof the Mainview↔Bun seam works.
export function App(): React.JSX.Element {
  const [message, setMessage] = useState<string>("calling ping()…");

  useEffect(() => {
    api
      .ping()
      .then((r) => setMessage(r.message))
      .catch((err: unknown) => setMessage(`RPC error: ${String(err)}`));
  }, []);

  return (
    <main className="shell">
      <h1>{message}</h1>
      <p className="shell__hint">flowd dashboard — shell scaffold (slice #206)</p>
    </main>
  );
}
