import { Connection } from "@/components/connection"
import { IsomorphicTree } from "@/components/isomorphic-tree"
import { OpLog } from "@/components/op-log"
import { StatusBar } from "@/components/status-bar"
import { cn } from "@/lib/utils"
import { useParams, useSearchParams } from "react-router-dom"

export const Room = () => {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const live = searchParams.get("live") !== null

  return (
    <Connection key={params.roomId}>
      <StatusBar />
      <main className="container max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-5 gap-4 p-4 flex-1 min-h-0">
        <IsomorphicTree
          className={cn(
            "col-span-1 md:col-span-3 max-h-[500px] md:max-h-full min-h-0",
            live && "md:col-span-5"
          )}
        />
        <OpLog
          className={cn("col-span-1 md:col-span-2 min-h-0", live && "hidden")}
        />
      </main>
    </Connection>
  )
}
