#!/usr/bin/env bun
/**
 * Self-contained Chrome DevTools Protocol client for debugging a running
 * Electrobun app's webview — no Playwright, no browser extension, no external
 * dependency. Speaks CDP over Bun's built-in WebSocket to the webview's
 * remote-debugging port (Windows WebView2 exposes it when the app is launched
 * with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>).
 *
 * Usage:  bun .claude/skills/electrobun-dev/cdp.ts <command> [args]
 *
 *   screenshot [outPath]     capture the webview to a PNG (default: temp file); prints the path
 *   eval <js>                run JS in the webview, print the JSON result
 *   snapshot                 inventory interactive elements (role/label/text) + title/url
 *   logs [seconds]           install an in-page console/error buffer (idempotent) and dump
 *                            it; if <seconds> given, also stream live console/exceptions
 *   click <cssSelector>      click the first matching element
 *   type <cssSelector> <txt> set an input's value + fire input/change (REFUSES password fields)
 *   reload                   reload the webview (after a rebuild)
 *
 * Config (Hiss defaults; override via env to reuse for another Electrobun app):
 *   CDP_PORT   remote-debugging port           (default 9222)
 *   CDP_HOST   debug host                       (default 127.0.0.1)
 *
 * Portability note: this file is app-agnostic. The only Hiss-specific knowledge
 * (launch command, port) lives in SKILL.md's config block + the `dev:debug`
 * script — lift this folder to promote the skill elsewhere.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.CDP_PORT ?? 9222);
const HOST = process.env.CDP_HOST ?? "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;

type CdpMsg = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };

class Cdp {
  #ws!: WebSocket;
  #id = 1;
  #pending = new Map<number, (m: CdpMsg) => void>();
  #onEvent?: (m: CdpMsg) => void;

  static async open(onEvent?: (m: CdpMsg) => void): Promise<Cdp> {
    let pages: Array<{ type: string; webSocketDebuggerUrl: string }>;
    try {
      pages = (await (await fetch(`${BASE}/json`)).json()) as typeof pages;
    } catch {
      throw new Error(
        `No CDP endpoint on ${BASE}. Is the app running with the debug port? (bun run --filter hiss-desktop dev:debug)`,
      );
    }
    const page = pages.find((p) => p.type === "page");
    if (!page) throw new Error(`CDP up on ${BASE} but no 'page' target found.`);
    const c = new Cdp();
    c.#onEvent = onEvent;
    c.#ws = new WebSocket(page.webSocketDebuggerUrl);
    c.#ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data as string) as CdpMsg;
      if (m.id && c.#pending.has(m.id)) {
        c.#pending.get(m.id)?.(m);
        c.#pending.delete(m.id);
      } else if (m.method) {
        c.#onEvent?.(m);
      }
    });
    await new Promise<void>((r) => c.#ws.addEventListener("open", () => r()));
    return c;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMsg> {
    const id = this.#id++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate JS and return the by-value result (throws on a JS exception). */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { result?: { value?: T }; exceptionDetails?: { text?: string } } };
    if (r.result?.exceptionDetails) {
      throw new Error(`eval threw: ${r.result.exceptionDetails.text ?? "unknown"}`);
    }
    return r.result?.result?.value as T;
  }

  close(): void {
    this.#ws.close();
  }
}

// The in-page console/error ring buffer — installed once, survives until reload.
const INSTALL_BUFFER = `(() => {
  const w = window;
  if (!w.__cdpLog) {
    w.__cdpLog = [];
    const push = (level, parts) => { try {
      w.__cdpLog.push({ t: new Date().toISOString().slice(11,23), level,
        msg: parts.map(a => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' ') });
      if (w.__cdpLog.length > 500) w.__cdpLog.shift();
    } catch {} };
    for (const lvl of ['log','info','warn','error','debug']) {
      const orig = console[lvl] ? console[lvl].bind(console) : () => {};
      console[lvl] = (...a) => { push(lvl, a); orig(...a); };
    }
    w.addEventListener('error', (e) => push('error', ['[window.onerror]', e.message, (e.filename||'') + ':' + (e.lineno||'')]));
    w.addEventListener('unhandledrejection', (e) => push('error', ['[unhandledrejection]', String(e && e.reason)]));
    w.__cdpLog.push({ t: new Date().toISOString().slice(11,23), level: 'info', msg: '[cdp] console buffer installed' });
  }
  return true;
})()`;

