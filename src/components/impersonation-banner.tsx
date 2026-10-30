"use client"

// The visible side of impersonation (found in the v1.4.7 permission sweep: nothing read
// session.user.isImpersonating, so an admin viewing as someone else had no sign of it on screen and
// no way back short of the cookie's hour running out). Shown on every page, above the header.
import { useState } from "react"
import { useSession } from "next-auth/react"
import { Eye, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import { nav } from "@/lib/session-expiry-client"

/** Ends the impersonation: the server drops the cookie, the session refresh reverts the token to the
 *  admin (the jwt callback runs on that request), and a full navigation lands back on Users. */
export function useStopImpersonating() {
  const { update } = useSession()
  const { toast } = useToast()
  const [stopping, setStopping] = useState(false)

  const stop = async () => {
    if (stopping) return
    setStopping(true)
    try {
      const res = await fetch('/api/impersonation/stop', { method: 'POST' })
      // 409 = the impersonation had already ended (the hour ran out): refresh and go back all the same.
      if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => null)
        toast({ variant: "destructive", title: "Couldn't stop impersonating", description: body?.error || `HTTP ${res.status}` })
        setStopping(false)
        return
      }
      await Promise.resolve(update()).catch(() => {})
      nav.go('/admin/users')
    } catch {
      toast({ variant: "destructive", title: "Couldn't stop impersonating", description: "The server could not be reached." })
      setStopping(false)
    }
  }

  return { stop, stopping }
}

export function ImpersonationBanner() {
  const { data: session } = useSession()
  const { stop, stopping } = useStopImpersonating()
  if (!(session?.user as { isImpersonating?: boolean } | undefined)?.isImpersonating) return null

  return (
    <div role="status" className="w-full border-b border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-100">
      <div className="container mx-auto flex items-center justify-between gap-3 px-4 sm:px-6 py-1.5 text-sm">
        <span className="flex items-center gap-2 min-w-0">
          <Eye className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="truncate">Viewing Omnibus as <strong className="font-bold">{session?.user?.name || 'another user'}</strong></span>
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={stop}
          disabled={stopping}
          className="h-8 shrink-0 border-amber-400 bg-background/80 text-foreground hover:bg-background font-bold dark:border-amber-700"
        >
          {stopping && <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />}
          Stop impersonating
        </Button>
      </div>
    </div>
  )
}
