import type { AgentInfo, EngineInterface, Register, Timer } from "claude-code";

import type { AgentTreeGraph, AgentTreeHistory, AgentTreeNode, AgentTreeStatus } from "../types";
import {
  age,
  attributeCost,
  barCells,
  isLive,
  clip,
  describeAction,
  detailLines,
  editedFile,
  flags,
  FOLD_AFTER,
  FOLD_H,
  headline,
  layoutTree,
  meta,
  note,
  overview,
  plural,
  report,
  STATUS_COLOR,
  statusColor,
  summarize,
  TILE_H,
  TILE_W,
  timelineRows,
  totals,
} from "./graph";
import type { PlacedFold, PlacedTile } from "./graph";
import { renderBarSvg, renderGraphSvg, svgSize } from "./svg";

const PANE = "agent-tree";
const MAIN = "main";
const TICK_MS = 1000;
const START_SESSION_TOOL = "mcp__ccd_session__start_session";
const CARD_W = 46;
// Measured from a desktop pane: about 10.6px per cell; a little under keeps the drawing inside.
const PX_PER_COLUMN = 10;
const FINE_REDRAW_MS = 10_000;
// Each new SVG source reloads its frame, which shows as a blink; between events it is only refreshed this often.
const SVG_REFRESH_MS = 300_000;
const SEEN_CAP = 50;
// Every fourth cell of a live wire is lit; the lit cells step one along per redraw.
const PULSE_EVERY = 4;
// The terminal timeline's label column at most, and room for a duration such as "12m05".
const TL_LABEL_W = 24;
const TL_TOOK_W = 5;
const HISTORY_PREFIX = "history:";
// Each history is capped by AGENT_CAP; a few fit well under the store's 4 MiB.
const HISTORIES_KEPT = 8;

const isOnRef = { plugin: "agent-tree", key: "isOn" } as const;
const graphRef = { plugin: "agent-tree", key: "graph" } as const;
const historyRef = { plugin: "agent-tree", key: "history" } as const;
const nowRef = { plugin: "agent-tree", key: "now" } as const;
const foldRef = { plugin: "agent-tree", key: "isFoldOpen" } as const;

async function readIsOn($: EngineInterface) {
  return (await $.state.get(isOnRef)).value ?? true;
}
async function readGraph($: EngineInterface) {
  return (await $.state.get(graphRef)).value ?? ({ nodes: [], now: 0 } as AgentTreeGraph);
}
async function readHistory($: EngineInterface) {
  return (await $.state.get(historyRef)).value ?? null;
}
async function readNow($: EngineInterface) {
  return (await $.state.get(nowRef)).value ?? 0;
}
async function readFold($: EngineInterface) {
  return (await $.state.get(foldRef)).value ?? true;
}

const AGENT_STATUS: Record<AgentInfo["status"], AgentTreeStatus> = {
  pending: "run",
  running: "run",
  waiting: "hold",
  idle: "idle",
  completed: "done",
  failed: "fail",
  killed: "fail",
};

const emptyHistory = (now: number): AgentTreeHistory => ({
  sessionStartedAt: now,
  waitMs: 0,
  peak: 0,
  counters: {},
  models: {},
  startedAt: {},
  endedAt: {},
  results: {},
  tasks: {},
  actions: {},
  edited: {},
  seen: {},
  costs: {},
  tokens: {},
  lastUsd: 0,
  sideSessions: [],
  agents: {},
});

