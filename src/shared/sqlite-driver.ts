import { SQLITE_ROW } from "wa-sqlite"
import { Driver, type Transaction } from "./crdt"
import { type Statement, sql } from "./sql"

export class SqliteDriver extends Driver {
  constructor(
    private readonly sqlite3: SQLiteAPI,
    private readonly db: number,
  ) {
    super()
  }

  async execute<Row = any>({ sql }: Statement): Promise<Row[]> {
    const results = await this.exec({ sql })
    return results[0] as Row[]
  }

  async executeScript({ sql }: Statement): Promise<void> {
    await this.exec({ sql })
  }

  async transaction<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
    await this.exec({ sql: "BEGIN IMMEDIATE TRANSACTION" })

    return await fn({
      commit: () => this.exec({ sql: "COMMIT" }).then(() => {}),
      rollback: () => this.exec({ sql: "ROLLBACK" }).then(() => {}),
      execute: <Row>({ sql }: Statement): Promise<Row[]> =>
        this.execute({ sql }),
      executeScript: ({ sql }: Statement) => this.executeScript({ sql }),
    })
  }

  private async exec({ sql /* bindings */ }: Statement) {
    const bindings = undefined

    const results = []
    for await (const stmt of this.sqlite3.statements(this.db, sql)) {
      let columns: string[] | undefined

      for (const binding of bindings ?? [[]]) {
        this.sqlite3.reset(stmt)
        if (bindings) {
          this.sqlite3.bind_collection(stmt, binding)
        }

        const rows = []
        while ((await this.sqlite3.step(stmt)) === SQLITE_ROW) {
          const row = this.sqlite3.row(stmt)
          rows.push(row)
        }

        columns = columns ?? this.sqlite3.column_names(stmt)
        if (columns.length) {
          results.push({ columns, rows })
        }
      }

      // When binding parameters, only a single statement is executed.
      if (bindings) {
        break
      }
    }

    return results.map(({ columns, rows }) =>
      rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]]))),
    )
  }

  async createTables() {
    await this.executeScript(sql`
      -- Create tables
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT NULL,
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
        node_id TEXT NOT NULL,
        old_parent_id TEXT,
        new_parent_id TEXT,
        client_id TEXT,
        sync_timestamp TEXT,
        last_sync_timestamp TEXT,
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

    await this.executeScript(sql`
      ALTER TABLE op_log ADD COLUMN last_sync_timestamp TEXT;
    `).catch(() => {})
  }
}
