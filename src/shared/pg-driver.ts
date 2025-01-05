import type { AbortSignal } from "@cloudflare/workers-types"
import postgres from "postgres"
import { Driver, type Transaction } from "./crdt"
import type { MoveOperation } from "./operation"
import { type Statement, sql as sqlTemplate } from "./sql"

export class PostgresDriver extends Driver {
  public sql: postgres.Sql
  private roomId: string

  constructor(
    roomId: string,
    config: { host: string; user: string; password: string; db: string },
  ) {
    super()
    this.roomId = roomId
    this.sql = postgres({
      host: config.host,
      user: config.user,
      password: config.password,
      database: config.db,
      ssl: true,
    })
  }

  private getTableName(base: string): string {
    return `${base}_${this.roomId}`
  }

  /**
   * Transform SQL statements to be compatible with PostgreSQL and add table prefixes
   */
  private transformSql(sql: string): string {
    // Replace table names with prefixed versions
    let transformed = sql
      .replace(/\bnodes\b/g, this.getTableName("nodes"))
      .replace(/\bpayloads\b/g, this.getTableName("payloads"))
      .replace(/\bop_log\b/g, this.getTableName("op_log"))
      .replace(/\bclients\b/g, this.getTableName("clients"))

    // Convert SQLite's INSERT OR IGNORE to PostgreSQL's INSERT ... ON CONFLICT DO NOTHING
    if (sql.includes("INSERT OR IGNORE")) {
      transformed = transformed.replace("INSERT OR IGNORE", "INSERT")
      transformed += " ON CONFLICT DO NOTHING"
    }

    return transformed
  }

  async execute<Row = any>({ sql }: Statement): Promise<Row[]> {
    const prefixedSql = this.transformSql(sql)
    const result = await this.sql.unsafe(prefixedSql)
    return result as unknown as Row[]
  }

  async executeScript({ sql }: Statement): Promise<void> {
    const prefixedSql = sql
      .split(";")
      .map((stmt) => stmt.trim())
      .filter((stmt) => stmt.length > 0)
      .map((stmt) => this.transformSql(stmt))
      .join(";")

    await this.sql.unsafe(prefixedSql)
  }

