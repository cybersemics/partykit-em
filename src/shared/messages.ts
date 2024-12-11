import { nanoid } from "nanoid/non-secure"
import type { Operation } from "./operation"
import type { RoomStatus } from "./room-status"

export type Message =
  | ReturnType<typeof status>
  | ReturnType<typeof connections>
  | ReturnType<typeof ping>
  | ReturnType<typeof syncStream>
  | ReturnType<typeof syncPage>
  | ReturnType<typeof syncBatch>
  | ReturnType<typeof push>

/**
 * The status of the room.
 */
export const status = (status: RoomStatus) => ({
  type: "status" as const,
  status,
})

/**
 * The connections in the room.
 */
export const connections = (clients: string[]) => ({
  type: "connections" as const,
  clients,
})

/**
 * A ping to the server, used to ask for the server's status and connections.
 */
export const ping = () => ({
  type: "ping" as const,
})

/**
 * Request a stream of operations from the server.
 */
export const syncStream = (lastSyncTimestamp: Date) => ({
  type: "sync:stream" as const,
  id: nanoid(),
  lastSyncTimestamp: lastSyncTimestamp.toISOString(),
})

/**
 * Request a page of operations from the server.
 */
export const syncPage = (lastSyncTimestamp: Date, page: number) => ({
  type: "sync:page" as const,
  id: nanoid(),
  lastSyncTimestamp: lastSyncTimestamp.toISOString(),
  page,
})

/**
 * A batch of operations from the server.
 */
export const syncBatch = (
  id: string,
  operations: Operation[],
  page: {
    current: number
    total: number
    cutoff: string
  },
) => ({
  type: "sync:batch" as const,
  id,
  operations,
  page,
})

/**
 * A batch of operations from the client or server.
 */
export const push = (operations: Operation[]) => ({
  type: "push" as const,
  operations,
})
