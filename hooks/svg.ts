import type { OrchestraGraph, OrchestraNode, OrchestraStatus } from '../types'
import { age, clip, flags, isLive, layoutTree, meta, note, plural, spend } from './graph'
import type { LayoutDims, PlacedFold, PlacedTile, TreeEdge } from './graph'

const CARD_W = 236
const CARD_H = 84
const FOLD_H = 44
const PAD = 16
const ARROW = 8
const LEAD = 12
const DIMS: LayoutDims = { tileW: CARD_W, tileH: CARD_H, foldH: FOLD_H, rowGap: 14, colGap: 84 }
const POP_W = 304
const POP_LINE = 15
const POP_CHARS = 46
const TL_GAP = 28
const FOLD_POP_ROWS = 8
/** The tallest hover card: a fold's, with its rows and two hint lines. */
const POP_MAX_H = 16 + (FOLD_POP_ROWS + 2) * POP_LINE
const TL_ROW = 22
const TL_LABEL = 168
const TL_CHAR = 6.2
const TL_BAR_H = 12

const HEX: Record<OrchestraStatus, string> = {
  run: '#1D9E75',
  wait: '#D68A1F',
  hold: '#378ADD',
  idle: '#7F77DD',
  done: '#9C9A92',
  fail: '#E24B4A',
}

/** How strongly each status washes its card; finished ones barely, so they recede. */
const TINT: Record<string, number> = { run: 0.12, wait: 0.18, hold: 0.1, fail: 0.16, idle: 0.08, done: 0.04, main: 0.1 }

const STYLE = `
:root{--card:#fff;--line:#e4e2da;--text:#1f1e1c;--muted:#6f6d66;--faint:#a3a19a;--track:#f1efe8;--pop:#fff}
@media (prefers-color-scheme:dark){:root{--card:#262624;--line:#3a3935;--text:#f1efe8;--muted:#b4b2a9;--faint:#7c7a73;--track:#33322f;--pop:#2f2e2b}}
text{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.card rect.bg{fill:var(--card);stroke:var(--line);stroke-width:1}
.card:hover rect.bg{stroke:var(--faint)}
.card.main rect.bg{stroke:#AFA9EC}
.tint{pointer-events:none}
.card.wait rect.bg{stroke:${HEX.wait};stroke-width:1.5}
.card.fail rect.bg{stroke:${HEX.fail};stroke-width:1.5}
.card.done{opacity:.6}
.k{font-size:10.5px;fill:var(--faint)}
.t{font-size:13.5px;font-weight:600;fill:var(--text)}
.m{font-size:11px;fill:var(--muted)}
.n{font-size:11px;font-style:italic;fill:var(--muted)}
.n.wait{fill:${HEX.wait};font-style:normal;font-weight:500}
.n.fail{fill:${HEX.fail};font-style:normal}
.flag{font-size:10px;fill:${HEX.wait};font-weight:600}
.flow{stroke-dasharray:4 6;animation:dash 1s linear infinite}
.ring{animation:ring 1.6s ease-out infinite;transform-box:fill-box;transform-origin:center}
.pop{opacity:0;visibility:hidden;transition:opacity .12s ease-out}
.pop rect{fill:var(--pop);stroke:var(--line);filter:drop-shadow(0 6px 14px rgba(0,0,0,.16))}
.pop .l{font-size:11px;fill:var(--muted)}
.pop .b{font-weight:600;fill:var(--text)}
.pop .h{font-size:10.5px;fill:var(--faint)}
.tl{font-size:11px;fill:var(--muted)}
.tl.h{font-weight:600;fill:var(--text)}
.grid{stroke:var(--track);stroke-width:1}
.tl.in{fill:#fff;font-weight:600}
.bar.live{animation:breathe 1.6s ease-in-out infinite}
/* A redraw reloads the frame; the wall-clock phase (--p, seconds) lets each animation resume where it was. */
.flow,.ring,.bar.live{animation-delay:calc(var(--p)*-1s)}
.paused .flow,.paused .ring,.paused .bar.live{animation:none}
.paused .wire,.paused .card{opacity:.45}
@keyframes dash{to{stroke-dashoffset:-20}}
@keyframes ring{0%{transform:scale(.6);opacity:.7}100%{transform:scale(2.2);opacity:0}}
@keyframes breathe{50%{opacity:.55}}
@media (prefers-reduced-motion:reduce){.flow,.ring,.bar.live{animation:none}.pop{transition:none}}
`