// The hot path reads module state; refresh() saves `history` to $.state and session.start loads it back.
const live = {
  isOn: true,
  /** Where this conversation's history is kept in `$.store`, so a resume under a new session id finds it. */
  storeKey: undefined as string | undefined,
  /** How many nodes waited on the person at the last refresh; the status and toast fire on its changes. */
  waitCount: 0,
  timer: undefined as Timer | undefined,
  mainStatus: "idle" as AgentTreeStatus,
  waitingSince: undefined as number | undefined,
  ctxPercent: undefined as number | undefined,
  costUsd: undefined as number | undefined,
  coarseSig: "",
  /** Agents whose permission prompt is up, with its message; cleared once their call goes through. */
  needsYou: {} as Record<string, string>,
  fineSig: "",
  /** The desktop pane's last SVG, reused while its key (shape and status) holds. */
  svg: undefined as { key: string; at: number; source: string } | undefined,
  lastWriteAt: 0,
  history: emptyHistory(0),
};

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "agent-tree",
      description:
        "Agent tree view for this session: on, off, view, all (fold or unfold finished agents), open <agent>, or export (copy the overview)",
      argumentHint: "on|off|view|all|open <agent>|export",
    });
    live.storeKey = await historyKey($);
    // Session state lasts as long as the process; a resumed conversation finds its history in the store instead.
    const saved = (await readHistory($)) ?? (await restoreHistory($));
    // A history saved by an older version lacks the newer fields; the empty one fills them.
    live.history = { ...emptyHistory(await $.clock.now()), ...saved };
    // Cost spent before the mod loaded belongs to no agent it saw.
    live.history.lastUsd = Math.max(live.history.lastUsd, (await sessionUsd($)) ?? 0);
    live.isOn = await readIsOn($);
    if (live.isOn) {
      startTicking($);
    }

    return next(e);
  });

  on("command.run", { command: "agent-tree" }, async ($, e) => {
    const [verb = "", ...rest] = e.args.trim().split(/\s+/);
    const arg = verb.toLowerCase();
    if (arg === "on" || arg === "off") {
      await setOn($, arg === "on");

      return { text: `Agent tree is ${arg} for this session.` };
    }
    if (arg === "all") {
      const isOpen = !(await readFold($));
      await $.state.set(foldRef, isOpen);

      return { text: isOpen ? "Showing every finished agent." : "Folding finished agents again." };
    }
    if (arg === "open" && rest.length === 0) {
      return { text: "Usage: /agent-tree open <agent id or name>, or main" };
    }
    if (arg === "open") {
      // A command is the person's own input, so it may switch the main view.
      const target = findNode(await readGraph($), rest.join(" "));
      if (!target || target.kind === "session") {
        return { text: `No agent matches "${rest.join(" ")}". Hover a card to see its id.` };
      }
      const moved = await $.ui.view(target.kind === "agent" ? { agentId: target.id } : {});

      if (!moved.deny) {
        return { text: `Showing ${target.label}.` };
      }

      // The desktop app has no switchable main view, so the session is the only conversation in it.
      if (target.kind === "main") {
        return { text: `You're already in this session (${moved.deny}).` };
      }

      // Its conversation cannot be shown here, so show what agent-tree knows of it instead.
      return {
        text: `${report(target, await $.clock.now())}\n\nThis app can't switch to its conversation (${moved.deny}).`,
      };
    }
    if (arg === "export") {
      const copied = await $.ui.copy({ text: overview(await readGraph($)) });

      return {
        text: copied.isCopied
          ? "Agent tree overview copied."
          : `Could not copy (${copied.reason}).`,
      };
    }
    if (arg !== "" && arg !== "view") {
      return { text: "Usage: /agent-tree on|off|view|all|open <agent>|export" };
    }
    const opened = await $.ui.open({ id: PANE, title: "Agent tree" });

    return {
      text: opened.isPlaced
        ? "Agent tree view opened."
        : `Agent tree view is waiting for room: ${opened.reason ?? "not placed"}.`,
    };
  });

  on("prompt.submit", async ($, e, next) => {
    await setMainStatus($, "run");

    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    await setMainStatus($, "run");

    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    // A subagent's turn end carries its report whole; the Agent call's own text is only a launch notice for a background agent.
    const answer = e.answer.replace(/\s+/g, " ").trim();
    if (live.isOn && e.agentId && answer) {
      live.history.results[e.agentId] = clip(answer, 300);
    }
    try {
      const result = await next(e);
      live.history.mainModel = result.usage?.model ?? live.history.mainModel;

      return result;
    } finally {
      await setMainStatus($, "idle");
      kick($);
    }
  });

  on("classic.Notification", async ($, e, next) => {
    if (e.agent_id) {
      live.needsYou[e.agent_id] = e.message;
    } else {
      await setMainStatus($, "wait");
    }
    kick($);

    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    const result = yield* next(e);
    if (live.isOn && result.usage) {
      const u = result.usage;
      const tokens =
        u.input_tokens +
        u.output_tokens +
        u.cache_read_input_tokens +
        u.cache_creation_input_tokens;
      attributeCost(live.history, e.agentId ?? MAIN, await sessionUsd($), tokens);
    }

    return result;
  });

  on("session.measure", ($, e, next) => {
    live.ctxPercent = e.context.percent ?? live.ctxPercent;
    live.costUsd = e.cost?.usd ?? live.costUsd;

    return next(e);
  });

  on("agent.spawn", async ($, e, next) => {
    const result = await next(e);
    if (live.isOn && result.agentId) {
      live.history.startedAt[result.agentId] = await $.clock.now();
      live.history.models[result.agentId] = result.model;
      live.history.tasks[result.agentId] = clip(e.prompt.replace(/\s+/g, " ").trim(), 300);
      kick($);
    }

    return result;
  });

  on("classic.SubagentStop", async ($, e, next) => {
    if (live.isOn) {
      live.history.endedAt[e.agent_id] ??= await $.clock.now();
      kick($);
    }

    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    if (!live.isOn) {
      return next(e);
    }
    const tool = String(e.tool);
    const input = e as unknown as Record<string, unknown>;
    const now = await $.clock.now();
    const id = e.agentId ?? MAIN;
    record(id, tool, input, now);
    if (tool !== START_SESSION_TOOL) {
      try {
        return await next(e);
      } finally {
        // The call ended, so whatever it asked the person is answered.
        delete live.needsYou[id];
      }
    }
    const args = input as { title?: string; name?: string; prompt?: string; initiation?: string };
    const node: AgentTreeNode = {
      id: `session-${e.tool_use_id}`,
      parentId: e.agentId ?? MAIN,
      kind: "session",
      // A start from a proposal card carries only proposal_id, no title.
      label: args.title ?? args.name ?? args.prompt?.slice(0, 40) ?? "side session",
      type: args.initiation ?? "session",
      status: "run",
      calls: 0,
      startedAt: now,
      task: args.prompt ? clip(args.prompt, 300) : undefined,
    };
    live.history.sideSessions.push(node);
    let status: AgentTreeStatus = "fail";
    try {
      const ran = await next(e);
      status = ran.deny !== undefined || ran.isError === true ? "fail" : "idle";

      return ran;
    } finally {
      node.status = status;
      node.endedAt = await $.clock.now();
      delete live.needsYou[id];
      kick($);
    }
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    // The band is one instance shared by every plugin: draw what the ones beneath drew under ours.
    const beneath = await next(e);
    if (e.props.hasSurvey) {
      return beneath;
    }
    const graph = await readGraph($);
    // Nothing to show until the session starts an agent or side session.
    if (!graph.nodes.some((n) => n.kind !== "main")) {
      return beneath;
    }
    const { Box, Button, Text } = $.ui.resolve(e);
    const isEnabled = await readIsOn($);
    // The band's one jump: the first agent that is waiting on the person.
    const waiting = isEnabled
      ? graph.nodes.find((n) => n.kind === "agent" && n.status === "wait")
      : undefined;

    const row = (
      <Box flexDirection="row" gap={1}>
        <Text color={isEnabled ? statusColor(graph) : undefined} dimColor={!isEnabled}>
          ●
        </Text>
        <Text dimColor>{isEnabled ? summarize(graph) : "off for this session"}</Text>
        {...waiting
          ? [
              <Button
                key="jump"
                label={`Jump to ${clip(waiting.label, 28)}`}
                variant="primary"
                onPress={() => void showConversation($, waiting)}
              />,
            ]
          : []}
        <Button
          key="view"
          label="View"
          onPress={() => void $.ui.open({ id: PANE, title: "Agent tree" })}
        />
        <Button
          key="toggle"
          label={isEnabled ? "On" : "Off"}
          variant={isEnabled && !waiting ? "primary" : "secondary"}
          onPress={() => setOn($, !isEnabled)}
        />
      </Box>
    );

    return (
      <Box flexDirection="column" gap="xs">
        {row}
        {beneath}
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e);
    const isEnabled = await readIsOn($);
    const graph = await readGraph($);
    const isFoldOpen = await readFold($);
    const header = isEnabled
      ? totals(graph)
      : `Off for this session. No events recorded. ${totals(graph)}`;
    const copy = async () => {
      // The latest graph, not the one this draw was made from.
      const copied = await $.ui.copy({
        text: overview(await readGraph($)),
        surface: e.surface,
      });
      $.ui.toast(
        copied.isCopied ? "Agent tree overview copied" : `Could not copy (${copied.reason})`,
      );
    };
    const head = headline(graph);
    const figures = [
      ...head.figures,
      head.top ? (
        <Text key="top">
          top{" "}
          <Text dimColor={false} weight="semibold">
            {head.top.label}
          </Text>{" "}
          {head.top.share}
        </Text>
      ) : undefined,
      head.waited,
    ].filter(Boolean);
    const total = head.counts.reduce((sum, [, count]) => sum + count, 0);
    // The terminal draws a line of ━ split by status; a desktop a thin rounded SVG track.
    const barCols = Math.max(10, e.props.bodyColumns - 4);
    let bar;
    if (e.surface === "terminal") {
      let drawn = 0;
      bar = (
        <Text>
          {total ? (
            head.counts.map(([status, count]) => {
              // Rounded at each running edge, so the segments always fill the line exactly.
              const cols =
                Math.round(((drawn + count) / total) * barCols) -
                Math.round((drawn / total) * barCols);
              drawn += count;

              return (
                <Text key={status} color={STATUS_COLOR[status]}>
                  {"━".repeat(cols)}
                </Text>
              );
            })
          ) : (
            <Text dimColor>{"━".repeat(barCols)}</Text>
          )}
        </Text>
      );
    } else {
      const { Svg } = $.ui.resolve(e);
      bar = (
        <Svg
          key="bar"
          source={renderBarSvg(head.counts, e.props.bodyColumns * PX_PER_COLUMN)}
          height={14}
          alt={head.state || "no agents yet"}
        />
      );
    }
    // Rows touch: on the desktop the bar's SVG carries the space around it, finer than a row of cells.
    // A card: count and state beside Copy, a bar split by status, then the session's figures.
    const headerRow = (
      <Box
        flexDirection="column"
        borderStyle="round"
        // Translucent on the desktop, so it is light in both themes; the terminal keeps a theme key.
        borderColor={e.surface === "terminal" ? "subtle" : "rgba(128,128,128,0.3)"}
        borderDimColor
        paddingX="sm"
        paddingY="sm"
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" gap={1} flexShrink={1}>
            <Text weight="semibold">{head.agents}</Text>
            <Text size="footnote" dimColor>
              {isEnabled
                ? head.state || "no agents yet"
                : "off for this session, no events recorded"}
            </Text>
          </Box>
          <Button key="copy" label="Copy" onPress={() => void copy()} />
        </Box>
        {bar}
        <Text size="footnote" dimColor>
          {figures.flatMap((f, i) => (i ? [" · ", f] : [f]))}
        </Text>
      </Box>
    );

    if (e.surface !== "terminal") {
      // Not reading nowRef here: each new SVG source reloads its frame, so it redraws only with the graph.
      const { Svg } = $.ui.resolve(e);
      const natural = svgSize(graph, isFoldOpen);
      // shortcut: the pane's width in pixels is estimated from its cells; measure it if a surface reports pixels.
      const scale = Math.min(1, (e.props.bodyColumns * PX_PER_COLUMN) / natural.width);

      return (
        <Box flexDirection="column" gap={1}>
          {headerRow}
          <Svg
            source={await svgSource($, graph, isFoldOpen, !isEnabled)}
            width={Math.round(natural.width * scale)}
            height={Math.round(natural.height * scale)}
            alt={`Agent tree: ${header}`}
            isInteractive
          />
        </Box>
      );
    }

    const now = Math.max(graph.now, await readNow($));
    const tree = layoutTree(graph, isFoldOpen);

    // Switching the main view is allowed only from the person's own press, which these closures are.
    const openTo = (n: AgentTreeNode) => () => void showConversation($, n);

    const tile = ({ node: n, x, y }: PlacedTile) => {
      const color = STATUS_COLOR[n.status];
      const isDone = n.status === "done";
      const warnings = flags(n, graph, now);
      const border =
        n.status === "wait" || n.status === "fail"
          ? color
          : n.kind === "main"
            ? "claude"
            : "subtle";
      const kind =
        n.kind === "main"
          ? "session"
          : n.kind === "session"
            ? "side session"
            : `${n.type} · ${n.id.slice(0, 6)}`;
      const title = clip(n.label, TILE_W - 4);

      return (
        <Box
          key={`tile-${n.id}`}
          position="absolute"
          top={y}
          left={x}
          width={TILE_W}
          height={TILE_H}
          flexDirection="column"
          borderStyle="round"
          borderColor={border}
          borderDimColor={isDone}
          paddingX={1}
          hover={{ scope: `t-${n.id}`, borderColor: "text" }}
        >
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>{clip(kind, TILE_W - 6)}</Text>
            <Text color={color} dimColor={isDone}>
              ●
            </Text>
          </Box>
          {n.kind === "session" ? (
            <Text bold>{title}</Text>
          ) : (
            <Button key={`open-${n.id}`} plain onPress={openTo(n)}>
              <Text bold={!isDone} dimColor={isDone}>
                {title}
              </Text>
            </Button>
          )}
          <Text dimColor>{clip(meta(n, graph, now), TILE_W - 4)}</Text>
          {n.kind === "main" && e.props.view.agentId !== undefined ? (
            // The main session has no result line, so its row holds the way back while an agent is in view.
            <Button key="back-main" label="Back to this session" onPress={openTo(n)} />
          ) : (
            <Text
              italic
              color={n.status === "wait" ? "warning" : n.status === "fail" ? "error" : undefined}
              dimColor={n.status !== "wait" && n.status !== "fail"}
            >
              {clip(note(n), TILE_W - 4)}
            </Text>
          )}
          <Text color="warning">
            {warnings.length ? `⚑ ${clip(warnings.join(" · "), TILE_W - 6)}` : " "}
          </Text>
        </Box>
      );
    };

    // Drawn after every tile, so it paints over the tiles below its own.
    const card = ({ node: n, x, y }: PlacedTile) => {
      const lines = detailLines(n, now);

      return (
        <Box
          key={`card-${n.id}`}
          position="absolute"
          top={y + TILE_H}
          left={x + 2}
          width={CARD_W}
          flexDirection="column"
          display="none"
          hover={{ scope: `t-${n.id}`, display: "flex" }}
          borderStyle="round"
          borderColor="subtle"
          backgroundColor="inverseText"
          paddingX={1}
        >
          {lines.map(([label, value]) => (
            <Text key={label} dimColor>
              <Text bold>{label}: </Text>
              {clip(value, 240)}
            </Text>
          ))}
          {n.kind === "agent" ? (
            <Button key={`jump-${n.id}`} label="Open conversation" onPress={openTo(n)} />
          ) : (
            // The way back to the main conversation is the main tile's own button, shown while an agent is in view.
            <Text> </Text>
          )}
        </Box>
      );
    };

    const foldTile = (f: PlacedFold) => (
      <Box
        key={`fold-${f.parentId}`}
        position="absolute"
        top={f.y}
        left={f.x}
        width={TILE_W}
        height={FOLD_H}
        borderStyle="round"
        borderColor="subtle"
        borderDimColor
        paddingX={1}
      >
        <Button key={`fold-${f.parentId}`} plain onPress={() => $.state.set(foldRef, true)}>
          <Text dimColor>▸ {plural(f.count, "finished agent")} · show</Text>
        </Button>
      </Box>
    );

    // Only the terminal reaches here. The wires are part of this tree, not a Client: a Client stayed at the
    // body's top while the tiles scrolled. Their pulses step with the once-a-second redraw while agents run.
    const phase = isEnabled ? Math.floor(now / TICK_MS) : -1;
    const wireLayer = [
      <Box key="wires" position="absolute" top={0} left={0} width={tree.width} height={tree.height}>
        {tree.wires.map((w) => {
          const isPulse =
            phase >= 0 && w.step !== undefined && (w.step - phase) % PULSE_EVERY === 0;

          return (
            <Box key={`w${w.x},${w.y}`} position="absolute" top={w.y} left={w.x}>
              <Text color={w.color} dimColor={w.dim} bold={isPulse}>
                {isPulse ? "•" : w.ch}
              </Text>
            </Box>
          );
        })}
      </Box>,
    ];

    const hasOpenFold =
      isFoldOpen && graph.nodes.filter((n) => n.status === "done").length > FOLD_AFTER;

    // The desktop's timeline in cells: one bar per tile on an axis from the session's start to now.
    const rows = timelineRows(graph, tree.tiles);
    const start = graph.startedAt ?? Math.min(now, ...graph.nodes.map((n) => n.startedAt));
    const end = Math.max(start + 1000, now);
    const labelW = Math.min(TL_LABEL_W, Math.max(...rows.map((r) => r.label.length)));
    const tlCols = Math.max(10, e.props.bodyColumns - labelW - TL_TOOK_W - 4);
    const mid = age(start, start + (end - start) / 2);
    const midAt = Math.floor((tlCols - mid.length) / 2);
    const axis = `0s${" ".repeat(Math.max(1, midAt - 2))}${mid}${" ".repeat(Math.max(1, tlCols - midAt - mid.length - 3))}now`;
    const timelineView = (
      <Box key="timeline" flexDirection="column">
        <Text bold dimColor>
          Timeline
        </Text>
        {rows.map((r, k) => {
          const [first, length] = barCells(r.startedAt, r.endedAt ?? end, start, end, tlCols);
          const isDone = r.status === "done";

          return (
            <Box key={`tl-${k}`} flexDirection="row" gap={1}>
              <Text dimColor={isDone}>{clip(r.label, labelW).padEnd(labelW)}</Text>
              <Text>
                {" ".repeat(first)}
                <Text color={STATUS_COLOR[r.status]} dimColor={isDone}>
                  {"━".repeat(length)}
                </Text>
                {" ".repeat(Math.max(0, tlCols - first - length))}
              </Text>
              <Text dimColor>{age(r.startedAt, r.endedAt ?? end)}</Text>
            </Box>
          );
        })}
        <Text dimColor>{`${" ".repeat(labelW + 1)}${axis}`}</Text>
      </Box>
    );

    return (
      <Box flexDirection="column" gap={1}>
        {headerRow}
        {/* The tiles start at this Box's top, so the cards, drawn last, sit by their tiles and over the timeline. */}
        <Box flexDirection="column" gap={1}>
          <Box width={tree.width + CARD_W} height={tree.height}>
            {...wireLayer}
            {tree.tiles.map(tile)}
            {tree.folds.map(foldTile)}
          </Box>
          {...hasOpenFold
            ? [
                <Button key="fold-close" plain onPress={() => $.state.set(foldRef, false)}>
                  <Text dimColor>▾ fold finished agents</Text>
                </Button>,
              ]
            : []}
          {timelineView}
          {tree.tiles.map(card)}
        </Box>
      </Box>
    );
  });
};

