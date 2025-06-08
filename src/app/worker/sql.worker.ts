import * as SQLite from "wa-sqlite"
// @ts-ignore
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs"
// @ts-ignore
import { OPFSCoopSyncVFS as VFS } from "wa-sqlite/src/examples/OPFSCoopSyncVFS.js"
import * as CRDT from "../../shared/crdt"
import type { MoveOperation } from "../../shared/operation"
import { sql } from "../../shared/sql"
import { SqliteDriver } from "../../shared/sqlite-driver"
import type { Action, ActionResult } from "./actions"

const OPEN_DB_LOCK = "wa-sqlite-open-db"

function invariant(condition: unknown, message?: string) {
  if (!condition) {
    throw new Error(message ?? "Invariant failed")
  }
}

async function initSQLite(
  room: string
): Promise<{ sqlite3: SQLiteAPI; db: number }> {
  const module = await SQLiteESMFactory()
  const sqlite3 = SQLite.Factory(module)
  const vfs = await VFS.create(room, module)
  sqlite3.vfs_register(vfs, true)

  let resolve: (value: { sqlite3: SQLiteAPI; db: number }) => void = () => {}
  let reject: (reason?: any) => void = () => {}
  const promise = new Promise<{ sqlite3: SQLiteAPI; db: number }>(
    (res, rej) => {
      resolve = res
      reject = rej
    }
  )

  navigator.locks.request(OPEN_DB_LOCK, async () => {
    try {
      const db = await sqlite3.open_v2(room)
      resolve({ sqlite3, db })

      // Keep the lock for another second.
      await new Promise((resolve) => setTimeout(resolve, 1000))
    } catch (e: any) {
      reject(e)
    }
  })

  return promise
}

