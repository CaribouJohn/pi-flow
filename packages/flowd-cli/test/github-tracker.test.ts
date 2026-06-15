import { describe, expect, test } from "bun:test";
import {
  type GhRunner,
  GitHubTrackerAdapter,
  parseDependsOn,
  parseEffort,
  parseIssueNumber,
  parseParent,
  parseReview,
  parseRole,
} from "../src/github-tracker.ts";

describe("parseIssueNumber", () => {
  test("parses the issue number from the create URL", () => {
    expect(parseIssueNumber("https://github.com/o/r/issues/42\n")).toBe(42);
  });
  test("throws on unparseable output", () => {
    expect(() => parseIssueNumber("https://github.com/o/r/issues/\n")).toThrow(/could not parse/);
  });
});

describe("GitHubTrackerAdapter — createItem / setDependencies", () => {
  function runnerWith(createUrl: string, body = "") {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "create") return createUrl;
      if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ body });
      return "";
    };
    return { run, calls };
  }

  test("createItem creates an issue with role/category/effort/review labels and returns its number", async () => {
    const { run, calls } = runnerWith("https://github.com/o/r/issues/55\n");
    const tracker = new GitHubTrackerAdapter({ repo: "o/r", trackBranch: "track/x", run });
    const id = await tracker.createItem({
      parentId: 1,
      role: "ready-for-agent",
      title: "do a thing",
      body: "the brief",
      effort: "low",
      review: "agent",
      category: "enhancement",
    });
    expect(id).toBe(55);
    const create = calls.find((c) => c[1] === "create");
    expect(create).toContain("do a thing");
    expect(create).toContain("ready-for-agent");
    expect(create).toContain("enhancement");
    expect(create).toContain("effort:low");
    expect(create).toContain("review:agent");
  });

  test("setDependencies appends a ## Blocked by section, preserving the body", async () => {
    const { run, calls } = runnerWith("", "## What\nexisting body");
    const tracker = new GitHubTrackerAdapter({ repo: "o/r", trackBranch: "track/x", run });
    await tracker.setDependencies(7, [3, 5]);
    const edit = calls.find((c) => c[1] === "edit");
    const body = edit?.[edit.indexOf("--body") + 1] ?? "";
    expect(body).toContain("## Blocked by");
    expect(body).toContain("- #3");
    expect(body).toContain("- #5");
    expect(body).toContain("existing body");
  });

  test("setDependencies is a no-op when there are no dependencies", async () => {
    const { run, calls } = runnerWith("");
    const tracker = new GitHubTrackerAdapter({ repo: "o/r", trackBranch: "track/x", run });
    await tracker.setDependencies(7, []);
    expect(calls.some((c) => c[1] === "edit")).toBe(false);
  });
});

describe("parseRole", () => {
  test("finds the canonical role label", () => {
    expect(parseRole(["ready-for-agent", "effort:low"])).toBe("ready-for-agent");
    expect(parseRole(["enhancement", "tracking"])).toBe("tracking");
  });
  test("returns undefined when no role label is present", () => {
    expect(parseRole(["enhancement", "effort:low"])).toBeUndefined();
  });
});

describe("parseEffort / parseReview", () => {
  test("effort from the effort: label", () => {
    expect(parseEffort(["effort:medium"])).toBe("medium");
    expect(parseEffort(["ready-for-agent"])).toBeUndefined();
  });
  test("review defaults to agent, human only when labelled", () => {
    expect(parseReview(["ready-for-agent"])).toBe("agent");
    expect(parseReview(["review:human"])).toBe("human");
  });
});

describe("parseDependsOn", () => {
  test("reads a Depends on: line", () => {
    expect(parseDependsOn("blah\nDepends on: #12, #13\nmore")).toEqual([12, 13]);
  });
  test("reads a ## Blocked by section until the next heading", () => {
    const body = "## Blocked by\n- #5\n- #6\n## Notes\n- #99";
    expect(parseDependsOn(body)).toEqual([5, 6]);
  });
  test("ignores refs outside the dependency section (parent links, prose)", () => {
    const body = "## Parent\n#1\n\nImplements like #42 in prose.";
    expect(parseDependsOn(body)).toEqual([]);
  });
});

