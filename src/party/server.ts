import type * as Party from "partykit/server"
import * as CRDT from "../shared/crdt"
import * as Messages from "../shared/messages"
import type { Message } from "../shared/messages"
import type { MoveOperation } from "../shared/operation"
import { PostgresDriver } from "../shared/pg-driver"
import { RoomStatus } from "../shared/room-status"

export default class Server implements Party.Server {
  // biome-ignore lint/style/noNonNullAssertion: <explanation>
  driver: PostgresDriver = null!

  status: RoomStatus = RoomStatus.BOOTING

  constructor(readonly room: Party.Room) {}

  /**
   * This is called when the server starts, before `onConnect` or `onRequest`.
   */
  async onStart() {
    try {
      this.driver = new PostgresDriver(this.room.id, {
        host: this.room.env.PG_HOST as string,
        user: this.room.env.PG_USER as string,
        password: this.room.env.PG_PASSWORD as string,
        db: this.room.env.PG_DB as string,
      })

      // Create tables if they don't exist yet.
      await this.driver.createTables()

      this.updateStatus(RoomStatus.READY)
    } catch (error) {
      console.error("Failed to start server.", error)
      this.updateStatus(RoomStatus.ERROR)
      throw error
    }
  }

  /**
   * Validate connections before accepting them.
   *
   * NOTE: This is where we would do authorization.
   */
  static async onBeforeConnect(request: Party.Request, lobby: Party.Lobby) {
    // Only allow alphanumeric characters and underscores for rooms
    if (!/^[a-z0-9_]{2,}$/.test(lobby.id))
      return new Response("Unauthorized", { status: 401 })

    return request
  }

  /**
   * Handles connection open events.
   *
   * Sends the current status to the new client and broadcasts the current list of clients to the room.
   */
  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    // send the current status to the new client
    conn.send(JSON.stringify(Messages.status(this.status)))

    // broadcast the current list of clients to the room
    this.room.broadcast(
      JSON.stringify(
        Messages.connections(
          [...this.room.getConnections()].map((conn) => conn.id),
        ),
      ),
    )
  }

  /**
   * Handles connection close events.
   */
  async onClose(_connection: Party.Connection) {
    this.room.broadcast(
      JSON.stringify(
        Messages.connections(
          [...this.room.getConnections()].map((conn) => conn.id),
        ),
      ),
      [],
    )
  }

  /**
   * Handles incoming messages.
   */
  onMessage(message: string, sender: Party.Connection) {
    try {
      const data = JSON.parse(message) as Message

      switch (data.type) {
        case "ping": {
          sender.send(JSON.stringify(Messages.status(this.status)))
          sender.send(
            JSON.stringify(
              Messages.connections(
                [...this.room.getConnections()].map((conn) => conn.id),
              ),
            ),
          )

          break
        }

        default: {
          console.log("Unknown message type", data)
          break
        }
      }
    } catch (error) {
      console.error("Error parsing message", error)
    }
  }

  /**
   * Handles incoming requests.
   */
  async onRequest(req: Party.Request) {
    console.log("onRequest", req.method, req.url)

    if (req.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      })

    if (req.method === "POST") {
      const message = (await req.json()) as Message

      switch (message.type) {
        case "push": {
          // TODO: Validation
          const now = new Date()

          const moveOps = message.operations.filter(
            (op): op is MoveOperation => op.type === "MOVE",
          )

          if (!moveOps.length)
            return this.json({ sync_timestamp: now.toISOString() })

          const clientId = moveOps[0].client_id

          this.room.broadcast(
            JSON.stringify(Messages.push(message.operations)),
            [clientId],
          )

          // PostgreSQL-optimized CRDT implementation
          await this.driver.insertMoveOperations(
            message.operations
              .filter((op) => op.type === "MOVE")
              .map((op) => ({
                ...op,
                sync_timestamp: now.toISOString(),
              })),
          )

          return this.json({ sync_timestamp: now.toISOString() })
        }

        case "sync:stream": {
          const { lastSyncTimestamp } = message

          const upperLimit = new Date().toISOString()

          const total = await this.driver.total({
            from: lastSyncTimestamp,
            until: upperLimit,
          })

          const header = {
            lowerLimit: lastSyncTimestamp,
            upperLimit: upperLimit,
            nodes: total.nodes,
            operations: total.operations,
          }

          console.log(`Sending ${header.operations} operations.`)

          const stream = new ReadableStream({
            start: async (controller) => {
              const encoder = new TextEncoder()

              controller.enqueue(encoder.encode(`${JSON.stringify(header)}\n`))

              try {
                for await (const operations of this.driver.streamOperations({
                  from: lastSyncTimestamp,
                  until: upperLimit,
                  chunkSize: 1000,
                  abort: req.signal,
                })) {
                  controller.enqueue(
                    encoder.encode(
                      `${operations.map((op) => JSON.stringify(op)).join("\n")}\n`,
                    ),
                  )
                }

                controller.close()
              } catch (err) {
                controller.error(err)
              }
            },
          })

          return new Response(stream, {
            headers: {
              "Content-Type": "application/x-ndjson",
              "Access-Control-Allow-Origin": "*",
            },
          })
        }

        case "sync:full": {
          try {
            // Get the raw stream from the driver and pass it directly to the response
            const stream = await this.driver.streamSyncTablesCopy(req.signal)

            const response = new Response(stream as any, {
              headers: {
                "Content-Type": "application/octet-stream",
                "Access-Control-Allow-Origin": "*",
              },
            })

            return response
          } catch (error) {
            console.error("Error streaming sync tables", error)
            return new Response("Internal server error", { status: 500 })
          }
        }

        case "subtree": {
          const { id, depth } = message
          const nodes = await CRDT.subtree(this.driver, id, depth)
          return this.json(nodes)
        }

        default:
          return new Response("Not found", { status: 404 })
      }
    }

    return new Response("Not found", { status: 404 })
  }

  /**
   * Updates the room status and broadcasts it to all clients.
   */
  async updateStatus(status: RoomStatus) {
    if (status === this.status) return

    this.status = status
    this.room.broadcast(JSON.stringify(Messages.status(status)), [])
  }

  /**
   * Helper function to create a JSON response with the correct headers.
   */
  json(data: any) {
    return Response.json(data, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    })
  }
}

Server satisfies Party.Worker