async function setup() {
  let driver: SqliteDriver

  // Set up communications with the main thread.
  const messagePort = await new Promise<MessagePort>((resolve) => {
    addEventListener("message", function handler(event) {
      if (event.data === "messagePort") {
        resolve(event.ports[0])
        removeEventListener("message", handler)
      }
    })
  })

  /**
   * Respond to an action with a result.
   */
  const respond = <A extends Action & { id: string }>(
    action: A,
    ...args: ActionResult<A> extends never ? [] : [ActionResult<A>]
  ) => {
    messagePort.postMessage({
      id: action.id,
      result: args[0],
    })
  }

  // Start listening for actions.
  messagePort.start()

  messagePort.addEventListener("message", async (event) => {
    const action = event.data as Action

    console.log("Worker handling action:", action.type)

    switch (action.type) {
      case "init": {
        const { room } = action
        const { sqlite3, db } = await initSQLite(room)
        driver = new SqliteDriver(sqlite3, db)

        await driver.createTables()

        const result = await driver.execute(sql`
          SELECT sync_timestamp FROM op_log ORDER BY sync_timestamp DESC LIMIT 1
        `)

        respond(action, {
          lastSyncTimestamp: result[0]?.sync_timestamp ?? null,
        })

        break
      }

      case "close": {
        try {
          await driver.close()
          console.log("DB closed")
        } catch (error: any) {
          if (error.name === "NoModificationAllowedError") {
            // Try again.
            try {
              await new Promise((resolve) => setTimeout(resolve))
              driver.close()
            } catch (error: any) {
              console.error("Failed to close db.")
            }
          }
        }

        return respond(action)
      }

      case "clear": {
        invariant(driver)

        await driver.transaction(async (t) => {
          await driver.execute(sql`DROP TABLE op_log`)
          await driver.execute(sql`DROP TABLE nodes`)
          await driver.execute(sql`DROP TABLE payloads`)

          await t.commit()
        })

        return respond(action)
      }

      case "tree": {
        invariant(driver)

        const result = await driver.execute(sql`
          WITH RECURSIVE tree AS (
            -- Base case: start with root node
            SELECT nodes.id, nodes.parent_id, payloads.content
            FROM nodes
            LEFT JOIN payloads ON nodes.id = payloads.node_id 
            WHERE nodes.id = 'ROOT'
            
            UNION ALL
            
            -- Recursive case: get all children
            SELECT nodes.id, nodes.parent_id, payloads.content
            FROM nodes
            LEFT JOIN payloads ON nodes.id = payloads.node_id
            JOIN tree ON nodes.parent_id = tree.id
            ORDER BY nodes.id
          )
          SELECT * FROM tree
        `)

        return respond(action, result)
      }

      case "subtree": {
        invariant(driver)

        const now = performance.now()

        const { nodeId } = action

        const result = await driver.execute(sql`
          WITH first_1000_children AS (
            SELECT id, parent_id
            FROM nodes 
            WHERE parent_id = '${nodeId}' 
            ORDER BY id 
            LIMIT 1000
          )
          SELECT n.id, n.parent_id, p.content
          FROM (
            SELECT id, parent_id, 1 as level FROM first_1000_children
            UNION ALL
            SELECT c.id, c.parent_id, 2 as level 
            FROM first_1000_children f
            JOIN nodes c ON f.id = c.parent_id
          ) n
          LEFT JOIN payloads p ON n.id = p.node_id
          ORDER BY n.level, n.id
        `)

        console.log(`Subtree query took ${performance.now() - now}ms`)

        return respond(action, result)
      }

      case "opLog": {
        invariant(driver)

        const { limit = 100 } = action.options ?? {}

        const result = await driver.execute<MoveOperation>(sql`
          SELECT * FROM op_log
          ORDER BY timestamp DESC
          LIMIT ${limit}
        `)

        return respond(action, result)
      }

      case "pendingMoves": {
        invariant(driver)

        const { clientId } = action

        const result = await driver.execute<MoveOperation>(sql`
          SELECT * FROM op_log
          WHERE sync_timestamp IS NULL
            AND client_id = '${clientId}'
          ORDER BY timestamp ASC
        `)

        return respond(action, result)
      }

      case "insertMoves": {
        invariant(driver)

        const { moves } = action
        await CRDT.insertMoveOperations(driver, moves)
        return respond(action)
      }

      case "insertVerbatim": {
        invariant(driver)

        const { moves, nodes } = action

        const stringify = (value?: string | null) =>
          value ? `'${value}'` : "NULL"

        await driver.transaction(async (t) => {
          await t.executeScript(sql`
          ${
            moves.length
              ? `INSERT INTO op_log (timestamp, node_id, old_parent_id, new_parent_id, client_id, sync_timestamp) VALUES ${moves
                  .map(
                    (move) =>
                      `(${[
                        move.timestamp,
                        move.node_id,
                        move.old_parent_id,
                        move.new_parent_id,
                        move.client_id,
                        move.sync_timestamp,
                      ]
                        .map(stringify)
                        .join(", ")})`
                  )
                  .join(",")} ON CONFLICT DO NOTHING;`
              : ""
          }
          ${
            nodes.length
              ? `INSERT INTO nodes (id, parent_id) VALUES ${nodes
                  .map(
                    (node) =>
                      `(${[node.id, node.parent_id].map(stringify).join(", ")})`
                  )
                  .join(",")} ON CONFLICT DO NOTHING;`
              : ""
          }
        `)

          await t.commit()
        })

        return respond(action)
      }

      case "acknowledgeMoves": {
        invariant(driver)

        const { moves, syncTimestamp } = action
        await driver.execute(sql`
          UPDATE op_log SET sync_timestamp = '${syncTimestamp}' WHERE timestamp IN (${moves
          .map((move) => `'${move.timestamp}'`)
          .join(",")})
        `)
        return respond(action)
      }

      case "lastSyncTimestamp": {
        invariant(driver)

        const { clientId } = action

        const result = await driver.execute(sql`
          SELECT sync_timestamp FROM op_log WHERE client_id != '${clientId}' ORDER BY sync_timestamp DESC LIMIT 1
        `)
        return respond(action, result[0]?.sync_timestamp)
      }

      default: {
        console.error("Unknown message type", event.data)
      }
    }
  })

  messagePort.postMessage("Hello from worker 🤖")
}

setup()
