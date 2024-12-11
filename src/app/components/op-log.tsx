import { useOpLog } from "@/lib/use-op-log"
import { cn } from "@/lib/utils"
import { ArrowRight, Plus, RotateCcw, Trash2 } from "lucide-react"
import { useConnection } from "./connection"

export function OpLog({ className }: { className?: string }) {
  const { clientId } = useConnection()
  const moves = useOpLog()

  if (!moves)
    return (
      <div
        className={cn(
          "bg-card border border-border rounded-lg p-2 shadow-sm flex justify-center items-center",
          className
        )}
      >
        Loading...
      </div>
    )

  return (
    <div
      className={cn(
        "bg-card border border-border rounded-lg shadow-sm overflow-y-auto h-full",
        className
      )}
    >
      {moves.length === 0 && (
        <div className="p-2 text-sm text-muted-foreground text-center">
          No operations
        </div>
      )}

      {moves.map((move) => {
        const isCreation = move.old_parent_id === null
        const isDeletion = move.new_parent_id === "TOMBSTONE"

        return (
          <div
            className={cn(
              "border-b border-border p-2 text-sm font-mono flex items-center gap-2",
              move.client_id === clientId &&
                "bg-blue-50/50 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(59,130,246,0.05)_2px,rgba(59,130,246,0.05)_8px)]",
              move.client_id !== clientId &&
                "bg-red-50/50 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(239,68,68,0.05)_2px,rgba(239,68,68,0.05)_8px)]",
              move.client_id === "server" &&
                "bg-yellow-50/50 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(253,224,71,0.05)_2px,rgba(253,224,71,0.05)_8px)]"
            )}
            key={`${move.node_id}-${move.timestamp}`}
          >
            {isCreation && <Plus className="w-4 h-4 text-green-500" />}
            {isDeletion && <Trash2 className="w-4 h-4 text-red-500" />}
            {!isCreation && !isDeletion && (
              <ArrowRight className="w-4 h-4 text-blue-500" />
            )}
            <span className="font-semibold">{move.node_id}:</span>{" "}
            <span className="text-muted-foreground">
              {move.old_parent_id ?? "NULL"} → {move.new_parent_id ?? "NULL"}
            </span>
            {move.client_id === "server" ? (
              <div className="ml-2 text-yellow-500 flex items-center gap-1">
                <RotateCcw className="w-4 h-4" /> Restored
              </div>
            ) : null}
            <div className="flex-1" />
            <span className="text-muted-foreground">
              {move.client_id !== clientId ? null : move.sync_timestamp ? (
                <span className="text-green-500">✓</span>
              ) : (
                <span className="text-yellow-500">●</span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