function record(id: string, tool: string, input: Record<string, unknown>, now: number) {
  const hist = live.history;
  const c = hist.counters[id] ?? { calls: 0 };
  hist.counters[id] = { calls: c.calls + 1, lastTool: tool, lastAt: now };
  const action = describeAction(tool, input);
  hist.actions[id] = action;
  const seen = (hist.seen[id] ??= {});
  if (seen[action] !== undefined || Object.keys(seen).length < SEEN_CAP) {
    seen[action] = (seen[action] ?? 0) + 1;
  }
  const file = editedFile(tool, input);
  if (file && !(hist.edited[id] ?? []).includes(file)) {
    hist.edited[id] = [...(hist.edited[id] ?? []), file];
  }
}

const ignore = () => {};
const AGENT_CAP = 200;

/** Fire-and-forget refresh; a failed one is retried by the next event or tick. */
function kick($: EngineInterface) {
  refresh($).catch(ignore);
}

/** Keeps a long session's saved history small by forgetting the oldest finished agents past AGENT_CAP. */
function prune(hist: AgentTreeHistory) {
  const ids = Object.keys(hist.agents);
  const finished = ids
    .filter((id) => hist.agents[id]?.status === "done" || hist.agents[id]?.status === "fail")
    .sort((a, b) => (hist.endedAt[a] ?? 0) - (hist.endedAt[b] ?? 0));
  for (const id of finished.slice(0, Math.max(0, ids.length - AGENT_CAP))) {
    delete hist.agents[id];
    for (const map of [
      hist.models,
      hist.startedAt,
      hist.endedAt,
      hist.results,
      hist.tasks,
      hist.actions,
      hist.edited,
      hist.seen,
      hist.costs,
      hist.tokens,
      hist.counters,
    ]) {
      delete map[id];
    }
  }
}

