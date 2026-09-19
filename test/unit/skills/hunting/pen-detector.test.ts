import { describe, expect, it } from '@jest/globals'
import { PenDetector } from '../../../../src/skills/hunting/pen-detector.js'
import { FakeBlockScanner } from '../../../fakes/fake-ports.js'

const at = { x: 10.5, y: 64, z: 10.5 }

function withBarriers(cells: Record<string, string>): PenDetector {
  const scanner = new FakeBlockScanner()
  for (const [key, name] of Object.entries(cells)) scanner.blockNames.set(key, name)
  return new PenDetector(scanner)
}

describe('PenDetector', () => {
  it('sees a pen when fences stand on three sides', () => {
    const pen = withBarriers({
      '13,64,10': 'oak_fence',
      '7,64,10': 'oak_fence',
      '10,64,12': 'oak_fence_gate',
    })

    expect(pen.isPenned(at)).toBe(true)
  })

  it('sees walls and iron bars as barriers too, and looks up to three blocks out', () => {
    const pen = withBarriers({
      '13,64,10': 'cobblestone_wall',
      '10,64,7': 'iron_bars',
      '9,64,10': 'birch_fence',
    })

    expect(pen.isPenned(at)).toBe(true)
  })

  it('does not call it a pen with fences on only two sides, or far away', () => {
    expect(withBarriers({ '13,64,10': 'oak_fence', '7,64,10': 'oak_fence' }).isPenned(at)).toBe(
      false,
    )
    expect(
      withBarriers({
        '14,64,10': 'oak_fence',
        '6,64,10': 'oak_fence',
        '10,64,14': 'oak_fence',
      }).isPenned(at),
    ).toBe(false)
  })

  it('ignores ordinary terrain', () => {
    const terrain = withBarriers({
      '11,64,10': 'stone',
      '9,64,10': 'oak_log',
      '10,64,11': 'fence_post',
    })

    expect(terrain.isPenned(at)).toBe(false)
    expect(new PenDetector(new FakeBlockScanner()).isPenned(at)).toBe(false)
  })
})