describe("parseParent", () => {
  test("reads a ## Parent heading followed by #n", () => {
    expect(parseParent("## Parent\n#7\n\n## What")).toBe(7);
  });
  test("reads an inline Parent: #n", () => {
    expect(parseParent("Parent: #3")).toBe(3);
  });
  test("undefined when no parent", () => {
    expect(parseParent("just a body with #9 in prose")).toBeUndefined();
  });
});

describe("GitHubTrackerAdapter", () => {
  const issuesJson = JSON.stringify([
    {
      number: 1,
      title: "the tracking parent",
      body: "the tracking parent",
      state: "OPEN",
      labels: [{ name: "tracking" }, { name: "enhancement" }],
      assignees: [],
    },
    {
      number: 2,
      title: "add add(a,b)",
      body: "## Parent\n#1\n\n## What\nadd add(a,b)",
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "effort:low" }, { name: "review:agent" }],
      assignees: [{ login: "flow-bot" }],
    },
    {
      number: 3,
      title: "Acceptance",
      body: "## Parent\n#1\n\n## Blocked by\n- #2",
      state: "CLOSED",
      labels: [{ name: "needs-acceptance" }, { name: "review:human" }],
      assignees: [],
    },
    {
      number: 4,
      title: "other track slice",
      body: "## Parent\n#99\nbelongs to another track",
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      assignees: [],
    },
  ]);

  function fakeRunner(): { run: GhRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") return issuesJson;
      if (args[0] === "issue" && args[1] === "view") {
        // Simulate `gh issue view --json labels` for getParentRole
        return JSON.stringify({ labels: [{ name: "tracking" }] });
      }
      return "";
    };
    return { run, calls };
  }

  test("listSlices returns children of the track, mapped, excluding the parent and other tracks", async () => {
    const { run } = fakeRunner();
    const tracker = new GitHubTrackerAdapter({ repo: "o/r", trackBranch: "track/x", run });
    const slices = await tracker.listSlices(1);

    expect(slices.map((s) => s.id)).toEqual([2, 3]); // not #1 (parent), not #4 (track 99)
    const two = slices.find((s) => s.id === 2);
    expect(two).toMatchObject({
      role: "ready-for-agent",
      effort: "low",
      review: "agent",
      assignee: "flow-bot",
      closed: false,
      dependsOn: [],
    });
    const three = slices.find((s) => s.id === 3);
    expect(three).toMatchObject({
      role: "needs-acceptance",
      review: "human",
      assignee: null,
      closed: true,
      dependsOn: [2],
    });
  });

  test("getTrack returns the configured track branch with the parent role", async () => {
    const { run } = fakeRunner();
    const tracker = new GitHubTrackerAdapter({ repo: "o/r", trackBranch: "track/x", run });
    expect(await tracker.getTrack(1)).toEqual({ id: 1, branch: "track/x", role: "tracking" });
  });

  test("mutations call gh with the expected args", async () => {
    const { run, calls } = fakeRunner();
    const tracker = new GitHubTrackerAdapter({ repo: "o/r", trackBranch: "track/x", run });
    await tracker.setAssignee(2, "flow-bot");
    await tracker.closeSlice(2);
    await tracker.comment(2, "hello");

    expect(calls).toContainEqual([
      "issue",
      "edit",
      "2",
      "--repo",
      "o/r",
      "--add-assignee",
      "flow-bot",
    ]);
    expect(calls).toContainEqual(["issue", "close", "2", "--repo", "o/r"]);
    expect(calls).toContainEqual(["issue", "comment", "2", "--repo", "o/r", "--body", "hello"]);
  });

  test("setRole removes existing role labels then adds the target", async () => {
    const { run, calls } = fakeRunner();
    const tracker = new GitHubTrackerAdapter({ repo: "o/r", trackBranch: "track/x", run });
    await tracker.setRole(2, "tracking");
    // adds the target role label
    expect(calls).toContainEqual([
      "issue",
      "edit",
      "2",
      "--repo",
      "o/r",
      "--add-label",
      "tracking",
    ]);
    // clears a pre-existing role label first (single-role invariant)
    expect(calls).toContainEqual([
      "issue",
      "edit",
      "2",
      "--repo",
      "o/r",
      "--remove-label",
      "ready-for-agent",
    ]);
  });
});
