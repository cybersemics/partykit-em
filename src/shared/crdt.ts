import type { MoveOperation } from "./operation"
import { type Statement, sql } from "./sql"

/**
 * Common transaction interface.
 */
export interface Transaction {
  execute<Row = any>(sql: Statement): Promise<Row[]>
  executeScript(sql: Statement): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}

/**
 * Common SQL driver interface.
 */
export abstract class Driver {
  /**
   * Executes a script. May contain multiple statements.
   */
  abstract executeScript(sql: Statement): Promise<void>

  /**
   * Executes a single statement and returns the result.
   */
  abstract execute<Row = any>(sql: Statement): Promise<Row[]>

  /**
   * Executes a transaction.
   */
  abstract transaction<T>(fn: (t: Transaction) => Promise<T>): Promise<T>
}

export const insertMoveOperations = async (
  driver: Driver,
  operations: MoveOperation[],
) => {
  if (!operations.length) return

  const minTimestamp = operations.reduce((min, op) => {
    return min < op.timestamp ? min : op.timestamp
  }, new Date("2999-01-01T00:00:00Z").toISOString())

  await driver.transaction(async (tx) => {
    const nodes = new Set(
      operations.flatMap((op) => [
        op.node_id,
        op.old_parent_id,
        op.new_parent_id,
      ]),
    )

    // Insert all new moves into op_log and ensure nodes exist
    const values = operations
      .map(
        (op) => `(
          '${op.timestamp}', 
          '${op.node_id}', 
          ${op.old_parent_id ? `'${op.old_parent_id}'` : "NULL"},
          '${op.new_parent_id}',
          '${op.client_id}',
          ${op.sync_timestamp ? `'${op.sync_timestamp}'` : "NULL"}
        )`,
      )
      .join(",\n")

    await tx.executeScript(sql`
      -- Create indexed temp table
      DROP TABLE IF EXISTS temp_nodes;
      CREATE TABLE temp_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT
      ) WITHOUT ROWID;
      CREATE INDEX temp_nodes_parent_idx ON temp_nodes(parent_id);

      -- Ensure all nodes exist
      INSERT OR IGNORE INTO nodes (id) VALUES ${Array.from(nodes)
        .map((id) => `('${id}')`)
        .join(",")};

      -- First insert moves
      INSERT INTO op_log
        (timestamp, node_id, old_parent_id, new_parent_id, client_id, sync_timestamp)
      VALUES ${values};

      -- Populate temp table with current node state
      INSERT INTO temp_nodes 
      SELECT id, parent_id FROM nodes;

      -- Reset moved nodes to their state before minTimestamp
      UPDATE temp_nodes
      SET parent_id = (
        SELECT old_parent_id
        FROM op_log
        WHERE node_id = temp_nodes.id
          AND timestamp >= '${minTimestamp}'
        ORDER BY timestamp ASC
        LIMIT 1
      )
      WHERE id IN (
        SELECT DISTINCT node_id
        FROM op_log
        WHERE timestamp >= '${minTimestamp}'
      );
    `)

    // Get and apply moves in timestamp order
    const moves = await tx.execute<{
      node_id: string
      new_parent_id: string
      timestamp: number
    }>(sql`
      SELECT node_id, new_parent_id, timestamp 
      FROM op_log
      WHERE timestamp >= '${minTimestamp}'
      ORDER BY timestamp ASC
    `)

    // Apply valid moves in timestamp order
    for (const { node_id, new_parent_id, timestamp } of moves) {
      if (!node_id || !new_parent_id) continue

      await tx.executeScript(sql`
        WITH RECURSIVE ancestors(id) AS (
          -- Start from the new parent
          SELECT parent_id 
          FROM temp_nodes
          WHERE id = '${new_parent_id}'
          
          UNION ALL
          
          -- Follow parent links up using indexed temp table
          SELECT n.parent_id 
          FROM temp_nodes n
          JOIN ancestors a ON n.id = a.id
          WHERE n.parent_id IS NOT NULL
        )
        UPDATE temp_nodes
        SET parent_id = CASE
          -- Only update if the node isn't an ancestor (wouldn't create cycle)
          WHEN NOT EXISTS (SELECT 1 FROM ancestors WHERE id = '${node_id}')
          THEN '${new_parent_id}'
          -- Otherwise keep existing parent
          ELSE parent_id
        END
        WHERE id = '${node_id}';
      `)
    }

    // Copy final state back to nodes table
    await tx.executeScript(sql`
      UPDATE nodes
      SET parent_id = (
        SELECT parent_id
        FROM temp_nodes
        WHERE temp_nodes.id = nodes.id
      );

      DROP TABLE IF EXISTS temp_nodes;
    `)

    await tx.commit()
  })
}
