import { useConnection } from "@/components/connection"
import { useCallback, useEffect, useMemo } from "react"
import { proxy, useSnapshot } from "valtio"
import type { MoveOperation } from "../../shared/operation"
import { subtree } from "../worker/actions"
import type { Node } from "./types"

type NodeWithChildRefs = Omit<Node, "children"> & {
  children?: Array<string>
  hasChildren?: boolean
  loading?: boolean
}

export const localTreeState = proxy<{ [id: string]: NodeWithChildRefs }>({
  ROOT: {
    id: "ROOT",
    loading: false,
  },
})

export const useLocalTree = () => {
  const { worker } = useConnection()

  const snapshot = useSnapshot(localTreeState)

  const expandNode = useCallback(
    async (id: string) => {
      // Already expanded
      if (
        localTreeState[id]?.children?.every(
          (child) => localTreeState[child]?.children
        )
      ) {
        console.log(`Node ${id} already expanded, skipping`)
        return
      }

      // Ensure the node exists in state
      if (!localTreeState[id]) {
        localTreeState[id] = { id }
      }

      localTreeState[id].loading = true

      try {
        const nodes = await worker.waitForResult(subtree(id))

        localTreeState[id].loading = false

        if (!localTreeState[id].children) localTreeState[id].children = []

        // Create the nodes in the state
        for (const node of nodes) {
          if (!localTreeState[node.id]) {
            localTreeState[node.id] = {
              id: node.id,
              content: node.content,
            }
          }

          if (node.parent_id === id && !localTreeState[node.id].children) {
            localTreeState[node.id].children = []
          }
        }

        // Create relationships
        for (const node of nodes) {
          const parent = localTreeState[node.parent_id]

          if (!parent.children) parent.children = []

          if (!parent.children.includes(node.id)) {
            parent.children.push(node.id)
          }
        }
      } catch (error) {
        localTreeState[id].loading = false
        console.error("Failed to expand node:", error)
      }
    },
    [worker]
  )

  const extra = useMemo(
    () => ({
      expandNode,
    }),
    [expandNode]
  )

  const tree = useMemo(() => {
    // Traverse down the tree and resolve the children
    const getNodeWithChildren = (id: string): Node => {
      const node = snapshot[id]

      return {
        ...node,
        children: node.children?.map((child) => getNodeWithChildren(child)),
      }
    }

    return [getNodeWithChildren("ROOT")]
  }, [snapshot])

  // useEffect(() => {
  //   if (
  //     worker.initialized &&
  //     !localTreeState.ROOT.children &&
  //     !localTreeState.ROOT.loading
  //   ) {
  //     expandNode("ROOT")
  //   }
  // }, [worker.initialized, expandNode])

  return [tree, extra] as const
}

/**
 * Insert a move operation into the local tree state.
 * Necessary for reflecting moves that are being generated or received while
 * the local tree is being used.
 */
export const insertIntoLocalTree = (move: MoveOperation) => {
  // Make sure node exists
  if (!localTreeState[move.node_id]) {
    localTreeState[move.node_id] = {
      id: move.node_id,
    }
  }

  // Make sure parent exists
  if (!localTreeState[move.new_parent_id]) {
    localTreeState[move.new_parent_id] = {
      id: move.new_parent_id,
      children: [],
    }
  }

  const node = localTreeState[move.node_id]
  const oldParent = move.old_parent_id
    ? localTreeState[move.old_parent_id]
    : null
  const parent = localTreeState[move.new_parent_id]

  if (oldParent?.children) {
    oldParent.children = oldParent.children?.filter(
      (child) => child !== node.id
    )
  }

  if (parent.children && !parent.children.includes(node.id)) {
    parent.children.push(node.id)
  }
}
