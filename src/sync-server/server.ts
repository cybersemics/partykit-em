import { Hono } from "hono"
import { cors } from "hono/cors"
import { stream } from "hono/streaming"
import { serve } from "@hono/node-server"
import postgres from "postgres"
import { makeDefaultReadableStreamFromNodeReadable } from "node-readable-to-web-readable-stream"
import { configDotenv } from "dotenv"

configDotenv()
configDotenv({ path: ".env.local", override: true })

const sql = postgres({
  host: process.env.PG_HOST,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DB,
  ssl: true,
})

const app = new Hono()

app.use("*", cors())

app.get("/:roomId/stats", async (c) => {
  const roomId = c.req.param("roomId")

  try {
    const result = await sql`
      SELECT 
        SUM(CASE WHEN relname = ${suffix("nodes", roomId)} THEN reltuples ELSE 0 END) as nodes,
        SUM(CASE WHEN relname = ${suffix("op_log", roomId)} THEN reltuples ELSE 0 END) as ops
      FROM pg_class 
      WHERE relname IN (${suffix("nodes", roomId)}, ${suffix("op_log", roomId)})
    `

    return Response.json({
      stats: {
        nodes: parseInt(result[0]?.nodes || 0),
        ops: parseInt(result[0]?.ops || 0),
      },
    })
  } catch (error) {
    console.error(`Error getting stats for room ${roomId}:`, error)
    return Response.json({
      stats: {
        nodes: 0,
        ops: 0,
      },
    }, { status: 500 })
  }
})

app.get("/:roomId/stream", async (c) => {
  const roomId = c.req.param("roomId")

  const q = sql`
      COPY (
        SELECT 'n' AS type,
               id,
               parent_id,
               NULL::text AS timestamp,
               NULL::text AS node_id,
               NULL::text AS old_parent_id,
               NULL::text AS new_parent_id,
               NULL::text AS client_id,
               NULL::text AS sync_timestamp
        FROM ${sql(suffix("nodes", roomId))}
        UNION ALL
        SELECT 'o' AS type,
               NULL::text AS id,
               NULL::text AS parent_id,
               timestamp,
               node_id,
               old_parent_id,
               new_parent_id,
               client_id,
               sync_timestamp
        FROM ${sql(suffix("op_log", roomId))}
      ) TO STDOUT (FORMAT binary)
    `

  const nodeStream = await q.readable()

  const cleanup = () => {
    try {
      q.cancel()
      console.log("Stream aborted, connection released.")
    } catch (err) {
      console.error("Error aborting stream", err)
    }
  }

  return stream(
    c,
    async (stream) => {
      stream.onAbort(cleanup)

      return stream.pipe(makeDefaultReadableStreamFromNodeReadable(nodeStream))
    },
    async (err, _stream) => {
      console.error(err)
      cleanup()
    }
  )
})

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000
const server = serve({ fetch: app.fetch, port })

console.log(`Sync server is running on port ${port}.`)

process.on("SIGINT", () => {
  console.log("Shutting down server...")
  server.close(() => {
    try {
      sql.end()
      console.log("Server and database connections closed")
    } catch (err) {
      console.error("Error closing database connection", err)
    }
    process.exit(0)
  })
})

/**
 * Returns a suffixed version of the table name.
 */
function suffix(base: string, roomId: string): string {
  return `${base}_${roomId}`
}
