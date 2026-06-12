/**
 * Smoke check for the preflight helper. Run with:
 *   bun extension/preflight.smoke.ts
 *
 * Covers:
 *   - parseOriginRemote against every URL form `git remote get-url` emits
 *     (SSH scp form, ssh://, https://, with/without `.git`, with trailing
 *     slash) plus rejection cases (empty, garbage, non-github host).
 *   - createPreflight against a stubbed runner: happy path, gh not authed,
 *     no origin, unparseable origin, gh spawn failure, and the combined
 *     "both broken" case so the error list aggregates rather than
 *     short-circuits.
 */

import {
  parseOriginRemote,
  createPreflight,
  type PreflightRun,
} from "./preflight.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`OK   ${label}`);
  else {
    console.error(`FAIL ${label}${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

// --- parseOriginRemote ----------------------------------------------------

const parseCases: Array<[string, string, { owner: string; repo: string } | null]> = [
  ["scp SSH", "git@github.com:CaribouJohn/pi-flow.git", { owner: "CaribouJohn", repo: "pi-flow" }],
  ["scp SSH no .git", "git@github.com:CaribouJohn/pi-flow", { owner: "CaribouJohn", repo: "pi-flow" }],
  ["https", "https://github.com/CaribouJohn/pi-flow.git", { owner: "CaribouJohn", repo: "pi-flow" }],
  ["https no .git", "https://github.com/CaribouJohn/pi-flow", { owner: "CaribouJohn", repo: "pi-flow" }],
  ["https with user", "https://CaribouJohn@github.com/CaribouJohn/pi-flow.git", { owner: "CaribouJohn", repo: "pi-flow" }],
  ["https trailing slash", "https://github.com/CaribouJohn/pi-flow/", { owner: "CaribouJohn", repo: "pi-flow" }],
  ["ssh:// URL form", "ssh://git@github.com/CaribouJohn/pi-flow.git", { owner: "CaribouJohn", repo: "pi-flow" }],
  ["trailing newline tolerated", "git@github.com:CaribouJohn/pi-flow.git\n", { owner: "CaribouJohn", repo: "pi-flow" }],
  ["empty", "", null],
  ["whitespace", "   ", null],
  ["non-github host", "https://gitlab.com/x/y.git", null],
  ["bare path", "CaribouJohn/pi-flow", null],
  ["garbage", "not a url at all", null],
];
for (const [label, url, expected] of parseCases) {
  const got = parseOriginRemote(url);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  check(
    `parseOriginRemote: ${label}`,
    ok,
    ok ? undefined : `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
  );
}

// --- createPreflight ------------------------------------------------------

type Cmd = { bin: string; args: string[] };
type Reply = { stdout?: string; stderr?: string; code: number } | { throw: string };

/**
 * Tiny fake runner. Looks up the (bin, first arg) pair in the table to
 * decide what to return; throws if asked for something we didn't script.
 */
function makeRun(table: Array<[Cmd, Reply]>): PreflightRun {
  return async (bin, args) => {
    for (const [cmd, reply] of table) {
      if (cmd.bin !== bin) continue;
      if (cmd.args.length !== args.length) continue;
      let match = true;
      for (let i = 0; i < args.length; i++) {
        if (cmd.args[i] !== args[i]) { match = false; break; }
      }
      if (!match) continue;
      if ("throw" in reply) throw new Error(reply.throw);
      return {
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        code: reply.code,
      };
    }
    throw new Error(`unstubbed: ${bin} ${args.join(" ")}`);
  };
}

const GH_AUTH_ARGS = ["auth", "status", "--hostname", "github.com"];
const GIT_ORIGIN_ARGS = ["remote", "get-url", "origin"];

async function runCase(label: string, table: Array<[Cmd, Reply]>) {
  const p = createPreflight({ run: makeRun(table) });
  return { label, result: await p.run() };
}

