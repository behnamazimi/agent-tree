import { expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";
import type { AgentInfo, On } from "claude-code";

import { renderGraphSvg } from "../hooks/svg";
import {
  attributeCost,
  barCells,
  describeAction,
  editedFile,
  flags,
  fold,
  layoutTree,
  meta,
  note,
  outline,
  spend,
  headline,
  summarize,
  TILE_H,
  TILE_W,
  totals,
} from "../hooks/graph";
import type { AgentTreeGraph, AgentTreeHistory, AgentTreeNode } from "../types";

const node = (
  id: string,
  parentId: string | null,
  status: AgentTreeNode["status"],
  extra: Partial<AgentTreeNode> = {},
): AgentTreeNode => ({
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
  plugin: "agent-tree",
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
  plugin: "agent-tree",
  component: "Pane",
  requestId: "agent-tree",
  props: {
    title: "Agent tree",
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

/** Stands for the engine; `beneath` is what another plugin's band under agent-tree draws. */
function engine(
  on: On,
  agents: AgentInfo[] = baseAgents,
  beneath = "",
  { viewDeny, store }: { viewDeny?: string; store?: Record<string, unknown> } = {},
) {
  const viewed: unknown[] = [];
  // A plain object rather than mock.store, so a test can read what was kept.
  const kept = store ?? {};
  on("store.get", (_, e) => ({ value: kept[e.key] }));
  on("store.set", (_, e) => {
    kept[e.key] = JSON.parse(JSON.stringify(e.value));

    return { value: undefined };
  });
  on("store.delete", (_, e) => {
    delete kept[e.key];

    return { value: undefined };
  });
  on("store.keys", () => ({ value: Object.keys(kept) }));
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e);

    return beneath ? <Text>{beneath}</Text> : <Box />;
  });
  on("command.register", () => ({ value: { command: "agent-tree" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.view", (_, e) => {
    viewed.push(e);

    return { value: viewDeny ? { deny: viewDeny } : {} };
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
    command: "agent-tree",
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
  const graph: AgentTreeGraph = {
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
  const slow = graph.nodes[2] as AgentTreeNode;
  expect(flags(slow, graph, 120_000)).toEqual(["same Grep ×6", "5× slower", "shared file a.ts"]);
  expect(flags(graph.nodes[1] as AgentTreeNode, graph, 120_000)).toEqual([]);
});

test("flags call out a quiet run and a cost far above its siblings", () => {
  const graph: AgentTreeGraph = {
    nodes: [
      node("main", null, "run"),
      node("a", "main", "run", { lastAt: 0, costUsd: 1.5 }),
      node("b", "main", "done", { costUsd: 0.2 }),
      node("c", "main", "done", { costUsd: 0.3 }),
    ],
    now: 0,
  };
  expect(flags(graph.nodes[1] as AgentTreeNode, graph, 200_000)).toEqual(["quiet 3m20", "cost 6×"]);
});

test("totals names the top spender, and outline nests children under parents", () => {
  const graph: AgentTreeGraph = {
    nodes: [
      node("main", null, "run"),
      node("a", "main", "run", { costUsd: 0.9 }),
      node("b", "main", "run", { costUsd: 0.3 }),
    ],
    costUsd: 1.5,
    now: 0,
  };
  expect(totals(graph)).toContain("top a 60%");
  const tree: AgentTreeGraph = {
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
  const graph: AgentTreeGraph = {
    nodes: [
      { ...node("main", null, "wait"), calls: 2 },
      { ...node("a", "main", "run"), calls: 5 },
      { ...node("b", "main", "fail"), calls: 1 },
    ],
    costUsd: 1.5,
    waitMs: 62_000,
    now: 0,
  };
  expect(summarize(graph)).toBe("2 nodes · 1 running · 1 needs you");
  expect(totals(graph)).toBe(
    "2 agents · 1 running · 1 failed · 8 calls · $1.50 · waited on you 1m02",
  );
  expect(headline(graph).state).toBe("1 running · 1 failed");
  const done = { ...graph, nodes: graph.nodes.map((n) => ({ ...n, status: "done" as const })) };
  expect(headline(done)).toMatchObject({ state: "all done", counts: [["done", 2]] });
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
  expect(await pane.find({ type: "Text", text: "▶" })).toBeDefined();
  await pane.press({ key: "open-a2" });
  expect(viewed).toEqual([{ agentId: "a2" }]);
  await pane.unmount();
});

test("terminal wires are part of the pane's tree and pulse one step per redraw", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(1100);

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  // A Client stayed at the body's top while the tiles scrolled; none is drawn now.
  expect(await pane.find({ type: "Client" })).toBeUndefined();
  // The keys of the wire cells drawn lit, read from the whole tree.
  const lit = async () => {
    const keys: string[] = [];
    const walk = (el: unknown, key?: string) => {
      if (Array.isArray(el)) {
        el.forEach((c) => walk(c, key));
      } else if (el === "•" && key) {
        keys.push(key);
      } else if (el && typeof el === "object" && "props" in el) {
        const { props, children } = el as { props: { key?: string }; children?: unknown };
        walk(children, props.key ?? key);
      }
    };
    walk(await pane.drawn());

    return keys;
  };
  const before = await lit();
  expect(before.length).toBeGreaterThan(0);
  await clock.advance(1000);
  expect(await lit()).not.toEqual(before);
  await pane.unmount();
});

test("a bar's cells follow its span on the axis, one cell at least", () => {
  expect(barCells(0, 10_000, 0, 10_000, 20)).toEqual([0, 20]);
  expect(barCells(5_000, 10_000, 0, 10_000, 20)).toEqual([10, 10]);
  // Too short to show still takes a cell, and one starting at the end stays on the axis.
  expect(barCells(2_000, 2_001, 0, 10_000, 20)).toEqual([4, 1]);
  expect(barCells(10_000, 10_000, 0, 10_000, 20)).toEqual([19, 1]);
});

test("the terminal pane has a timeline row per tile", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(1100);

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await pane.find({ type: "Text", text: "Timeline" })).toBeDefined();
  // The session and its three agents.
  for (let k = 0; k < 4; k++) {
    expect(await pane.find({ type: "Box", key: `tl-${k}` })).toBeDefined();
  }
  expect(await pane.find({ type: "Box", key: "tl-4" })).toBeUndefined();
  expect(await pane.find({ type: "Text", text: /^ +0s .* now$/ })).toBeDefined();
  await pane.unmount();
});

test("while an agent is in view the main tile offers the way back", async ($, on) => {
  const clock = mock.clock(on);
  const { viewed } = engine(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(1100);

  const inMain = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(await inMain.find({ key: "back-main" })).toBeUndefined();
  await inMain.unmount();

  const inAgent = await $.ui.mount({
    ...PANE,
    surface: "terminal",
    props: { ...PANE.props, view: { agentId: "a2" } },
  });
  await inAgent.press({ key: "back-main" });
  expect(viewed).toEqual([{}]);
  await inAgent.unmount();
});

test("a tile press the engine refuses says why in a toast", async ($, on) => {
  const clock = mock.clock(on);
  engine(on, baseAgents, "", { viewDeny: "the view moved meanwhile" });
  const toasts: string[] = [];
  on("ui.toast", (_, e, next) => {
    toasts.push(e.text);

    return next(e);
  });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(1100);

  const pane = await $.ui.mount({ ...PANE, surface: "terminal" });
  await pane.press({ key: "open-main" });
  await clock.advance(10);
  expect(toasts).toContain("Could not show this session: the view moved meanwhile");
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
  const svg = (await pane.findAll({ type: "Svg" })).at(-1);
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
  const svg = (await narrow.findAll({ type: "Svg" })).at(-1);
  expect(svg?.props.width).toBe(400);
  const natural = /viewBox="0 0 (\d+) (\d+)"/.exec(String(svg?.props.source));
  const ratio = Number(natural?.[2]) / Number(natural?.[1]);
  expect(Math.abs(Number(svg?.props.height) / 400 - ratio)).toBeLessThan(0.01);
  await narrow.unmount();
});

test("finished agents show by default; /agent-tree all folds them past six", async ($, on) => {
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
  expect(String((await desktop.findAll({ type: "Svg" })).at(-1)?.props.source)).toContain("done 6");
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

test("the band keeps the band another plugin draws beneath it", async ($, on) => {
  const clock = mock.clock(on);
  engine(on, baseAgents, "other plugin");
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(1100);

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface });
    expect(await band.find({ key: "toggle" })).toBeDefined();
    expect(await band.find({ type: "Text", text: "other plugin" })).toBeDefined();
    await band.unmount();
  }
});

test("the band stays hidden until the session has an agent", async ($, on) => {
  const clock = mock.clock(on);
  engine(on, [], "other plugin");
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(1100);

  const band = await $.ui.mount({ ...BAND, surface: "desktop" });
  expect(await band.find({ key: "toggle" })).toBeUndefined();
  expect(await band.find({ type: "Text", text: "other plugin" })).toBeDefined();
  await band.unmount();
});

test("the band switch turns agent-tree off for the session and the pane says so", async ($, on) => {
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
  expect((await pane.find({ type: "Text", text: /off for this session/ }))?.text).toContain(
    "no events recorded",
  );
  expect((await pane.find({ type: "Text", text: /agents/ }))?.text).toBe("3 agents");
  await pane.unmount();
});

test("/agent-tree answers on, off, view, open and bad input", async ($, on) => {
  mock.clock(on);
  const { viewed } = engine(on);
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await run($, "");

  expect((await run($, "off")).text).toBe("Agent tree is off for this session.");
  expect((await run($, "on")).text).toBe("Agent tree is on for this session.");
  expect((await run($, "")).text).toBe("Agent tree view opened.");
  expect((await run($, "open nested")).text).toBe("Showing Nested scan.");
  expect((await run($, "open a2")).text).toBe("Showing Search the repo.");
  expect((await run($, "open main")).text).toBe("Showing this session.");
  expect((await run($, "open nobody")).text).toBe(
    'No agent matches "nobody". Hover a card to see its id.',
  );
  expect((await run($, "nope")).text).toBe(
    "Usage: /agent-tree on|off|view|all|open <agent>|export",
  );
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
    expect(toasts).toEqual(["Agent tree overview copied"]);
    await pane.unmount();
  });
}

test("/agent-tree export copies an outline with nested agents indented", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  const copied: string[] = [];
  on("ui.copy", (_, e) => {
    copied.push(e.text);

    return { value: { isCopied: true } };
  });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(1100);

  expect((await run($, "export")).text).toBe("Agent tree overview copied.");
  expect(copied[0]).toContain("- **this session**");
  expect(copied[0]).toContain("  - **Search the repo**");
  expect(copied[0]).toContain("    - **Nested scan**");
});

test("/agent-tree open says why where the app cannot switch views", async ($, on) => {
  const clock = mock.clock(on);
  engine(on, baseAgents, "", { viewDeny: "no main view here" });
  await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
  await clock.advance(1100);

  expect((await run($, "open")).text).toBe("Usage: /agent-tree open <agent id or name>, or main");
  expect((await run($, "open main")).text).toBe(
    "You're already in this session (no main view here).",
  );
  const shown = (await run($, "open a2")).text;
  expect(shown).toMatch(/^Search the repo \(running\)\n/);
  expect(shown).toContain("\nStarted: ");
  expect(shown).toEndWith("\n\nThis app can't switch to its conversation (no main view here).");
});

test("an agent's result is its final answer, not the launch notice", async ($, on) => {
  const clock = mock.clock(on);
  engine(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));
  const copied: string[] = [];
  on("ui.copy", (_, e) => {
    copied.push(e.text);

    return { value: { isCopied: true } };
  });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await $.turn.complete({
    agentId: "a2",
    answer: "The command printed:\n\n```\nhello\n```",
    durationMs: 3000,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  await clock.advance(1100);

  await run($, "export");
  expect(copied[0]).toMatch(/\*\*Search the repo\*\* \(.*\): The command printed: ``` hello ```/);
});

test("animations resume at the same phase after a redraw", () => {
  const graph: AgentTreeGraph = {
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
  const source = async () => String((await pane.findAll({ type: "Svg" })).at(-1)?.props.source);
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
  const saved: AgentTreeHistory[] = [];
  on("state.set", (_, e, next) => {
    if (e.key === "history" && e.value) {
      saved.push(e.value as AgentTreeHistory);
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

test("a resumed conversation gets its history back from the store, and old ones are dropped", async ($, on) => {
  const clock = mock.clock(on);
  const store: Record<string, unknown> = {
    // session.usage's startedAt is 0 in this engine, so "history:0" is this conversation.
    "history:0": {
      agents: {
        gone: { label: "Ran before the resume", type: "Explore", parentId: "main", status: "done" },
      },
      results: { gone: "printed hello" },
    },
  };
  for (let i = 1; i <= 10; i++) {
    store[`history:${i}`] = {};
  }
  engine(on, [], "", { store });
  const copied: string[] = [];
  on("ui.copy", (_, e) => {
    copied.push(e.text);

    return { value: { isCopied: true } };
  });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(1100);

  await run($, "export");
  expect(copied[0]).toMatch(/\*\*Ran before the resume\*\* \(done.*\): printed hello/);
  const band = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await band.find({ key: "toggle" })).toBeDefined();
  await band.unmount();
  // This conversation and the seven newest others are kept.
  expect(Object.keys(store).sort()).toEqual(
    [
      "history:0",
      "history:4",
      "history:5",
      "history:6",
      "history:7",
      "history:8",
      "history:9",
      "history:10",
    ].sort(),
  );
});

test("the layout keeps a row between tiles and wires every child to its parent", () => {
  const graph: AgentTreeGraph = {
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
  const graph: AgentTreeGraph = { nodes: [], now: 30_000 };
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
  const source = String((await desktop.findAll({ type: "Svg" })).at(-1)?.props.source);
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
  const graph: AgentTreeGraph = {
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
