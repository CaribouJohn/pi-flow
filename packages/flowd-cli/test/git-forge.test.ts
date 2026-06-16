import { describe, expect, test } from "bun:test";
import {
  type CmdRunner,
  GitForgeAdapter,
  checkMainProtectionWarning,
  prFromMarkers,
  reopenComment,
  sliceBranch,
  verdictComment,
} from "../src/git-forge.ts";

function makeFake(opts?: {
  prBase?: string;
  lsRemote?: string;
  prCreate?: string;
  /** Response for `gh pr list --state open`. */
  prList?: string;
  /** Response for `gh pr list --state merged` (defaults to "[]"). */
  mergedPrList?: string;
  /** What `git branch --list <name>` returns (non-empty ⇒ the branch exists locally). */
  localBranch?: string;
  /** Response for `gh api repos/.../branches/.../protection`. Throws when set to "throw". */
  apiProtection?: string | "throw";
}) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const run: CmdRunner = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o?.cwd });
    if (cmd === "git" && args[0] === "ls-remote") return opts?.lsRemote ?? "";
    if (cmd === "git" && args[0] === "branch" && args[1] === "--list")
      return opts?.localBranch ?? "";
    if (cmd === "gh" && args[0] === "pr" && args[1] === "create")
      return opts?.prCreate ?? "https://github.com/o/r/pull/200\n";
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view")
      return JSON.stringify({ baseRefName: opts?.prBase ?? "track/x" });
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
      const stateIdx = args.indexOf("--state");
      const state = stateIdx >= 0 ? args[stateIdx + 1] : "open";
      if (state === "merged") return opts?.mergedPrList ?? "[]";
      return opts?.prList ?? "[]";
    }
    if (cmd === "gh" && args[0] === "api") {
      const val = opts?.apiProtection;
      if (val === "throw") throw new Error("HTTP 404: Branch not protected");
      return (
        val ??
        JSON.stringify({
          required_pull_request_reviews: { required_approving_review_count: 1 },
        })
      );
    }
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

  test("createSliceBranch creates slice/<id> off the track branch when it doesn't exist", async () => {
    const { run, calls } = makeFake(); // git branch --list → "" ⇒ new
    const branch = await new GitForgeAdapter(OPTS(run)).createSliceBranch(2, "track/x");
    expect(branch).toBe("slice/2");
    const git = calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
    expect(git).toContain("checkout track/x");
    expect(git).toContain("checkout -b slice/2"); // -b (create), not -B (reset)
  });

  test("createSliceBranch REUSES an existing slice branch — never -B-resets unpushed work (§8.8)", async () => {
    const { run, calls } = makeFake({ localBranch: "  slice/2\n" }); // exists locally
    const branch = await new GitForgeAdapter(OPTS(run)).createSliceBranch(2, "track/x");
    expect(branch).toBe("slice/2");
    const git = calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
    expect(git).toContain("checkout slice/2"); // plain checkout — keeps prior commits
    expect(git.some((g) => g.includes("-B slice/2"))).toBe(false); // never force-reset
    expect(git.some((g) => g.includes("-b slice/2"))).toBe(false); // never recreate
  });

  test("createTrackBranch creates the branch off the default branch when absent", async () => {
    const { run, calls } = makeFake(); // not on remote, not local
    await new GitForgeAdapter(OPTS(run)).createTrackBranch("track/x");
    const git = calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
    expect(git).toContain("checkout -b track/x origin/main");
    expect(git).toContain("push -u origin track/x");
  });

  test("createTrackBranch is a no-op when the branch already exists on origin (§8.8)", async () => {
    const { run, calls } = makeFake({ lsRemote: "abc\trefs/heads/track/x" });
    await new GitForgeAdapter(OPTS(run)).createTrackBranch("track/x");
    const git = calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
    expect(git.some((g) => g.startsWith("checkout"))).toBe(false); // never created
    expect(git.some((g) => g.startsWith("push"))).toBe(false); // never pushed
  });

  test("createTrackBranch REUSES a local branch from a prior failed push (no -b crash)", async () => {
    const { run, calls } = makeFake({ localBranch: "  track/x\n" }); // local exists, not on remote
    await new GitForgeAdapter(OPTS(run)).createTrackBranch("track/x");
    const git = calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
    expect(git).toContain("checkout track/x"); // plain checkout, not -b
    expect(git.some((g) => g.includes("-b track/x"))).toBe(false);
    expect(git).toContain("push -u origin track/x");
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

  test("pushSlice publishes the slice branch to origin (S6a)", async () => {
    const { run, calls } = makeFake();
    await new GitForgeAdapter(OPTS(run)).pushSlice(2);
    expect(calls.map((c) => c.args.join(" "))).toContain("push origin slice/2");
  });

  test("refreshSliceFromTrack merges the track into the slice and pushes (S7)", async () => {
    const { run, calls } = makeFake();
    const ok = await new GitForgeAdapter(OPTS(run)).refreshSliceFromTrack(2, "track/x");
    expect(ok).toBe(true);
    const git = calls.filter((c) => c.cmd === "git").map((c) => c.args.join(" "));
    expect(git).toContain("checkout -B slice/2 origin/slice/2"); // sync to PR head (picks up remote fixes)
    expect(git).toContain("merge origin/track/x --no-edit");
    expect(git).toContain("push origin slice/2");
  });

  test("refreshSliceFromTrack aborts + returns false on conflict (parks, never pushes)", async () => {
    const calls: string[][] = [];
    const run: CmdRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "merge" && args[1] !== "--abort") {
        throw new Error("CONFLICT (content): merge conflict");
      }
      return "";
    };
    const ok = await new GitForgeAdapter(OPTS(run)).refreshSliceFromTrack(2, "track/x");
    expect(ok).toBe(false);
    expect(calls).toContainEqual(["git", "merge", "--abort"]); // workdir recovered
    expect(calls.some((c) => c[0] === "git" && c[1] === "push")).toBe(false); // never pushed
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

  test("getSlicePr returns null when both open and merged lists are empty", async () => {
    const { run } = makeFake(); // prList defaults to "[]", mergedPrList defaults to "[]"
    const pr = await new GitForgeAdapter(OPTS(run)).getSlicePr(1);
    expect(pr).toBeNull();
  });

  test("getSlicePr returns merged status when the PR was merged out-of-band (§8.8)", async () => {
    const mergedJson = JSON.stringify([{ number: 42, baseRefName: "track/x", comments: [] }]);
    // open list is empty; merged list has the PR
    const { run, calls } = makeFake({ prList: "[]", mergedPrList: mergedJson });
    const pr = await new GitForgeAdapter(OPTS(run)).getSlicePr(1);
    expect(pr).toMatchObject({ number: 42, base: "track/x", status: "merged" });
    // adapter queried both --state open and --state merged
    const listCalls = calls.filter((c) => c.cmd === "gh" && c.args[1] === "list");
    expect(listCalls.some((c) => c.args.includes("open"))).toBe(true);
    expect(listCalls.some((c) => c.args.includes("merged"))).toBe(true);
  });

  test("getSlicePr returns the open PR without querying merged when an open PR exists", async () => {
    const openJson = JSON.stringify([{ number: 99, baseRefName: "track/x", comments: [] }]);
    const { run, calls } = makeFake({ prList: openJson });
    const pr = await new GitForgeAdapter(OPTS(run)).getSlicePr(1);
    expect(pr).toMatchObject({ number: 99, status: "open" });
    // the merged query should NOT have been issued (short-circuit)
    const listCalls = calls.filter((c) => c.cmd === "gh" && c.args[1] === "list");
    expect(listCalls.some((c) => c.args.includes("merged"))).toBe(false);
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

describe("GitForgeAdapter — getMainProtection", () => {
  test("returns protected when the API reports requiresPr + non-author approval", async () => {
    const { run } = makeFake(); // default apiProtection: PR required, 1 approver
    const prot = await new GitForgeAdapter(OPTS(run)).getMainProtection();
    expect(prot).toEqual({ requiresPr: true, requiresNonAuthorApproval: true });
  });

  test("requiresNonAuthorApproval is false when required_approving_review_count is 0", async () => {
    const { run } = makeFake({
      apiProtection: JSON.stringify({
        required_pull_request_reviews: { required_approving_review_count: 0 },
      }),
    });
    const prot = await new GitForgeAdapter(OPTS(run)).getMainProtection();
    expect(prot).toEqual({ requiresPr: true, requiresNonAuthorApproval: false });
  });

  test("returns unprotected defaults (no throw) when the branch has no protection rule (404)", async () => {
    const { run } = makeFake({ apiProtection: "throw" });
    const prot = await new GitForgeAdapter(OPTS(run)).getMainProtection();
    expect(prot).toEqual({ requiresPr: false, requiresNonAuthorApproval: false });
  });

  test("calls gh api with the correct path for the default branch", async () => {
    const { run, calls } = makeFake();
    await new GitForgeAdapter(OPTS(run)).getMainProtection();
    const api = calls.find((c) => c.cmd === "gh" && c.args[0] === "api");
    expect(api?.args[1]).toBe("repos/o/r/branches/main/protection");
  });
});

describe("GitForgeAdapter — track PR / A1 (getTrackPr, openTrackPr, updatePrBody)", () => {
  test("getTrackPr returns null when no open PR exists for the head branch", async () => {
    const { run } = makeFake(); // prList defaults to "[]"
    const pr = await new GitForgeAdapter(OPTS(run)).getTrackPr("track/feature");
    expect(pr).toBeNull();
  });

  test("getTrackPr returns the open PR when one exists", async () => {
    const prJson = JSON.stringify([{ number: 55, baseRefName: "main" }]);
    const { run } = makeFake({ prList: prJson });
    const pr = await new GitForgeAdapter(OPTS(run)).getTrackPr("track/feature");
    expect(pr).toEqual({ number: 55, base: "main", status: "open", reviewAttempts: 0 });
  });

  test("getTrackPr passes --head, --base defaultBranch, --state open to gh pr list", async () => {
    const { run, calls } = makeFake();
    await new GitForgeAdapter(OPTS(run)).getTrackPr("track/feature");
    const list = calls.find((c) => c.cmd === "gh" && c.args[1] === "list");
    expect(list?.args).toContain("--head");
    expect(list?.args).toContain("track/feature");
    expect(list?.args).toContain("--base");
    expect(list?.args).toContain("main"); // defaultBranch from OPTS
    expect(list?.args).toContain("--state");
    expect(list?.args).toContain("open");
    expect(list?.args).toContain("--repo");
    expect(list?.args).toContain("o/r");
  });

  test("openTrackPr creates a PR with correct --head, --base, --title, --body args", async () => {
    const { run, calls } = makeFake({ prCreate: "https://github.com/o/r/pull/300\n" });
    const pr = await new GitForgeAdapter(OPTS(run)).openTrackPr({
      head: "track/feature",
      base: "main",
      title: "Acceptance: track/feature → main",
      body: "PR body here",
    });
    expect(pr).toEqual({ number: 300, base: "main", status: "open", reviewAttempts: 0 });
    const create = calls.find((c) => c.cmd === "gh" && c.args[1] === "create");
    expect(create?.args).toContain("--head");
    expect(create?.args).toContain("track/feature");
    expect(create?.args).toContain("--base");
    expect(create?.args).toContain("main");
    expect(create?.args).toContain("--title");
    expect(create?.args).toContain("Acceptance: track/feature → main");
    expect(create?.args).toContain("--body");
    expect(create?.args).toContain("PR body here");
  });

  test("openTrackPr throws on an unparseable PR number", async () => {
    const { run } = makeFake({ prCreate: "not-a-url\n" });
    await expect(
      new GitForgeAdapter(OPTS(run)).openTrackPr({
        head: "track/feature",
        base: "main",
        title: "t",
        body: "b",
      }),
    ).rejects.toThrow(/could not parse PR number/);
  });

  test("updatePrBody calls gh pr edit with the PR number, --repo, and --body", async () => {
    const { run, calls } = makeFake();
    await new GitForgeAdapter(OPTS(run)).updatePrBody(77, "updated body text");
    const edit = calls.find((c) => c.cmd === "gh" && c.args[1] === "edit");
    expect(edit?.args).toContain("77");
    expect(edit?.args).toContain("--repo");
    expect(edit?.args).toContain("o/r");
    expect(edit?.args).toContain("--body");
    expect(edit?.args).toContain("updated body text");
  });
});

describe("checkMainProtectionWarning (pure)", () => {
  test("returns null when both requiresPr and requiresNonAuthorApproval are true", () => {
    expect(
      checkMainProtectionWarning({ requiresPr: true, requiresNonAuthorApproval: true }, "flow-bot"),
    ).toBeNull();
  });

  test("returns a warning when requiresPr is false", () => {
    const w = checkMainProtectionWarning(
      { requiresPr: false, requiresNonAuthorApproval: false },
      "flow-bot",
    );
    expect(w).toMatch(/flow-bot/);
    expect(w).toMatch(/invariant #1 on layer 3 only/);
    expect(w).toMatch(/\u26a0/);
  });

  test("returns a warning when requiresPr is true but requiresNonAuthorApproval is false", () => {
    const w = checkMainProtectionWarning(
      { requiresPr: true, requiresNonAuthorApproval: false },
      "ci-bot",
    );
    expect(w).not.toBeNull();
    expect(w).toMatch(/ci-bot/);
  });

  test("embeds the actor name in the warning string", () => {
    const w = checkMainProtectionWarning(
      { requiresPr: false, requiresNonAuthorApproval: false },
      "my-custom-actor",
    );
    expect(w).toMatch(/my-custom-actor/);
  });
});
