import { type Client, createClient } from "@libsql/client/web"
import fetch from "node-fetch"
import type * as Party from "partykit/server"
import * as CRDT from "../shared/crdt"
import * as Messages from "../shared/messages"
import type { Message } from "../shared/messages"
import type { MoveOperation } from "../shared/operation"
import { RoomStatus } from "../shared/room-status"
import { TursoDriver } from "../shared/turso-driver"

export default class Server implements Party.Server {
  // biome-ignore lint/style/noNonNullAssertion: <explanation>
  client: Client = null!
  // biome-ignore lint/style/noNonNullAssertion: <explanation>
  driver: TursoDriver = null!

  db = "<pending>"
  status: RoomStatus = RoomStatus.BOOTING

  constructor(readonly room: Party.Room) {}

  /**
   * This is called when the server starts, before `onConnect` or `onRequest`.
   */
  async onStart() {
    // Check if the database exists; handle 1m room separately.
    const db =
      this.room.id === "1m"
        ? "em-db-1m-finkef.turso.io"
        : await this.room.storage.get<string>("db")

    try {
      if (!db) {
        await this.updateStatus(RoomStatus.CREATING_DB)
        await this.createDatabase()
      } else {
        this.db = db
      }

      this.setupClient()

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
    // Only allow alphanumeric characters and dashes for rooms
    if (!/^[a-z0-9-]{2,}$/.test(lobby.id))
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

          await CRDT.insertMoveOperations(
            this.driver,
            message.operations
              .filter((op) => op.type === "MOVE")
              .map((op) => ({
                ...op,
                sync_timestamp: now.toISOString(),
              })),
          )

          this.room.broadcast(
            JSON.stringify(Messages.push(message.operations)),
            [clientId],
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
   * Creates a new database from the base branch.
   */
  async createDatabase() {
    const {
      database: { Hostname: hostname },
    } = await fetch(
      `https://api.turso.tech/v1/organizations/${this.room.env.TURSO_ORG_ID}/databases`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.room.env.TURSO_PLATFORM_TOKEN}`,
        },
        body: JSON.stringify({
          group: this.room.env.TURSO_GROUP_ID,
          name: `${this.room.env.TURSO_DB_PREFIX}${this.room.id}`,
        }),
      },
    ).then(async (res) => {
      if (!res.ok) {
        const error = await res.json()

        if (
          "error" in error &&
          typeof error.error === "string" &&
          error.error.includes("already exists")
        ) {
          return {
            database: {
              Hostname: `${this.room.env.TURSO_DB_PREFIX}${this.room.id}-${this.room.env.TURSO_ORG_ID}.turso.io`,
            },
          }
        }

        throw new Error(await res.text())
      }

      return res.json() as Promise<{ database: { Hostname: string } }>
    })

    await this.room.storage.put("db", hostname)
    this.db = hostname
  }

  /**
   * Sets up the client and driver.
   */
  setupClient() {
    this.client = createClient({
      url: `libsql://${this.db}`,
      authToken: this.room.env.TURSO_DB_TOKEN as string,
    })

    this.driver = new TursoDriver(this.client)
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
