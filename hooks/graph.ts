import type { OrchestraGraph, OrchestraNode, OrchestraStatus } from '../types'

export const FOLD_AFTER = 6
const REPEAT_FLAG = 4
const SLOW_FACTOR = 2
const SLOW_MIN_MS = 60_000

/** Theme keys, so both surfaces draw them in the person's light or dark theme. */
export const STATUS_COLOR: Record<OrchestraStatus, string> = {
  run: 'success',
  wait: 'warning',
  hold: 'suggestion',
  idle: 'subtle',
  done: 'inactive',
  fail: 'error',
}

/** Still working: running, held on its own work, or waiting on the person. */
export function isLive(status: OrchestraStatus): boolean {
  return status === 'run' || status === 'wait' || status === 'hold'
}

const ARG_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt', 'path']

/** A tool call as one short line: the tool and its main argument (`Bash ls -la`). */
export function describeAction(tool: string, input: Record<string, unknown>): string {
  const name = shortTool(tool)
  for (const field of ARG_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.trim() !== '') {
      return `${name} ${oneLine(value)}`.slice(0, 160)
    }
  }

  return name
}

/**
 * Gives one finished model request its share of the session's cost: the
 * total's growth since the last request, to the loop that made this one.
 * shortcut: two requests that finish before either reads the total share one delta; per-request prices would split it exactly.
 */
export function attributeCost(
  h: { costs: Record<string, number>; tokens: Record<string, number>; lastUsd: number },
  id: string,
  totalUsd: number | undefined,
  tokens: number,
): void {
  h.tokens[id] = (h.tokens[id] ?? 0) + tokens
  if (totalUsd === undefined) {
    return
  }
  h.costs[id] = (h.costs[id] ?? 0) + Math.max(0, totalUsd - h.lastUsd)
  h.lastUsd = Math.max(h.lastUsd, totalUsd)
}

/** Dollars when known, else tokens; undefined when the node has used neither. */
export function spend(n: OrchestraNode): string | undefined {
  if (n.costUsd !== undefined && n.costUsd > 0) {
    return n.costUsd < 0.01 ? '<$0.01' : `$${n.costUsd.toFixed(2)}`
  }
  if (n.tokens) {
    return n.tokens >= 1000 ? `${Math.round(n.tokens / 1000)}k tok` : `${n.tokens} tok`
  }

  return undefined
}

/** The file a tool call edits or writes, if it does. */
export function editedFile(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool !== 'Edit' && tool !== 'Write' && tool !== 'NotebookEdit' && tool !== 'MultiEdit') {
    return undefined
  }
  const path = input.file_path ?? input.notebook_path

  return typeof path === 'string' ? path : undefined
}

/** Children per parent id, orphans under the root. */
export function childrenOf(nodes: OrchestraNode[]): Map<string | null, OrchestraNode[]> {
  const ids = new Set(nodes.map(n => n.id))
  const children = new Map<string | null, OrchestraNode[]>()
  for (const n of nodes) {
    const parent = n.parentId !== null && ids.has(n.parentId) ? n.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), n])
  }

  return children
}

/**
 * Splits a parent's children into those drawn as tiles and those folded away:
 * past FOLD_AFTER finished ones, the finished ones fold (unless the fold is open).
 */
export function fold(kids: OrchestraNode[], isOpen: boolean): { shown: OrchestraNode[]; folded: OrchestraNode[] } {
  const finished = kids.filter(n => n.status === 'done')
  if (isOpen || finished.length <= FOLD_AFTER) {
    return { shown: kids, folded: [] }
  }

  return { shown: kids.filter(n => n.status !== 'done'), folded: finished }
}

/** Short warnings worth a glance; empty when the node looks normal. */
export function flags(n: OrchestraNode, graph: OrchestraGraph, now: number): string[] {
  const out: string[] = []
  if (n.repeat && n.repeat.count >= REPEAT_FLAG) {
    out.push(`same ${n.repeat.action.split(' ')[0]} ×${n.repeat.count}`)
  }
  const siblings = graph.nodes.filter(o => o !== n && o.parentId === n.parentId && o.kind === 'agent')
  const durations = siblings.filter(o => o.endedAt !== undefined).map(o => (o.endedAt ?? 0) - o.startedAt)
  const mine = (n.endedAt ?? now) - n.startedAt
  const typical = median(durations)
  if (n.status === 'run' && typical !== undefined && mine > SLOW_MIN_MS && mine > typical * SLOW_FACTOR) {
    out.push(`${Math.round(mine / typical)}× slower`)
  }
  const shared = (n.edited ?? []).find(f => graph.nodes.some(o => o !== n && o.edited?.includes(f)))
  if (shared) {
    out.push(`shared file ${baseName(shared)}`)
  }

  return out
}

