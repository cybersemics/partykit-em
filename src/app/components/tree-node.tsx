import type { VirtualNode } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  ChevronRightIcon,
  DotIcon,
  Loader,
  PlusIcon,
  TrashIcon,
} from "lucide-react"
import { ChevronDownIcon } from "lucide-react"
import { useRef } from "react"
import { useEffect } from "react"
import type { NodeRendererProps } from "react-arborist"

const Edit = ({ node }: NodeRendererProps<VirtualNode>) => {
  const input = useRef<any>()

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  return (
    <input
      ref={input}
      // @ts-ignore
      defaultValue={node.data.name}
      onBlur={() => node.submit(input.current?.value || "")}
      onKeyDown={(e) => {
        if (e.key === "Escape") node.reset()
        if (e.key === "Enter") node.submit(input.current?.value || "")
      }}
    />
  )
}

const Show = ({ node }: NodeRendererProps<VirtualNode>) => {
  return (
    <span
      className={cn("cursor-text", node.id === "ROOT" && "opacity-50")}
      onClick={() => node.id !== "ROOT" && node.edit()}
    >
      {node.id === "ROOT" ? "ROOT" : node.data.content ?? `Node ${node.id}`}
    </span>
  )
}

export const TreeNode = (props: NodeRendererProps<VirtualNode>) => {
  const { node, style, tree, dragHandle } = props

  return (
    <div
      className="flex flex-row items-center gap-2 font-mono font-semibold group py-1"
      style={style}
      ref={dragHandle}
    >
      <span
        className="cursor-pointer"
        onClick={(e) => {
          e.stopPropagation()
          node.toggle()
        }}
      >
        {node.data.loading ? (
          <Loader className="w-5 h-5 animate-spin duration-1000" />
        ) : node.children && !node.children.length ? (
          <DotIcon width={20} height={20} />
        ) : node.isOpen ? (
          <ChevronDownIcon width={20} height={20} />
        ) : (
          <ChevronRightIcon width={20} height={20} />
        )}
      </span>

      {props.node.isEditing ? <Edit {...props} /> : <Show {...props} />}

      <div className="flex flex-row items-center gap-1">
        <div
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 cursor-pointer"
          onClick={() =>
            tree.create({
              type: "leaf",
              parentId: node.id,
            })
          }
        >
          <PlusIcon width={16} height={16} className="text-gray-400" />
        </div>

        {node.id !== "ROOT" && (
          <div
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 cursor-pointer"
            onClick={() => tree.delete(node.id)}
          >
            <TrashIcon width={16} height={16} className="text-red-400" />
          </div>
        )}
      </div>
    </div>
  )
}
