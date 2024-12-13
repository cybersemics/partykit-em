import type { AbortSignal } from "@cloudflare/workers-types"
import type { Client } from "@libsql/client/ws"
import { Driver, type Transaction } from "./crdt"
import type { MoveOperation } from "./operation"
import { type Statement, sql } from "./sql"

export class TursoDriver extends Driver {
  constructor(private readonly client: Client) {
    super()
  }

  async execute<Row = any>({ sql }: Statement): Promise<Row[]> {
    return this.client.execute(sql).then(({ rows }) => rows as Row[])
  }

  async executeScript({ sql }: Statement): Promise<void> {
    return this.client.executeMultiple(sql)
  }

  async transaction<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.client.transaction("write")

    try {
      return await fn({
        commit: () => tx.commit(),
        rollback: () => tx.rollback(),
        execute: <Row>({ sql }: Statement): Promise<Row[]> =>
          tx.execute(sql).then((res) => res.rows as any),
        executeScript: ({ sql }: Statement) => tx.executeMultiple(sql),
      })
    } catch (e) {
      console.log(e)
      throw e
    } finally {
      tx.close()
    }
  }

  /**
   * Create the tables and root nodes if they don't exist.
   */
  async createTables() {
    await this.executeScript(sql`
      -- Create tables
        CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT NULL
      );
      CREATE TABLE IF NOT EXISTS payloads (
        node_id TEXT NOT NULL,
        content TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS op_log (
        timestamp TEXT PRIMARY KEY,
        node_id TEXT NULL,
        old_parent_id TEXT NULL,
        new_parent_id TEXT NULL,
        client_id TEXT,
        sync_timestamp TEXT -- The time the operation was synced to the server.
      );
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        last_seen TEXT NOT NULL
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_nodes_id ON nodes(id);
      CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_op_log_timestamp ON op_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_payloads_node_id ON payloads(node_id);
      CREATE INDEX IF NOT EXISTS idx_op_log_sync_timestamp ON op_log(sync_timestamp);
      CREATE INDEX IF NOT EXISTS idx_op_log_node_id ON op_log(node_id);

      -- Create the root and tombstone nodes
      INSERT OR IGNORE INTO nodes (id, parent_id) VALUES ('ROOT', NULL);
      INSERT OR IGNORE INTO nodes (id, parent_id) VALUES ('TOMBSTONE', NULL);
    `)
  }

  /**
   * Get the total number of operations and nodes.
   */
  async total(
    { from, until }: { from: string; until: string } = {
      from: "1970-01-01",
      until: new Date().toISOString(),
    },
  ) {
    const [
      [{ count: operations } = { count: 0 }],
      [{ count: nodes } = { count: 0 }],
    ] = await Promise.all([
      this.execute<{ count: number }>(sql`
        SELECT COUNT(1) AS count FROM op_log
        WHERE sync_timestamp >= '${from}'
          AND sync_timestamp <= '${until}';
      `),
      this.execute<{ count: number }>(sql`
      SELECT COUNT(1) AS count FROM nodes;
    `),
    ])

    return {
      operations,
      nodes,
    }
  }

  /**
   * Stream operations from the server.
   */
  async *streamOperations({
    from,
    until,
    chunkSize = 200,
    abort,
  }: {
    from: string
    until: string
    chunkSize?: number
    abort?: AbortSignal
  }) {
    let rowsProcessed = 0
    let shouldAbort = false

    const onAbort = () => {
      shouldAbort = true
    }

    abort?.addEventListener("abort", onAbort)

    while (true && !shouldAbort) {
      const operations = await this.execute<MoveOperation>(sql`
        SELECT * 
        FROM op_log 
        WHERE sync_timestamp >= '${from}'
          AND sync_timestamp <= '${until}'
        ORDER BY timestamp ASC 
        LIMIT ${chunkSize} 
        OFFSET ${rowsProcessed}
      `)

      if (!operations.length) break

      yield operations

      rowsProcessed += operations.length
    }

    abort?.removeEventListener("abort", onAbort)
  }
}
