import { useConnection } from "@/components/connection"
import { useCallback, useEffect, useMemo } from "react"
import { proxy, useSnapshot } from "valtio"
import type { MoveOperation } from "../../shared/operation"
import type { Node } from "./types"

type NodeWithChildRefs = Omit<Node, "children"> & {
  children?: Array<string>
  loading?: boolean
}

export const state = proxy<{ [id: string]: NodeWithChildRefs }>({
  ROOT: {
    id: "ROOT",
    loading: true,
  },
})

export const useVirtualTree = () => {
  const { fetchSubtree } = useConnection()

  const snapshot = useSnapshot(state)

  const expandNode = useCallback(
    async (id: string) => {
      // Already expanded
      if (state[id]?.children) return

      state[id].loading = true
      const nodes = await fetchSubtree(id).catch(async (e) => {
        // Retry once, in case the room is not ready yet
        return fetchSubtree(id)
      })
      state[id].loading = false

      if (!state[id].children) state[id].children = []

      // Create the nodes in the state
      for (const node of nodes) {
        state[node.id] = {
          ...node,
        }
      }

      for (const node of nodes) {
        const parent = state[node.parent_id]

        if (parent) {
          parent.children?.push(node.id)
        }
      }
    },
    [fetchSubtree],
  )

  const extra = useMemo(
    () => ({
      expandNode,
    }),
    [expandNode],
  )

  const tree = useMemo(() => {
    // Traverse down the tree and resolve the children
    const getNodeWithChildren = (id: string): Node => {
      const node = snapshot[id]

      if (node.children)
        return {
          ...node,
          children: node.children.map((child) => getNodeWithChildren(child)),
        }

      return {
        ...node,
        children: undefined,
      }
    }

    return [getNodeWithChildren("ROOT")]
  }, [snapshot])

  useEffect(() => {
    expandNode("ROOT")
  }, [expandNode])

  return [tree, extra] as const
}

/**
 * Insert a move operation into the virtual tree.
 * Necessary for reflecting moves that are being generated or received while
 * the virtual tree is being used.
 */
export const insertIntoVirtualTree = (move: MoveOperation) => {
  // Make sure node exists
  if (!state[move.node_id]) {
    state[move.node_id] = {
      id: move.node_id,
    }
  }

  // Make sure parent exists
  if (!state[move.new_parent_id]) {
    state[move.new_parent_id] = {
      id: move.new_parent_id,
      children: [],
    }
  }

  const node = state[move.node_id]
  const oldParent = move.old_parent_id ? state[move.old_parent_id] : null
  const parent = state[move.new_parent_id]

  if (oldParent?.children) {
    oldParent.children = oldParent.children?.filter(
      (child) => child !== node.id,
    )
  }

  if (parent.children) parent.children.push(node.id)
}
