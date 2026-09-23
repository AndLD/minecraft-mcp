import { describe, expect, it } from '@jest/globals'
import { SetSwitchPolicyTool } from '../../../../src/mcp/tools/set-switch-policy-tool.js'
import { SwitchPolicy } from '../../../../src/state/switch-policy.js'
import { StandingInstructions } from '../../../../src/state/standing-instructions.js'
import { InMemoryStateStore } from '../../../fakes/state-fakes.js'

describe('SetSwitchPolicyTool', () => {
  async function tool() {
    const store = new InMemoryStateStore()
    const policy = new SwitchPolicy()
    const standing = new StandingInstructions()
    await policy.attach(store)
    await standing.attach(store)
    return { policy, standing, tool: new SetSwitchPolicyTool(policy, standing) }
  }

  it('saves the policy and mirrors it as a standing instruction the briefing shows', async () => {
    const { policy, standing, tool: t } = await tool()

    const result = t.execute(t.inputSchema.parse({ policy: 'auto' }))

    expect(result).toEqual({ ok: true, data: { policy: 'auto' } })
    expect(policy.get()).toBe('auto')
    expect(standing.all().switch_policy).toContain('itself')
  })

  it('removes the standing instruction when going back to asking', async () => {
    const { policy, standing, tool: t } = await tool()
    t.execute(t.inputSchema.parse({ policy: 'never' }))
    expect(standing.all().switch_policy).toContain('never')

    t.execute(t.inputSchema.parse({ policy: 'ask' }))

    expect(policy.get()).toBe('ask')
    expect(standing.all()).not.toHaveProperty('switch_policy')
  })

  it('fails without an active world', () => {
    const t = new SetSwitchPolicyTool(new SwitchPolicy(), new StandingInstructions())

    expect(t.execute(t.inputSchema.parse({ policy: 'auto' })).ok).toBe(false)
    expect(t.inputSchema.safeParse({ policy: 'sometimes' }).success).toBe(false)
  })
})
