import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { useState } from "react"
import { useNavigate } from "react-router-dom"

export const Lobby = () => {
  const navigate = useNavigate()
  const [live, setLive] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const formData = new FormData(e.currentTarget as HTMLFormElement)
    const roomIdFromForm = formData.get("roomId")?.toString() || ""

    if (roomIdFromForm.trim()) {
      navigate(`/${roomIdFromForm.trim()}${live ? "?live" : ""}`)
    } else {
      alert("Please enter a room ID")
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <form onSubmit={handleSubmit} className="p-6 max-w-md w-full">
        <h1 className="text-2xl font-bold mb-4">Join a Room</h1>
        <div className="flex gap-2 mb-2">
          <Input
            name="roomId"
            type="text"
            placeholder="Enter room ID"
            required
            pattern="[a-z0-9_]{2,}"
          />
          <Button type="submit">Join</Button>
        </div>
        <div className="flex gap-2 items-center">
          <Switch
            checked={live}
            onCheckedChange={(checked) => setLive(checked)}
            id="live"
          />
          <label htmlFor="live" className="font-semibold">
            Live
          </label>
        </div>
      </form>
    </div>
  )
}