// Happy path
{
  const { result } = await runCase("happy path", [
    [{ bin: "gh", args: GH_AUTH_ARGS }, { code: 0, stderr: "  Logged in to github.com account CaribouJohn (keyring)\n" }],
    [{ bin: "git", args: GIT_ORIGIN_ARGS }, { code: 0, stdout: "git@github.com:CaribouJohn/pi-flow.git\n" }],
  ]);
  check(
    "happy path: ok + user + owner/repo",
    result.ok === true &&
      result.ghAuthed === true &&
      result.ghUser === "CaribouJohn" &&
      result.owner === "CaribouJohn" &&
      result.repo === "pi-flow" &&
      result.errors.length === 0,
    JSON.stringify(result),
  );
}

// gh not authed
{
  const { result } = await runCase("gh not authed", [
    [{ bin: "gh", args: GH_AUTH_ARGS }, { code: 1, stderr: "You are not logged into any GitHub hosts.\n" }],
    [{ bin: "git", args: GIT_ORIGIN_ARGS }, { code: 0, stdout: "git@github.com:CaribouJohn/pi-flow.git\n" }],
  ]);
  check(
    "gh not authed: ok=false, code=gh_not_authed, owner still parsed",
    result.ok === false &&
      result.ghAuthed === false &&
      result.errors.length === 1 &&
      result.errors[0]!.code === "gh_not_authed" &&
      /gh auth login/.test(result.errors[0]!.message) &&
      result.owner === "CaribouJohn",
    JSON.stringify(result),
  );
}

// no origin
{
  const { result } = await runCase("no origin", [
    [{ bin: "gh", args: GH_AUTH_ARGS }, { code: 0, stderr: "  Logged in to github.com account CaribouJohn\n" }],
    [{ bin: "git", args: GIT_ORIGIN_ARGS }, { code: 2, stderr: "error: No such remote 'origin'\n" }],
  ]);
  check(
    "no origin: ok=false, code=no_origin, ghAuthed preserved",
    result.ok === false &&
      result.ghAuthed === true &&
      result.errors.length === 1 &&
      result.errors[0]!.code === "no_origin",
    JSON.stringify(result),
  );
}

// unparseable origin
{
  const { result } = await runCase("unparseable origin", [
    [{ bin: "gh", args: GH_AUTH_ARGS }, { code: 0, stderr: "Logged in to github.com account CaribouJohn\n" }],
    [{ bin: "git", args: GIT_ORIGIN_ARGS }, { code: 0, stdout: "https://gitlab.com/x/y.git\n" }],
  ]);
  check(
    "unparseable origin: ok=false, code=unparseable_remote, message names the URL",
    result.ok === false &&
      result.errors.length === 1 &&
      result.errors[0]!.code === "unparseable_remote" &&
      /gitlab\.com/.test(result.errors[0]!.message),
    JSON.stringify(result),
  );
}

// gh spawn failure (ENOENT)
{
  const { result } = await runCase("gh not on PATH", [
    [{ bin: "gh", args: GH_AUTH_ARGS }, { throw: "spawn gh ENOENT" }],
    [{ bin: "git", args: GIT_ORIGIN_ARGS }, { code: 0, stdout: "git@github.com:CaribouJohn/pi-flow.git\n" }],
  ]);
  check(
    "gh not on PATH: code=gh_not_authed, message mentions PATH",
    result.ok === false &&
      result.ghAuthed === false &&
      result.errors.length === 1 &&
      result.errors[0]!.code === "gh_not_authed" &&
      /PATH/.test(result.errors[0]!.message),
    JSON.stringify(result),
  );
}

// Both broken — errors aggregate (don't short-circuit)
{
  const { result } = await runCase("both broken", [
    [{ bin: "gh", args: GH_AUTH_ARGS }, { code: 1, stderr: "not logged in\n" }],
    [{ bin: "git", args: GIT_ORIGIN_ARGS }, { code: 2, stderr: "no origin\n" }],
  ]);
  const codes = result.errors.map((e) => e.code).sort();
  check(
    "both broken: two errors, one of each code",
    result.ok === false &&
      result.errors.length === 2 &&
      codes[0] === "gh_not_authed" &&
      codes[1] === "no_origin",
    JSON.stringify(result),
  );
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