function repeatOf(id: string): AgentTreeNode["repeat"] {
  const entries = Object.entries(live.history.seen[id] ?? {});
  const top = entries.sort((a, b) => b[1] - a[1])[0];

  return top ? { action: top[0], count: top[1] } : undefined;
}

/** The session's running cost, or undefined where the host keeps no ledger or cannot say. */
async function sessionUsd($: EngineInterface): Promise<number | undefined> {
  try {
    return (await $.session.usage()).cost?.usd;
  } catch {
    // A missing cost must not stop the view: tokens still count.
    return undefined;
  }
}

async function setMainStatus($: EngineInterface, status: AgentTreeStatus) {
  const now = await $.clock.now();
  if (live.waitingSince !== undefined && status !== "wait") {
    live.history.waitMs += now - live.waitingSince;
    live.waitingSince = undefined;
  }
  if (status === "wait" && live.waitingSince === undefined) {
    live.waitingSince = now;
  }
  live.mainStatus = status;
}

async function snapshot($: EngineInterface): Promise<AgentTreeGraph> {
  const now = await $.clock.now();
  const agents = await $.agent.list();
  const hist = live.history;
  prune(hist);
  const details = (id: string) => ({
    ...(hist.counters[id] ?? { calls: 0 }),
    task: hist.tasks[id],
    action: hist.actions[id],
    edited: hist.edited[id],
    repeat: repeatOf(id),
    costUsd: hist.costs[id],
    tokens: hist.tokens[id],
  });
  const nodes: AgentTreeNode[] = [
    {
      id: MAIN,
      parentId: null,
      kind: "main",
      label: "this session",
      type: "session",
      status: live.mainStatus,
      model: hist.mainModel,
      startedAt: hist.sessionStartedAt,
      ...details(MAIN),
    },
  ];
  for (const a of agents) {
    hist.agents[a.id] = {
      label: a.description || a.name || a.type,
      type: a.type,
      parentId: a.parentId ?? MAIN,
      status: AGENT_STATUS[a.status],
    };
  }
  const listed = new Set(agents.map((a) => a.id));
  for (const [id, a] of Object.entries(hist.agents)) {
    // The list drops an agent once it ends (a nested one, say); keep it, as finished, for the overview.
    const status = live.needsYou[id]
      ? "wait"
      : listed.has(id) || a.status === "fail"
        ? a.status
        : "done";
    hist.startedAt[id] ??= now;
    if (status === "done" || status === "fail") {
      hist.endedAt[id] ??= now;
    }
    nodes.push({
      id,
      parentId: a.parentId,
      kind: "agent",
      label: a.label,
      type: a.type,
      status,
      model: hist.models[id],
      startedAt: hist.startedAt[id] ?? now,
      endedAt: hist.endedAt[id],
      result: hist.results[id],
      ...details(id),
    });
  }
  nodes.push(...hist.sideSessions.map((n) => ({ ...n })));
  hist.peak = Math.max(
    hist.peak,
    nodes.filter((n) => n.kind !== "main" && n.status === "run").length,
  );

  return {
    nodes,
    ctxPercent: live.ctxPercent,
    costUsd: live.costUsd,
    waitMs: hist.waitMs,
    peak: hist.peak,
    startedAt: hist.sessionStartedAt,
    now,
  };
}

