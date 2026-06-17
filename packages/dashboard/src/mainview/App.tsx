import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BoardSnapshot,
  needsYouGroups,
  recentDone,
  repoBadge,
  runningGroups,
  ticketUrl,
} from "./lib/board-view.ts";
import { api } from "./lib/electrobun.ts";

// Poll cadence for refreshing the board. Aligned to the daemon idle poll
// (DEFAULT_POLL_CADENCE_MS is 60s; the daemon ticks at most once per cadence,
// so a 30s board poll comfortably catches each tick) and kept modest to avoid
// hammering gh/git on every interval.
const POLL_INTERVAL_MS = 30_000;

/** A clickable repo badge + the issue link behaviour, shared by every row. */
function Row({
  repo,
  id,
  title,
}: {
  repo: string;
  id: number;
  title: string;
}): React.JSX.Element {
  const onOpen = (): void => {
    if (repo.length === 0) return; // no repo → no resolvable URL
    void api.openTicket(ticketUrl(repo, id));
  };
  return (
    <button type="button" className="row" onClick={onOpen} disabled={repo.length === 0}>
      <span className="row__id">#{id}</span>
      <span className="row__title">{title}</span>
      {repo.length > 0 && <span className="row__badge">{repoBadge(repo)}</span>}
    </button>
  );
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  // Re-rendered ticker so "updated Xs ago" counts up between refreshes.
  const [, setTick] = useState(0);
  const inflight = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (inflight.current) return; // coalesce overlapping refreshes
    inflight.current = true;
    setLoading(true);
    try {
      const snap = await api.getBoard();
      setSnapshot(snap);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      inflight.current = false;
    }
  }, []);

  // Initial load + poll interval.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Refresh on window focus (operator switches back to the dashboard).
  useEffect(() => {
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // 1s ticker so the "updated Xs ago" label stays live.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const ageLabel = ((): string => {
    if (loading && snapshot === null) return "loading…";
    if (updatedAt === null) return "—";
    const secs = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
    return `updated ${secs}s ago`;
  })();

  const needs = snapshot ? needsYouGroups(snapshot) : [];
  const running = snapshot ? runningGroups(snapshot) : [];
  const done = snapshot ? recentDone(snapshot) : [];

  return (
    <main className="board">
      <header className="board__bar">
        <h1 className="board__title">flowd board</h1>
        <div className="board__status">
          <span className={`board__age${loading ? " is-loading" : ""}`}>{ageLabel}</span>
          <button type="button" className="board__refresh" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      {error !== null && <div className="board__error">error: {error}</div>}

      <div className="board__cols">
        <section className="col">
          <h2 className="col__head">NEEDS YOU</h2>
          {needs.length === 0 && <p className="col__empty">nothing waiting on you</p>}
          {needs.map((group) => (
            <div key={group.reason} className="group">
              <h3 className="group__head">{group.reason}</h3>
              {group.items.map((item) => (
                <Row
                  key={`${item.repo}#${item.id}`}
                  repo={item.repo}
                  id={item.id}
                  title={item.title}
                />
              ))}
            </div>
          ))}
        </section>

        <section className="col">
          <h2 className="col__head">RUNNING</h2>
          {running.length === 0 && <p className="col__empty">nothing running</p>}
          {running.map((group) => (
            <div key={group.trackId} className="group">
              <h3 className="group__head">track #{group.trackId}</h3>
              {group.items.map((item) => (
                <Row
                  key={`${item.repo}#${item.id}`}
                  repo={item.repo}
                  id={item.id}
                  title={item.title}
                />
              ))}
            </div>
          ))}
        </section>

        <section className="col">
          <h2 className="col__head">DONE</h2>
          {done.length === 0 && <p className="col__empty">nothing done yet</p>}
          {done.map((item) => (
            <Row key={`${item.repo}#${item.id}`} repo={item.repo} id={item.id} title={item.title} />
          ))}
        </section>
      </div>
    </main>
  );
}
