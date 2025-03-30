import { Notifier } from "@/lib/notifier"
import { useClientId } from "@/lib/use-client-id"
import { insertIntoVirtualTree } from "@/lib/use-virtual-tree"
import {
  type Action,
  type ActionResult,
  acknowledgeMoves,
  clear,
  init,
  insertMoves,
  insertVerbatim,
  lastSyncTimestamp,
  pendingMoves,
} from "@/worker/actions"
import { useNetworkState } from "@uidotdev/usehooks"
import { nanoid } from "nanoid/non-secure"
import usePartySocket from "partysocket/react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useParams, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import {
  type Message,
  ping,
  push,
  subtree,
  syncStream,
} from "../../shared/messages"
import type { Node } from "../../shared/node"
import type { MoveOperation } from "../../shared/operation"
import * as Timing from "../lib/timing"
import SQLWorker from "../worker/sql.worker?worker"

export interface ConnectionContext {
  connected: boolean
  hydrated: boolean
  status: string | null
  clients: string[]
  clientId: string
  worker: {
    instance: InstanceType<typeof SQLWorker>
    initialized: boolean
    waitForResult: <A extends Action & { id: string }>(
      action: A
    ) => Promise<ActionResult<A>>
  }
  lastSyncTimestamp: string | null
  timestamp: () => string
  pushMoves: (moves: MoveOperation[]) => Promise<void>
  fetchSubtree: (
    id: string,
    depth?: number
  ) => Promise<{ id: string; parent_id: string }[]>
}

const ConnectionContext = createContext<ConnectionContext>({} as any)

export const useConnection = () => {
  return useContext(ConnectionContext)
}

export interface ConnectionProps {
  children: React.ReactNode
}

