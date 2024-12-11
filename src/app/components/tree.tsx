import { Notifier } from "@/lib/notifier"
import type { Node } from "@/lib/types"
import { useTree } from "@/lib/use-tree"
import { cn } from "@/lib/utils"
import { insertMoves } from "@/worker/actions"
import { nanoid } from "nanoid/non-secure"
import { useCallback } from "react"
import {
  Tree as Arborist,
  type CreateHandler,
  type DeleteHandler,
  type MoveHandler,
  type RenameHandler,
} from "react-arborist"
import useResizeObserver from "use-resize-observer"
import type { MoveOperation } from "../../shared/operation"
import { useConnection } from "./connection"
import { TreeNode } from "./tree-node"

export interface TreeProps {
  className?: string
}

export const Tree = ({ className }: TreeProps) => {
  const { worker, clientId, timestamp, pushMoves } = useConnection()
  const { ref, width, height } = useResizeObserver()

  const tree = useTree()

  const onCreate = useCallback<CreateHandler<Node>>(
    async ({ parentId }) => {
      if (!parentId) {
        console.log("Attempted to create outside the tree.")
        return null
      }

      const move: MoveOperation = {
        type: "MOVE",
        node_id: nanoid(8),
        old_parent_id: null,
        new_parent_id: parentId,
        client_id: clientId,
        timestamp: timestamp(),
      }

      await worker.waitForResult(insertMoves([move]))
      Notifier.notify()

      pushMoves([move])

      return {
        id: move.node_id,
      }
    },
    [clientId, timestamp, worker, pushMoves]
  )

  const onRename = useCallback<RenameHandler<Node>>(({ id, name }) => {}, [])

  const onMove = useCallback<MoveHandler<Node>>(
    async ({ dragIds, parentId, index, parentNode, dragNodes }) => {
      console.log("onMove", dragIds, parentId, index)

      if (!parentId) {
        console.log("Attempted to move outside the tree.")
        return
      }

      const moves = dragNodes.map(
        (node): MoveOperation => ({
          type: "MOVE",
          node_id: node.id,
          old_parent_id: node.parent?.id ?? null,
          new_parent_id: parentId,
          client_id: clientId,
          timestamp: timestamp(),
        })
      )

      await worker.waitForResult(insertMoves(moves))
      Notifier.notify()

      pushMoves(moves)
    },
    [clientId, timestamp, worker, pushMoves]
  )

  const onDelete = useCallback<DeleteHandler<Node>>(
    async ({ nodes }) => {
      const moves = nodes.map(
        (node): MoveOperation => ({
          type: "MOVE",
          node_id: node.id,
          old_parent_id: node.parent?.id ?? null,
          new_parent_id: "TOMBSTONE",
          client_id: clientId,
          timestamp: timestamp(),
        })
      )

      await worker.waitForResult(insertMoves(moves))
      Notifier.notify()

      pushMoves(moves)
    },
    [clientId, timestamp, worker, pushMoves]
  )

  if (!tree)
    return (
      <div
        ref={ref}
        className={cn(
          "bg-card border border-border rounded-lg p-2 shadow-sm flex justify-center items-center",
          className
        )}
      >
        Loading...
      </div>
    )

  return (
    <div
      ref={ref}
      className={cn(
        "bg-card border border-border rounded-lg p-2 shadow-sm",
        className
      )}
    >
      <Arborist<Node>
        data={tree}
        width={width}
        height={height}
        onCreate={onCreate}
        onRename={onRename}
        onMove={onMove}
        onDelete={onDelete}
        openByDefault={false}
        initialOpenState={{ ROOT: true }}
      >
        {TreeNode}
      </Arborist>
    </div>
  )
}
