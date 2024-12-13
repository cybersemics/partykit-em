import { input, number } from "@inquirer/prompts"
import { createClient } from "@libsql/client"
import { configDotenv } from "dotenv"
import * as CRDT from "../src/shared/crdt"
import type { MoveOperation } from "../src/shared/operation"
import { TursoDriver } from "../src/shared/turso-driver"

configDotenv()
configDotenv({ path: ".env.local", override: true })

let _seq = 0
const seq = () => {
  return String(_seq++).padStart(10, "0")
}

async function main() {
  if (!process.env.TURSO_DB_TOKEN) {
    console.error("TURSO_DB_TOKEN is not set")
    process.exit(1)
  }
  if (!process.env.TURSO_DB_PREFIX) {
    console.error("TURSO_DB_PREFIX is not set")
    process.exit(1)
  }
  if (!process.env.TURSO_ORG_ID) {
    console.error("TURSO_ORG_ID is not set")
    process.exit(1)
  }

  const room = await input({
    message: "Please enter the room name:",
    required: true,
    validate(value) {
      return /^[a-zA-Z0-9-]{2,}$/.test(value)
        ? true
        : "Room name must be alphanumeric and have at least two characters"
    },
  })

  const client = createClient({
    url: `libsql://${process.env.TURSO_DB_PREFIX}${room}-${process.env.TURSO_ORG_ID}.turso.io`,
    authToken: process.env.TURSO_DB_TOKEN,
  })

  const driver = new TursoDriver(client)

  const numberOfNodes = (await number({
    message: "Please enter the number of nodes to seed:",
    min: 1,
    default: 10000,
    required: true,
  })) as number

  const nodes = Array.from({ length: numberOfNodes }, (_, i) => ({
    id: `node-${String(i).padStart(10, "0")}`,
    parent_id: "ROOT",
  }))

  const syncTimestamp = new Date("2024-10-01T00:00:00Z")

  const insertOperations = nodes.map(
    (node, i): MoveOperation => ({
      type: "MOVE",
      timestamp: `${new Date().toISOString()}-seed:${seq()}`,
      node_id: node.id,
      old_parent_id: null,
      new_parent_id: node.parent_id,
      client_id: "seed",
      sync_timestamp: new Date(syncTimestamp.getTime() + _seq).toISOString(),
    }),
  )

  const moves = Array.from(
    {
      length: numberOfNodes * 9,
    },
    (_, i): MoveOperation => {
      const node = nodes[Math.floor(Math.random() * numberOfNodes)]
      const randomParent = nodes[Math.floor(Math.random() * numberOfNodes)]

      // Make sure the new parent is not itself
      const newParent = randomParent.id === node.id ? "ROOT" : randomParent.id

      node.parent_id = newParent

      return {
        type: "MOVE",
        timestamp: `${new Date().toISOString()}-seed:${seq()}`,
        node_id: node.id,
        old_parent_id: node.parent_id,
        new_parent_id: newParent,
        client_id: "seed",
        sync_timestamp: new Date(syncTimestamp.getTime() + _seq).toISOString(),
      }
    },
  )

  const start = Date.now()

  console.log(`Seeding ${numberOfNodes} nodes into ${room}...`)

  while (insertOperations.length > 0) {
    const batch = insertOperations.splice(0, 1000)
    await CRDT.insertMoveOperations(driver, batch)
  }

  console.log(`Seeding ${moves.length} moves into ${room}...`)

  while (moves.length > 0) {
    const batch = moves.splice(0, 1000)
    const before = Date.now()
    await CRDT.insertMoveOperations(driver, batch)
    const after = Date.now()
    console.log(`Batch: ${after - before}ms`)
  }

  console.log(`Seeding complete. DB time: ${Date.now() - start}ms`)
}

main()
