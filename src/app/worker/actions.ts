import { nanoid } from "nanoid"
import type { Node } from "../../shared/node"
import type { MoveOperation } from "../../shared/operation"

type ActionResults = {
  tree: Array<{ id: string; parent_id: string; content?: string | null }>
  subtree: Array<{ id: string; parent_id: string; content?: string | null }>
  opLog: Array<MoveOperation>
  pendingMoves: Array<MoveOperation>
  lastSyncTimestamp: string | null
  init: {
    lastSyncTimestamp: string | null
  }
}

export const clear = () => ({
  type: "clear" as const,
  id: nanoid(),
})

export const init = (room: string) => ({
  type: "init" as const,
  id: nanoid(),
  room,
})

export const close = () => ({
  type: "close" as const,
  id: nanoid(),
})

export const tree = () => ({
  type: "tree" as const,
  id: nanoid(),
})

export const subtree = (nodeId: string) => ({
  type: "subtree" as const,
  id: nanoid(),
  nodeId,
})

export const opLog = (options?: { limit?: number }) => ({
  type: "opLog" as const,
  id: nanoid(),
  options,
})

export const pendingMoves = (clientId: string) => ({
  type: "pendingMoves" as const,
  clientId,
  id: nanoid(),
})

export const insertMoves = (moves: Array<MoveOperation>) => ({
  type: "insertMoves" as const,
  id: nanoid(),
  moves,
})

export const insertVerbatim = (
  moves: Array<MoveOperation>,
  nodes: Array<Node>
) => ({
  type: "insertVerbatim" as const,
  id: nanoid(),
  moves,
  nodes,
})

export const lastSyncTimestamp = (clientId: string) => ({
  type: "lastSyncTimestamp" as const,
  clientId,
  id: nanoid(),
})

export const acknowledgeMoves = (
  moves: Array<MoveOperation>,
  syncTimestamp: string
) => ({
  type: "acknowledgeMoves" as const,
  id: nanoid(),
  moves,
  syncTimestamp,
})

export type Action =
  | ReturnType<typeof init>
  | ReturnType<typeof clear>
  | ReturnType<typeof close>
  | ReturnType<typeof tree>
  | ReturnType<typeof subtree>
  | ReturnType<typeof opLog>
  | ReturnType<typeof pendingMoves>
  | ReturnType<typeof insertMoves>
  | ReturnType<typeof insertVerbatim>
  | ReturnType<typeof lastSyncTimestamp>
  | ReturnType<typeof acknowledgeMoves>

export type ActionResult<A extends Action> =
  A["type"] extends keyof ActionResults ? ActionResults[A["type"]] : never