/** The drawing's natural size in CSS pixels. */
export function svgSize(graph: OrchestraGraph, isFoldOpen: boolean): { width: number; height: number } {
  const tree = layoutTree(graph, isFoldOpen, DIMS)

  return {
    width: Math.max(tree.width, TL_LABEL + 300) + 2 * PAD,
    // Never shorter than the tallest hover card, which would otherwise be cut at the bottom.
    height: Math.max(POP_MAX_H + 2 * PAD, tree.height + 2 * PAD + TL_GAP + TL_ROW * (timelineRows(graph, tree.tiles).length + 2)),
  }
}

/**
 * The whole view as one SVG: cards, curved wires with travelling particles,
 * hover cards and a timeline. Hover is CSS (`#c-i:hover ~ #p-i`), so it needs
 * the Svg's interactive frame; the frame runs no script, so nothing here clicks.
 */
export function renderGraphSvg(graph: OrchestraGraph, opts: { isPaused: boolean; isFoldOpen: boolean; now: number; phase?: number }): string {
  const tree = layoutTree(graph, opts.isFoldOpen, DIMS)
  const { width, height } = svgSize(graph, opts.isFoldOpen)
  const shift = (t: { x: number; y: number }) => ({ x: t.x + PAD, y: t.y + PAD })
  const tiles = tree.tiles.map(t => ({ ...t, ...shift(t) }))
  const folds = tree.folds.map(f => ({ ...f, ...shift(f) }))
  const finished = graph.nodes.filter(n => n.status === 'done')
  const hoverRules = [...tiles.map((_, i) => `#c${i}:hover~#p${i},#p${i}:hover`), ...folds.map((_, i) => `#f${i}:hover~#q${i},#q${i}:hover`)]
  const chartBottom = tree.height + 2 * PAD
  // Wall-clock seconds the animations are aligned to, apart from `now`, which only labels ages.
  const phase = (opts.phase ?? opts.now) / 1000

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<defs>${Object.entries(HEX)
      // Fixed size in user units (not scaled by the stroke), its tip as the reference point so it ends exactly at the card.
      .map(([s, c]) => `<marker id="a-${s}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="${ARROW}" markerHeight="${ARROW}" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 1 L10 5 L0 9 z" fill="${c}"/></marker>`)
      .join('')}${Object.entries({ ...HEX, main: HEX.idle })
      .map(([s, c]) => `<linearGradient id="t-${s}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${c}" stop-opacity="${TINT[s] ?? 0.1}"/><stop offset=".7" stop-color="${c}" stop-opacity="0"/></linearGradient>`)
      .join('')}</defs>`,
    `<style>${STYLE}:root{--p:${phase.toFixed(3)}}${hoverRules.length ? `${hoverRules.join(',')}{opacity:1;visibility:visible}` : ''}</style>`,
    `<g class="${opts.isPaused ? 'paused' : ''}">`,
    ...tree.edges.map((e, i) => wire(e, i, phase)),
    ...tiles.map((t, i) => card(t, i, graph, opts.now)),
    ...folds.map((f, i) => foldBox(f, i)),
    timeline(graph, timelineRows(graph, tree.tiles), chartBottom, width, opts.now),
    // Hover cards last, so they paint over cards and timeline alike.
    ...tiles.map((t, i) => popover(t, i, opts.now, width, height)),
    ...folds.map((f, i) => foldPopover(f, i, finished, width, height)),
    '</g></svg>',
  ].join('')
}

function wire({ from, to }: TreeEdge, i: number, phase: number): string {
  const x1 = from.x + PAD + CARD_W
  const y1 = from.y + PAD + from.h / 2
  const x2 = to.x + PAD - 1
  const y2 = to.y + PAD + to.h / 2
  // The curve ends in a short straight lead-in, so the arrow sits on a level line rather than mid-bend.
  const xs = x2 - LEAD
  const mx = (x1 + xs) / 2
  const d = `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${xs} ${y2} L${x2} ${y2}`
  const color = HEX[to.status]
  const isLiveWire = isLive(to.status)
  const width = isLiveWire ? 1.75 : 1.25
  const opacity = isLiveWire ? '' : ' opacity=".55"'
  // The dashed body never ends in a gap at the arrow: a solid lead-in carries the line into its base.
  const lead = `<path d="M${xs} ${y2} L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${width}"${opacity} marker-end="url(#a-${to.status})"/>`
  const path = `<path id="w${i}" class="wire${isLiveWire ? ' flow' : ''}" d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"${opacity}/>${lead}`
  if (!isLiveWire) {
    return path
  }
  const dur = to.status === 'run' ? 1.4 : 2.6
  // A negative begin starts the particle mid-path, here at the wall-clock phase so a reload does not restart it.
  const dot = (offset: number) => {
    const begin = `-${((phase + offset) % dur).toFixed(3)}s`

    // Fades in off the source card and out before the arrowhead, so it never sits on the tip.
    return `<circle r="3" fill="${color}" opacity="0"><animateMotion dur="${dur}s" begin="${begin}" repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines=".4 0 .6 1"><mpath href="#w${i}"/></animateMotion><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.12;.8;.92" dur="${dur}s" begin="${begin}" repeatCount="indefinite"/></circle>`
  }

  return `<g class="wire">${path}${dot(0)}${dot(dur / 2)}</g>`
}

