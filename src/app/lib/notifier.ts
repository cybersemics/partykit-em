const listeners: Record<string, Set<() => void>> = {}

export const Notifier = {
  subscribe: (callback: () => void) => {
    const key = "op_log"

    if (!listeners[key]) {
      listeners[key] = new Set()
    }

    listeners[key].add(callback)

    return () => {
      listeners[key].delete(callback)
    }
  },

  notify: () => {
    const key = "op_log"

    if (listeners[key]) {
      for (const callback of listeners[key]) {
        callback()
      }
    }
  },
}