/** The tile's last line: what it waits on, what it is doing, or what it found. */
export function note(n: OrchestraNode): string {
  if (n.status === 'wait') {
    return `needs you${n.action ? `: ${n.action}` : ''}`
  }
  if (n.status === 'fail') {
    return '✕ failed'
  }
  if (n.status === 'hold') {
    return `waiting on ${n.action ?? 'its own work'}`
  }
  if (n.result) {
    return `↳ ${n.result}`
  }
  if (n.status === 'run' && n.action) {
    return `▸ ${n.action}`
  }

  return n.status === 'done' ? '↳ no result text' : ''
}

/** The tile's middle line: model, type, calls and how long it has run. */
export function meta(n: OrchestraNode, graph: OrchestraGraph, now: number): string {
  if (n.kind === 'main') {
    return [
      n.model?.replace(/^claude-/, ''),
      spend(n),
      graph.ctxPercent === undefined ? undefined : `ctx ${Math.round(graph.ctxPercent)}%`,
    ]
      .filter(Boolean)
      .join(' · ')
  }

  return [
    n.model?.replace(/^claude-/, '') ?? (n.kind === 'session' ? n.type : undefined),
    plural(n.calls, 'call'),
    spend(n),
    // Finished nodes are dimmed already, so their duration needs no word of its own.
    age(n.startedAt, n.endedAt ?? now),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The band's dot: amber while anything waits on you, green while anything runs. */
export function statusColor(graph: OrchestraGraph): string {
  const statuses = new Set(graph.nodes.map(n => n.status))

  return statuses.has('wait') ? STATUS_COLOR.wait : statuses.has('run') ? STATUS_COLOR.run : STATUS_COLOR.done
}

export function summarize(graph: OrchestraGraph): string {
  const agents = graph.nodes.filter(n => n.kind !== 'main')
  const running = agents.filter(n => n.status === 'run').length
  const waiting = graph.nodes.filter(n => n.status === 'wait').length
  const parts = [`orchestra · ${plural(agents.length, 'node')}`, `${running} running`]
  if (waiting > 0) {
    parts.push(`${waiting} needs you`)
  }

  return parts.join(' · ')
}

/** One line of everything the session has done so far, for the pane's header. */
export function totals(graph: OrchestraGraph): string {
  const agents = graph.nodes.filter(n => n.kind !== 'main')
  const by = (s: OrchestraStatus) => agents.filter(n => n.status === s).length
  const calls = graph.nodes.reduce((sum, n) => sum + n.calls, 0)
  const parts = [
    plural(agents.length, 'agent'),
    by('wait') ? `${by('wait')} need you` : undefined,
    by('run') ? `${by('run')} running` : undefined,
    by('hold') ? `${by('hold')} held` : undefined,
    by('done') ? `${by('done')} done` : undefined,
    by('fail') ? `${by('fail')} failed` : undefined,
    plural(calls, 'call'),
    graph.costUsd === undefined ? undefined : `$${graph.costUsd.toFixed(2)}`,
    graph.waitMs ? `waited on you ${age(0, graph.waitMs)}` : undefined,
  ]

  return parts.filter(Boolean).join(' · ')
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function age(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000))

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function shortTool(tool: string): string {
  return tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

export const TILE_W = 34
export const TILE_H = 7
export const FOLD_H = 3
const ROW_GAP = 1
const COL_GAP = 8
const ANCHOR = 2

export type PlacedTile = { node: OrchestraNode; x: number; y: number }
export type PlacedFold = { parentId: string; count: number; x: number; y: number }
/** One wire glyph at a cell; `path` and `step` order the live wires' cells so a pulse can travel them. */
export type WireCell = { x: number; y: number; ch: string; color: string; dim: boolean; path?: number; step?: number }
export type TreeLayout = {
  tiles: PlacedTile[]
  folds: PlacedFold[]
  edges: TreeEdge[]
  wires: WireCell[]
  width: number
  height: number
}
/** A placed box as an edge end: a tile or a fold, with its size. */
export type EdgeEnd = { x: number; y: number; h: number; isFold: boolean; status: OrchestraStatus }
export type TreeEdge = { from: EdgeEnd; to: EdgeEnd }
/** The box sizes a layout places with: character cells for the terminal, pixels for the SVG. */
export type LayoutDims = { tileW: number; tileH: number; foldH: number; rowGap: number; colGap: number }

export const CELL_DIMS: LayoutDims = { tileW: TILE_W, tileH: TILE_H, foldH: FOLD_H, rowGap: ROW_GAP, colGap: COL_GAP }

type Slot = { kind: 'tile'; node: OrchestraNode } | { kind: 'fold'; parentId: string; count: number }

const N = 1
const E = 2
const S = 4
const W = 8
const BOX: Record<number, string> = {
  [E]: '─', [W]: '─', [E | W]: '─', [N]: '│', [S]: '│', [N | S]: '│',
  [S | W]: '╮', [N | W]: '╯', [N | E]: '╰', [S | E]: '╭',
  [N | S | W]: '┤', [N | S | E]: '├', [E | W | S]: '┬', [E | W | N]: '┴', [N | E | S | W]: '┼',
}
const RANK: Record<OrchestraStatus, number> = { done: 0, idle: 1, hold: 2, fail: 3, wait: 4, run: 5 }

/**
 * Places the tree left to right: one column per depth, leaves top to bottom,
 * each parent centred on its children. In character cells (the default) it
 * also lays the wires as box-drawing glyphs, the one unit every surface
 * honours for size and offset; given pixel dims it places the SVG's cards.
 */
export function layoutTree(graph: OrchestraGraph, isFoldOpen: boolean, dims: LayoutDims = CELL_DIMS): TreeLayout {
  const kids = childrenOf(graph.nodes)
  const tiles: PlacedTile[] = []
  const folds: PlacedFold[] = []
  const edges: TreeEdge[] = []
  const isCells = dims === CELL_DIMS
  const snap = (v: number) => (isCells ? Math.round(v) : v)
  let y = 0
  let width = dims.tileW

  const visit = (slot: Slot, depth: number): EdgeEnd => {
    const x = depth * (dims.tileW + dims.colGap)
    width = Math.max(width, x + dims.tileW)
    if (slot.kind === 'fold') {
      const placed = { parentId: slot.parentId, count: slot.count, x, y }
      folds.push(placed)
      y += dims.foldH + dims.rowGap

      return { x, y: placed.y, h: dims.foldH, isFold: true, status: 'done' }
    }
    const { shown, folded } = fold(kids.get(slot.node.id) ?? [], isFoldOpen)
    const children: Slot[] = [
      ...shown.map((node): Slot => ({ kind: 'tile', node })),
      ...(folded.length ? [{ kind: 'fold', parentId: slot.node.id, count: folded.length } as Slot] : []),
    ]
    let tileY: number
    let placedKids: EdgeEnd[] = []
    if (children.length === 0) {
      tileY = y
      y += dims.tileH + dims.rowGap
    } else {
      placedKids = children.map(c => visit(c, depth + 1))
      const first = placedKids.at(0)
      const last = placedKids.at(-1)
      const mid = ((first ? first.y + first.h / 2 : y) + (last ? last.y + last.h / 2 : y)) / 2
      tileY = Math.max(0, snap(mid - dims.tileH / 2))
    }
    const end: EdgeEnd = { x, y: tileY, h: dims.tileH, isFold: false, status: slot.node.status }
    tiles.push({ node: slot.node, x, y: tileY })
    for (const to of placedKids) {
      edges.push({ from: end, to })
    }

    return end
  }
  for (const root of kids.get(null) ?? []) {
    visit({ kind: 'tile', node: root }, 0)
  }
  const bottom = Math.max(dims.tileH, ...tiles.map(t => t.y + dims.tileH), ...folds.map(f => f.y + dims.foldH))

  return { tiles, folds, edges, wires: isCells ? wireCells(edges) : [], width, height: bottom }
}

function wireCells(edges: TreeEdge[]): WireCell[] {
  const mask = new Map<string, { bits: number; status: OrchestraStatus }>()
  const order = new Map<string, { path: number; step: number }>()
  const arrows: WireCell[] = []
  const link = (x: number, y: number, bits: number, status: OrchestraStatus) => {
    const k = `${x},${y}`
    const old = mask.get(k)
    mask.set(k, { bits: (old?.bits ?? 0) | bits, status: old && RANK[old.status] > RANK[status] ? old.status : status })
  }
  edges.forEach(({ from, to }, path) => {
    const status = to.status
    const x0 = from.x + TILE_W
    const y0 = from.y + ANCHOR
    const xm = x0 + 3
    const x1 = to.x - 2
    const y1 = to.y + (to.isFold ? 1 : ANCHOR)
    const cells: [number, number][] = []
    for (let x = x0; x <= xm; x++) cells.push([x, y0])
    const dy = Math.sign(y1 - y0)
    for (let yy = y0 + dy; dy !== 0 && yy !== y1 + dy; yy += dy) cells.push([xm, yy])
    for (let x = xm + 1; x <= x1; x++) cells.push([x, y1])
    link(x0, y0, W, status)
    cells.forEach(([x, yy], step) => {
      const next = cells[step + 1]
      if (next) {
        const [nx, ny] = next
        const dir = nx > x ? E : nx < x ? W : ny > yy ? S : N
        const back = dir === E ? W : dir === W ? E : dir === S ? N : S
        link(x, yy, dir, status)
        link(nx, ny, back, status)
      }
      if (isLive(status)) {
        order.set(`${x},${yy}`, { path, step })
      }
    })
    link(x1, y1, E, status)
    arrows.push({ x: to.x - 1, y: y1, ch: '▶', color: STATUS_COLOR[status], dim: status === 'done' })
  })
  const cells = [...mask].map(([k, { bits, status }]): WireCell => {
    const [x = 0, yy = 0] = k.split(',').map(Number)
    const ch = BOX[bits] ?? '┼'
    // Pulses travel straight runs only; a junction keeps its shape.
    const live = ch === '─' || ch === '│' ? order.get(k) : undefined

    return { x, y: yy, ch, color: STATUS_COLOR[status], dim: status === 'done', ...live }
  })

  return [...cells, ...arrows]
}
