import { useConnection } from "@/components/connection"
import { opLog } from "@/worker/actions"
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react"
import type { MoveOperation } from "../../shared/operation"
import { Notifier } from "./notifier"

export const useOpLog = () => {
  const { worker } = useConnection()

  const opLogCache = useRef<MoveOperation[]>()

  const getSnapshot = useCallback(() => {
    return opLogCache.current
  }, [])

  const subscribe = useCallback(
    (callback: () => void) => {
      // Wrap the notifier's callback to handle the async update
      return Notifier.subscribe(async () => {
        const newOpLog = await worker.waitForResult(opLog())
        opLogCache.current = newOpLog
        callback()
      })
    },
    [worker],
  )

  useLayoutEffect(() => {
    if (opLogCache.current || !worker.initialized) return

    worker.waitForResult(opLog()).then((opLog) => {
      opLogCache.current = opLog
      Notifier.notify()
    })
  }, [worker])

  return useSyncExternalStore(subscribe, getSnapshot)
}