function out(v: unknown): void {
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "screenshot": {
      const cdp = await Cdp.open();
      const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as {
        result?: { data?: string };
      };
      cdp.close();
      if (!shot.result?.data) throw new Error("screenshot returned no data");
      const path = args[0] ?? `${process.env.TEMP ?? "/tmp"}\\electrobun-cdp-${Date.now()}.png`;
      await Bun.write(path, Buffer.from(shot.result.data, "base64"));
      out(path);
      break;
    }

    case "eval": {
      const js = args.join(" ");
      if (!js) throw new Error("eval needs a JS expression");
      const cdp = await Cdp.open();
      out(await cdp.eval(js));
      cdp.close();
      break;
    }

    case "snapshot": {
      const cdp = await Cdp.open();
      const snap = await cdp.eval(`JSON.stringify({
        title: document.title, url: location.href,
        text: (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0,500),
        buttons: [...document.querySelectorAll('button,[role=button]')].map(b => (b.getAttribute('aria-label') || (b.textContent||'').trim())).filter(Boolean).slice(0,40),
        links: [...document.querySelectorAll('a')].map(a => (a.getAttribute('aria-label') || (a.textContent||'').trim())).filter(Boolean).slice(0,20),
        inputs: [...document.querySelectorAll('input,textarea')].map(i => ({ kind: i.getAttribute('type') || i.tagName.toLowerCase(), label: i.getAttribute('aria-label') || i.getAttribute('placeholder') || '' }))
      })`);
      out(JSON.parse(snap as string));
      cdp.close();
      break;
    }

    case "logs": {
      const seconds = args[0] ? Number(args[0]) : 0;
      const live: string[] = [];
      const cdp = await Cdp.open((m) => {
        if (m.method === "Runtime.consoleAPICalled") {
          const p = m.params as {
            type?: string;
            args?: Array<{ value?: unknown; description?: string }>;
          };
          const text = (p.args ?? [])
            .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? "")))
            .join(" ");
          live.push(`[live ${p.type}] ${text}`);
        } else if (m.method === "Runtime.exceptionThrown") {
          const p = m.params as {
            exceptionDetails?: { text?: string; exception?: { description?: string } };
          };
          live.push(
            `[live exception] ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? ""}`,
          );
        }
      });
      await cdp.send("Runtime.enable");
      await cdp.eval(INSTALL_BUFFER);
      const buffered = (await cdp.eval(
        "JSON.stringify((window.__cdpLog||[]).slice(-200))",
      )) as string;
      out(JSON.parse(buffered));
      if (seconds > 0) {
        out(`--- streaming live console for ${seconds}s (reproduce now) ---`);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        out(live.length ? live : "(no live console events captured)");
      }
      cdp.close();
      break;
    }

    case "click": {
      const sel = args[0];
      if (!sel) throw new Error("click needs a CSS selector");
      const cdp = await Cdp.open();
      const r = await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return { ok:false, error:'no element matches ${sel.replace(/'/g, "")}' };
        el.scrollIntoView({block:'center'});
        el.click();
        return { ok:true, clicked: el.getAttribute('aria-label') || (el.textContent||'').trim().slice(0,60) };
      })()`);
      out(r);
      cdp.close();
      break;
    }

    case "type": {
      const sel = args[0];
      const text = args.slice(1).join(" ");
      if (!sel) throw new Error("type needs: <selector> <text>");
      const cdp = await Cdp.open();
      const r = await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return { ok:false, error:'no element matches' };
        if ((el.type||'').toLowerCase() === 'password') return { ok:false, error:'refused: will not type into a password field' };
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value')?.set;
        setter ? setter.call(el, ${JSON.stringify(text)}) : (el.value = ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        return { ok:true };
      })()`);
      out(r);
      cdp.close();
      break;
    }

    case "reload": {
      const cdp = await Cdp.open();
      await cdp.send("Page.reload", {});
      cdp.close();
      out("reloaded");
      break;
    }

    case "capture": {
      // Trigger the `/hiss-capture` mechanical command (a LOCAL command — posts
      // nothing to the channel) to dump the full AppState to ~/.hiss/captures/,
      // then return the newest capture file. Far richer than `eval`/`snapshot`
      // for state-shape bugs: it's the exact reconciled AppState at this moment.
      const capturesDir = join(homedir(), ".hiss", "captures");
      const before = await newestCapture(capturesDir);
      const cdp = await Cdp.open();
      const hasComposer = await cdp.eval<boolean>(`!!document.querySelector('.composer__input')`);
      if (!hasComposer) {
        cdp.close();
        out({
          ok: false,
          error: "no composer in view — open a channel first, or run /hiss-capture manually",
        });
        break;
      }
      // Set the composer text via a real input event so React's controlled
      // `text` state updates, then submit with a TRUSTED Enter (CDP key event,
      // which React handles like a genuine keypress).
      await cdp.eval(`(() => {
        const ta = document.querySelector('.composer__input');
        ta.focus();
        const setter = Object.getOwnPropertyDescriptor(ta.__proto__, 'value')?.set;
        setter ? setter.call(ta, '/hiss-capture') : (ta.value = '/hiss-capture');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 150)); // let React flush the state update
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          windowsVirtualKeyCode: 13,
          key: "Enter",
          code: "Enter",
        });
      }
      cdp.close();
      await new Promise((r) => setTimeout(r, 600)); // let the capture write to disk
      const after = await newestCapture(capturesDir);
      if (after && after !== before) {
        out({ ok: true, file: after });
      } else {
        out({
          ok: false,
          error: `no new capture appeared in ${capturesDir} — submit may not have fired; try /hiss-capture manually`,
        });
        process.exitCode = 1;
      }
      break;
    }

    default:
      out(
        "commands: screenshot [path] | eval <js> | snapshot | logs [seconds] | click <sel> | type <sel> <text> | reload | capture",
      );
      if (cmd) process.exitCode = 1;
  }
}

/** Newest `state-*.ts` capture file in `dir` (absolute path), or null. */
async function newestCapture(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.startsWith("state-") && f.endsWith(".ts"));
  } catch {
    return null;
  }
  let newest: { path: string; mtime: number } | null = null;
  for (const f of entries) {
    const path = join(dir, f);
    const mtime = (await stat(path)).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { path, mtime };
  }
  return newest?.path ?? null;
}

await main();
