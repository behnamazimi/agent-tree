import { atom, read, update } from "claude-code";
import type { AgentInfo, EngineInterface, Register, Timer } from "claude-code";

import type { OrchestraGraph, OrchestraHistory, OrchestraNode, OrchestraStatus } from "../types";
import {
  age,
  attributeCost,
  isLive,
  clip,
  describeAction,
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
  STATUS_COLOR,
  statusColor,
  summarize,
  TILE_H,
  TILE_W,
  totals,
} from "./graph";
import type { PlacedFold, PlacedTile } from "./graph";
import { renderBarSvg, renderGraphSvg, svgSize } from "./svg";
import type { WiresProps } from "./wires";

const PANE = "orchestra";
const MAIN = "main";
const TICK_MS = 1000;
const START_SESSION_TOOL = "mcp__ccd_session__start_session";
const CARD_W = 46;
// Measured from a desktop pane: about 10.6px per cell; a little under keeps the drawing inside.
const PX_PER_COLUMN = 10;
const FINE_REDRAW_MS = 10_000;
// Each new SVG source reloads its frame, which shows as a blink; between events it is only refreshed this often.
const SVG_REFRESH_MS = 300_000;
const CARD_ROOM = 9;
const SEEN_CAP = 50;

const isOnAtom = atom({ plugin: "orchestra", key: "isOn" } as const, true);
const graphAtom = atom(
  { plugin: "orchestra", key: "graph" } as const,
  {
    nodes: [],
    now: 0,
  } as OrchestraGraph,
);
const historyAtom = atom(
  { plugin: "orchestra", key: "history" } as const,
  null as OrchestraHistory | null,
);
const nowAtom = atom({ plugin: "orchestra", key: "now" } as const, 0);
const foldAtom = atom({ plugin: "orchestra", key: "isFoldOpen" } as const, true);

const AGENT_STATUS: Record<AgentInfo["status"], OrchestraStatus> = {
  pending: "run",
  running: "run",
  waiting: "hold",
  idle: "idle",
  completed: "done",
  failed: "fail",
  killed: "fail",
};

