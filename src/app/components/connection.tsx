import { Notifier } from "@/lib/notifier"
import { useClientId } from "@/lib/use-client-id"
import { insertIntoVirtualTree } from "@/lib/use-virtual-tree"
import {
  type Action,
  type ActionResult,
  acknowledgeMoves,
  init,
  insertMoves,
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
import { type Message, push, subtree, syncStream } from "../../shared/messages"
import type { MoveOperation } from "../../shared/operation"
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
        body: JSON.stringify(syncStream(new Date(syncTimestamp))),
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

        console.log(`Inserting ${operations.length} operations`)
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
   * Fetch a subtree from the server.
   */
  const fetchSubtree = useCallback(
    async (id: string, depth = 1) => {
      const nodes = await fetch(
        `${import.meta.env.VITE_PARTYKIT_HOST}/parties/main/${room}`,
        {
          method: "POST",
          body: JSON.stringify(subtree(id, depth)),
        }
      ).then(
        (res) => res.json() as Promise<{ id: string; parent_id: string }[]>
      )

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
          // Pull moves from the server.
          await pullMoves()
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

    console.log("Pending moves", moves)

    if (moves.length > 0) {
      await pushMoves(moves)
    }
  }, [pushMoves, worker, clientId])

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
