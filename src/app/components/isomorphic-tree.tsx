import { useTree } from "@/lib/use-tree"
import { useVirtualTree } from "@/lib/use-virtual-tree"
import { useConnection } from "./connection"
import { Tree, type TreeProps } from "./tree"

export const IsomorphicTree = (props: Omit<TreeProps, "tree" | "virtual">) => {
  const localTree = useTree()
  const [virtualTree, { expandNode }] = useVirtualTree()
  const { hydrated } = useConnection()

  if (hydrated) return <Tree {...props} tree={localTree} />

  return <Tree {...props} virtual tree={virtualTree} onToggle={expandNode} />
}
