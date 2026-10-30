import { expect, test } from 'claude-code/testing'

const T0 = new Date(2026, 9, 30, 15, 28, 26).getTime()

test('lists skills, MCP and subagents as the spec shows', async ($, on) => {
  let now = T0
  const at = (s: number) => {
    now = T0 + s * 1000
  }
  on('clock.now', () => ({ value: now }))
  on('session.id', () => ({ value: 's1' }))
  on('command.register', () => ({ value: { command: 'tool-history' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('tool.call', async (_, e) => {
    const tool = String(e.tool)
    if (tool === 'Skill') {
      const skill = String((e as { skill?: unknown }).skill)
      await $.skill.prompt({ skill, text: '', source: 'plugin', pluginName: 'superpowers' })
    }
    if (tool === 'mcp__plugin_context7_context7__query-docs') now += 1600
    if (tool === 'mcp__plugin_context7_context7__resolve-library-id') now += 1500
    if (tool === 'Agent') {
      // The subagent's own calls, raised while its Agent call runs.
      await ($.agent.spawn as (input: unknown) => Promise<unknown>)({
        prompt: 'look',
        description: 'look',
        subagentType: 'Explore',
        tool_use_id: e.tool_use_id,
      })
      at(20)
      await $.tool.call({ tool: 'Skill', skill: 'superpowers:using-superpowers', agentId: 'a1' } as never)
      at(22)
      await $.tool.call({ tool: 'mcp__plugin_context7_context7__resolve-library-id', agentId: 'a1' } as never)
      at(24.7)
    }
    if (tool === 'mcp__github__get_issue') return { isError: true, result: {}, text: 'boom' } as never
    return { result: { status: 'completed' } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'tool-history', args: '' } as never)).text).toBe(
    'No skills, MCP tools or subagents used in this session yet.',
  )

  at(0)
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:verification-before-completion' } as never)
  at(8)
  await $.tool.call({ tool: 'mcp__plugin_context7_context7__query-docs' } as never)
  at(10)
  await $.tool.call({ tool: 'mcp__plugin_context7_context7__query-docs' } as never)
  at(17)
  await $.tool.call({ tool: 'Agent', prompt: 'look', description: 'look', subagent_type: 'Explore' } as never)
  at(30)
  await $.tool.call({ tool: 'mcp__github__get_issue' } as never)

  const out = await $.command.run({ command: 'tool-history', args: '' } as never)
  expect(out.text).toBe(
    [
      'Skills, MCP tools and subagents used in this session:',
      '15:28:26  skill     verification-before-completion  superpowers',
      '15:28:34  MCP       query-docs ×2                   context7     3.2s',
      '15:28:43  subagent  Explore                         built-in     7.7s',
      '          ├─ 15:28:46  skill  using-superpowers   superpowers',
      '          └─ 15:28:48  MCP    resolve-library-id  context7     1.5s',
      '15:28:56  MCP       get_issue                       github       ✗ 0.0s',
    ].join('\n'),
  )
})
