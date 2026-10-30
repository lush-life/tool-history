import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ToolHistory, ToolHistoryEntry, ToolHistoryKind } from '../types'

const COMMAND = 'tool-history'
const LIMIT = 500
const TITLE = 'Skills, MCP tools and subagents used in this session:'
const EMPTY = 'No skills, MCP tools or subagents used in this session yet.'

const history = atom(
  { plugin: 'tool-history', key: 'history' } as const,
  { sessionId: '', entries: [] },
  { shape: 'history-1' },
)

const LABELS: Record<ToolHistoryKind, string> = {
  skill: 'skill',
  mcp: 'MCP',
  subagent: 'subagent',
}
const COLORS: Record<string, string> = {
  skill: '#b48ead',
  MCP: '#5fafa0',
  subagent: '#d8a05a',
}
const SOURCE_COLOR = '#7a7a7a'

// Where each agent type came from, as agent.offer last told it.
const agentSources = new Map<string, string>()

function sourceLabel(source: string, pluginName?: string): string {
  switch (source) {
    case 'plugin':
      return pluginName ?? 'plugin'
    case 'userSettings':
    case 'user_settings':
    case 'user':
      return 'user'
    case 'projectSettings':
    case 'project_settings':
    case 'localSettings':
    case 'local_settings':
    case 'project':
      return 'project'
    case 'policySettings':
    case 'policy_settings':
      return 'policy'
    case 'builtin':
    case 'built-in':
      return 'built-in'
    default:
      return source
  }
}

// `superpowers:brainstorming` is the plugin's skill `brainstorming`.
function splitPlugin(name: string): { plugin?: string; name: string } {
  const at = name.indexOf(':')
  return at > 0 ? { plugin: name.slice(0, at), name: name.slice(at + 1) } : { name }
}

// `mcp__<server>__<tool>`; a plugin's server is `plugin_<plugin>_<server>`.
function splitMcp(tool: string): { server: string; name: string } {
  const rest = tool.slice('mcp__'.length)
  const at = rest.indexOf('__')
  const server = at < 0 ? rest : rest.slice(0, at)
  const name = at < 0 ? rest : rest.slice(at + 2)
  if (!server.startsWith('plugin_')) return { server, name }
  const owner = server.slice('plugin_'.length)
  const half = (owner.length - 1) / 2
  if (Number.isInteger(half) && owner.slice(0, half) === owner.slice(half + 1)) {
    return { server: owner.slice(0, half), name }
  }
  return { server: owner.split('_')[0] || owner, name }
}

async function change(
  $: EngineInterface,
  fn: (entries: ToolHistoryEntry[]) => ToolHistoryEntry[],
): Promise<void> {
  const sessionId = await $.session.id()
  await update($, history, value => {
    const entries = value.sessionId === sessionId ? value.entries : []
    return { sessionId, entries: fn(entries).slice(-LIMIT) }
  })
}

function patch(
  id: string,
  fields: Partial<ToolHistoryEntry>,
): (entries: ToolHistoryEntry[]) => ToolHistoryEntry[] {
  return entries => entries.map(one => (one.id === id ? { ...one, ...fields } : one))
}

function clock(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':')
}

function seconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

type Row = {
  time: string
  label: string
  name: string
  source: string
  duration: string
  children: Row[]
}

function toRows(entries: ToolHistoryEntry[], parentId: string | undefined, known: Set<string>): Row[] {
  const rows: Row[] = []
  let last: { entry: ToolHistoryEntry; row: Row; count: number; total: number } | undefined
  for (const entry of entries) {
    // A call whose subagent is gone (dropped, or spawned before the mod
    // loaded) is listed at the top.
    const parent = entry.parentId !== undefined && known.has(entry.parentId) ? entry.parentId : undefined
    if (parent !== parentId) continue
    const isDone = entry.endedAt !== undefined
    const took = isDone ? entry.endedAt! - entry.startedAt : 0
    const canMerge =
      last !== undefined &&
      entry.kind !== 'subagent' &&
      isDone &&
      !entry.isFailed &&
      last.entry.kind === entry.kind &&
      last.entry.name === entry.name &&
      last.entry.source === entry.source
    if (canMerge && last) {
      last.count += 1
      last.total += took
      last.row.name = `${entry.name} ×${last.count}`
      last.row.duration = entry.kind === 'skill' ? '' : seconds(last.total)
      continue
    }
    const duration = !isDone
      ? 'running'
      : entry.isFailed
        ? entry.kind === 'skill'
          ? '✗'
          : `✗ ${seconds(took)}`
        : entry.kind === 'skill'
          ? ''
          : seconds(took)
    const row: Row = {
      time: clock(entry.startedAt),
      label: LABELS[entry.kind],
      name: entry.name,
      source: entry.source,
      duration,
      children: entry.kind === 'subagent' ? toRows(entries, entry.id, known) : [],
    }
    rows.push(row)
    last = isDone && !entry.isFailed && entry.kind !== 'subagent' ? { entry, row, count: 1, total: took } : undefined
  }
  return rows
}