async function refresh($: EngineInterface): Promise<AgentTreeGraph | undefined> {
  if (!live.isOn) {
    return undefined;
  }
  const graph = await snapshot($);
  // Turned off while the snapshot was being taken.
  if (!live.isOn) {
    return undefined;
  }
  // Agents only, as the band's jump is: the main loop's own prompt is already in front of the person.
  const waiting = graph.nodes.filter((n) => n.kind === "agent" && n.status === "wait");
  if (waiting.length !== live.waitCount) {
    if (live.waitCount === 0 && waiting[0]) {
      $.ui.toast(`${clip(waiting[0].label, 40)} needs you`);
    }
    $.ui.status(waiting.length ? `${waiting.length} need you` : undefined);
    live.waitCount = waiting.length;
  }
  const { coarse, fine } = signatures(graph);
  const isCoarse = coarse !== live.coarseSig;
  // Structure and status redraw at once; counts and current actions at most every FINE_REDRAW_MS,
  // since each redraw reloads the desktop's SVG frame.
  const isFineDue = fine !== live.fineSig && graph.now - live.lastWriteAt >= FINE_REDRAW_MS;
  if (isCoarse || isFineDue) {
    live.coarseSig = coarse;
    live.fineSig = fine;
    live.lastWriteAt = graph.now;
    await $.state.set(graphRef, graph);
    await $.state.set(historyRef, JSON.parse(JSON.stringify(live.history)) as AgentTreeHistory);
    if (live.storeKey) {
      await $.store
        .set(live.storeKey, live.history)
        .catch((err: unknown) =>
          $.ui.log(`agent-tree: history not saved for a resume (${String(err)})`),
        );
    }
  }

  return graph;
}

