import type { Node } from "./types"

export function buildTree(
  nodes: Array<{ id: string; parent_id: string; content?: string | null }>,
): Node[] {
  // Create a map to store nodes by their IDs for quick lookup
  const nodeMap = new Map<string, Node>()

  // First pass: Create Node objects and store them in the map
  for (const { id, content } of nodes) {
    nodeMap.set(id, {
      id,
      content,
      children: [],
    })
  }

  // Second pass: Build the tree structure by connecting parents and children
  const rootNodes: Node[] = []

  for (const { id, parent_id } of nodes) {
    const node = nodeMap.get(id)
    if (!node) continue

    if (!parent_id) {
      // If this node has no parent_id, it's a root node
      rootNodes.push(node)
    } else {
      // Get the parent node and add this node as its child
      const parent = nodeMap.get(parent_id)
      if (parent?.children) {
        parent.children.push(node)
      }
    }
  }

  return rootNodes
}
