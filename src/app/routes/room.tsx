import { Connection } from "@/components/connection"
import { StatusBar } from "@/components/status-bar"
import { useParams } from "react-router-dom"
import { OpLog } from "../components/op-log"
import { Tree } from "../components/tree"

export const Room = () => {
  const params = useParams()

  return (
    <Connection key={params.roomId}>
      <StatusBar />
      <main className="container max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-5 gap-4 p-4 flex-1 min-h-0">
        <Tree className="col-span-1 md:col-span-3 max-h-[500px] md:max-h-full min-h-0" />
        <OpLog className="col-span-1 md:col-span-2 min-h-0" />
      </main>
    </Connection>
  )
}
