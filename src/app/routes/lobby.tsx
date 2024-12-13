import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useNavigate } from "react-router-dom"

export const Lobby = () => {
  const navigate = useNavigate()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const formData = new FormData(e.currentTarget as HTMLFormElement)
    const roomIdFromForm = formData.get("roomId")?.toString() || ""

    if (roomIdFromForm.trim()) {
      navigate(`/${roomIdFromForm.trim()}`)
    } else {
      alert("Please enter a room ID")
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <form onSubmit={handleSubmit} className="p-6 max-w-md w-full">
        <h1 className="text-2xl font-bold mb-4">Join a Room</h1>
        <div className="flex gap-2">
          <Input
            name="roomId"
            type="text"
            placeholder="Enter room ID"
            required
            pattern="[a-z0-9-]{2,}"
          />
          <Button type="submit">Join</Button>
        </div>
      </form>
    </div>
  )
}
