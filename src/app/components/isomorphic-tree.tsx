import { useLocalTree } from "@/lib/use-local-tree"
import { useVirtualTree } from "@/lib/use-virtual-tree"
import { useConnection } from "./connection"
import { Tree, type TreeProps } from "./tree"

export const IsomorphicTree = (
  props: Omit<TreeProps, "tree" | "virtual" | "local">,
) => {
  const [localTree, { expandNode: expandLocalNode }] = useLocalTree()
  const [virtualTree, { expandNode: expandVirtualNode }] = useVirtualTree()
  const { hydrated } = useConnection()

  if (!hydrated) {
    return (
      <Tree
        {...props}
        virtual
        tree={virtualTree}
        onToggle={expandVirtualNode}
      />
    )
  }

  return <Tree {...props} tree={localTree} onToggle={expandLocalNode} />
}