  async transaction<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
    return (await this.sql.begin(async (sql) => {
      const transaction: Transaction = {
        commit: async () => {
          // commit is handled automatically by postgres.js
          return
        },
        rollback: async () => {
          throw new Error("ROLLBACK")
        },
        execute: async <Row>({ sql: sqlStr }: Statement): Promise<Row[]> => {
          const prefixedSql = this.transformSql(sqlStr)
          const result = await sql.unsafe(prefixedSql)
          return result as unknown as Row[]
        },
        executeScript: async ({ sql: sqlStr }: Statement) => {
          const prefixedSql = sqlStr
            .split(";")
            .map((stmt) => stmt.trim())
            .filter((stmt) => stmt.length > 0)
            .map((stmt) => this.transformSql(stmt))
            .join(";")

          await sql.unsafe(prefixedSql)
        },
      }

      try {
        const result = await fn(transaction)
        return result
      } catch (e) {
        if (e instanceof Error && e.message === "ROLLBACK") {
          throw e
        }
        throw e
      }
    })) as T
  }

  /**
   * Create PostgreSQL-specific functions for optimized CRDT operations
   */
  private async createFunctions(): Promise<void> {
    await this.executeScript({
      sql: `
        -- Function to process an entire batch of move operations atomically
        CREATE OR REPLACE FUNCTION ${this.getTableName("process_move_operations")}(
          p_operations JSONB
        ) RETURNS void AS $$
        DECLARE
          min_timestamp TEXT;
          op_record RECORD;
          nodes TEXT[];
          move_record RECORD;
        BEGIN
          -- Extract min_timestamp
          SELECT MIN(op_data->>'timestamp')
          INTO min_timestamp
          FROM jsonb_array_elements(p_operations) AS op_data;

          -- Collect all node IDs
          WITH operation_list AS (
            SELECT DISTINCT jsonb_array_elements(p_operations) AS op_data
          ),
          node_ids AS (
            SELECT op_data->>'node_id' AS id FROM operation_list
            UNION
            SELECT op_data->>'old_parent_id' AS id FROM operation_list WHERE op_data->>'old_parent_id' IS NOT NULL
            UNION
            SELECT op_data->>'new_parent_id' AS id FROM operation_list WHERE op_data->>'new_parent_id' IS NOT NULL
          )
          SELECT array_agg(id)
          INTO nodes
          FROM node_ids
          WHERE id IS NOT NULL;

          -- Ensure all nodes exist
          INSERT INTO ${this.getTableName("nodes")} (id)
          SELECT UNNEST(nodes)
          ON CONFLICT (id) DO NOTHING;

          -- Insert all operations into op_log
          FOR op_record IN 
            SELECT op_data 
            FROM jsonb_array_elements(p_operations) AS op_data
          LOOP
            INSERT INTO ${this.getTableName("op_log")}
              (timestamp, node_id, old_parent_id, new_parent_id, client_id, sync_timestamp)
            VALUES (
              op_record.op_data->>'timestamp',
              op_record.op_data->>'node_id',
              NULLIF(op_record.op_data->>'old_parent_id', 'null'),
              op_record.op_data->>'new_parent_id',
              op_record.op_data->>'client_id',
              NULLIF(op_record.op_data->>'sync_timestamp', 'null')
            )
            ON CONFLICT (timestamp) DO NOTHING;
          END LOOP;

          -- Reset moved nodes to their state before minTimestamp
          UPDATE ${this.getTableName("nodes")} n
          SET parent_id = (
            SELECT old_parent_id
            FROM ${this.getTableName("op_log")}
            WHERE node_id = n.id
              AND timestamp >= min_timestamp
            ORDER BY timestamp ASC
            LIMIT 1
          )
          WHERE id IN (
            SELECT DISTINCT node_id
            FROM ${this.getTableName("op_log")}
            WHERE timestamp >= min_timestamp
          );

          -- Apply moves in timestamp order, checking for cycles
          FOR move_record IN 
            SELECT node_id, new_parent_id
            FROM ${this.getTableName("op_log")}
            WHERE timestamp >= min_timestamp
            ORDER BY timestamp ASC
          LOOP
            -- Check for cycles using recursive CTE
            IF NOT EXISTS (
              WITH RECURSIVE ancestors AS (
                -- Start from the new parent
                SELECT id, parent_id, 1 as depth
                FROM ${this.getTableName("nodes")}
                WHERE id = move_record.new_parent_id
                
                UNION ALL
                
                -- Follow parent links up, with depth limit
                SELECT n.id, n.parent_id, a.depth + 1
                FROM ${this.getTableName("nodes")} n
                JOIN ancestors a ON n.id = a.parent_id
                WHERE n.parent_id IS NOT NULL 
                  AND n.parent_id != move_record.new_parent_id
                  AND a.depth < 100
              )
              SELECT 1 FROM ancestors WHERE id = move_record.node_id
            ) THEN
              -- Apply the move if it won't create a cycle
              UPDATE ${this.getTableName("nodes")}
              SET parent_id = move_record.new_parent_id
              WHERE id = move_record.node_id;
            END IF;
          END LOOP;

        EXCEPTION WHEN OTHERS THEN
          -- If anything fails, the entire transaction will be rolled back
          RAISE;
        END;
        $$ LANGUAGE plpgsql;
      `,
    })
  }

  /**
   * Create the tables for this room if they don't exist.
   */
  async createTables(): Promise<void> {
    await this.executeScript({
      sql: `
        -- Create tables
        CREATE TABLE IF NOT EXISTS ${this.getTableName("nodes")} (
          id TEXT PRIMARY KEY,
          parent_id TEXT NULL
        );

        CREATE TABLE IF NOT EXISTS ${this.getTableName("payloads")} (
          node_id TEXT NOT NULL,
          content TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ${this.getTableName("op_log")} (
          timestamp TEXT PRIMARY KEY,
          node_id TEXT NULL,
          old_parent_id TEXT NULL,
          new_parent_id TEXT NULL,
          client_id TEXT,
          sync_timestamp TEXT -- The time the operation was synced to the server.
        );

        CREATE TABLE IF NOT EXISTS ${this.getTableName("clients")} (
          id TEXT PRIMARY KEY,
          last_seen TEXT NOT NULL
        );

        -- Create indexes
        CREATE INDEX IF NOT EXISTS idx_${this.roomId}_nodes_id ON ${this.getTableName("nodes")}(id);
        CREATE INDEX IF NOT EXISTS idx_${this.roomId}_nodes_parent_id ON ${this.getTableName("nodes")}(parent_id);
        CREATE INDEX IF NOT EXISTS idx_${this.roomId}_op_log_timestamp ON ${this.getTableName("op_log")}(timestamp);
        CREATE INDEX IF NOT EXISTS idx_${this.roomId}_payloads_node_id ON ${this.getTableName("payloads")}(node_id);
        CREATE INDEX IF NOT EXISTS idx_${this.roomId}_op_log_sync_timestamp ON ${this.getTableName("op_log")}(sync_timestamp);
        CREATE INDEX IF NOT EXISTS idx_${this.roomId}_op_log_node_id ON ${this.getTableName("op_log")}(node_id);
        CREATE INDEX IF NOT EXISTS idx_${this.roomId}_op_log_node_timestamp ON ${this.getTableName("op_log")}(node_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_${this.roomId}_op_log_timestamp_node ON ${this.getTableName("op_log")}(timestamp, node_id);

        -- Create the root and tombstone nodes
        INSERT INTO ${this.getTableName("nodes")} (id, parent_id)
        VALUES ('ROOT', NULL), ('TOMBSTONE', NULL)
        ON CONFLICT (id) DO NOTHING;
      `,
    })

    // Create PostgreSQL functions
    await this.createFunctions()
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
    // Use a single query with multiple aggregates
    const [result] = await this.execute<{
      operations: number
      nodes: number
    }>(sqlTemplate`
      SELECT 
        (SELECT COUNT(1) FROM ${this.getTableName("op_log")} 
         WHERE sync_timestamp >= '${from}' AND sync_timestamp <= '${until}'
        ) as operations,
        (SELECT reltuples::bigint FROM pg_class WHERE relname = '${this.getTableName("nodes")}') as nodes;
    `)

    return {
      operations: Number(result.operations) || 0,
      nodes: Number(result.nodes) || 0,
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
    let shouldAbort = false

    const onAbort = () => {
      shouldAbort = true
    }

    abort?.addEventListener("abort", onAbort)

    const cursor = this.sql
      .unsafe(
        sqlTemplate`
        SELECT * 
        FROM ${this.getTableName("op_log")}
        WHERE sync_timestamp >= '${from}'
          AND sync_timestamp <= '${until}'
        ORDER BY timestamp ASC 
      `.sql,
      )
      .cursor(chunkSize)

    for await (const operations of cursor) {
      if (shouldAbort) break
      yield operations
    }

    abort?.removeEventListener("abort", onAbort)
  }

  /**
   * PostgreSQL-optimized version of insertMoveOperations
   */
  async insertMoveOperations(operations: MoveOperation[]): Promise<void> {
    if (!operations.length) return

    // Make a single call to process all operations atomically
    await this.executeScript({
      sql: `
        SELECT ${this.getTableName("process_move_operations")}(
          '${JSON.stringify(operations)}'::jsonb
        );
      `,
    })
  }
}
