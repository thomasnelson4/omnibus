"use client"

// src/components/setup-checklist.tsx
//
// The first-run checklist (replaces the static "Welcome to Omnibus!" banner, whose four steps assumed
// comics were already on disk and never knew what was done). Every step comes live from
// /api/setup-status with the action that completes it. On Home it shows an admin the steps until
// setup is complete or dismissed; on an empty Library it is the empty state, whatever the banner's
// state. Anyone else gets a one-line hint while their library is empty. Wording follows the README's
// "First Steps" section.
import { useEffect, useState, type ReactNode } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { useToast } from "@/components/ui/use-toast"
import { CheckCircle2, Circle, Loader2, Rocket, X } from "lucide-react"
import { getErrorMessage } from "@/lib/utils/error"

type StepId = 'library' | 'metadata' | 'comics' | 'match' | 'discover' | 'sources'
interface Step { id: StepId; required: boolean; done: boolean; detail?: string; count?: number }
interface AdminStatus { role: 'ADMIN'; dismissed: boolean; completed: boolean; libraryEmpty: boolean; steps: Step[] }
interface UserStatus { role: 'USER'; libraryEmpty: boolean; canRequest: boolean }
type Status = AdminStatus | UserStatus

type Variant = 'home' | 'library'
type JobId = 'library' | 'popular'

const JOB_TOASTS: Record<JobId, { title: string; description: string }> = {
  library: { title: "Scan queued", description: "New files show up in the Library; anything unidentified lands in the Smart Matcher." },
  popular: { title: "Discover sync started", description: "Popular Issues and New Releases fill in once it finishes." },
}

export function SetupChecklist({ variant, fallback = null }: { variant: Variant; fallback?: ReactNode }) {
  const { toast } = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [running, setRunning] = useState<JobId | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/setup-status', { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (alive) setStatus(data) })
      .catch(() => { /* the page still works without it */ })
      .finally(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [])

  if (!loaded) return null
  if (!status) return <>{fallback}</>

  if (status.role !== 'ADMIN') {
    if (!status.libraryEmpty) return <>{fallback}</>
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground space-y-1">
        <p className="font-bold text-foreground">Your library is empty.</p>
        {status.canRequest ? (
          <p>
            {variant === 'home' ? 'Search for a series below and request it' : 'Search for a series on Home and request it'}
            {' '}- it shows up in your Library once it&apos;s downloaded.
          </p>
        ) : (
          <p>Ask your admin to add comics, or to let you request them.</p>
        )}
      </div>
    )
  }

  const show = variant === 'library' ? status.libraryEmpty : !status.completed && !status.dismissed && !dismissed
  if (!show) return <>{fallback}</>

  const runJob = async (job: JobId) => {
    setRunning(job)
    try {
      // The queue's Redis client retries forever, so give up after 10s rather than spin (same as Home).
      const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined
      const res = await fetch('/api/admin/jobs/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job }),
        signal,
      })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
      toast(JOB_TOASTS[job])
    } catch (e: unknown) {
      toast({ title: "Couldn't start it", description: getErrorMessage(e), variant: "destructive" })
    } finally {
      setRunning(null)
    }
  }

  const dismiss = async () => {
    setDismissed(true)
    try {
      await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { hide_first_steps_banner: 'true' } }),
      })
    } catch { /* hidden for this visit either way */ }
  }

  const jobButton = (job: JobId, label: string) => (
    <Button size="sm" variant="outline" className="h-8 font-bold" disabled={running !== null} onClick={() => runJob(job)}>
      {running === job && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}{label}
    </Button>
  )
  const linkButton = (href: string, label: string) => (
    <Button asChild size="sm" variant="outline" className="h-8 font-bold"><Link href={href}>{label}</Link></Button>
  )

  const view = (s: Step): { title: string; help: string; actions?: ReactNode } | null => {
    switch (s.id) {
      case 'library': return {
        title: 'Add a library folder',
        help: s.detail || 'Where your comics live, as Omnibus sees it inside its container (e.g. /data/comics).',
        actions: linkButton('/admin/settings?tab=library', 'Open Library & Files'),
      }
      case 'metadata': return {
        title: 'Add a ComicVine key',
        help: 'Covers, summaries and issue lists come from ComicVine (or Metron).',
        actions: linkButton('/admin/settings?tab=metadata', 'Open Metadata settings'),
      }
      case 'comics': return {
        title: 'Add some comics',
        help: s.done
          ? `${s.count ?? 0} series in your library.`
          : variant === 'home'
            ? 'Copy comics into your library folder and scan it, or search below and request one.'
            : 'Copy comics into your library folder and scan it, or request one from Home.',
        actions: <>{jobButton('library', 'Scan library')}{variant === 'library' && linkButton('/', 'Request a comic')}</>,
      }
      case 'match':
        if (!s.count) return null
        return {
          title: `Match ${s.count} unidentified series`,
          help: "Series Omnibus couldn't identify on its own wait in the Smart Matcher.",
          actions: linkButton('/admin/smart-match', 'Open Smart Matcher'),
        }
      case 'discover': return {
        title: 'Fill the Discover rows',
        help: 'Popular Issues and New Releases on Home come from a Discover sync.',
        actions: jobButton('popular', 'Run Discover sync'),
      }
      case 'sources': return {
        title: 'Optional: add Prowlarr or a download client',
        help: 'Requests already work through GetComics; these add torrent and usenet sources.',
        actions: linkButton('/admin/settings?tab=search', 'Open Search & Indexers'),
      }
    }
  }

  const required = status.steps.filter(s => s.required)
  const doneCount = required.filter(s => s.done).length

  return (
    <div className="relative rounded-lg border border-indigo-200 bg-indigo-50 p-4 sm:p-5 shadow-sm dark:border-indigo-900/50 dark:bg-indigo-950/30">
      {variant === 'home' && (
        <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={dismiss}
          className="absolute top-2 right-2 h-6 w-6 text-indigo-500 hover:bg-indigo-100 dark:hover:bg-indigo-900/50">
          <X className="h-4 w-4" />
        </Button>
      )}
      <div className="flex items-center gap-2 text-indigo-900 dark:text-indigo-300">
        <Rocket className="h-5 w-5" />
        <h2 className="font-black text-lg">Set up Omnibus</h2>
      </div>
      <p className="mt-1 text-sm text-indigo-800/80 dark:text-indigo-400/80">{doneCount} of {required.length} required steps done</p>
      <ol className="mt-4 space-y-3">
        {status.steps.map(s => {
          const v = view(s)
          if (!v) return null
          return (
            <li key={s.id} data-step={s.id} data-done={String(s.done)}
              className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 rounded-md border border-indigo-100 bg-white/60 p-3 dark:border-indigo-900/30 dark:bg-black/20">
              <div className="flex items-start gap-2 flex-1 min-w-0">
                {s.done
                  ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" aria-label="Done" />
                  : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" aria-label="Not done yet" />}
                <div className="min-w-0">
                  <p className={`font-bold text-sm ${s.done ? 'text-muted-foreground' : 'text-indigo-900 dark:text-indigo-200'}`}>{v.title}</p>
                  <p className="text-xs text-muted-foreground break-words">{v.help}</p>
                </div>
              </div>
              {!s.done && v.actions && <div className="flex flex-wrap gap-2 shrink-0">{v.actions}</div>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