export const Connection = ({ children }: ConnectionProps) => {
  const room = useParams().roomId ?? nanoid()
  const [searchParams] = useSearchParams()
  const live = searchParams.get("live") !== null

  const { clientId } = useClientId()

  const didConnectInitially = useRef(false)
  const [connected, setConnected] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const workerInitializedRef = useRef<boolean>(false)
  const [workerInitialized, setWorkerInitialized] = useState<boolean>(false)
  const [clients, setClients] = useState<string[]>([])
  const [lastServerSyncTimestamp, setLastServerSyncTimestamp] = useState<
    string | null
  >(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const worker = useMemo(() => {
    const worker = new SQLWorker()
    const { port1, port2 } = new MessageChannel()

    // Register the port with the worker.
    worker.postMessage("messagePort", [port2])

    // Map of pending callbacks.
    const pendingCallbacks = new Map<string, (result: any) => void>()

    port1.addEventListener("message", (event) => {
      if (event.data.id) {
        const callback = pendingCallbacks.get(event.data.id)
        pendingCallbacks.delete(event.data.id)
        callback?.(event.data.result)
      }
    })
    port1.start()

    /**
     * Wait for a result from the worker.
     */
    const waitForResult = <A extends Action & { id: string }>(
      action: A
    ): Promise<ActionResult<A>> =>
      new Promise((resolve) => {
        port1.postMessage(action)
        pendingCallbacks.set(action.id, resolve)
      })

    waitForResult(init(room)).then(({ lastSyncTimestamp }) => {
      setWorkerInitialized(true)
      workerInitializedRef.current = true

      if (lastSyncTimestamp) {
        setHydrated(true)
      }
    })

    return { instance: worker, waitForResult }
  }, [])

  /**
   * Pull moves from the server.
   */
  const pullMoves = useCallback(async () => {
    const syncTimestamp = await worker.waitForResult(
      lastSyncTimestamp(clientId)
    )

    setLastServerSyncTimestamp(syncTimestamp)

    const res = await fetch(
      `${import.meta.env.VITE_PARTYKIT_HOST}/parties/main/${room}`,
      {
        method: "POST",
        body: JSON.stringify(
          syncStream(new Date(syncTimestamp ?? "1970-01-01"))
        ),
      }
    )

    const reader = res.body?.getReader()
    if (!reader) throw new Error("No reader available")

    const decoder = new TextDecoder()
    let buffer = ""
    let header: {
      lowerLimit: string
      upperLimit: string
      nodes: number
      operations: number
    } | null = null

    let syncToast: number | string | undefined = undefined
    let processed = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // Collect operations from the stream
        const operations: MoveOperation[] = []

        // Add new chunk to buffer and split on newlines
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")

        // Process all complete lines
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i]
          if (!line) continue

          // The first line is the header
          if (!header) {
            header = JSON.parse(line)
            syncToast = toast.loading(
              `Syncing ${header?.operations} operations...`,
              {
                duration: Number.POSITIVE_INFINITY,
              }
            )
            continue
          }

          const operation = JSON.parse(line) as MoveOperation
          operations.push(operation)
        }

        // Keep last partial line in buffer
        buffer = lines[lines.length - 1]

        processed += operations.length
        toast.loading(
          `Syncing ${processed}/${header?.operations} operations...`,
          {
            id: syncToast,
          }
        )

        await worker.waitForResult(insertMoves(operations))
      }

      // Process any remaining data
      if (buffer.length > 0) {
        const lines = buffer.split("\n")
        const operations = lines.map(
          (line) => JSON.parse(line) as MoveOperation
        )
        await worker.waitForResult(insertMoves(operations))
      }

      Timing.measureOnce("replication")

      const syncTimestamp = await worker.waitForResult(
        lastSyncTimestamp(clientId)
      )

      setLastServerSyncTimestamp(syncTimestamp)

      setHydrated(true)

      toast.success(`Synced ${processed} operations.`, {
        id: syncToast,
        duration: 1000,
        dismissible: true,
      })
    } catch (e) {
      toast.error("Failed to sync", {
        id: syncToast,
        description: "Please try again later",
        duration: 1000,
        dismissible: true,
      })

      throw e
    } finally {
      reader.releaseLock()
      Notifier.notify()
    }
  }, [room, worker, clientId])

  /**
   * Perform a full sync with the server, copying tables directly.
   */
  const performFullSync = useCallback(async () => {
    const res = await fetch(
      `${import.meta.env.VITE_SYNC_HOST}/${room}/stream`,
      {
        method: "GET",
      }
    )

    const reader = res.body?.getReader()
    if (!reader) throw new Error("No reader available")

    // We'll use a single TextDecoder instance.
    const decoder = new TextDecoder()
    // Our accumulated binary data.
    let binaryBuffer = new Uint8Array(0)
    // We expect a 19-byte header (11 bytes signature + 4 bytes flags + 4 bytes header extension length).
    const HEADER_LENGTH = 19
    let headerParsed = false
    let processed = 0
    const operations: MoveOperation[] = []
    const nodes: Node[] = []

    // Set up a batch size constant.
    const BATCH_SIZE = 5000
    const syncToast: number | string | undefined = toast.loading("Syncing...", {
      duration: Number.POSITIVE_INFINITY,
    })

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          binaryBuffer = concatUint8Array(binaryBuffer, value)
        }

        // Parse and remove header if not already done.
        if (!headerParsed && binaryBuffer.length >= HEADER_LENGTH) {
          // Optionally verify the signature here.
          binaryBuffer = binaryBuffer.subarray(HEADER_LENGTH)
          headerParsed = true
        }

        // Process as many complete rows as possible from our binary buffer.
        while (true) {
          // Not enough data for column count?
          if (binaryBuffer.length < 2) break
          const ncols = readInt16(binaryBuffer, 0)
          // End-of-data marker: a 16-bit value of -1.
          if (ncols === -1) {
            // Consume the marker and exit the row loop.
            binaryBuffer = binaryBuffer.subarray(2)
            break
          }

          // Try to parse one row.
          let offset = 2
          const row: (string | null)[] = []
          let incompleteRow = false
          for (let i = 0; i < ncols; i++) {
            // Need 4 bytes for the column length.
            if (binaryBuffer.length < offset + 4) {
              incompleteRow = true
              break
            }
            const colLength = readInt32(binaryBuffer, offset)
            offset += 4
            if (colLength === -1) {
              row.push(null)
            } else {
              // Wait until we have the full column data.
              if (binaryBuffer.length < offset + colLength) {
                incompleteRow = true
                break
              }
              const colData = binaryBuffer.subarray(offset, offset + colLength)
              offset += colLength
              // Decode the bytes into a string.
              const field = decoder.decode(colData)
              row.push(field)
            }
          }
          if (incompleteRow) break

          // Remove the parsed row bytes from our buffer.
          binaryBuffer = binaryBuffer.subarray(offset)

          // Process the row based on its type.
          if (row[0] === "n") {
            // Node row: [ "n", id, parent_id ]
            nodes.push({ id: row[1]!, parent_id: row[2]! })
          } else if (row[0] === "o") {
            // Operation row: [ "o", null, null, timestamp, node_id, old_parent_id, new_parent_id, client_id, sync_timestamp ]
            operations.push({
              type: "MOVE",
              timestamp: row[3]!,
              node_id: row[4]!,
              old_parent_id: row[5]!,
              new_parent_id: row[6]!,
              client_id: row[7]!,
              sync_timestamp: row[8]!,
            })
          } else {
            console.warn("Unknown row type:", row)
          }
          processed++

          // Flush in batches.
          if (nodes.length + operations.length >= BATCH_SIZE) {
            await worker.waitForResult(insertVerbatim(operations, nodes))
            // Clear our temporary arrays.
            operations.length = 0
            nodes.length = 0
            // Update the progress toast.
            toast.loading(`Syncing entries... (${processed})`, {
              id: syncToast,
            })
          }
        }
      }

      // Flush any remaining rows.
      if (nodes.length || operations.length) {
        await worker.waitForResult(insertVerbatim(operations, nodes))
      }

      if (binaryBuffer.length > 0) {
        console.log("Remaining binary data:", binaryBuffer)
      }

      Timing.measureOnce("replication")

      const syncTimestamp = await worker.waitForResult(
        lastSyncTimestamp(clientId)
      )
      setLastServerSyncTimestamp(syncTimestamp)
      setHydrated(true)

      toast.success(`Synced ${processed} entries.`, {
        id: syncToast,
        duration: 1000,
        dismissible: true,
      })
    } catch (e) {
      toast.error("Failed to sync", {
        id: syncToast,
        description: "Please try again later",
        duration: 1000,
        dismissible: true,
      })
      throw e
    } finally {
      reader.releaseLock()
      Notifier.notify()
    }
  }, [room, worker, clientId])

  /**
   * Fetch a subtree from the server.
   */
  const fetchSubtree = useCallback(
    async (id: string, depth = 1) => {
      const start = performance.now()
      const nodes = await fetch(
        `${import.meta.env.VITE_PARTYKIT_HOST}/parties/main/${room}`,
        {
          method: "POST",
          body: JSON.stringify(subtree(id, depth)),
        }
      ).then(
        (res) => res.json() as Promise<{ id: string; parent_id: string }[]>
      )
      const end = performance.now()

      console.log(
        `%c[FOREGROUND] Took ${end - start}ms. (${id} – ${
          nodes.length
        } children)`,
        "color: teal; font-weight: bold; font-size: 12px;"
      )

      Timing.measureOnce("interactive")

      return nodes
    },
    [room]
  )

  const socket = usePartySocket({
    room: room,
    id: clientId,
    host: import.meta.env.VITE_PARTYKIT_HOST,
    async onOpen() {
      setConnected(true)

      if (!didConnectInitially.current) {
        didConnectInitially.current = true

        // Wait for the worker to initialize.
        while (!workerInitializedRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }

        pushPendingMoves()

        if (!live) {
          // Check last sync timestamp
          const lastSync = await worker.waitForResult(
            lastSyncTimestamp(clientId)
          )

          if (lastSync) {
            // Pull moves from the server.
            await pullMoves()
          } else {
            // Full sync
            await performFullSync()
          }
        }
      }
    },
    async onMessage(evt) {
      try {
        const data = JSON.parse(evt.data || "{}") as Message

        switch (data.type) {
          case "status": {
            setStatus(data.status)
            break
          }

          case "connections": {
            setClients(data.clients)
            break
          }

          case "push": {
            Timing.timestamp("push:receive")

            const moveOps = data.operations.filter(
              (op): op is MoveOperation => op.type === "MOVE"
            )
            for (const move of moveOps) {
              insertIntoVirtualTree(move)
            }
            await worker.waitForResult(insertMoves(moveOps))
            Notifier.notify()
            break
          }

          default:
            console.log("Unknown message type", data)
            break
        }
      } catch (error) {
        console.error("Error parsing message", error)
      }
    },
  })

  const { online } = useNetworkState()

  /**
   * Timestamp that is unique for each client.
   */
  const timestamp = useCallback(
    () => `${new Date().toISOString()}-${clientId}`,
    [clientId]
  )

  const pushMoves = useCallback(
    async (moves: MoveOperation[]) => {
      Timing.timestamp("push:send")

      const { sync_timestamp } = await fetch(
        `${import.meta.env.VITE_PARTYKIT_HOST}/parties/main/${room}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(push(moves)),
        }
      ).then((res) => {
        if (!res.ok) {
          throw new Error("Failed to push moves")
        }

        return res.json() as Promise<{ sync_timestamp: string }>
      })

      await worker.waitForResult(acknowledgeMoves(moves, sync_timestamp))
      Notifier.notify()
    },
    [room, worker]
  )

  /**
   * Push pending moves to the server.
   */
  const pushPendingMoves = useCallback(async () => {
    const moves = await worker.waitForResult(pendingMoves(clientId))

    if (moves.length > 0) {
      await pushMoves(moves)
    }
  }, [pushMoves, worker, clientId])

  useEffect(() => {
    if (hydrated) {
      // Race with subtree fetch
      Timing.measureOnce("interactive")
    }
  }, [hydrated])

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    if (online) {
      /**
       * When reconnecting, push and pull moves.
       */
      if (didConnectInitially.current) {
        socket.reconnect()

        if (!live) {
          pullMoves()
        }

        pushPendingMoves()
      }
    } else {
      socket.close()
      setConnected(false)
      setClients([])
      setStatus(null)
    }
  }, [online, live])

  const value = useMemo(
    () => ({
      connected,
      hydrated: hydrated && !live,
      status,
      clients,
      clientId,
      worker: { ...worker, initialized: workerInitialized },
      timestamp,
      lastSyncTimestamp: lastServerSyncTimestamp,
      pushMoves,
      fetchSubtree,
    }),
    [
      connected,
      hydrated,
      status,
      clients,
      worker,
      workerInitialized,
      clientId,
      live,
      timestamp,
      lastServerSyncTimestamp,
      pushMoves,
      fetchSubtree,
    ]
  )

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  )
}

/**
 * Helper: Reads a 16-bit signed integer (big-endian) from the buffer at the given offset.
 */
function readInt16(buffer: Uint8Array, offset: number): number {
  return new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  ).getInt16(offset, false)
}

/**
 * Helper: Reads a 32-bit signed integer (big-endian) from the buffer at the given offset.
 */
function readInt32(buffer: Uint8Array, offset: number): number {
  return new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  ).getInt32(offset, false)
}

/**
 * Helper: Concatenates two Uint8Array instances.
 */
function concatUint8Array(a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = new Uint8Array(a.length + b.length)
  c.set(a, 0)
  c.set(b, a.length)
  return c
}
