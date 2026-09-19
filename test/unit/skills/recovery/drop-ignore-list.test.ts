import { describe, expect, it } from '@jest/globals'
import { DropIgnoreList } from '../../../../src/skills/recovery/drop-ignore-list.js'
import { FakeClock } from '../../../fakes/fake-clock.js'

const item = (name: string, x: number) => ({
  entityId: 1,
  name,
  count: 1,
  position: { x, y: 64, z: 0 },
  distance: 1,
})

describe('DropIgnoreList', () => {
  it('ignores items of a kind thrown away nearby', () => {
    const list = new DropIgnoreList(new FakeClock(0))
    list.add([{ name: 'rotten_flesh', count: 8 }], { x: 0, y: 64, z: 0 })

    expect(list.isIgnored(item('rotten_flesh', 3))).toBe(true)
  })

  it('does not ignore other kinds, or the same kind far away', () => {
    const list = new DropIgnoreList(new FakeClock(0))
    list.add([{ name: 'rotten_flesh', count: 8 }], { x: 0, y: 64, z: 0 })

    expect(list.isIgnored(item('iron_ingot', 1))).toBe(false)
    expect(list.isIgnored(item('rotten_flesh', 40))).toBe(false)
  })

  it('forgets a drop once the items would have despawned', () => {
    const clock = new FakeClock(0)
    const list = new DropIgnoreList(clock)
    list.add([{ name: 'rotten_flesh', count: 8 }], { x: 0, y: 64, z: 0 })

    clock.advance(300_000)

    expect(list.isIgnored(item('rotten_flesh', 1))).toBe(false)
  })
})
