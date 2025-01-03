export type Node = {
  id: string
  content?: string | null
  children?: Node[]
}

export type VirtualNode = Node & {
  loading?: boolean
}
