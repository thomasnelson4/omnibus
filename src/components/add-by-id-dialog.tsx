"use client"

import { useRef, useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"

type Provider = "COMICVINE" | "METRON"

interface SeriesDetails {
  id: number
  name: string
  year?: string
  publisher?: string
  image?: string
  description?: string
  count?: number | string
}

export function AddByIdDialog({ onAdded }: { onAdded: () => void }) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState<Provider>("COMICVINE")
  const [metadataId, setMetadataId] = useState("")
  const [details, setDetails] = useState<SeriesDetails | null>(null)
  const [requestExisting, setRequestExisting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const lookupVersion = useRef(0)
  const savingRef = useRef(false)

  const changeOpen = (nextOpen: boolean) => {
    if (savingRef.current) return
    lookupVersion.current += 1
    setOpen(nextOpen)
    setMetadataId("")
    setDetails(null)
    setRequestExisting(false)
    setError("")
    setLoading(false)
  }

  const lookup = async (event: React.FormEvent) => {
    event.preventDefault()
    const version = ++lookupVersion.current
    setDetails(null)
    setError("")
    // ComicVine also displays volume IDs with the 4050 resource prefix.
    const rawId = metadataId.trim()
    const id = provider === "COMICVINE" ? rawId.replace(/^4050-/, "") : rawId
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
      setError("Enter a positive numeric series ID from the selected provider.")
      return
    }

    setLoading(true)
    try {
      const params = new URLSearchParams({ id: String(Number(id)), type: "volume", provider })
      const res = await fetch(`/api/issue-details?${params}`)
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || "Could not look up that ID.")
      if (Number(data.id) !== Number(id) || !data.name || data.name === "Unknown") {
        throw new Error("No series found for that ID. Check the provider and series ID.")
      }
      if (version === lookupVersion.current) setDetails(data)
    } catch (err) {
      if (version === lookupVersion.current) {
        setError(err instanceof Error ? err.message : "Could not look up that ID. Try again.")
      }
    } finally {
      if (version === lookupVersion.current) setLoading(false)
    }
  }

  const addToLibrary = async () => {
    if (!details || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError("")
    try {
      const res = await fetch("/api/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cvId: details.id,
          metadataSource: provider,
          type: "volume",
          name: details.name,
          year: details.year === "????" ? undefined : details.year,
          publisher: details.publisher || "Unknown",
          image: details.image,
          description: details.description,
          monitored: true,
          monitorOnly: !requestExisting,
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || "Could not add this series.")
      toast({
        title: "Added to Library",
        description: requestExisting ? data.message : `${details.name} added. Future issues will be monitored.`,
      })
      savingRef.current = false
      changeOpen(false)
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add this series. Try again.")
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-10 sm:h-9 border-border">
          <Plus className="w-4 h-4 mr-2" /> Add by ID
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Add series or book by ID</DialogTitle>
          <DialogDescription>
            Enter a ComicVine volume ID or Metron series ID, including collected editions.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={lookup} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="add-id-provider">Metadata provider</Label>
            <Select value={provider} disabled={loading || saving} onValueChange={(value: Provider) => {
              setProvider(value)
              setDetails(null)
              setError("")
            }}>
              <SelectTrigger id="add-id-provider" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="COMICVINE">ComicVine</SelectItem>
                <SelectItem value="METRON">Metron</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-metadata-id">{provider === "COMICVINE" ? "Volume ID" : "Series ID"}</Label>
            <Input id="add-metadata-id" value={metadataId} disabled={loading || saving}
              placeholder={provider === "COMICVINE" ? "e.g. 4050-12345 or 12345" : "e.g. 12345"}
              aria-describedby={error ? "add-id-error" : undefined}
              onChange={event => {
                setMetadataId(event.target.value)
                setDetails(null)
                setError("")
              }} />
          </div>
          <Button type="submit" variant="secondary" disabled={!metadataId.trim() || loading || saving} className="w-full">
            {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Look up ID
          </Button>
        </form>
        {error && <p id="add-id-error" role="alert" className="text-sm text-destructive">{error}</p>}
        {details && (
          <div className="space-y-4">
            <div className="rounded-md border p-3 space-y-1">
              <p className="font-semibold">{details.name}</p>
              <p className="text-sm text-muted-foreground">
                {details.year} · {details.publisher || "Unknown publisher"} · {details.count ?? "?"} issues
              </p>
            </div>
            <p className="text-sm text-muted-foreground">Adds this series to your library and monitors future issues.</p>
            <div className="flex items-center gap-2">
              <Switch id="add-id-request-existing" checked={requestExisting} onCheckedChange={setRequestExisting} disabled={saving} />
              <Label htmlFor="add-id-request-existing">Also request existing issues</Label>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => changeOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={addToLibrary} disabled={!details || loading || saving}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Add to Library
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
