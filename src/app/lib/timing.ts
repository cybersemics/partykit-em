const measurements = new Set<string>()

let start = performance.now()

export function registerStart() {
  start = performance.now()
}

export function measureOnce(name: string) {
  if (measurements.has(name)) return

  measurements.add(name)
  const end = performance.now()
  console.log(
    `%c[${name.toUpperCase()}] Took ${end - start}ms.`,
    "color: purple; font-weight: bold; font-size: 12px;",
  )
}

export function timestamp(name: string) {
  console.log(
    `%c[${name.toUpperCase()}] Executed at ${new Date().toISOString()}. (Date.now: ${Date.now()})`,
    "color: orange; font-weight: bold; font-size: 12px;",
  )
}
