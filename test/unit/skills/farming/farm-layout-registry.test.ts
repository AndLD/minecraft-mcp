import { describe, expect, it } from '@jest/globals'
import { FarmLayoutRegistry } from '../../../../src/skills/farming/farm-layout-registry.js'
import { CropFieldProvider } from '../../../../src/skills/farming/providers/crop-field.js'

describe('FarmLayoutRegistry', () => {
  it('registers and looks providers up by kind', () => {
    const registry = new FarmLayoutRegistry().register(new CropFieldProvider())

    expect(registry.get('field')).toBeInstanceOf(CropFieldProvider)
    expect(registry.get('pen')).toBeUndefined()
    expect(registry.kinds()).toEqual(['field'])
  })

  it('lists every kind with a description and a JSON schema of its parameters', () => {
    const registry = new FarmLayoutRegistry().register(new CropFieldProvider())

    const list = registry.list()

    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'field' })
    expect(list[0]?.description).toContain('field')
    expect(list[0]?.params).toMatchObject({ type: 'object' })
  })
})
