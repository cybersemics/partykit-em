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

function invariant(condition: unknown, message?: string) {
  if (!condition) {
    throw new Error(message ?? "Invariant failed")
  }
}

async function initSQLite(room: string) {
  const module = await SQLiteESMFactory()
  const sqlite3 = SQLite.Factory(module)
  const vfs = await VFS.create(room, module)
  sqlite3.vfs_register(vfs, true)
  const db = await sqlite3.open_v2(room)

  return { sqlite3, db }
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

    switch (action.type) {
      case "init": {
        const { room } = action
        const { sqlite3, db } = await initSQLite(room)
        driver = new SqliteDriver(sqlite3, db)

        await driver.createTables()

        respond(action)

        break
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
          )
          SELECT * FROM tree
        `)

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

      case "insertMoves": {
        invariant(driver)

        const { moves } = action
        await CRDT.insertMoveOperations(driver, moves)
        return respond(action)
      }

      case "acknowledgeMoves": {
        invariant(driver)

        const { moves, syncTimestamp } = action
        await driver.execute(sql`
          UPDATE op_log SET sync_timestamp = '${syncTimestamp}' WHERE timestamp IN (${moves.map((move) => `'${move.timestamp}'`).join(",")})
        `)
        return respond(action)
      }

      default: {
        console.error("Unknown message type", event.data)
      }
    }
  })

  messagePort.postMessage("Hello from worker 🤖")
}

setup()