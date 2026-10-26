import { expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";
import type { AgentInfo, On } from "claude-code";

import { renderGraphSvg } from "../hooks/svg";
import {
  attributeCost,
  describeAction,
  editedFile,
  flags,
  fold,
  layoutTree,
  meta,
  note,
  outline,
  spend,
  summarize,
  TILE_H,
  TILE_W,
  totals,
} from "../hooks/graph";
import type { OrchestraGraph, OrchestraHistory, OrchestraNode } from "../types";

const node = (
  id: string,
  parentId: string | null,
  status: OrchestraNode["status"],
  extra: Partial<OrchestraNode> = {},
): OrchestraNode => ({
  id,
  parentId,
  kind: parentId === null ? "main" : "agent",
  label: id,
  type: "Explore",
  status,
  calls: 0,
  startedAt: 0,
  ...extra,
});

const BAND = {
  plugin: "orchestra",
  component: "AbovePrompt",
  requestId: "band",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const;

const PANE = {
  plugin: "orchestra",
  component: "Pane",
  requestId: "orchestra",
  props: {
    title: "Orchestra",
    isFocused: false,
    bodyColumns: 120,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

const SURFACES = ["terminal", "desktop"] as const;

const baseAgents: AgentInfo[] = [
  { id: "a1", description: "Plan the change", type: "Plan", status: "completed" },
  { id: "a2", description: "Search the repo", type: "Explore", status: "running" },
  { id: "a3", description: "Nested scan", type: "Explore", status: "waiting", parentId: "a2" },
];

function engine(on: On, agents: AgentInfo[] = baseAgents) {
  const viewed: unknown[] = [];
  on("command.register", () => ({ value: { command: "orchestra" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.view", (_, e) => {
    viewed.push(e);

    return { value: {} };
  });
  on("agent.list", () => ({ value: agents }));
  on("session.usage", () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("tool.call", () => ({ result: {} }));
  on("classic.Notification", () => ({}));

  return { viewed };
}

/** A permission prompt from inside agent a3, as the engine raises it. */
const askFromA3 = ($: Parameters<TestBody>[0]) =>
  $.classic.Notification({
    message: "Claude needs your permission to use Bash",
    notification_type: "permission_prompt",
    agent_id: "a3",
  });

const run = ($: Parameters<TestBody>[0], args: string) =>
  $.command.run({
    command: "orchestra",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 80 },
  });

test("an action reads as the tool and its main argument", () => {
  expect(describeAction("Bash", { command: "ls   -la\n~/x" })).toBe("Bash ls -la ~/x");
  expect(describeAction("mcp__ccd_session__start_session", { title: "t", prompt: "do it" })).toBe(
    "start_session do it",
  );
  expect(describeAction("TodoWrite", { todos: [] })).toBe("TodoWrite");
  expect(editedFile("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
  expect(editedFile("Read", { file_path: "/a/b.ts" })).toBeUndefined();
});

test("flags call out repeats, slow runs and files two agents edited", () => {
  const graph: OrchestraGraph = {
    nodes: [
      node("main", null, "run"),
      node("fast", "main", "done", { endedAt: 30_000 }),
      node("slow", "main", "run", {
        repeat: { action: "Grep foo", count: 6 },
        edited: ["/x/a.ts"],
      }),
      node("other", "main", "done", { endedAt: 20_000, edited: ["/x/a.ts"] }),
    ],
    now: 0,
  };
  const slow = graph.nodes[2] as OrchestraNode;
  expect(flags(slow, graph, 120_000)).toEqual(["same Grep ×6", "5× slower", "shared file a.ts"]);
  expect(flags(graph.nodes[1] as OrchestraNode, graph, 120_000)).toEqual([]);
});

test("flags call out a quiet run and a cost far above its siblings", () => {
  const graph: OrchestraGraph = {
    nodes: [
      node("main", null, "run"),
      node("a", "main", "run", { lastAt: 0, costUsd: 1.5 }),
      node("b", "main", "done", { costUsd: 0.2 }),
      node("c", "main", "done", { costUsd: 0.3 }),
    ],
    now: 0,
  };
  expect(flags(graph.nodes[1] as OrchestraNode, graph, 200_000)).toEqual(["quiet 3m20", "cost 6×"]);
});

test("totals names the top spender, and outline nests children under parents", () => {
  const graph: OrchestraGraph = {
    nodes: [
      node("main", null, "run"),
      node("a", "main", "run", { costUsd: 0.9 }),
      node("b", "main", "run", { costUsd: 0.3 }),
    ],
    costUsd: 1.5,
    now: 0,
  };
  expect(totals(graph)).toContain("top a 60%");
  const tree: OrchestraGraph = {
    nodes: [
      node("main", null, "run"),
      node("a", "main", "done", { calls: 2, endedAt: 30_000, result: "Found 3" }),
    ],
    now: 60_000,
  };
  expect(outline(tree)).toBe(
    "- **main** (run, 0 calls, 1m00)\n  - **a** (done, 2 calls, 30s): Found 3",
  );
});

test("past six finished children the finished ones fold, unless opened", () => {
  const kids = [
    node("r", "main", "run"),
    ...Array.from({ length: 7 }, (_, i) => node(`d${i}`, "main", "done")),
  ];
  expect(fold(kids, false).shown.map((n) => n.id)).toEqual(["r"]);
  expect(fold(kids, false).folded).toHaveLength(7);
  expect(fold(kids, true).shown).toHaveLength(8);
  expect(fold(kids.slice(0, 7), false).folded).toEqual([]);
});

test("the note says what a node waits on, does, or found", () => {
  expect(note(node("a", "main", "wait", { action: "Bash rm -rf build" }))).toBe(
    "needs you: Bash rm -rf build",
  );
  expect(note(node("a", "main", "run", { action: "Read x.ts" }))).toBe("▸ Read x.ts");
  expect(note(node("a", "main", "done", { result: "Found 3" }))).toBe("↳ Found 3");
  expect(note(node("a", "main", "fail"))).toBe("✕ failed");
});

test("summary and totals count the whole session", () => {
  const graph: OrchestraGraph = {
    nodes: [
      { ...node("main", null, "wait"), calls: 2 },
      { ...node("a", "main", "run"), calls: 5 },
      { ...node("b", "main", "fail"), calls: 1 },
    ],
    costUsd: 1.5,
    waitMs: 62_000,
    now: 0,
  };
  expect(summarize(graph)).toBe("orchestra · 2 nodes · 1 running · 1 needs you");
  expect(totals(graph)).toBe(
    "2 agents · 1 running · 1 failed · 8 calls · $1.50 · waited on you 1m02",
  );
});

test("on the terminal each agent is a tile whose title opens its conversation", async ($, on) => {
  const clock = mock.clock(on);
  const { viewed } = engine(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await askFromA3($);
  await clock.advance(1100);

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await pane.find({ type: "Box", key: "tile-a3" })).toBeDefined();
  expect((await pane.find({ type: "Text", text: /needs you/ }))?.props.color).toBe("warning");
  expect((await pane.find({ type: "Client", key: "wires" }))?.props.module).toContain("wires");
  await pane.press({ key: "open-a2" });
  expect(viewed).toEqual([{ agentId: "a2" }]);
  await pane.unmount();
});

test("on the desktop the view is one interactive svg with hover cards and a timeline", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.tool.call({ tool: "Bash", command: "ls -la", agentId: "a2" });
  // A new current action is a fine change: the svg takes it up at its five-minute refresh.
  await clock.advance(301_000);

  const pane = await $.ui.mount({ ...PANE, surface: "desktop" });
  const svg = await pane.find({ type: "Svg" });
  const source = String(svg?.props.source);
  expect(svg?.props.isInteractive).toBe(true);
  expect(source).toContain("Search the repo");
  expect(source).toContain("animateMotion");
  expect(source).toMatch(/#c\d+:hover~#p\d+/);
  expect(source).toContain("Bash ls -la");
  expect(source).toContain("Timeline");
  expect(await pane.find({ type: "Box", key: "tile-a2" })).toBeUndefined();
  await pane.unmount();
});

test("the svg fits the pane width and keeps its proportions", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(1100);

  const narrow = await $.ui.mount({
    ...PANE,
    surface: "desktop",
    props: { ...PANE.props, bodyColumns: 40 },
  });
  const svg = await narrow.find({ type: "Svg" });
  expect(svg?.props.width).toBe(400);
  const natural = /viewBox="0 0 (\d+) (\d+)"/.exec(String(svg?.props.source));
  const ratio = Number(natural?.[2]) / Number(natural?.[1]);
  expect(Math.abs(Number(svg?.props.height) / 400 - ratio)).toBeLessThan(0.01);
  await narrow.unmount();
});

test("finished agents show by default; /orchestra all folds them past six", async ($, on) => {
  const clock = mock.clock(on);
  const many: AgentInfo[] = Array.from({ length: 7 }, (_, i) => ({
    id: `d${i}`,
    description: `done ${i}`,
    type: "Explore",
    status: "completed",
  }));
  engine(on, many);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(1100);

  const desktop = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect(String((await desktop.find({ type: "Svg" }))?.props.source)).toContain("done 6");
  await desktop.unmount();

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await pane.find({ type: "Box", key: "tile-d0" })).toBeDefined();
  expect((await run($, "all")).text).toBe("Folding finished agents again.");
  expect(await pane.find({ type: "Box", key: "tile-d0" })).toBeUndefined();
  expect((await pane.find({ type: "Text", text: /7 finished agents/ }))?.text).toContain("show");
  await pane.unmount();
});

test("the band offers a jump to the agent waiting on you", async ($, on) => {
  const clock = mock.clock(on);
  const { viewed } = engine(on);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(1100);

  const quiet = await $.ui.mount({ ...BAND, surface: "desktop" });
  // Held on its own work is not waiting on you: no jump.
  expect(await quiet.find({ key: "jump" })).toBeUndefined();
  await quiet.unmount();

  await askFromA3($);
  await clock.advance(1100);
  const band = await $.ui.mount({ ...BAND, surface: "desktop" });
  expect((await band.find({ key: "jump" }))?.props.label).toBe("Jump to Nested scan");
  await band.press({ key: "jump" });
  expect(viewed).toEqual([{ agentId: "a3" }]);
  await band.unmount();
});

test("the band switch turns orchestra off for the session and the pane says so", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(1100);

  const band = await $.ui.mount({ ...BAND, surface: "desktop" });
  expect((await band.find({ key: "toggle" }))?.props.label).toBe("On");
  expect((await band.find({ type: "Text", text: /nodes/ }))?.text).toContain("3 nodes · 1 running");
  await band.press({ key: "toggle" });
  expect((await band.find({ key: "toggle" }))?.props.label).toBe("Off");
  await band.unmount();

  const pane = await $.ui.mount({ ...PANE, surface: "desktop" });
  expect((await pane.find({ type: "Text", text: /Off for this session/ }))?.text).toContain(
    "3 agents",
  );
  await pane.unmount();
});

test("/orchestra answers on, off, view, open and bad input", async ($, on) => {
  mock.clock(on);
  const { viewed } = engine(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await run($, "");

  expect((await run($, "off")).text).toBe("Orchestra is off for this session.");
  expect((await run($, "on")).text).toBe("Orchestra is on for this session.");
  expect((await run($, "")).text).toBe("Orchestra view opened.");
  expect((await run($, "open nested")).text).toBe("Showing Nested scan.");
  expect((await run($, "open a2")).text).toBe("Showing Search the repo.");
  expect((await run($, "open main")).text).toBe("Showing this session.");
  expect((await run($, "open nobody")).text).toBe(
    'No agent matches "nobody". Hover a card to see its id.',
  );
  expect((await run($, "nope")).text).toBe("Usage: /orchestra on|off|view|all|open <agent>|export");
  expect(viewed).toEqual([{ agentId: "a3" }, { agentId: "a2" }, {}]);
});

test("an agent that starts waiting on you raises one toast and a status line, cleared once answered", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  const toasts: string[] = [];
  const statuses: (string | undefined)[] = [];
  on("ui.toast", (_, e, next) => {
    toasts.push(e.text);

    return next(e);
  });
  on("ui.status", (_, e, next) => {
    statuses.push(e.text);

    return next(e);
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(1100);
  expect(toasts).toEqual([]);

  await askFromA3($);
  await clock.advance(2100);
  expect(toasts).toEqual(["Nested scan needs you"]);
  expect(statuses.at(-1)).toBe("1 need you");

  await $.tool.call({ tool: "Bash", command: "ls", agentId: "a3" });
  await clock.advance(2100);
  expect(toasts).toHaveLength(1);
  expect(statuses.at(-1)).toBeUndefined();
});

for (const surface of SURFACES) {
  test(`the pane's Copy button copies the totals and the outline on the ${surface}`, async ($, on) => {
    const clock = mock.clock(on);
    engine(on);
    const copied: string[] = [];
    const toasts: string[] = [];
    on("ui.copy", (_, e) => {
      copied.push(e.text);

      return { value: { isCopied: true } };
    });
    on("ui.toast", (_, e, next) => {
      toasts.push(e.text);

      return next(e);
    });
    await $.session.start({ cwd: "/", surface, isInteractive: true });
    await clock.advance(1100);

    const pane = await $.ui.mount({ ...PANE, surface });
    expect((await pane.find({ key: "copy" }))?.props.label).toBe("Copy");
    await pane.press({ key: "copy" });
    expect(copied[0]).toMatch(/^3 agents/);
    expect(copied[0]).toContain("- **this session**");
    expect(copied[0]).toContain("    - **Nested scan**");
    expect(toasts).toEqual(["Orchestra overview copied"]);
    await pane.unmount();
  });
}

test("/orchestra export copies an outline with nested agents indented", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  const copied: string[] = [];
  on("ui.copy", (_, e) => {
    copied.push(e.text);

    return { value: { isCopied: true } };
  });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(1100);

  expect((await run($, "export")).text).toBe("Orchestra overview copied.");
  expect(copied[0]).toContain("- **this session**");
  expect(copied[0]).toContain("  - **Search the repo**");
  expect(copied[0]).toContain("    - **Nested scan**");
});

test("animations resume at the same phase after a redraw", () => {
  const graph: OrchestraGraph = {
    nodes: [node("main", null, "run"), node("a", "main", "run")],
    now: 0,
  };
  const begins = (phase: number) =>
    renderGraphSvg(graph, { isPaused: false, isFoldOpen: false, now: 0, phase }).match(
      /begin="[^"]+"/g,
    );
  expect(begins(0)).not.toBeNull();
  // A running wire's particle period is 1.4s: one period later it is where it was.
  expect(begins(1400)).toEqual(begins(0));
  expect(begins(500)).not.toEqual(begins(0));
});

test("the svg keeps its source through count changes and reloads on a status change", async ($, on) => {
  const clock = mock.clock(on);
  const agents: AgentInfo[] = [
    { id: "a1", description: "Work", type: "Explore", status: "running" },
  ];
  engine(on, agents);
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(1100);
  const pane = await $.ui.mount({ ...PANE, surface: "desktop" });
  const source = async () => String((await pane.find({ type: "Svg" }))?.props.source);
  const first = await source();

  // Calls and a new action reach the graph within ten seconds, but not the frame.
  await $.tool.call({ tool: "Bash", command: "ls", agentId: "a1" });
  await clock.advance(40_000);
  expect(await source()).toBe(first);

  agents[0] = { ...agents[0]!, status: "completed" };
  await clock.advance(2000);
  expect(await source()).not.toBe(first);
  await pane.unmount();
});

test("counts redraw at most every ten seconds; a status change redraws at once", async ($, on) => {
  const clock = mock.clock(on);
  const agents: AgentInfo[] = [
    { id: "a1", description: "Work", type: "Explore", status: "running" },
  ];
  engine(on, agents);
  let writes = 0;
  on("state.set", (_, e, next) => {
    if (e.key === "graph") {
      writes += 1;
    }

    return next(e);
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(1100);
  const first = writes;

  await $.tool.call({ tool: "Bash", command: "ls", agentId: "a1" });
  await clock.advance(2000);
  expect(writes).toBe(first);

  await clock.advance(9000);
  expect(writes).toBe(first + 1);

  agents[0] = { ...agents[0]!, status: "completed" };
  await clock.advance(1000);
  expect(writes).toBe(first + 2);
});

test("history is saved to session state as it changes", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  const saved: OrchestraHistory[] = [];
  on("state.set", (_, e, next) => {
    if (e.key === "history" && e.value) {
      saved.push(e.value as OrchestraHistory);
    }

    return next(e);
  });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await $.tool.call({ tool: "Edit", file_path: "/x/a.ts", old_string: "a", new_string: "b" });
  await clock.advance(1100);

  const last = saved.at(-1);
  expect(last?.counters.main?.calls).toBe(1);
  expect(last?.edited.main).toEqual(["/x/a.ts"]);
  expect(last?.actions.main).toBe("Edit /x/a.ts");
});

test("the layout keeps a row between tiles and wires every child to its parent", () => {
  const graph: OrchestraGraph = {
    nodes: [
      node("main", null, "run"),
      node("a", "main", "run"),
      node("b", "main", "done"),
      node("c", "a", "wait"),
    ],
    now: 0,
  };
  const tree = layoutTree(graph, false);
  const at = (id: string) => tree.tiles.find((t) => t.node.id === id);
  expect((at("b")?.y ?? 0) - (at("c")?.y ?? 0)).toBe(TILE_H + 1);
  expect(at("a")?.x).toBe(TILE_W + 8);
  expect(at("c")?.x).toBe(2 * (TILE_W + 8));
  expect(tree.wires.filter((w) => w.ch === "▶")).toHaveLength(3);
  expect(tree.wires.some((w) => w.step !== undefined)).toBe(true);
  expect(tree.wires.filter((w) => w.dim).every((w) => w.step === undefined)).toBe(true);
  const xs = tree.tiles.flatMap((t) =>
    tree.wires.filter((w) => w.y >= t.y && w.y < t.y + TILE_H && w.x >= t.x && w.x < t.x + TILE_W),
  );
  expect(xs).toEqual([]);
});

test("each request gets the growth of the session total since the last one", () => {
  const h = {
    costs: {} as Record<string, number>,
    tokens: {} as Record<string, number>,
    lastUsd: 0.5,
  };
  attributeCost(h, "a1", 0.62, 4000);
  attributeCost(h, "main", 0.7, 1000);
  attributeCost(h, "a1", 0.75, 2000);
  attributeCost(h, "a2", undefined, 500);
  expect(
    Object.fromEntries(Object.entries(h.costs).map(([k, v]) => [k, Math.round(v * 100) / 100])),
  ).toEqual({ a1: 0.17, main: 0.08 });
  expect(h.tokens).toEqual({ a1: 6000, main: 1000, a2: 500 });
  expect(h.lastUsd).toBe(0.75);
});

test("a tile shows dollars when known, else tokens", () => {
  const graph: OrchestraGraph = { nodes: [], now: 30_000 };
  expect(spend(node("a", "main", "run", { costUsd: 0.123 }))).toBe("$0.12");
  expect(spend(node("a", "main", "run", { costUsd: 0.004 }))).toBe("<$0.01");
  expect(spend(node("a", "main", "run", { tokens: 41_200 }))).toBe("41k tok");
  expect(spend(node("a", "main", "run"))).toBeUndefined();
  expect(
    meta(
      node("a", "main", "done", {
        model: "claude-sonnet-5-5",
        calls: 4,
        costUsd: 0.06,
        endedAt: 18_000,
      }),
      graph,
      30_000,
    ),
  ).toBe("sonnet-5-5 · 4 calls · $0.06 · 18s");
});

test("an agent the list drops when it ends stays on the graph as finished", async ($, on) => {
  const clock = mock.clock(on);
  const agents: AgentInfo[] = [...baseAgents];
  engine(on, agents);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(1100);

  agents.splice(2, 1);
  await clock.advance(1100);

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await pane.find({ type: "Box", key: "tile-a3" })).toBeDefined();
  const desktop = await $.ui.mount({ ...PANE, surface: "desktop" });
  const source = String((await desktop.find({ type: "Svg" }))?.props.source);
  expect(source).toMatch(/class="card done"[^]*Nested scan/);
  await pane.unmount();
  await desktop.unmount();
});

test("a held agent waits on its own work, and only a named prompt means you", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await $.tool.call({ tool: "Bash", command: "ls", agentId: "a3" });
  await clock.advance(11_000);

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(
    (await pane.find({ type: "Text", text: /waiting on Bash ls/ }))?.props.color,
  ).toBeUndefined();
  await askFromA3($);
  await clock.advance(1100);
  expect((await pane.find({ type: "Text", text: /needs you/ }))?.props.color).toBe("warning");
  await $.tool.call({ tool: "Bash", command: "ls", agentId: "a3" });
  await clock.advance(1100);
  expect(await pane.find({ type: "Text", text: /needs you/ })).toBeUndefined();
  await pane.unmount();
});

test("wires start their particles mid-path and end in a level, fixed-size arrow", () => {
  const graph: OrchestraGraph = {
    nodes: [node("main", null, "run"), node("a", "main", "wait")],
    now: 0,
  };
  const svg = renderGraphSvg(graph, { isPaused: false, isFoldOpen: false, now: 0 });
  expect(svg).toContain('begin="-1.300s"');
  expect(svg).not.toMatch(/begin="[1-9]/);
  expect(svg).toContain('markerUnits="userSpaceOnUse"');
  const lead = /<path d="M(\d+) (\d+) L(\d+) (\d+)"[^>]*marker-end/.exec(svg);
  expect(lead?.[2]).toBe(lead?.[4]);
});
