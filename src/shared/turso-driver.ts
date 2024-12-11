import type { Client } from "@libsql/client/ws"
import { Driver, type Transaction } from "./crdt"
import { type Statement, sql } from "./sql"

export class TursoDriver extends Driver {
  constructor(private readonly client: Client) {
    super()
  }

  async execute({ sql }: Statement): Promise<any> {
    return this.client.execute(sql)
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

  async createTables() {
    await this.executeScript(sql`
      -- Create tables
        CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        FOREIGN KEY (parent_id) REFERENCES nodes(id)
      );
      CREATE TABLE IF NOT EXISTS payloads (
        node_id TEXT NOT NULL,
        content TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (node_id) REFERENCES nodes(id)
      );
      CREATE TABLE IF NOT EXISTS op_log (
        timestamp TEXT PRIMARY KEY,
        node_id TEXT NULL,
        old_parent_id TEXT NULL,
        new_parent_id TEXT NULL,
        client_id TEXT,
        sync_timestamp TEXT, -- The time the operation was synced to the server.
        FOREIGN KEY (node_id) REFERENCES nodes(id),
        FOREIGN KEY (old_parent_id) REFERENCES nodes(id),
        FOREIGN KEY (new_parent_id) REFERENCES nodes(id)
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

      -- Create the root and tombstone nodes
      INSERT OR IGNORE INTO nodes (id, parent_id) VALUES ('ROOT', NULL);
      INSERT OR IGNORE INTO nodes (id, parent_id) VALUES ('TOMBSTONE', NULL);
    `)
  }
}
