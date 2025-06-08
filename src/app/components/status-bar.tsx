import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { clear } from "@/worker/actions"
import { Trash2, Users } from "lucide-react"
import { useConnection } from "./connection"
import { Button } from "./ui/button"

export const StatusBar = () => {
  const { connected, status, clients, clientId, worker } = useConnection()

  return (
    <div
      className={cn(
        "p-1 border-b border-border shadow-sm font-mono",
        "bg-gray-50/50 bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,rgba(148,163,184,0.05)_4px,rgba(148,163,184,0.05)_16px)]",
      )}
    >
      <div className="px-4 container max-w-7xl mx-auto gap-1 flex flex-col md:flex-row justify-between md:items-center">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "size-2 rounded-full transition-colors",
              connected ? "bg-green-500" : "bg-red-500",
            )}
            title={connected ? "Connected" : "Disconnected"}
          />
          <div className="text-sm font-semibold">
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>

        <div className="text-sm font-semibold">Status: {status}</div>

        <div className="text-sm font-semibold flex items-center gap-4">
          <TooltipProvider>
            <Tooltip delayDuration={0}>
              <TooltipTrigger>
                <div className="flex items-center gap-1">
                  <Users className="size-4" />
                  Clients: {clients.length}
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Connected clients:
                  {clients.map((client) => (
                    <span key={client} className="font-semibold">
                      <br />
                      {client} {client === clientId ? "(You)" : ""}
                    </span>
                  ))}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  className="py-0"
                  variant="ghost"
                  size="icon"
                  onClick={async () => {
                    await worker.waitForResult(clear())
                    window.location.reload()
                  }}
                >
                  <Trash2 className="size-4 text-red-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Clear local database</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </div>
  )
}