/** A conversation keeps its first launch time across resumes, while its session id changes. */
async function historyKey($: EngineInterface): Promise<string | undefined> {
  try {
    return `${HISTORY_PREFIX}${(await $.session.usage()).startedAt}`;
  } catch {
    return undefined;
  }
}

/** This conversation's saved history, dropping all but the newest few others so the store stays small. */
async function restoreHistory($: EngineInterface): Promise<AgentTreeHistory | undefined> {
  try {
    const launches = (await $.store.keys())
      .filter((k) => k.startsWith(HISTORY_PREFIX) && k !== live.storeKey)
      .sort(
        (a, b) => Number(a.slice(HISTORY_PREFIX.length)) - Number(b.slice(HISTORY_PREFIX.length)),
      );
    for (const k of launches.slice(0, Math.max(0, launches.length - (HISTORIES_KEPT - 1)))) {
      await $.store.delete(k);
    }

    return live.storeKey
      ? ((await $.store.get(live.storeKey)) as AgentTreeHistory | undefined)
      : undefined;
  } catch {
    // A store that cannot be read starts the view empty, as a new conversation would.
    return undefined;
  }
}

/**
 * The desktop pane's SVG. The last one is reused until the graph changes in shape or status, or the refresh is due,
 * so the frame is not reloaded for every count or age; those go stale in it meanwhile (the header text stays live).
 */