const emptyHistory = (now: number): OrchestraHistory => ({
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
  /** How many nodes waited on the person at the last refresh; the status and toast fire on its changes. */
  waitCount: 0,
  timer: undefined as Timer | undefined,
  mainStatus: "idle" as OrchestraStatus,
  waitingSince: undefined as number | undefined,
  ctxPercent: undefined as number | undefined,
  costUsd: undefined as number | undefined,
  coarseSig: "",
  /** Agents whose permission prompt is up, with its message; cleared once their call goes through. */
  needsYou: {} as Record<string, string>,
  /** Agent tool call id to the agent it started, so the call's result text can become that agent's result. */
  spawned: {} as Record<string, string>,
  fineSig: "",
  /** The desktop pane's last SVG, reused while its key (shape and status) holds. */
  svg: undefined as { key: string; at: number; source: string } | undefined,
  lastWriteAt: 0,
  history: emptyHistory(0),
};

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "orchestra",
      description:
        "Orchestra view for this session: on, off, view, all (fold or unfold finished agents), open <agent>, or export (copy the overview)",
      argumentHint: "on|off|view|all|open <agent>|export",
    });
    // A history saved by an older version lacks the newer fields; the empty one fills them.
    live.history = { ...emptyHistory(await $.clock.now()), ...(await read($, historyAtom)) };
    // Cost spent before the mod loaded belongs to no agent it saw.
    live.history.lastUsd = Math.max(live.history.lastUsd, (await sessionUsd($)) ?? 0);
    live.isOn = await read($, isOnAtom);
    if (live.isOn) {
      startTicking($);
    }

    return next(e);
  });

  on("command.run", { command: "orchestra" }, async ($, e) => {
    const [verb = "", ...rest] = e.args.trim().split(/\s+/);
    const arg = verb.toLowerCase();
    if (arg === "on" || arg === "off") {
      await setOn($, arg === "on");

      return { text: `Orchestra is ${arg} for this session.` };
    }
    if (arg === "all") {
      const isOpen = !(await read($, foldAtom));
      await update($, foldAtom, () => isOpen);

      return { text: isOpen ? "Showing every finished agent." : "Folding finished agents again." };
    }
    if (arg === "open") {
      // A command is the person's own input, so it may switch the main view.
      const target = findNode(await read($, graphAtom), rest.join(" "));
      if (!target || target.kind === "session") {
        return { text: `No agent matches "${rest.join(" ")}". Hover a card to see its id.` };
      }
      const moved = await $.ui.view(target.kind === "agent" ? { agentId: target.id } : {});

      return { text: moved.deny ? `Could not open it: ${moved.deny}` : `Showing ${target.label}.` };
    }
    if (arg === "export") {
      const copied = await $.ui.copy({ text: overview(await read($, graphAtom)) });

      return {
        text: copied.isCopied ? "Orchestra overview copied." : `Could not copy (${copied.reason}).`,
      };
    }
    if (arg !== "" && arg !== "view") {
      return { text: "Usage: /orchestra on|off|view|all|open <agent>|export" };
    }
    const opened = await $.ui.open({ id: PANE, title: "Orchestra" });

    return {
      text: opened.isPlaced
        ? "Orchestra view opened."
        : `Orchestra view is waiting for room: ${opened.reason ?? "not placed"}.`,
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
      live.spawned[e.tool_use_id] = result.agentId;
      live.history.startedAt[result.agentId] = await $.clock.now();
      live.history.models[result.agentId] = result.model;
      live.history.tasks[result.agentId] = clip(e.prompt.replace(/\s+/g, " ").trim(), 300);
      kick($);
    }

    return result;
  });

  on("classic.SubagentStop", async ($, e, next) => {
    if (live.isOn) {
      const firstLine = e.last_assistant_message?.trim().split("\n")[0];
      // The host often sends this empty; the parent's Agent call result then fills it (see tool.call).
      if (firstLine) {
        live.history.results[e.agent_id] = firstLine.slice(0, 200);
      }
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
        const ran = await next(e);
        const agentId = live.spawned[e.tool_use_id];
        const firstLine = ran.text?.trim().split("\n")[0];
        if (agentId && firstLine) {
          live.history.results[agentId] ??= firstLine.slice(0, 200);
        }

        return ran;
      } finally {
        // The call ended, so whatever it asked the person is answered.
        delete live.needsYou[id];
      }
    }
    const args = input as { title?: string; name?: string; prompt?: string; initiation?: string };
    const node: OrchestraNode = {
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
    let status: OrchestraStatus = "fail";
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
    if (e.props.hasSurvey) {
      return next(e);
    }
    const { Box, Button, Text } = $.ui.resolve(e);
    const isEnabled = await read($, isOnAtom);
    const graph = await read($, graphAtom);
    // The band's one jump: the first agent that is waiting on the person.
    const waiting = isEnabled
      ? graph.nodes.find((n) => n.kind === "agent" && n.status === "wait")
      : undefined;

    return (
      <Box flexDirection="row" gap={1}>
        <Text color={isEnabled ? statusColor(graph) : undefined} dimColor={!isEnabled}>
          ●
        </Text>
        <Text dimColor>{isEnabled ? summarize(graph) : "orchestra off for this session"}</Text>
        {...waiting
          ? [
              <Button
                key="jump"
                label={`Jump to ${clip(waiting.label, 28)}`}
                variant="primary"
                onPress={() => void $.ui.view({ agentId: waiting.id })}
              />,
            ]
          : []}
        <Button
          key="view"
          label="View"
          onPress={() => void $.ui.open({ id: PANE, title: "Orchestra" })}
        />
        <Button
          key="toggle"
          label={isEnabled ? "On" : "Off"}
          variant={isEnabled && !waiting ? "primary" : "secondary"}
          onPress={() => setOn($, !isEnabled)}
        />
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e);
    const isEnabled = await read($, isOnAtom);
    const graph = await read($, graphAtom);
    const isFoldOpen = await read($, foldAtom);
    const header = isEnabled
      ? totals(graph)
      : `Off for this session. No events recorded. ${totals(graph)}`;
    const copy = async () => {
      // The latest graph, not the one this draw was made from.
      const copied = await $.ui.copy({
        text: overview(await read($, graphAtom)),
        surface: e.surface,
      });
      $.ui.toast(
        copied.isCopied ? "Orchestra overview copied" : `Could not copy (${copied.reason})`,
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
          height={16}
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
        borderColor="subtle"
        borderDimColor
        paddingX="sm"
        paddingY="sm"
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Box flexDirection="row" gap={1} flexShrink={1}>
            <Text size="heading" weight="semibold">
              {head.agents}
            </Text>
            <Text dimColor>
              {isEnabled
                ? head.state || "no agents yet"
                : "off for this session, no events recorded"}
            </Text>
          </Box>
          <Button key="copy" label="Copy" onPress={() => void copy()} />
        </Box>
        {bar}
        <Text dimColor>{figures.flatMap((f, i) => (i ? [" · ", f] : [f]))}</Text>
      </Box>
    );

    if (e.surface !== "terminal") {
      // Not reading nowAtom here: each new SVG source reloads its frame, so it redraws only with the graph.
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
            alt={`Orchestra: ${header}`}
            isInteractive
          />
        </Box>
      );
    }

    const now = Math.max(graph.now, await read($, nowAtom));
    const tree = layoutTree(graph, isFoldOpen);
    const wires: WiresProps = {
      wires: tree.wires,
      width: tree.width,
      height: tree.height,
      isPaused: !isEnabled,
    };

    // Switching the main view is allowed only from the person's own press, which these closures are.
    const openTo = (n: OrchestraNode) => () =>
      void $.ui.view(n.kind === "agent" ? { agentId: n.id } : {});

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
          <Text
            italic
            color={n.status === "wait" ? "warning" : n.status === "fail" ? "error" : undefined}
            dimColor={n.status !== "wait" && n.status !== "fail"}
          >
            {clip(note(n), TILE_W - 4)}
          </Text>
          <Text color="warning">
            {warnings.length ? `⚑ ${clip(warnings.join(" · "), TILE_W - 6)}` : " "}
          </Text>
        </Box>
      );
    };

    // Drawn after every tile, so it paints over the tiles below its own.
    const card = ({ node: n, x, y }: PlacedTile) => {
      const lines: [string, string][] = [
        ["Task", n.task],
        [n.status === "wait" ? "Waiting on" : "Now", n.status === "done" ? undefined : n.action],
        ["Result", n.result],
        ["Edited", n.edited?.map((f) => f.split("/").pop()).join(", ")],
        [
          "Started",
          `${age(n.startedAt, now)} ago${n.endedAt ? ` · took ${age(n.startedAt, n.endedAt)}` : ""}`,
        ],
      ].filter((line): line is [string, string] => Boolean(line[1]));

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
            <Text dimColor>
              {n.kind === "main" ? "Click the title to return to the main conversation" : " "}
            </Text>
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
        <Button key={`fold-${f.parentId}`} plain onPress={() => update($, foldAtom, () => true)}>
          <Text dimColor>▸ {plural(f.count, "finished agent")} · show</Text>
        </Button>
      </Box>
    );

    // Only the terminal reaches here; its Client animates the wires behind the tiles.
    const { Client } = $.ui.resolve(e);
    const wireLayer = [
      <Box key="wires" position="absolute" top={0} left={0}>
        <Client
          key="wires-client"
          module="./wires.tsx"
          props={wires}
          width={tree.width}
          height={tree.height}
        />
      </Box>,
    ];

    const hasOpenFold =
      isFoldOpen && graph.nodes.filter((n) => n.status === "done").length > FOLD_AFTER;

    return (
      <Box flexDirection="column" gap={1}>
        {headerRow}
        <Box width={tree.width + CARD_W} height={tree.height + CARD_ROOM}>
          {...wireLayer}
          {tree.tiles.map(tile)}
          {tree.folds.map(foldTile)}
          {tree.tiles.map(card)}
        </Box>
        {...hasOpenFold
          ? [
              <Button key="fold-close" plain onPress={() => update($, foldAtom, () => false)}>
                <Text dimColor>▾ fold finished agents</Text>
              </Button>,
            ]
          : []}
      </Box>
    );
  });
};

