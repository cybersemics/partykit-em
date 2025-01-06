import "./index.css"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import { Toaster } from "./components/ui/sonner"
import { Lobby } from "./routes/lobby"
import { Room } from "./routes/room"
import { useEffect } from "react"
import * as Timing from "./lib/timing"

function App() {
  useEffect(() => {
    Timing.registerStart()
  }, [])

  return (
    <div className="h-screen flex flex-col bg-slate-50/50">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Lobby />} />
          <Route path="/:roomId" element={<Room />} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </div>
  )
}

// biome-ignore lint/style/noNonNullAssertion: <explanation>
createRoot(document.getElementById("app")!).render(<App />)