async function svgSource(
  $: EngineInterface,
  graph: AgentTreeGraph,
  isFoldOpen: boolean,
  isPaused: boolean,
): Promise<string> {
  const now = await $.clock.now();
  // Context in tenths, so the tile's figure updates now and then without a reload per turn.
  const ctxTenth = Math.floor((graph.ctxPercent ?? 0) / 10);
  const key = `${signatures(graph).coarse}|${isFoldOpen}|${isPaused}|${ctxTenth}`;
  let cached = live.svg;
  if (!cached || cached.key !== key || now - cached.at >= SVG_REFRESH_MS) {
    cached = {
      key,
      at: now,
      source: renderGraphSvg(graph, { isPaused, isFoldOpen, now: graph.now, phase: now }),
    };
    live.svg = cached;
  }

  return cached.source;
}

/** What changes the drawing's shape (coarse) and what only changes its numbers and lines (fine). */
function signatures(graph: AgentTreeGraph): { coarse: string; fine: string } {
  // The flag count, so a flag that turns on with time alone (a quiet agent makes no calls) still redraws.
  const coarse = graph.nodes.map((n) => [
    n.id,
    n.parentId,
    n.status,
    n.label,
    n.result,
    n.edited?.length,
    (n.repeat?.count ?? 0) >= 4,
    flags(n, graph, graph.now).length,
  ]);
  const fine = graph.nodes.map((n) => [n.id, n.calls, n.action, n.model, n.costUsd, n.tokens]);

  return {
    coarse: JSON.stringify(coarse),
    fine: JSON.stringify([fine, graph.costUsd, graph.ctxPercent, graph.waitMs, graph.peak]),
  };
}

