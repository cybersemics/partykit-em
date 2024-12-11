import { Notifier } from "@/lib/notifier"
import { useClientId } from "@/lib/use-client-id"
import {
  type Action,
  type ActionResult,
  acknowledgeMoves,
  init,
  insertMoves,
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
import { useParams } from "react-router-dom"
import { type Message, push } from "../../shared/messages"
import type { MoveOperation } from "../../shared/operation"
import SQLWorker from "../worker/sql.worker?worker"

export interface ConnectionContext {
  connected: boolean
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
  timestamp: () => string
  pushMoves: (moves: MoveOperation[]) => Promise<void>
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

  const { clientId } = useClientId()

  const didConnectInitially = useRef(false)
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [workerInitialized, setWorkerInitialized] = useState<boolean>(false)
  const [clients, setClients] = useState<string[]>([])

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  const worker = useMemo(() => {
    const worker = new SQLWorker()
    console.log(worker)

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

    waitForResult(init(room)).then((result) => {
      setWorkerInitialized(true)
    })

    return { instance: worker, waitForResult }
  }, [])

  const socket = usePartySocket({
    room: room,
    id: clientId,
    host: import.meta.env.VITE_PARTYKIT_HOST,
    onOpen() {
      setConnected(true)
      didConnectInitially.current = true
    },
    async onMessage(evt) {
      try {
        const data = JSON.parse(evt.data || "{}") as Message

        console.log("onMessage", data)

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    if (online) {
      if (didConnectInitially.current) {
        socket.reconnect()
      }
    } else {
      socket.close()
      setConnected(false)
      setClients([])
      setStatus(null)
    }
  }, [online])

  const value = useMemo(
    () => ({
      connected,
      status,
      clients,
      clientId,
      worker: { ...worker, initialized: workerInitialized },
      timestamp,
      pushMoves,
    }),
    [
      connected,
      status,
      clients,
      worker,
      workerInitialized,
      clientId,
      timestamp,
      pushMoves,
    ]
  )

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  )
}
