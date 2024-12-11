import { nanoid } from "nanoid/non-secure"
import { useCallback, useState } from "react"

const CLIENT_ID_KEY = "em-client-id"

export function useClientId() {
  const [clientId, setClientIdState] = useState<string>(getOrSetClientId())

  const setClientId = useCallback((clientId: string) => {
    localStorage.setItem(CLIENT_ID_KEY, clientId)
    setClientIdState(clientId)
  }, [])

  return { clientId, setClientId }
}

function getOrSetClientId() {
  const clientId = localStorage.getItem(CLIENT_ID_KEY)

  if (!clientId) {
    const newClientId = nanoid(8)
    localStorage.setItem(CLIENT_ID_KEY, newClientId)
    return newClientId
  }

  return clientId
}
