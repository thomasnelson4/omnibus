"use client"

// Fix match for ONE reading-list entry: point it at a ComicVine or Metron issue by searching a
// series and picking the issue, or by entering an issue ID/URL. Every path ends in a preview the
// SERVER resolves (GET /api/reading-lists/match — same owner-access rule and #194 identity guard as
// the save), so what the preview says is what Save does. Controlled (open/item from the page), so
// the page owns which row is being fixed and patches its own state from onMatched.
//
// Staleness is handled with version refs, not AbortController: every response checks the version
// it was issued under, so Back / Cancel / provider changes stay usable while a slow provider
// answers, and late answers are dropped. All GETs take the URL only (tests assert on it).

import { useEffect, useRef, useState } from "react"
import {
  Loader2, Search, Image as ImageIcon, ArrowLeft, ExternalLink, Check, TriangleAlert, Unlink, Link2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useToast } from "@/components/ui/use-toast"
import { coverSrc } from "@/lib/utils/cover-url"
import { isSameIssue, normalizeFractionNumbers } from "@/lib/utils/issue-parser"
import {
  isDownloaded, isMatchProvider, libraryCannotContradict, matchSearchPrefill, parseProviderIssueId,
  parseReadingListTitle, providerIssueUrl, providerLabel, readingListItemLabel,
  type MatchLookupResponse, type MatchProvider, type ProviderIssueSummary,
} from "@/lib/utils/reading-list-match"

export interface MatchDialogItem {
  id: string
  title: string
  cvIssueId: number | null
  metadataSource: string
  issueId: string | null
  issue?: {
    number: string
    name?: string | null
    isAnnual?: boolean | null
    filePath?: string | null
    metadataSource?: string | null
    metadataId?: string | null
    series?: { name: string; year?: number | null } | null
  } | null
}

export interface ReadingListItemMatchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  listId: string
  item: MatchDialogItem | null
  listItems?: MatchDialogItem[]
  resyncWarning?: string | null
  /** How long a search / issue list / lookup may be pending before the slow-provider notice. */
  slowNoticeMs?: number
  onMatched: (updatedItem: any, outcome: { linked: boolean; cleared: boolean }) => void
  onStale?: () => void
}

interface SeriesResult {
  id: number | string
  name: string
  year?: number | string | null
  publisher?: string | null
  count?: number | null
  image?: string | null
  metadataSource?: string | null
}

interface IssueResult {
  id: number | string
  name?: string | null
  issueNumber?: string | null
  year?: string | number | null
  image?: string | null
  metadataSource?: string | null
}

type ProviderFlags = Record<MatchProvider, boolean>
type IdError = { error: string; suggestProvider?: MatchProvider }

const issueSortKey = (n: unknown): number => {
  const v = parseFloat(normalizeFractionNumbers(String(n ?? "")))
  return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY
}

const otherProvider = (p: MatchProvider): MatchProvider => (p === "COMICVINE" ? "METRON" : "COMICVINE")

/** Save/clear errors that mean the page's copy of the list is out of date — refetch it. */
const STALE_CODES = new Set(["FORBIDDEN", "ITEM_NOT_FOUND"])

function Thumb({ src, className }: { src?: string | null; className: string }) {
  if (!src) {
    return (
      <div className={`${className} shrink-0 rounded bg-muted border border-border flex items-center justify-center`}>
        <ImageIcon className="w-4 h-4 text-muted-foreground" />
      </div>
    )
  }
  return <img src={coverSrc(src, 160)} loading="lazy" alt="" className={`${className} shrink-0 rounded object-cover bg-muted border border-border`} />
}

