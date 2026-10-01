import { describe, expect, it } from '@jest/globals'
import {
  facingTowards,
  faceVector,
  isAir,
  isBadGround,
  isSignBlock,
  isSignItem,
  isWallSign,
  woodOfSign,
} from '../../../../src/skills/signs/sign-table.js'
import { joinSignText, sameSignText, signLines } from '../../../../src/skills/signs/sign-text.js'

describe('sign text', () => {
  const lines = (input: Parameters<typeof signLines>[0], allowEmpty?: boolean) => {
    const result = signLines(input, allowEmpty)
    return result.ok ? result.value : result.error
  }

  it('keeps short text on one line and pads to four lines', () => {
    expect(lines({ text: 'Iron' })).toEqual(['Iron', '', '', ''])
  })

  it('wraps on spaces into lines of at most 15 characters', () => {
    expect(lines({ text: 'Iron ingots and tools' })).toEqual(['Iron ingots and', 'tools', '', ''])
    expect(lines({ text: 'aaaaaaaaaaaaaaa bbb' })).toEqual(['aaaaaaaaaaaaaaa', 'bbb', '', ''])
  })

  it('keeps line breaks of its own, blank lines included', () => {
    expect(lines({ text: 'Farm\n\nnorth' })).toEqual(['Farm', '', 'north', ''])
  })

  it('takes explicit lines as they are', () => {
    expect(lines({ lines: ['Iron', '', 'chest'] })).toEqual(['Iron', '', 'chest', ''])
  })

  it('says how to split text that is too long', () => {
    const wrapped = lines({
      text: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo',
    })
    expect(wrapped).toMatchObject({ reason: 'text_too_long' })
    expect((wrapped as { message: string }).message).toContain('several signs')
    expect(lines({ lines: ['a', 'b', 'c', 'd', 'e'] })).toMatchObject({ reason: 'text_too_long' })
    expect(lines({ lines: ['sixteen chars!!!!'] })).toMatchObject({ reason: 'text_too_long' })
  })

  it('refuses a word that cannot fit on any line', () => {
    const problem = lines({ text: 'Supercalifragilistic' }) as { reason: string; message: string }
    expect(problem.reason).toBe('text_too_long')
    expect(problem.message).toContain('Supercalifragilistic')
  })

  it('refuses colour codes and control characters', () => {
    expect(lines({ text: '§cRed' })).toMatchObject({ reason: 'bad_text' })
    expect(lines({ lines: ['a\u0007b'] })).toMatchObject({ reason: 'bad_text' })
  })

  it('needs text, and refuses blank text unless clearing is allowed', () => {
    expect(lines({})).toMatchObject({ reason: 'no_text' })
    expect(lines({ text: '   ' })).toMatchObject({ reason: 'no_text' })
    expect(lines({ lines: ['', ''] }, true)).toEqual(['', '', '', ''])
  })

  it('compares text without its trailing blank lines', () => {
    expect(sameSignText(['Iron', '', '', ''], ['Iron'])).toBe(true)
    expect(sameSignText(['Iron', '', '', ''], ['Iron', 'x'])).toBe(false)
    expect(joinSignText(['Iron', 'chest', '', ''])).toBe('Iron chest')
  })
})

describe('sign table', () => {
  it('knows standing and wall signs and leaves hanging signs out', () => {
    expect(isSignBlock('oak_sign')).toBe(true)
    expect(isSignBlock('spruce_wall_sign')).toBe(true)
    expect(isSignBlock('oak_hanging_sign')).toBe(false)
    expect(isSignBlock('oak_wall_hanging_sign')).toBe(false)
    expect(isSignBlock('sign_post')).toBe(false)
    expect(isSignItem('birch_sign')).toBe(true)
    expect(isSignItem('oak_hanging_sign')).toBe(false)
    expect(isWallSign('oak_wall_sign')).toBe(true)
    expect(isWallSign('oak_sign')).toBe(false)
    expect(woodOfSign('dark_oak_wall_sign')).toBe('dark_oak')
    expect(woodOfSign('bamboo_sign')).toBe('bamboo')
  })

  it('turns faces into vectors and points from a cell towards a player', () => {
    expect(faceVector('top')).toEqual({ x: 0, y: 1, z: 0 })
    expect(faceVector('west')).toEqual({ x: -1, y: 0, z: 0 })
    expect(facingTowards({ x: 0, y: 64, z: 0 }, { x: 0.5, y: 64, z: 9.5 })).toBe('south')
    expect(facingTowards({ x: 0, y: 64, z: 0 }, { x: -7, y: 64, z: 1 })).toBe('west')
    expect(facingTowards({ x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 })).toBe('east')
    expect(facingTowards({ x: 0, y: 64, z: 0 }, { x: 0.5, y: 64, z: -5 })).toBe('north')
  })

  it('tells air, and ground the bot must not stand on', () => {
    expect(isAir('cave_air')).toBe(true)
    expect(isAir('stone')).toBe(false)
    expect(isAir(undefined)).toBe(false)
    expect(isBadGround('farmland')).toBe(true)
    expect(isBadGround('water')).toBe(true)
    expect(isBadGround(undefined)).toBe(true)
    expect(isBadGround('grass_block')).toBe(false)
  })
})