function card({ node: n, x, y }: PlacedTile, i: number, graph: OrchestraGraph, now: number): string {
  const color = HEX[n.status]
  const isLiveCard = isLive(n.status)
  const kind = n.kind === 'main' ? 'session' : n.kind === 'session' ? 'side session' : `${n.type} · ${n.id.slice(0, 6)}`
  const warnings = flags(n, graph, now)
  const cls = ['card', n.kind === 'main' ? 'main' : '', n.status].filter(Boolean).join(' ')

  return [
    `<g id="c${i}" class="${cls}">`,
    `<rect class="bg" x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="12"/>`,
    // Same rounded rect as the card, filled with a status wash that fades from the top: no edge to clash with the corners.
    `<rect class="tint" x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="12" fill="url(#t-${n.kind === 'main' && n.status !== 'wait' && n.status !== 'fail' ? 'main' : n.status})"/>`,
    `<text class="k mono" x="${x + 14}" y="${y + 20}">${esc(clip(kind, warnings.length ? 16 : 26))}</text>`,
    // A warning sits in the header, left of the dot, so the stats line (and its cost) always shows.
    warnings.length ? `<text class="flag" x="${x + CARD_W - 28}" y="${y + 20}" text-anchor="end">⚑ ${esc(clip(warnings.join(' · '), 18))}</text>` : '',
    isLiveCard ? `<circle class="ring" cx="${x + CARD_W - 16}" cy="${y + 16}" r="4" fill="${color}"/>` : '',
    `<circle cx="${x + CARD_W - 16}" cy="${y + 16}" r="4" fill="${color}"/>`,
    `<text class="t" x="${x + 14}" y="${y + 40}">${esc(clip(n.label, 28))}</text>`,
    `<text class="m" x="${x + 14}" y="${y + 57}">${esc(clip(meta(n, graph, now), 38))}</text>`,
    `<text class="n ${n.status}" x="${x + 14}" y="${y + 73}">${esc(clip(note(n), 38))}</text>`,
    '</g>',
  ].join('')
}

