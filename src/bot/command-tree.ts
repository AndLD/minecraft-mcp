interface CommandNode {
  readonly children?: readonly number[]
  readonly extraNodeData?: { readonly name?: string }
}

/**
 * The names of the commands the server offers, from its `declare_commands` packet (a tree of nodes; the children of
 * the root are the commands). Undefined when the packet does not have the expected shape.
 */
export function commandNamesFrom(packet: unknown): string[] | undefined {
  if (typeof packet !== 'object' || packet === null) return undefined
  const { nodes, rootIndex } = packet as { nodes?: unknown; rootIndex?: unknown }
  if (!Array.isArray(nodes) || typeof rootIndex !== 'number') return undefined
  const all = nodes as (CommandNode | undefined)[]
  const root = all[rootIndex]
  if (root?.children === undefined) return undefined
  const names: string[] = []
  for (const child of root.children) {
    const name = all[child]?.extraNodeData?.name
    if (typeof name === 'string') names.push(name)
  }
  return names
}
