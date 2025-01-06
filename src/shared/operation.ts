export type Operation = MoveOperation | UpdateOperation

export type MoveOperation = {
  type: "MOVE"

  /**
   * HLC timestamp.
   */
  timestamp: string

  /**
   * The node to be moved.
   */
  node_id: string

  /**
   * The old parent of the node.
   */
  old_parent_id: string | null

  /**
   * The new parent of the node.
   */
  new_parent_id: string

  /**
   * The client that created the operation.
   */
  client_id: string

  /**
   * The time the operation was synced to the server.
   */
  sync_timestamp?: string | null

  /**
   * The knowledge cutoff of the client at the time of the operation.
   */
  last_sync_timestamp?: string | null
}

export type UpdateOperation = {
  type: "UPDATE"

  /**
   * HLC timestamp.
   */
  timestamp: string

  /**
   * The node to be updated.
   */
  node_id: string

  /**
   * The new content of the node.
   */
  content: string
}