function record(id: string, tool: string, input: Record<string, unknown>, now: number) {
  const h = live.history;
  const c = h.counters[id] ?? { calls: 0 };
  h.counters[id] = { calls: c.calls + 1, lastTool: tool, lastAt: now };
  const action = describeAction(tool, input);
  h.actions[id] = action;
  const seen = (h.seen[id] ??= {});
  if (seen[action] !== undefined || Object.keys(seen).length < SEEN_CAP) {
    seen[action] = (seen[action] ?? 0) + 1;
  }
  const file = editedFile(tool, input);
  if (file && !(h.edited[id] ?? []).includes(file)) {
    h.edited[id] = [...(h.edited[id] ?? []), file];
  }
}

const ignore = () => {};
const AGENT_CAP = 200;

/** Fire-and-forget refresh; a failed one is retried by the next event or tick. */
function kick($: EngineInterface) {
  refresh($).catch(ignore);
}

/** Keeps a long session's saved history small by forgetting the oldest finished agents past AGENT_CAP. */
function prune(h: OrchestraHistory) {
  const ids = Object.keys(h.agents);
  const finished = ids
    .filter((id) => h.agents[id]?.status === "done" || h.agents[id]?.status === "fail")
    .sort((a, b) => (h.endedAt[a] ?? 0) - (h.endedAt[b] ?? 0));
  for (const id of finished.slice(0, Math.max(0, ids.length - AGENT_CAP))) {
    delete h.agents[id];
    for (const map of [
      h.models,
      h.startedAt,
      h.endedAt,
      h.results,
      h.tasks,
      h.actions,
      h.edited,
      h.seen,
      h.costs,
      h.tokens,
      h.counters,
    ]) {
      delete map[id];
    }
  }
}

