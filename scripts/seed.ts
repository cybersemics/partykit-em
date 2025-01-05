import { input, number } from "@inquirer/prompts"
import { configDotenv } from "dotenv"
import type { MoveOperation } from "../src/shared/operation"
import { PostgresDriver } from "../src/shared/pg-driver"

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
      return /^[a-zA-Z0-9_]{2,}$/.test(value)
        ? true
        : "Room name must be alphanumeric and have at least two characters"
    },
  })
  const driver = new PostgresDriver(room, {
    host: process.env.PG_HOST as string,
    user: process.env.PG_USER as string,
    password: process.env.PG_PASSWORD as string,
    db: process.env.PG_DB as string,
  })

  const numberOfNodes = (await number({
    message: "Please enter the number of nodes to seed:",
    min: 1,
    default: 10000,
    required: true,
  })) as number

  await driver.createTables()

  const nodes = Array.from({ length: numberOfNodes }, (_, i) => ({
    id: `node-${String(i).padStart(10, "0")}`,
    parent_id: "ROOT",
  }))

  // Create a Map for O(1) access to nodes
  const nodesMap = new Map(nodes.map((node) => [node.id, node]))

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
      length: numberOfNodes * 3,
    },
    (_, i): MoveOperation => {
      const node = nodes[Math.floor(Math.random() * numberOfNodes)]
      const randomParent = nodes[Math.floor(Math.random() * numberOfNodes)]

      // Check for cycles using the Map for O(1) lookups
      let currentParentId = randomParent.id
      let wouldCreateCycle = false
      const visited = new Set<string>()

      while (currentParentId && currentParentId !== "ROOT") {
        if (currentParentId === node.id || visited.has(currentParentId)) {
          wouldCreateCycle = true
          break
        }
        visited.add(currentParentId)
        const currentNode = nodesMap.get(currentParentId)
        if (!currentNode) break
        currentParentId = currentNode.parent_id
      }

      // If we found a cycle, use ROOT instead
      const newParent = wouldCreateCycle ? "ROOT" : randomParent.id

      // Update the node's parent in both the array and map
      node.parent_id = newParent
      nodesMap.set(node.id, node)

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

  while (nodes.length > 0) {
    const batch = nodes.splice(0, 1000)
    await driver.sql.unsafe(
      `INSERT INTO nodes_${room} (id, parent_id) VALUES ${batch.map((node) => `('${node.id}', '${node.parent_id}')`).join(",")}`,
    )
  }

  console.log(
    `Seeding ${insertOperations.length} insert operations into ${room}...`,
  )

  while (insertOperations.length > 0) {
    const batch = moves.splice(0, 1000)
    const before = Date.now()
    // await CRDT.insertMoveOperations(driver, batch)
    await driver.sql.unsafe(
      `INSERT INTO op_log_${room} (timestamp, node_id, old_parent_id, new_parent_id, client_id, sync_timestamp) VALUES ${batch.map((op) => `('${op.timestamp}', '${op.node_id}', '${op.old_parent_id}', '${op.new_parent_id}', '${op.client_id}', '${op.sync_timestamp}')`).join(",")}`,
    )
    const after = Date.now()
    console.log(`Batch: ${after - before}ms`)
  }

  console.log(`Seeding ${moves.length} moves into $room...`)

  while (moves.length > 0) {
    const batch = moves.splice(0, 1000)
    const before = Date.now()
    // await CRDT.insertMoveOperations(driver, batch)
    await driver.sql.unsafe(
      `INSERT INTO op_log_${room} (timestamp, node_id, old_parent_id, new_parent_id, client_id, sync_timestamp) VALUES ${batch.map((op) => `('${op.timestamp}', '${op.node_id}', '${op.old_parent_id}', '${op.new_parent_id}', '${op.client_id}', '${op.sync_timestamp}')`).join(",")}`,
    )
    const after = Date.now()
    console.log(`Batch: ${after - before}ms`)
  }

  console.log(`Seeding complete. DB time: ${Date.now() - start}ms`)

  await driver.sql.end()
}

main()
