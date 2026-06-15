import { describe, expect, test } from "bun:test";
import {
  type CmdRunner,
  GitForgeAdapter,
  prFromMarkers,
  reopenComment,
  sliceBranch,
  verdictComment,
} from "../src/git-forge.ts";

function makeFake(opts?: {
  prBase?: string;
  lsRemote?: string;
  prCreate?: string;
  prList?: string;
}) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const run: CmdRunner = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o?.cwd });
    if (cmd === "git" && args[0] === "ls-remote") return opts?.lsRemote ?? "";
    if (cmd === "gh" && args[0] === "pr" && args[1] === "create")
      return opts?.prCreate ?? "https://github.com/o/r/pull/200\n";
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view")
      return JSON.stringify({ baseRefName: opts?.prBase ?? "track/x" });
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return opts?.prList ?? "[]";
    return "";
  };
  return { run, calls };
}

const OPTS = (run: CmdRunner) => ({ repo: "o/r", workdir: "/wd", defaultBranch: "main", run });

describe("sliceBranch", () => {
  test("deterministic slice/<id>", () => {
    expect(sliceBranch(7)).toBe("slice/7");
  });
});

describe("marker round-trip (prFromMarkers)", () => {
  const pr = (bodies: string[]) => ({
    number: 200,
    baseRefName: "track/x",
    comments: bodies.map((body) => ({ body })),
  });

  test("no markers → open, 0 attempts", () => {
    expect(prFromMarkers(pr([]))).toMatchObject({ status: "open", reviewAttempts: 0 });
  });

  test("a REQUEST_CHANGES verdict → changes-requested with findings", () => {
    const result = prFromMarkers(
      pr([verdictComment({ decision: "REQUEST_CHANGES", findings: ["fix x"] })]),
    );
    expect(result).toMatchObject({
      status: "changes-requested",
      reviewAttempts: 1,
      lastFindings: ["fix x"],
    });
  });

  test("reopen after changes → open, attempts unchanged", () => {
    const result = prFromMarkers(
      pr([verdictComment({ decision: "REQUEST_CHANGES", findings: ["x"] }), reopenComment()]),
    );
    expect(result).toMatchObject({ status: "open", reviewAttempts: 1 });
  });

  test("two verdicts ending in APPROVE → approved, 2 attempts", () => {
    const result = prFromMarkers(
      pr([
        verdictComment({ decision: "REQUEST_CHANGES", findings: ["x"] }),
        reopenComment(),
        verdictComment({ decision: "APPROVE", findings: [] }),
      ]),
    );
    expect(result).toMatchObject({ status: "approved", reviewAttempts: 2, lastFindings: [] });
  });
});

describe("GitForgeAdapter — git ops run in the workdir", () => {
  test("driftRefresh merges the default branch into the track branch", async () => {
    const { run, calls } = makeFake();
    await new GitForgeAdapter(OPTS(run)).driftRefresh("track/x");
    const git = calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
    expect(git).toEqual([
      "fetch origin",
      "checkout -f -B track/x origin/track/x",
      "merge origin/main --no-edit",
      "push origin track/x",
    ]);
    expect(calls.every((c) => c.cmd !== "git" || c.cwd === "/wd")).toBe(true);
  });

  test("createSliceBranch checks out slice/<id> off the track branch", async () => {
    const { run, calls } = makeFake();
    const branch = await new GitForgeAdapter(OPTS(run)).createSliceBranch(2, "track/x");
    expect(branch).toBe("slice/2");
    expect(calls.map((c) => c.args.join(" "))).toContain("checkout -B slice/2");
  });

  test("getSliceBranch reflects ls-remote", async () => {
    const present = makeFake({ lsRemote: "abc123\trefs/heads/slice/2" });
    expect(await new GitForgeAdapter(OPTS(present.run)).getSliceBranch(2)).toBe("slice/2");
    const absent = makeFake({ lsRemote: "" });
    expect(await new GitForgeAdapter(OPTS(absent.run)).getSliceBranch(2)).toBeNull();
  });
});

describe("GitForgeAdapter — PRs", () => {
  test("openPr pushes and creates a PR based on the track branch", async () => {
    const { run, calls } = makeFake({ prCreate: "https://github.com/o/r/pull/200\n" });
    const pr = await new GitForgeAdapter(OPTS(run)).openPr(2, "track/x");
    expect(pr).toEqual({ number: 200, base: "track/x", status: "open", reviewAttempts: 0 });
    expect(calls.map((c) => c.args.join(" "))).toContain("push -u origin slice/2");
    const create = calls.find((c) => c.args[1] === "create");
    expect(create?.args).toContain("--base");
    expect(create?.args).toContain("track/x");
  });

  test("mergePr merges a track-based PR with --squash", async () => {
    const { run, calls } = makeFake({ prBase: "track/x" });
    await new GitForgeAdapter(OPTS(run)).mergePr(200);
    const merge = calls.find((c) => c.args[1] === "merge");
    expect(merge?.args).toContain("--squash");
  });

  test("mergePr REFUSES to merge a PR based on the default branch (invariant #1/#6)", async () => {
    const { run, calls } = makeFake({ prBase: "main" });
    await expect(new GitForgeAdapter(OPTS(run)).mergePr(200)).rejects.toThrow(/default branch/);
    expect(calls.some((c) => c.args[1] === "merge")).toBe(false); // never reached the merge
  });

  test("openPr is idempotent: returns the existing PR without creating one (§8.8)", async () => {
    const existing = JSON.stringify([{ number: 200, baseRefName: "track/x", comments: [] }]);
    const { run, calls } = makeFake({ prList: existing });
    const pr = await new GitForgeAdapter(OPTS(run)).openPr(2, "track/x");
    expect(pr.number).toBe(200);
    expect(calls.some((c) => c.args[1] === "create")).toBe(false); // did not create a duplicate
    expect(calls.some((c) => c.args[0] === "push")).toBe(false); // did not re-push
  });

  test("openPr throws on an unparseable PR number (e.g. trailing slash)", async () => {
    const { run } = makeFake({ prCreate: "https://github.com/o/r/pull/200/\n" });
    await expect(new GitForgeAdapter(OPTS(run)).openPr(2, "track/x")).rejects.toThrow(
      /could not parse PR number/,
    );
  });
});

describe("GitForgeAdapter — resilience", () => {
  test("driftRefresh aborts the merge on conflict and rethrows", async () => {
    const calls: string[][] = [];
    const run: CmdRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "merge" && args[1] !== "--abort") {
        throw new Error("CONFLICT (content): merge conflict");
      }
      return "";
    };
    await expect(new GitForgeAdapter(OPTS(run)).driftRefresh("track/x")).rejects.toThrow(
      /CONFLICT/,
    );
    expect(calls).toContainEqual(["git", "merge", "--abort"]); // workdir recovered
    expect(calls.some((c) => c[0] === "git" && c[1] === "push")).toBe(false); // never pushed
  });
});