function foldBox({ count, x, y }: PlacedFold, i: number): string {
  return [
    `<g id="f${i}" class="card done">`,
    `<rect class="bg" x="${x}" y="${y}" width="${CARD_W}" height="${FOLD_H}" rx="12" stroke-dasharray="4 4"/>`,
    `<text class="m" x="${x + 14}" y="${y + 26}">▸ ${plural(count, 'finished agent')} · hover to list</text>`,
    '</g>',
  ].join('')
}

type PopLine = { label?: string; text: string; cls?: string }

function popover({ node: n, x, y }: PlacedTile, i: number, now: number, width: number, bottom: number): string {
  const lines: PopLine[] = [
    ...field('Task', n.task, 3),
    ...field(n.status === 'wait' || n.status === 'hold' ? 'Waiting on' : 'Now', n.status === 'done' ? undefined : n.action, 2),
    ...field('Result', n.result, 3),
    ...field('Edited', n.edited?.map(f => f.split('/').pop()).join(', '), 2),
    ...field('Model', n.model?.replace(/^claude-/, ''), 1),
    ...field('Spent', [spend(n), n.tokens && n.costUsd ? `${Math.round(n.tokens / 1000)}k tokens` : undefined].filter(Boolean).join(' · '), 1),
    ...field('Time', `started ${age(n.startedAt, now)} ago${n.endedAt ? ` · took ${age(n.startedAt, n.endedAt)}` : ''}`, 1),
    { text: n.kind === 'agent' ? `Jump in: /orchestra open ${n.id.slice(0, 6)}` : n.kind === 'main' ? 'Back here: /orchestra open main' : '', cls: 'h' },
  ].filter(l => l.text !== '')

  return popBox(`p${i}`, lines, x, y, CARD_H, width, bottom)
}

function foldPopover({ x, y }: PlacedFold, i: number, finished: OrchestraNode[], width: number, bottom: number): string {
  const lines: PopLine[] = finished.slice(0, FOLD_POP_ROWS).map(n => ({
    label: clip(n.label, 20),
    text: clip(n.result ?? 'no result text', POP_CHARS - Math.min(20, n.label.length) - 2),
  }))
  const more = finished.length - FOLD_POP_ROWS
  const tail: PopLine[] = [
    ...(more > 0 ? [{ text: `+${more} more`, cls: 'h' }] : []),
    { text: 'Show them all: /orchestra all', cls: 'h' },
  ]

  return popBox(`q${i}`, [...lines, ...tail], x, y, FOLD_H, width, bottom)
}

function popBox(id: string, lines: PopLine[], x: number, y: number, h: number, width: number, bottom: number): string {
  const popH = 16 + lines.length * POP_LINE
  const px = Math.min(x + 10, width - POP_W - PAD)
  // Below the card when it fits in the drawing, else above it; overlapping the card by 4px keeps the hover alive on the way in.
  const py = y + h - 4 + popH <= bottom ? y + h - 4 : Math.max(4, y - popH + 4)
  const rows = lines.map((l, k) => {
    const ty = py + 20 + k * POP_LINE
    const label = l.label ? `<tspan class="b">${esc(l.label)}${l.text ? ': ' : ''}</tspan>` : ''

    return `<text class="l ${l.cls ?? ''}" x="${px + 12}" y="${ty}">${label}${esc(l.text)}</text>`
  })

  return `<g id="${id}" class="pop"><rect x="${px}" y="${py}" width="${POP_W}" height="${popH}" rx="10"/>${rows.join('')}</g>`
}

function field(label: string, value: string | undefined, maxLines: number): PopLine[] {
  if (!value) {
    return []
  }
  const wrapped = wrap(value, POP_CHARS - label.length - 2, POP_CHARS, maxLines)

  return wrapped.map((text, k) => (k === 0 ? { label, text } : { text }))
}