function repeatOf(id: string): OrchestraNode["repeat"] {
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

async function setMainStatus($: EngineInterface, status: OrchestraStatus) {
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

async function snapshot($: EngineInterface): Promise<OrchestraGraph> {
  const now = await $.clock.now();
  const agents = await $.agent.list();
  const h = live.history;
  prune(h);
  const details = (id: string) => ({
    ...(h.counters[id] ?? { calls: 0 }),
    task: h.tasks[id],
    action: h.actions[id],
    edited: h.edited[id],
    repeat: repeatOf(id),
    costUsd: h.costs[id],
    tokens: h.tokens[id],
  });
  const nodes: OrchestraNode[] = [
    {
      id: MAIN,
      parentId: null,
      kind: "main",
      label: "this session",
      type: "session",
      status: live.mainStatus,
      model: h.mainModel,
      startedAt: h.sessionStartedAt,
      ...details(MAIN),
    },
  ];
  for (const a of agents) {
    h.agents[a.id] = {
      label: a.description || a.name || a.type,
      type: a.type,
      parentId: a.parentId ?? MAIN,
      status: AGENT_STATUS[a.status],
    };
  }
  const listed = new Set(agents.map((a) => a.id));
  for (const [id, a] of Object.entries(h.agents)) {
    // The list drops an agent once it ends (a nested one, say); keep it, as finished, for the overview.
    const status = live.needsYou[id]
      ? "wait"
      : listed.has(id) || a.status === "fail"
        ? a.status
        : "done";
    h.startedAt[id] ??= now;
    if (status === "done" || status === "fail") {
      h.endedAt[id] ??= now;
    }
    nodes.push({
      id,
      parentId: a.parentId,
      kind: "agent",
      label: a.label,
      type: a.type,
      status,
      model: h.models[id],
      startedAt: h.startedAt[id] ?? now,
      endedAt: h.endedAt[id],
      result: h.results[id],
      ...details(id),
    });
  }
  nodes.push(...h.sideSessions.map((n) => ({ ...n })));
  h.peak = Math.max(h.peak, nodes.filter((n) => n.kind !== "main" && n.status === "run").length);

  return {
    nodes,
    ctxPercent: live.ctxPercent,
    costUsd: live.costUsd,
    waitMs: h.waitMs,
    peak: h.peak,
    startedAt: h.sessionStartedAt,
    now,
  };
}

async function refresh($: EngineInterface): Promise<OrchestraGraph | undefined> {
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
    await update($, graphAtom, () => graph);
    await update(
      $,
      historyAtom,
      () => JSON.parse(JSON.stringify(live.history)) as OrchestraHistory,
    );
  }

  return graph;
}

/**
 * The desktop pane's SVG. The last one is reused until the graph changes in shape or status, or the refresh is due,
 * so the frame is not reloaded for every count or age; those go stale in it meanwhile (the header text stays live).
 */
async function svgSource(
  $: EngineInterface,
  graph: OrchestraGraph,
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
function signatures(graph: OrchestraGraph): { coarse: string; fine: string } {
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

/** The node `/orchestra open <query>` means: `main`, an id prefix, or a label fragment. */
function findNode(graph: OrchestraGraph, query: string): OrchestraNode | undefined {
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
    await update($, nowAtom, () => graph.now);
  }
}

function startTicking($: EngineInterface) {
  live.timer?.cancel();
  live.timer = $.clock.every(TICK_MS, () => tick($).catch(ignore));
  kick($);
}

async function setOn($: EngineInterface, value: boolean) {
  live.isOn = value;
  await update($, isOnAtom, () => value);
  if (value) {
    startTicking($);
  } else {
    live.timer?.cancel();
    live.timer = undefined;
    $.ui.status(undefined);
    live.waitCount = 0;
  }
}
