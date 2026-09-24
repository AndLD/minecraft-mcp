export interface Col {
  readonly x: number
  readonly z: number
}

export interface SearchOptions {
  readonly start: Col
  readonly end: Col
  /** The cost of stepping from one column to a neighbour (with the direction 0 to 3 already taken, or -1 at the start), or undefined when it may not be entered. */
  readonly step: (from: Col, to: Col, turned: boolean) => number | undefined
  readonly bounds: {
    readonly minX: number
    readonly maxX: number
    readonly minZ: number
    readonly maxZ: number
  }
  /** Give up after this many columns have been expanded. */
  readonly maxExpansions: number
}

const DIRS: readonly Col[] = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
]

interface Node {
  readonly x: number
  readonly z: number
  readonly dir: number
  readonly g: number
  readonly f: number
  readonly parent: Node | undefined
}

/** A binary min-heap on `f`. */
class Heap {
  private readonly items: Node[] = []

  get size(): number {
    return this.items.length
  }

  push(node: Node): void {
    this.items.push(node)
    let i = this.items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      const above = this.items[parent]
      const here = this.items[i]
      if (above === undefined || here === undefined || above.f <= here.f) break
      this.items[parent] = here
      this.items[i] = above
      i = parent
    }
  }

  pop(): Node | undefined {
    const top = this.items[0]
    const last = this.items.pop()
    if (top === undefined || last === undefined) return top
    if (this.items.length === 0) return top
    this.items[0] = last
    let i = 0
    for (;;) {
      const left = 2 * i + 1
      const right = left + 1
      let smallest = i
      if ((this.items[left]?.f ?? Infinity) < (this.items[smallest]?.f ?? Infinity)) smallest = left
      if ((this.items[right]?.f ?? Infinity) < (this.items[smallest]?.f ?? Infinity))
        smallest = right
      if (smallest === i) break
      const a = this.items[i]
      const b = this.items[smallest]
      if (a === undefined || b === undefined) break
      this.items[i] = b
      this.items[smallest] = a
      i = smallest
    }
    return top
  }
}

/**
 * The cheapest chain of neighbouring columns from start to end (A* over column and heading, so turns can cost
 * something), or undefined when there is none within the limits.
 */
export function searchPath(options: SearchOptions): Col[] | undefined {
  const { start, end, bounds } = options
  const heuristic = (x: number, z: number): number => Math.abs(x - end.x) + Math.abs(z - end.z)
  const best = new Map<string, number>()
  const heap = new Heap()
  const key = (x: number, z: number, dir: number): string =>
    `${String(x)},${String(z)},${String(dir)}`
  heap.push({
    x: start.x,
    z: start.z,
    dir: -1,
    g: 0,
    f: heuristic(start.x, start.z),
    parent: undefined,
  })
  best.set(key(start.x, start.z, -1), 0)
  let expanded = 0
  for (;;) {
    const node = heap.pop()
    if (node === undefined) return undefined
    if (node.g > (best.get(key(node.x, node.z, node.dir)) ?? Infinity)) continue
    if (node.x === end.x && node.z === end.z) {
      const path: Col[] = []
      for (let at: Node | undefined = node; at !== undefined; at = at.parent)
        path.push({ x: at.x, z: at.z })
      return path.reverse()
    }
    expanded += 1
    if (expanded > options.maxExpansions) return undefined
    for (const [dir, delta] of DIRS.entries()) {
      const x = node.x + delta.x
      const z = node.z + delta.z
      if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue
      const cost = options.step(
        { x: node.x, z: node.z },
        { x, z },
        node.dir !== -1 && node.dir !== dir,
      )
      if (cost === undefined) continue
      const g = node.g + cost
      const k = key(x, z, dir)
      if (g >= (best.get(k) ?? Infinity)) continue
      best.set(k, g)
      heap.push({ x, z, dir, g, f: g + heuristic(x, z), parent: node })
    }
  }
}