export function ReadingListItemMatchDialog({
  open, onOpenChange, listId, item, listItems, resyncWarning, slowNoticeMs = 10000, onMatched, onStale,
}: ReadingListItemMatchDialogProps) {
  const { toast } = useToast()

  // The page clears `item` when it closes the dialog; keep rendering the last one through the
  // close animation instead of flashing an empty dialog.
  const lastItemRef = useRef<MatchDialogItem | null>(item)
  if (item) lastItemRef.current = item
  const current = item ?? lastItemRef.current

  const [providers, setProviders] = useState<ProviderFlags | null>(null)
  const [provider, setProvider] = useState<MatchProvider>("COMICVINE")
  const [tab, setTab] = useState<"search" | "id">("search")

  // Search tab
  const [query, setQuery] = useState("")
  const [number, setNumber] = useState("")
  const [annualPrefill, setAnnualPrefill] = useState(false)
  const [seriesResults, setSeriesResults] = useState<SeriesResult[]>([])
  const [seriesPage, setSeriesPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState("")
  const [openedSeries, setOpenedSeries] = useState<SeriesResult | null>(null)
  const [issues, setIssues] = useState<IssueResult[] | null>(null)
  const [issuesLoading, setIssuesLoading] = useState(false)
  const [issuesError, setIssuesError] = useState("")
  const [showAllIssues, setShowAllIssues] = useState(false)

  // Enter ID tab
  const [idInput, setIdInput] = useState("")
  const [idError, setIdError] = useState<IdError | null>(null)

  // Preview
  const [selected, setSelected] = useState<{ provider: MatchProvider; id: number } | null>(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupError, setLookupError] = useState("")
  const [preview, setPreview] = useState<MatchLookupResponse | null>(null)
  const [keepLink, setKeepLink] = useState(false)
  const [currentMatch, setCurrentMatch] = useState<ProviderIssueSummary | null>(null)

  // Save / clear
  const [saving, setSaving] = useState<"save" | "clear" | null>(null)
  const [saveError, setSaveError] = useState("")
  const [confirmClear, setConfirmClear] = useState(false)
  const [slow, setSlow] = useState(false)

  const lookupVersion = useRef(0)
  const searchVersion = useRef(0)
  const issuesVersion = useRef(0)
  const currentVersion = useRef(0)
  const providersVersion = useRef(0)
  const savingRef = useRef(false)
  const providerTouched = useRef(false)
  const committedRef = useRef(false)
  const userTypedRef = useRef(false)
  const prefillNumberRef = useRef("")
  const providerRef = useRef<MatchProvider>("COMICVINE")
  const keepCancelRef = useRef<HTMLButtonElement | null>(null)

  const bumpVersions = () => {
    lookupVersion.current += 1
    searchVersion.current += 1
    issuesVersion.current += 1
    currentVersion.current += 1
    providersVersion.current += 1
  }

  const applyProvider = (next: MatchProvider) => {
    providerRef.current = next
    setProvider(next)
  }

  // Changing provider invalidates everything provider-specific (results, issue list, selection,
  // preview, errors) but keeps what the user typed. In-flight responses are dropped by version.
  const clearProviderState = () => {
    lookupVersion.current += 1
    searchVersion.current += 1
    issuesVersion.current += 1
    setSeriesResults([]); setSeriesPage(1); setHasMore(false); setSearched(false); setSearching(false); setSearchError("")
    setOpenedSeries(null); setIssues(null); setIssuesLoading(false); setIssuesError(""); setShowAllIssues(false)
    setSelected(null); setPreview(null); setLookupLoading(false); setLookupError(""); setIdError(null)
    setSaveError(""); setConfirmClear(false)
  }

  const changeProvider = (next: MatchProvider) => {
    if (next === providerRef.current) return
    clearProviderState()
    applyProvider(next)
  }

  // --- Reset on open / item change -----------------------------------------------------------
  useEffect(() => {
    bumpVersions()
    if (!open || !item) return
    committedRef.current = false
    providerTouched.current = false
    userTypedRef.current = false

    const prefill = matchSearchPrefill(item)
    prefillNumberRef.current = prefill.number
    const itemProvider: MatchProvider | null = item.cvIssueId && isMatchProvider(item.metadataSource)
      ? item.metadataSource
      : (isMatchProvider(item.issue?.metadataSource) ? item.issue!.metadataSource as MatchProvider : null)

    applyProvider(itemProvider ?? "COMICVINE")
    setProviders(null)
    setTab("search")
    setQuery(prefill.query); setNumber(prefill.number); setAnnualPrefill(prefill.annual)
    setSeriesResults([]); setSeriesPage(1); setHasMore(false); setSearched(false); setSearching(false); setSearchError("")
    setOpenedSeries(null); setIssues(null); setIssuesLoading(false); setIssuesError(""); setShowAllIssues(false)
    setIdInput(""); setIdError(null)
    setSelected(null); setLookupLoading(false); setLookupError(""); setPreview(null); setKeepLink(false); setCurrentMatch(null)
    setSaving(null); setSaveError(""); setConfirmClear(false); setSlow(false)
    savingRef.current = false

    void loadProviders(itemProvider)
    if (item.cvIssueId && isMatchProvider(item.metadataSource)) void loadCurrentMatch(item.metadataSource, item.cvIssueId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id])

  const loadProviders = async (itemProvider: MatchProvider | null) => {
    const version = ++providersVersion.current
    let flags: ProviderFlags = { COMICVINE: true, METRON: true }
    let primary: MatchProvider = "COMICVINE"
    try {
      const res = await fetch("/api/reading-lists/match/providers")
      if (res.ok) {
        const data = await res.json()
        if (data?.providers) flags = { COMICVINE: data.providers.COMICVINE === true, METRON: data.providers.METRON === true }
        if (isMatchProvider(data?.primary)) primary = data.primary
      }
    } catch { /* unknown → assume both work; a lookup reports the real error */ }
    if (version !== providersVersion.current) return
    setProviders(flags)
    if (providerTouched.current) return
    let chosen: MatchProvider = itemProvider ?? primary
    if (!flags[chosen] && flags[otherProvider(chosen)]) chosen = otherProvider(chosen)
    changeProvider(chosen)
  }

  const loadCurrentMatch = async (p: MatchProvider, id: number) => {
    const version = ++currentVersion.current
    try {
      const res = await fetch(`/api/reading-lists/match?${new URLSearchParams({ listId, provider: p, issueId: String(id) })}`)
      if (!res.ok) return
      const data = await res.json()
      if (version !== currentVersion.current || !data?.match) return
      const m: ProviderIssueSummary = data.match
      setCurrentMatch(m)
      // Auto-built CV entries are titled with story names ("Days of Future Past"), so the title
      // gives no series/number — the current match does.
      if (!prefillNumberRef.current && !userTypedRef.current && m.seriesName) {
        setQuery(m.seriesStartYear ? `${m.seriesName} (${m.seriesStartYear})` : m.seriesName)
        setNumber(m.issueNumber || "")
      }
    } catch { /* informational only */ }
  }

  // --- Slow-provider notice -------------------------------------------------------------------
  const busy = searching || issuesLoading || lookupLoading
  useEffect(() => {
    if (!busy) { setSlow(false); return }
    const t = setTimeout(() => setSlow(true), slowNoticeMs)
    return () => clearTimeout(t)
  }, [busy, slowNoticeMs])

  // --- Search ---------------------------------------------------------------------------------
  const runSearch = async (page: number) => {
    const q = query.trim()
    if (q.length < 2) return
    const p = providerRef.current
    const version = ++searchVersion.current
    if (page === 1) {
      issuesVersion.current += 1
      setSeriesResults([]); setHasMore(false); setSearched(false)
      setOpenedSeries(null); setIssues(null); setIssuesLoading(false); setIssuesError("")
    }
    setSearching(true); setSearchError("")
    try {
      const res = await fetch(`/api/search?${new URLSearchParams({ q, provider: p, page: String(page) })}`)
      const data = await res.json().catch(() => ({}))
      if (version !== searchVersion.current) return
      if (!res.ok) { setSearchError(data?.error || "Search failed — try again."); return }
      const results: SeriesResult[] = Array.isArray(data?.results) ? data.results : []
      setSeriesResults(prev => {
        const merged = page === 1 ? results : [...prev, ...results]
        const seen = new Set<string>()
        return merged.filter(r => {
          const key = `${r.metadataSource}-${r.id}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      })
      setHasMore(!!data?.hasMore)
      setSeriesPage(page)
      setSearched(true)
    } catch {
      if (version === searchVersion.current) setSearchError("Search failed — try again.")
    } finally {
      if (version === searchVersion.current) setSearching(false)
    }
  }

  const openSeries = async (r: SeriesResult) => {
    const seriesProvider: MatchProvider = isMatchProvider(r.metadataSource) ? r.metadataSource : providerRef.current
    const version = ++issuesVersion.current
    setOpenedSeries(r); setIssues(null); setIssuesError(""); setIssuesLoading(true); setShowAllIssues(false)
    try {
      const res = await fetch(`/api/series-issues?${new URLSearchParams({ volumeId: String(r.id), provider: seriesProvider })}`)
      const data = await res.json().catch(() => ({}))
      if (version !== issuesVersion.current) return
      if (!res.ok) {
        setIssues([])
        setIssuesError(data?.error || `Couldn't load issues from ${providerLabel(seriesProvider)} — try again.`)
        return
      }
      const list: IssueResult[] = (Array.isArray(data?.results) ? data.results : [])
        .slice()
        .sort((a: IssueResult, b: IssueResult) => issueSortKey(a.issueNumber) - issueSortKey(b.issueNumber))
      setIssues(list)
      const wanted = number.trim()
      if (wanted) {
        const exact = list.filter(i => isSameIssue(String(i.issueNumber ?? ""), wanted))
        // An annual entry shouldn't silently pick #N from the main run.
        if (exact.length === 1 && !(annualPrefill && !/annual/i.test(r.name || ""))) {
          const only = exact[0]
          void selectIssue(isMatchProvider(only.metadataSource) ? only.metadataSource : seriesProvider, Number(only.id))
        }
      }
    } catch {
      if (version === issuesVersion.current) {
        setIssues([])
        setIssuesError(`Couldn't load issues from ${providerLabel(seriesProvider)} — try again.`)
      }
    } finally {
      if (version === issuesVersion.current) setIssuesLoading(false)
    }
  }

  const backToSeries = () => {
    issuesVersion.current += 1
    setOpenedSeries(null); setIssues(null); setIssuesLoading(false); setIssuesError(""); setShowAllIssues(false)
  }

  // --- Preview --------------------------------------------------------------------------------
  // itemId is sent so the SERVER can say whether the current link can survive keepLocalLink: that
  // depends on the list OWNER's library access (an ADMIN editing a restricted owner's entry), which
  // the client cannot know. Without the answer the client would promise "stays linked" and the save
  // would unlink.
  const selectIssue = async (p: MatchProvider, id: number) => {
    if (!Number.isSafeInteger(id) || id <= 0) return
    const version = ++lookupVersion.current
    setSelected({ provider: p, id }); setPreview(null); setLookupError(""); setLookupLoading(true)
    setSaveError(""); setConfirmClear(false)
    try {
      const res = await fetch(`/api/reading-lists/match?${new URLSearchParams({
        listId, itemId: current?.id ?? "", provider: p, issueId: String(id),
      })}`)
      const data = await res.json().catch(() => ({}))
      if (version !== lookupVersion.current) return
      if (!res.ok || !data?.match) {
        setLookupError(data?.error || `Couldn't look up ${providerLabel(p)} issue #${id} — try again.`)
        return
      }
      const lookup = data as MatchLookupResponse
      setPreview(lookup)
      const it = current
      setKeepLink(!!it?.issue && isSameIssue(String(it.issue.number ?? ""), lookup.match.issueNumber))
    } catch {
      if (version === lookupVersion.current) setLookupError(`Couldn't look up ${providerLabel(p)} issue #${id} — try again.`)
    } finally {
      if (version === lookupVersion.current) setLookupLoading(false)
    }
  }

  const submitIdFor = (p: MatchProvider) => {
    const parsed = parseProviderIssueId(p, idInput)
    if (!parsed.ok) {
      lookupVersion.current += 1
      setSelected(null); setPreview(null); setLookupLoading(false); setLookupError("")
      setIdError({ error: parsed.error, suggestProvider: parsed.suggestProvider })
      return
    }
    setIdError(null)
    void selectIssue(p, parsed.id)
  }

  const submitId = (e: React.FormEvent) => {
    e.preventDefault()
    submitIdFor(providerRef.current)
  }

  const switchProviderAndRetry = (next: MatchProvider) => {
    providerTouched.current = true
    changeProvider(next)
    submitIdFor(next)
  }

  // --- Save / clear ---------------------------------------------------------------------------
  const handleOpenChange = (next: boolean) => {
    if (savingRef.current) return
    bumpVersions()
    onOpenChange(next)
  }

  const finishCommit = () => {
    committedRef.current = true
    savingRef.current = false
    handleOpenChange(false)
  }

  const save = async () => {
    if (!current || !preview || savingRef.current) return
    savingRef.current = true
    setSaving("save"); setSaveError("")
    const match = preview.match
    // Same predicate the preview block uses — server `keepable` gates it, so an entry whose link
    // can't survive (outside the owner's libraries) never sends keepLocalLink at all.
    const keepVisible = !preview.local && preview.keepable === true && !!current.issue
      && libraryCannotContradict(current.issue, match.provider)
    try {
      const res = await fetch("/api/reading-lists/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listId, itemId: current.id, action: "rematch", provider: match.provider, providerIssueId: match.issueId,
          ...(keepVisible ? { keepLocalLink: keepLink } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.success) {
        setSaveError(data?.error || "Couldn't save the match — try again.")
        if (STALE_CODES.has(data?.code)) onStale?.()
        return
      }
      const title = data.match?.displayTitle || match.displayTitle
      const description = data.link === "matched"
        ? (data.hasFile ? `${title} — linked to your library copy.` : `${title} — linked to the wanted issue (not downloaded yet). Use Request to get it.`)
        : data.link === "kept"
          ? `${title} — still linked to your file.`
          : `${title} — not in the library yet. Use Request to get it.`
      toast({ title: "Match updated", description })
      onMatched(data.item, { linked: !!data.item?.issueId, cleared: false })
      finishCommit()
    } catch {
      setSaveError("Couldn't save the match — try again.")
    } finally {
      savingRef.current = false
      setSaving(null)
    }
  }

  const clear = async () => {
    if (!current || savingRef.current) return
    savingRef.current = true
    setSaving("clear"); setSaveError("")
    try {
      const res = await fetch("/api/reading-lists/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId, itemId: current.id, action: "clear" }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.success) {
        setConfirmClear(false)
        setSaveError(data?.error || "Couldn't clear the match — try again.")
        if (STALE_CODES.has(data?.code)) onStale?.()
        return
      }
      const idPart = current.cvIssueId ? `${providerLabel(current.metadataSource)} #${current.cvIssueId}` : ""
      const description = current.issueId
        ? `Was linked to “${readingListItemLabel(current)}”${idPart ? ` (${idPart})` : ""}.`
        : `Was ${idPart}.`
      toast({ title: "Match cleared", description })
      onMatched(data.item, { linked: false, cleared: true })
      finishCommit()
    } catch {
      setConfirmClear(false)
      setSaveError("Couldn't clear the match — try again.")
    } finally {
      savingRef.current = false
      setSaving(null)
    }
  }

  const requestClear = () => {
    if (!current) return
    if (current.issueId) setConfirmClear(true)
    else void clear()
  }

  // The confirmation REPLACES the footer, so focus would drop to <body>. Park it on the safe
  // choice ("Keep") rather than auto-focusing the destructive Unlink button.
  useEffect(() => {
    if (confirmClear) keepCancelRef.current?.focus()
  }, [confirmClear])

  // --- Derived view state ---------------------------------------------------------------------
  const noProviders = !!providers && !providers.COMICVINE && !providers.METRON
  const providerName = providerLabel(provider)
  const isSaving = saving !== null

  if (!current) {
    return <Dialog open={false} onOpenChange={handleOpenChange} />
  }

  const linked = !!current.issue && !!current.issue.series
  const currentLabel = readingListItemLabel(current)
  const match = preview?.match ?? null
  const local = preview?.local ?? null
  // Authoritative: the preview's `keepable` is the exact predicate PATCH applies.
  const keepVisible = !!match && !local && preview?.keepable === true && !!current.issue
    && libraryCannotContradict(current.issue, match.provider)
  const contradicts = !!match && !!current.issue && !libraryCannotContradict(current.issue, match.provider)
    && current.issue.metadataId !== String(match.issueId)

  const expectedNumber = current.issue?.number ?? parseReadingListTitle(current.title).number
  const numberMismatch = !!match && !!expectedNumber && !isSameIssue(String(expectedNumber), match.issueNumber)
  const annualMismatch = !!match && !!current.issue?.isAnnual && !/annual/i.test(match.seriesName ?? "")
  const duplicateIndex = match
    ? (listItems ?? []).findIndex(other => other.id !== current.id && (
      (other.cvIssueId === match.issueId && other.metadataSource === match.provider)
      || (!!local && other.issueId === local.issueId)))
    : -1

  const wantedNumber = number.trim()
  const exactIssues = issues && wantedNumber ? issues.filter(i => isSameIssue(String(i.issueNumber ?? ""), wantedNumber)) : []
  const visibleIssues = issues
    ? (wantedNumber && exactIssues.length > 0 && !showAllIssues ? exactIssues : issues)
    : []
  const canSave = !!preview && !lookupLoading && !lookupError && !isSaving
  const showClear = !!(current.cvIssueId || current.issueId)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!isSaving}
        onCloseAutoFocus={e => { if (committedRef.current) e.preventDefault() }}
        className="sm:max-w-2xl max-h-[90vh] flex flex-col bg-background border-border rounded-xl w-[95%]"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Link2 className="w-5 h-5 text-primary" /> Fix match</DialogTitle>
          <DialogDescription>Point this entry at the right ComicVine or Metron issue.</DialogDescription>
          <div className="text-xs text-muted-foreground space-y-0.5 text-left">
            {linked && (
              <p>Linked to: <span className="font-semibold text-foreground">{currentLabel}</span>{!isDownloaded(current) && " · not downloaded"}</p>
            )}
            {!!current.cvIssueId && isMatchProvider(current.metadataSource) && (
              <p>
                Matched to:{" "}
                <a href={providerIssueUrl(current.metadataSource, current.cvIssueId)} target="_blank" rel="noopener noreferrer" className="font-mono text-primary hover:underline">
                  {providerLabel(current.metadataSource)} #{current.cvIssueId}
                </a>
                {currentMatch && ` — ${currentMatch.displayTitle}${currentMatch.coverDate ? ` (${currentMatch.coverDate.slice(0, 7)})` : ""}`}
              </p>
            )}
            {!linked && !current.cvIssueId && <p>Unmatched entry: “{current.title}”</p>}
          </div>
          {resyncWarning && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400 text-left">
              <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {resyncWarning}
            </p>
          )}
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
          <div className="space-y-2">
            <Label htmlFor="rl-match-provider">Metadata provider</Label>
            <Select value={provider} disabled={isSaving} onValueChange={(value: string) => {
              if (!isMatchProvider(value)) return
              providerTouched.current = true
              changeProvider(value)
            }}>
              <SelectTrigger id="rl-match-provider" className="w-full sm:w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="COMICVINE" disabled={!!providers && !providers.COMICVINE}>
                  {providers && !providers.COMICVINE ? "ComicVine (not configured)" : "ComicVine"}
                </SelectItem>
                <SelectItem value="METRON" disabled={!!providers && !providers.METRON}>
                  {providers && !providers.METRON ? "Metron (not configured)" : "Metron"}
                </SelectItem>
              </SelectContent>
            </Select>
            {noProviders && (
              <p role="status" className="text-sm text-muted-foreground">
                No metadata provider is configured on this server. An admin can add a ComicVine API key or Metron login in Settings → Metadata.
              </p>
            )}
          </div>

          <Tabs value={tab} onValueChange={v => setTab(v === "id" ? "id" : "search")}>
            <TabsList>
              <TabsTrigger value="search">Search</TabsTrigger>
              <TabsTrigger value="id">Enter ID</TabsTrigger>
            </TabsList>

            <TabsContent value="search" className="space-y-3 pt-2">
              <form onSubmit={e => { e.preventDefault(); void runSearch(1) }} className="flex flex-col sm:flex-row sm:items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="rl-match-query">Series</Label>
                  <Input id="rl-match-query" value={query} disabled={isSaving}
                    onChange={e => { userTypedRef.current = true; setQuery(e.target.value) }} />
                </div>
                <div className="w-full sm:w-24 space-y-1.5">
                  <Label htmlFor="rl-match-number">Issue #</Label>
                  <Input id="rl-match-number" value={number} disabled={isSaving}
                    onChange={e => { userTypedRef.current = true; setNumber(e.target.value) }} />
                </div>
                <Button type="submit" variant="secondary" disabled={query.trim().length < 2 || searching || noProviders || isSaving}>
                  {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Search
                </Button>
              </form>

              {searchError && <p role="alert" className="text-sm text-destructive">{searchError}</p>}

              {openedSeries ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={backToSeries}>
                      <ArrowLeft className="w-4 h-4" /> All series
                    </Button>
                    <span className="text-sm font-semibold truncate">
                      {openedSeries.name}{openedSeries.year ? ` (${openedSeries.year})` : ""}
                    </span>
                  </div>
                  {issuesLoading && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading issues…</p>
                  )}
                  {!issuesLoading && issues && issues.length === 0 && (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">
                        {issuesError || `No issues came back from ${providerLabel(isMatchProvider(openedSeries.metadataSource) ? openedSeries.metadataSource : provider)}. It may be busy or rate-limiting — Retry, or use Enter ID.`}
                      </p>
                      <Button type="button" variant="outline" size="sm" onClick={() => void openSeries(openedSeries)}>Retry</Button>
                    </div>
                  )}
                  {!issuesLoading && issues && issues.length > 0 && (
                    <>
                      {wantedNumber && exactIssues.length === 0 && (
                        <p className="text-sm text-muted-foreground">No #{wantedNumber} in this series — pick another issue or series.</p>
                      )}
                      {wantedNumber && exactIssues.length > 0 && exactIssues.length < issues.length && (
                        <Button type="button" variant="link" size="sm" className="px-0" onClick={() => setShowAllIssues(s => !s)}>
                          {showAllIssues ? `Show only #${wantedNumber}` : `Show all ${issues.length} issues`}
                        </Button>
                      )}
                      <ul className="space-y-1.5">
                        {visibleIssues.map(i => {
                          const p: MatchProvider = isMatchProvider(i.metadataSource) ? i.metadataSource : (isMatchProvider(openedSeries.metadataSource) ? openedSeries.metadataSource : provider)
                          const isSelected = !!selected && selected.provider === p && selected.id === Number(i.id)
                          return (
                            <li key={`${p}-${i.id}`}>
                              <button type="button" aria-pressed={isSelected} aria-label={`Choose issue #${i.issueNumber ?? "?"}`}
                                disabled={isSaving}
                                onClick={() => void selectIssue(p, Number(i.id))}
                                className={`w-full flex items-center gap-3 p-2 rounded-lg border text-left transition-colors ${isSelected ? "bg-primary/10 border-primary/40" : "border-border hover:bg-muted/60"}`}>
                                <Thumb src={i.image} className="w-8 h-11" />
                                <span className="font-mono text-sm font-bold shrink-0">#{i.issueNumber ?? "?"}</span>
                                <span className="flex-1 min-w-0 text-sm truncate">{i.name}</span>
                                {i.year && <span className="text-xs text-muted-foreground shrink-0">{i.year}</span>}
                                {isSelected && <Check className="w-4 h-4 text-primary shrink-0" />}
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {searched && !searching && !searchError && seriesResults.length === 0 && (
                    <p className="text-sm text-muted-foreground">No series found on {providerName}. Try a shorter name or switch provider.</p>
                  )}
                  {seriesResults.length > 0 && (
                    <ul className="space-y-1.5">
                      {seriesResults.map(r => (
                        <li key={`${r.metadataSource}-${r.id}`}>
                          <button type="button" aria-label={`Choose series ${r.name}${r.year ? ` (${r.year})` : ""}`}
                            disabled={isSaving}
                            onClick={() => void openSeries(r)}
                            className="w-full flex items-center gap-3 p-2 rounded-lg border border-border text-left hover:bg-muted/60 transition-colors">
                            <Thumb src={r.image} className="w-8 h-11" />
                            <span className="flex-1 min-w-0">
                              <span className="block text-sm font-bold truncate">{r.name}</span>
                              <span className="block text-xs text-muted-foreground truncate">
                                {[r.publisher, r.year, r.count != null ? `${r.count} issues` : null].filter(Boolean).join(" • ")}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {hasMore && seriesResults.length > 0 && (
                    <Button type="button" variant="outline" size="sm" disabled={searching} onClick={() => void runSearch(seriesPage + 1)}>
                      {searching && <Loader2 className="w-4 h-4 animate-spin" />} Load more
                    </Button>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="id" className="space-y-3 pt-2">
              <form onSubmit={submitId} className="space-y-2">
                <Label htmlFor="rl-match-issue-id">{provider === "METRON" ? "Metron issue ID" : "ComicVine issue ID"}</Label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input id="rl-match-issue-id" value={idInput} disabled={isSaving}
                    placeholder={provider === "METRON" ? "e.g. 123456" : "e.g. 4000-123456, 123456 or a ComicVine issue URL"}
                    aria-describedby={idError ? "rl-match-id-error" : "rl-match-id-help"}
                    onChange={e => {
                      setIdInput(e.target.value)
                      lookupVersion.current += 1
                      setIdError(null); setSelected(null); setPreview(null); setLookupLoading(false); setLookupError("")
                    }} />
                  <Button type="submit" variant="secondary" disabled={!idInput.trim() || lookupLoading || noProviders || isSaving}>
                    {lookupLoading && <Loader2 className="w-4 h-4 animate-spin" />} Look up
                  </Button>
                </div>
                <p id="rl-match-id-help" className="text-xs text-muted-foreground">
                  {provider === "METRON"
                    ? "The numeric Metron issue ID. Metron's web links use name slugs, so the Search tab is usually easier."
                    : "Paste an issue page URL (…/4000-123456/) or the number."}
                </p>
                <p className="text-xs text-muted-foreground">
                  Find IDs on{" "}
                  <a href="https://comicvine.gamespot.com/issues/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">ComicVine ↗</a>
                  {" "}or{" "}
                  <a href="https://metron.cloud/issue/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Metron ↗</a>
                  , or use the Search tab.
                </p>
              </form>
              {idError && (
                <div className="space-y-2">
                  <p id="rl-match-id-error" role="alert" className="text-sm text-destructive">{idError.error}</p>
                  {idError.suggestProvider && (!providers || providers[idError.suggestProvider]) && (
                    <Button type="button" variant="outline" size="sm" onClick={() => switchProviderAndRetry(idError.suggestProvider!)}>
                      Switch to {providerLabel(idError.suggestProvider)}
                    </Button>
                  )}
                </div>
              )}
            </TabsContent>
          </Tabs>

          <div aria-live="polite" className="space-y-3">
            {slow && busy && (
              <p role="status" className="text-xs text-muted-foreground">
                {providerName} is taking a while (it may be rate-limiting). Keep waiting, go back, or use Enter ID.
              </p>
            )}
            {lookupLoading && selected && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Looking up {providerLabel(selected.provider)} issue #{selected.id}…
              </p>
            )}
            {lookupError && <p role="alert" className="text-sm text-destructive">{lookupError}</p>}

            {match && !lookupLoading && (
              <div className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex gap-3">
                  <Thumb src={match.image} className="w-12 h-[72px]" />
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-bold text-sm break-words">{match.displayTitle}</p>
                    <p className="text-xs text-muted-foreground">
                      {match.seriesName || "Unknown series"}
                      {match.seriesStartYear ? ` · started ${match.seriesStartYear}` : ""}
                      {match.publisher ? ` · ${match.publisher}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Issue #{match.issueNumber || "?"}
                      {match.coverDate ? ` · cover date ${match.coverDate}` : ""}
                      {match.issueTitle ? ` · “${match.issueTitle}”` : ""}
                    </p>
                    <a href={match.siteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      View on {providerLabel(match.provider)} <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>

                {local?.hasFile ? (
                  <p className="text-sm text-green-600 dark:text-green-400">In the library — this entry will link to {local.seriesName} #{local.number}.</p>
                ) : local ? (
                  <p className="text-sm text-muted-foreground">In the library as a wanted issue (not downloaded yet) — this entry will link to it; use Request afterwards to download it.</p>
                ) : keepVisible && keepLink ? (
                  <p className="text-sm text-muted-foreground">This entry stays linked to “{currentLabel}”.</p>
                ) : current.issueId ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    Saving unlinks this entry from “{currentLabel}”.
                    {contradicts && ` Your library has that copy matched to a different ${providerLabel(match.provider)} issue.`}
                  </p>
                ) : (
                  <p className="text-sm text-orange-600 dark:text-orange-400">Not in the library — the entry stays missing; use Request after saving.</p>
                )}

                {keepVisible && current.issue && (
                  <div className="space-y-1">
                    <div className="flex items-start gap-3">
                      <Switch id="rl-match-keep-link" checked={keepLink} onCheckedChange={setKeepLink} disabled={isSaving} className="mt-0.5" />
                      <div className="grid gap-0.5">
                        <Label htmlFor="rl-match-keep-link" className="cursor-pointer leading-snug">
                          Keep linking this entry to your library file “{currentLabel}”.
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {`Your library hasn't matched that file to this ${providerLabel(match.provider)} issue, so it can't confirm or rule out this match.`}
                        </p>
                      </div>
                    </div>
                    {(current.issue.metadataId ?? "").startsWith("unmatched_") && (
                      <p className="text-xs text-muted-foreground">
                        This file is still unmatched in your library. If it is later linked from its series page, this entry will be removed.
                      </p>
                    )}
                  </div>
                )}

                {(numberMismatch || annualMismatch || duplicateIndex >= 0 || preview?.mislabeled) && (
                  <ul className="space-y-1 text-xs text-amber-600 dark:text-amber-400">
                    {numberMismatch && <li className="flex gap-1.5"><TriangleAlert className="w-3.5 h-3.5 shrink-0" /> This entry says #{expectedNumber}; the selected issue is #{match.issueNumber}.</li>}
                    {annualMismatch && <li className="flex gap-1.5"><TriangleAlert className="w-3.5 h-3.5 shrink-0" /> This entry is an annual; the selected issue is from “{match.seriesName}”.</li>}
                    {duplicateIndex >= 0 && <li className="flex gap-1.5"><TriangleAlert className="w-3.5 h-3.5 shrink-0" /> Already in this list at position {duplicateIndex + 1}.</li>}
                    {preview?.mislabeled && (
                      <li className="flex gap-1.5">
                        <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                        {`Your library has “${preview.mislabeled.seriesName} #${preview.mislabeled.number}” tagged with this ID, but it doesn't match this issue (different number or series), so it won't be linked. Re-syncing that series' metadata fixes the tag.`}
                      </li>
                    )}
                  </ul>
                )}

                {preview?.accessScope === "owner" && (
                  <p className="text-xs text-muted-foreground">{"Checked against the list owner's libraries."}</p>
                )}
              </div>
            )}
            {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
          </div>
        </div>

        {confirmClear ? (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 border-t border-border pt-3">
            <p className="text-sm flex-1">
              Unlink this entry from “{currentLabel}”? It can only be relinked here if that issue is matched to ComicVine or Metron.
            </p>
            <div className="flex gap-2 justify-end">
              <Button ref={keepCancelRef} type="button" variant="outline" disabled={isSaving} onClick={() => setConfirmClear(false)}>Keep</Button>
              <Button type="button" variant="destructive" disabled={isSaving} onClick={() => void clear()}>
                {saving === "clear" && <Loader2 className="w-4 h-4 animate-spin" />} Unlink
              </Button>
            </div>
          </div>
        ) : (
          <DialogFooter className="sm:justify-between gap-2">
            <div>
              {showClear && (
                <Button type="button" variant="ghost" disabled={isSaving} onClick={requestClear}>
                  {saving === "clear" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />} Clear match
                </Button>
              )}
            </div>
            <div className="flex flex-col-reverse sm:flex-row gap-2">
              <Button type="button" variant="outline" disabled={isSaving} onClick={() => handleOpenChange(false)}>Cancel</Button>
              <Button type="button" disabled={!canSave} onClick={() => void save()}>
                {saving === "save" && <Loader2 className="w-4 h-4 animate-spin" />} Save match
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
