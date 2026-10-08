"use client"

// #215: a collected edition you own reads like any issue. The Collected Editions shelf only selected
// a card (the reader was reachable only through the sidebar's Read Selected), so owned books get the
// downloaded issues' Read/Resume button and read/progress badge. Same rules as the series page's
// issue cards: finished = marked read or at 100%; Resume part-way through.
import Link from "next/link"
import { Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

type ReadState = { fullPath: string; isRead?: boolean; readProgress?: number }

const progressOf = (book: ReadState) => book.readProgress || 0
const isFinished = (book: ReadState) => !!book.isRead || progressOf(book) >= 100

/** Opens the book in the reader, with its series as context. Never selects the card behind it. */
export function CollectedReadButton({ book, seriesFolder }: { book: ReadState; seriesFolder: string }) {
  const label = progressOf(book) > 0 && !isFinished(book) ? "Resume" : "Read"
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 px-3 text-[10px] font-black uppercase tracking-wider shrink-0"
      asChild
      onClick={(e) => e.stopPropagation()}
    >
      <Link href={`/reader?path=${encodeURIComponent(book.fullPath)}&series=${encodeURIComponent(seriesFolder || "")}`}>
        {label}
      </Link>
    </Button>
  )
}

/** The read check or the percentage (with a progress bar) over the book's cover; nothing when unread. */
export function CollectedProgressBadge({ book }: { book: ReadState }) {
  if (isFinished(book)) {
    return (
      <div className="absolute top-0.5 right-0.5 z-10">
        <Badge aria-label="Read" className="bg-green-600 border-0 text-[9px] px-0.5 h-3.5"><Check className="w-2.5 h-2.5" /></Badge>
      </div>
    )
  }
  const progress = progressOf(book)
  if (progress <= 0) return null
  return (
    <>
      <div className="absolute top-0.5 right-0.5 z-10">
        <Badge className="bg-primary border-0 text-primary-foreground text-[9px] px-0.5 h-3.5">{Math.round(progress)}%</Badge>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50"><div className="h-full bg-primary" style={{ width: `${progress}%` }} /></div>
    </>
  )
}
