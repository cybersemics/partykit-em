import { useConnection } from "@/components/connection"
import type { Node } from "@/lib/types"
import { tree } from "@/worker/actions"
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react"
import { Notifier } from "./notifier"

export const useTree = () => {
  const { worker } = useConnection()

  const treeCache = useRef<Node[]>()

  const getSnapshot = useCallback(() => {
    return treeCache.current
  }, [])

  const subscribe = useCallback(
    (callback: () => void) => {
      // Wrap the notifier's callback to handle the async update
      return Notifier.subscribe(async () => {
        const newTree = await worker.waitForResult(tree())
        treeCache.current = buildTree(newTree)
        callback()
      })
    },
    [worker]
  )

  useLayoutEffect(() => {
    if (treeCache.current || !worker.initialized) return

    worker.waitForResult(tree()).then((tree) => {
      treeCache.current = buildTree(tree)
      Notifier.notify()
    })
  }, [worker])

  return useSyncExternalStore(subscribe, getSnapshot)
}

function buildTree(
  nodes: Array<{ id: string; parent_id: string; content?: string | null }>
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