/** Greedy word wrap: the first line is shorter to leave room for its label. */
function wrap(text: string, first: number, rest: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const room = lines.length === 0 ? first : rest
    if ((line ? `${line} ${word}` : word).length > room && line) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) {
    lines.push(line)
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = clip(`${kept[maxLines - 1]} …`, rest)

    return kept
  }

  return lines.map(l => clip(l, rest))
}

type TimelineRow = { label: string; status: OrchestraStatus; startedAt: number; endedAt?: number }

/** One bar per drawn card, and one per fold spanning the agents folded into it. */
function timelineRows(graph: OrchestraGraph, tiles: PlacedTile[]): TimelineRow[] {
  const shown = new Set(tiles.map(t => t.node.id))
  const rows: TimelineRow[] = graph.nodes.filter(n => shown.has(n.id))
  const folded = graph.nodes.filter(n => !shown.has(n.id))
  if (folded.length) {
    rows.push({
      label: plural(folded.length, 'finished agent'),
      status: 'done',
      startedAt: Math.min(...folded.map(n => n.startedAt)),
      endedAt: Math.max(...folded.map(n => n.endedAt ?? n.startedAt)),
    })
  }

  return rows
}

function timeline(graph: OrchestraGraph, rows: TimelineRow[], top: number, width: number, now: number): string {
  const start = graph.startedAt ?? Math.min(now, ...graph.nodes.map(n => n.startedAt))
  const end = Math.max(start + 1000, now)
  const labels = rows.map(n => clip(n.label, 26))
  // The label column fits its longest label, so short labels leave no empty band before the bars.
  const labelW = Math.min(TL_LABEL, Math.max(80, Math.max(...labels.map(l => l.length)) * TL_CHAR + 16))
  const x0 = PAD + labelW
  const x1 = width - PAD
  const scale = (t: number) => x0 + ((Math.min(t, end) - start) / (end - start)) * (x1 - x0)
  const y0 = top + TL_GAP - PAD
  const rowsBottom = y0 + TL_ROW * (rows.length + 1)
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const gx = x0 + f * (x1 - x0)
    const anchor = f === 0 ? 'start' : f === 1 ? 'end' : 'middle'
    const label = f === 1 ? 'now' : age(start, start + f * (end - start))

    return [
      `<line class="grid" x1="${gx}" y1="${y0 + TL_ROW - 4}" x2="${gx}" y2="${rowsBottom - 4}"/>`,
      `<text class="tl" x="${gx}" y="${rowsBottom + 10}" text-anchor="${anchor}">${label}</text>`,
    ].join('')
  })
  const bars = rows.map((n, k) => {
    const y = y0 + TL_ROW * (k + 1)
    const from = scale(n.startedAt)
    const to = Math.max(from + TL_BAR_H, scale(n.endedAt ?? end))
    const isLiveBar = isLive(n.status)
    const took = age(n.startedAt, n.endedAt ?? end)
    // The duration sits just after its bar, or inside its end when the bar runs to the edge.
    const isInside = to + took.length * TL_CHAR + 10 > x1
    const durX = isInside ? to - 6 : to + 6
    const durAnchor = isInside ? 'end' : 'start'

    return [
      `<g${n.status === 'done' ? ' opacity=".6"' : ''}>`,
      `<text class="tl" x="${PAD}" y="${y + 9}">${esc(labels[k] ?? '')}</text>`,
      `<rect class="bar${isLiveBar ? ' live' : ''}" x="${from}" y="${y}" width="${to - from}" height="${TL_BAR_H}" rx="${TL_BAR_H / 2}" fill="${HEX[n.status]}"/>`,
      `<text class="tl${isInside ? ' in' : ''}" x="${durX}" y="${y + 9}" text-anchor="${durAnchor}">${took}</text>`,
      '</g>',
    ].join('')
  })

  return [`<text class="tl h" x="${PAD}" y="${y0 + 6}">Timeline</text>`, ...grid, ...bars].join('')
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}
