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
    // Check if the database exists
    const db = await this.room.storage.get<string>("db")

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
      throw error
    }
  }

  static async onBeforeConnect(request: Party.Request, lobby: Party.Lobby) {
    // Only allow alphanumeric characters and dashes for rooms
    if (!/^[a-zA-Z0-9-]{2,}$/.test(lobby.id))
      return new Response("Unauthorized", { status: 401 })

    return request
  }

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

  onMessage(message: string, sender: Party.Connection) {
    console.log("onMessage", message, sender)

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
            message.operations.filter((op) => op.type === "MOVE"),
          )

          this.room.broadcast(
            JSON.stringify(Messages.push(message.operations)),
            [clientId],
          )

          return this.json({ sync_timestamp: now.toISOString() })
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
      if (!res.ok) throw new Error(await res.text())

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

  json(data: any) {
    return Response.json(data, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      },
    })
  }
}

Server satisfies Party.Worker