/** The node `/agent-tree open <query>` means: `main`, an id prefix, or a label fragment. */
function findNode(graph: AgentTreeGraph, query: string): AgentTreeNode | undefined {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return undefined;
  }
  if (q === "main" || q === "session") {
    return graph.nodes.find((n) => n.kind === "main");
  }

  return (
    graph.nodes.find((n) => n.id.toLowerCase().startsWith(q)) ??
    graph.nodes.find((n) => n.label.toLowerCase().includes(q))
  );
}

async function tick($: EngineInterface) {
  const graph = await refresh($);
  // Ages only move while something runs; an idle session draws nothing new.
  if (graph?.nodes.some((n) => isLive(n.status))) {
    await $.state.set(nowRef, graph.now);
  }
}

function startTicking($: EngineInterface) {
  live.timer?.cancel();
  live.timer = $.clock.every(TICK_MS, () => tick($).catch(ignore));
  kick($);
}

/** Puts an agent's conversation, or the main one, in view; a refusal is said rather than lost. */
async function showConversation($: EngineInterface, n: AgentTreeNode) {
  const moved = await $.ui.view(n.kind === "agent" ? { agentId: n.id } : {});
  if (moved.deny) {
    $.ui.toast(`Could not show ${n.label}: ${moved.deny}`);
  }
}

async function setOn($: EngineInterface, value: boolean) {
  live.isOn = value;
  await $.state.set(isOnRef, value);
  if (value) {
    startTicking($);
  } else {
    live.timer?.cancel();
    live.timer = undefined;
    $.ui.status(undefined);
    live.waitCount = 0;
  }
}
