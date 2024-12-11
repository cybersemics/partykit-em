import { nanoid } from "nanoid"
import type { MoveOperation } from "../../shared/operation"

type ActionResults = {
  tree: Array<{ id: string; parent_id: string; content?: string | null }>
  opLog: Array<MoveOperation>
}

export const init = (room: string) => ({
  type: "init" as const,
  id: nanoid(),
  room,
})

export const tree = () => ({
  type: "tree" as const,
  id: nanoid(),
})

export const opLog = (options?: { limit?: number }) => ({
  type: "opLog" as const,
  id: nanoid(),
  options,
})

export const insertMoves = (moves: Array<MoveOperation>) => ({
  type: "insertMoves" as const,
  id: nanoid(),
  moves,
})

export const acknowledgeMoves = (
  moves: Array<MoveOperation>,
  syncTimestamp: string,
) => ({
  type: "acknowledgeMoves" as const,
  id: nanoid(),
  moves,
  syncTimestamp,
})

export type Action =
  | ReturnType<typeof init>
  | ReturnType<typeof tree>
  | ReturnType<typeof opLog>
  | ReturnType<typeof insertMoves>
  | ReturnType<typeof acknowledgeMoves>

export type ActionResult<A extends Action> =
  A["type"] extends keyof ActionResults ? ActionResults[A["type"]] : never
