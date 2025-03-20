import { nanoid } from "nanoid/non-secure"
import type { Operation } from "./operation"
import type { RoomStatus } from "./room-status"

export type Message =
  | ReturnType<typeof status>
  | ReturnType<typeof connections>
  | ReturnType<typeof ping>
  | ReturnType<typeof syncStream>
  | ReturnType<typeof push>
  | ReturnType<typeof subtree>

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
 * Request a subtree from the server.
 */
export const subtree = (id: string, depth = 1) => ({
  type: "subtree" as const,
  id,
  depth,
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
 * A batch of operations from the client or server.
 */
export const push = (operations: Operation[]) => ({
  type: "push" as const,
  operations,
})