function toLines(rows: Row[], lead: string): string[] {
  const width = (pick: (row: Row) => string) => Math.max(...rows.map(row => pick(row).length))
  const labelWidth = width(row => row.label)
  const nameWidth = width(row => row.name)
  const sourceWidth = width(row => row.source)
  const lines: string[] = []
  rows.forEach((row, i) => {
    const isLast = i === rows.length - 1
    const branch = lead === '' ? '' : isLast ? '└─ ' : '├─ '
    const line = [
      lead + branch + row.time,
      row.label.padEnd(labelWidth),
      row.name.padEnd(nameWidth),
      row.source.padEnd(sourceWidth),
      row.duration,
    ].join('  ')
    lines.push(line.trimEnd())
    if (row.children.length > 0) {
      // Children sit under the parent's category column.
      const pad = ' '.repeat(row.time.length + 2)
      const carry = lead === '' ? '' : lead + (isLast ? '   ' : '│  ')
      lines.push(...toLines(row.children, carry + pad))
    }
  })
  return lines
}

function report(entries: ToolHistoryEntry[]): string {
  if (entries.length === 0) return EMPTY
  const known = new Set(entries.filter(one => one.kind === 'subagent').map(one => one.id))
  return [TITLE, ...toLines(toRows(entries, undefined, known), '')].join('\n')
}

const LINE = /^([\s│├└─]*)(\d{2}:\d{2}:\d{2})(\s+)(skill|MCP|subagent)(\s+)(.*)$/

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'List the skills, MCP tools and subagents used in this session',
      immediate: true,
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await update($, history, () => ({ sessionId: '', entries: [] }))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const sessionId = await $.session.id()
    const value = await read($, history)
    return { text: report(value.sessionId === sessionId ? value.entries : []) }
  })

  on('agent.offer', ($, e, next) => {
    agentSources.set(e.agent, sourceLabel(e.source, e.provider.plugin === 'engine' ? undefined : e.provider.plugin))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if ('agentId' in spawned && spawned.agentId !== undefined) {
      const typed = splitPlugin(e.subagentType)
      const provider = e.provider?.plugin ?? 'engine'
      const source =
        provider !== 'engine'
          ? provider
          : (typed.plugin ?? agentSources.get(e.subagentType) ?? 'built-in')
      await change(
        $,
        patch(e.tool_use_id, {
          agentId: spawned.agentId,
          name: typed.name,
          source,
          isBackground: e.background,
        }),
      )
    }
    return spawned
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    const source = sourceLabel(e.source, e.pluginName)
    const bare = splitPlugin(e.skill).name
    await change($, entries => {
      const at = entries.findLastIndex(
        one => one.kind === 'skill' && one.isSourcePending === true && one.name === bare,
      )
      if (at < 0) return entries
      return entries.map((one, i) => (i === at ? { ...one, source, isSourcePending: false } : one))
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const endedAt = await $.clock.now()
      await change($, entries =>
        entries.map(one =>
          one.kind === 'subagent' && one.agentId === agentId && one.endedAt === undefined
            ? { ...one, endedAt, isFailed: e.isAborted || 'refusal' in e }
            : one,
        ),
      )
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    let entry: ToolHistoryEntry
    const base = { id: e.tool_use_id, startedAt: await $.clock.now(), isFailed: false }
    if (e.tool === 'Skill') {
      const named = splitPlugin(e.skill)
      entry = {
        ...base,
        kind: 'skill',
        name: named.name,
        source: named.plugin ?? 'built-in',
        isSourcePending: true,
      }
    } else if (tool === 'Agent' || tool === 'Task') {
      const type = String((e as { subagent_type?: unknown }).subagent_type ?? 'general-purpose')
      const named = splitPlugin(type)
      entry = { ...base, kind: 'subagent', name: named.name, source: named.plugin ?? 'built-in' }
    } else if (tool.startsWith('mcp__')) {
      const mcp = splitMcp(tool)
      entry = { ...base, kind: 'mcp', name: mcp.name, source: mcp.server }
    } else {
      return next(e)
    }

    const agentId = e.agentId
    await change($, entries => {
      const parent = agentId === undefined ? undefined : entries.findLast(one => one.agentId === agentId)
      return [...entries, { ...entry, parentId: parent?.id }]
    })

    let isFailed = true
    let isLaunched = false
    try {
      const ran = await next(e)
      isFailed = ran.deny !== undefined || ran.isError === true
      const result = ran.result as { status?: unknown } | undefined
      isLaunched = !isFailed && entry.kind === 'subagent' && result?.status === 'async_launched'
      return ran
    } finally {
      const endedAt = await $.clock.now()
      // A background subagent runs on: turn.complete ends it.
      await change($, patch(entry.id, isLaunched ? {} : { endedAt, isFailed }))
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = e.props.text.split('\n')
    if (lines.length < 2) return next(e)
    return (
      <Box flexDirection="column">
        {lines.map(line => {
          const m = LINE.exec(line)
          if (!m) return <Text>{line}</Text>
          const [, tree = '', time = '', gap1 = '', label = '', gap2 = '', rest = ''] = m
          const [name = '', gap3 = '', source = '', gap4 = '', duration = ''] = rest.split(/(\s{2,})/)
          const failed = duration.startsWith('✗')
          return (
            <Text>
              <Text dimColor>{tree}</Text>
              {time}
              {gap1}
              <Text color={COLORS[label]}>{label}</Text>
              {gap2}
              {name}
              {gap3}
              <Text color={SOURCE_COLOR}>{source}</Text>
              {gap4}
              {failed ? <Text color="red">✗</Text> : null}
              {failed ? duration.slice(1) : duration}
            </Text>
          )
        })}
      </Box>
    )
  })
}
