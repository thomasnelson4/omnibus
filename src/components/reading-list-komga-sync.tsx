// src/components/reading-list-komga-sync.tsx
//
// The admin-only "Sync to Komga" panel on the reading-list page.
//
// One-way by design, and the copy says so: Komga is the READER of this list. Anything changed there
// (a StoryArc import appending books, a rename, a book id swapped after a file rename) is reverted
// by the next push or the nightly reconcile. That is the whole contract, so it is stated plainly
// rather than left to be discovered.
//
// The numbers come from KomgaReadListLink, which the push writes: how many entries made it into
// Komga, when, and the reason each skipped entry did not.
"use client"

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { getErrorMessage } from "@/lib/utils/error"
import { Logger } from "@/lib/logger"

interface SkippedCounts {
    placeholder: number
    notDownloaded: number
    unsupportedFormat: number
    libraryUnmapped: number
    awaitingScan: number
    duplicate: number
}

interface LinkStatus {
    komgaReadListId: string | null
    status: string
    lastPushedName: string | null
    lastPushedAt: string | null
    pushedCount: number
    skippedCount: number
    skipped: SkippedCounts
    lastError: string | null
}

const SKIP_LABELS: [keyof SkippedCounts, string][] = [
    ['notDownloaded', 'not downloaded'],
    ['awaitingScan', 'awaiting scan'],
    ['placeholder', 'placeholder'],
    ['unsupportedFormat', 'unsupported format'],
    ['libraryUnmapped', 'library not mapped to Komga'],
    ['duplicate', 'duplicate'],
]

/** "5 m ago" / "3 h ago" / "never" — the status line is read at a glance. */
export function formatPushedAt(iso: string | null | undefined, now: number = Date.now()): string {
    if (!iso) return 'never'
    const then = new Date(iso).getTime()
    if (!Number.isFinite(then)) return 'never'
    const secs = Math.max(0, Math.round((now - then) / 1000))
    if (secs < 60) return `${secs} s ago`
    const mins = Math.round(secs / 60)
    if (mins < 60) return `${mins} m ago`
    const hours = Math.round(mins / 60)
    if (hours < 24) return `${hours} h ago`
    return `${Math.round(hours / 24)} d ago`
}

/** Pure so it can be tested without a browser: "38 of 52 issues in Komga · 14 skipped (9 not downloaded, 5 awaiting scan)". */
export function formatStatusLine(input: {
    total: number
    link: LinkStatus | null
    now?: number
}): string {
    const { total, link, now } = input
    if (!link) return `Not pushed to Komga yet · ${total} issue${total === 1 ? '' : 's'} in this list`
    const pushed = link.pushedCount || 0
    const pushedPart = `${pushed} of ${total} issue${total === 1 ? '' : 's'} in Komga`
    const parts = [pushedPart, `pushed ${formatPushedAt(link.lastPushedAt, now)}`]
    const skipped = link.skipped || ({} as SkippedCounts)
    const detail = SKIP_LABELS
        .map(([key, label]) => [label, Number(skipped[key]) || 0] as const)
        .filter(([, n]) => n > 0)
        .map(([label, n]) => `${n} ${label}`)
    const skippedTotal = Object.values(skipped).reduce((a, b) => a + (Number(b) || 0), 0)
    if (skippedTotal > 0) parts.push(`${skippedTotal} skipped${detail.length ? ` (${detail.join(', ')})` : ''}`)
    if (link.status === 'waiting') parts.push('waiting for issues to be indexed');
    return parts.join(' · ')
}

export default function ReadingListKomgaSync({ listId, totalItems }: { listId: string; totalItems: number }) {
    const [enabled, setEnabled] = useState(false)
    const [link, setLink] = useState<LinkStatus | null>(null)
    const [loaded, setLoaded] = useState(false)
    const [busy, setBusy] = useState(false)

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/reading-lists/komga?listId=${encodeURIComponent(listId)}`)
            if (!res.ok) return
            const body = await res.json()
            setEnabled(!!body.komgaSync)
            setLink(body.link ?? null)
        } catch (e) {
            Logger.log(`[Reading Lists Komga] status load failed: ${getErrorMessage(e)}`, 'debug')
        } finally {
            setLoaded(true)
        }
    }, [listId])

    useEffect(() => { void load() }, [load])

    const toggle = async (next: boolean) => {
        setBusy(true)
        setEnabled(next)
        try {
            const res = await fetch('/api/reading-lists/komga', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ listId, komgaSync: next }),
            })
            if (!res.ok) {
                setEnabled(!next)
                const body = await res.json().catch(() => ({ error: 'Request failed' }))
                Logger.log(`[Reading Lists Komga] toggle failed: ${body.error ?? res.status}`, 'error')
                return
            }
            // The push is debounced server-side (10 s) and then reconciled; poll once shortly after.
            setTimeout(() => { void load() }, 2000)
        } catch (e) {
            Logger.log(`[Reading Lists Komga] toggle failed: ${getErrorMessage(e)}`, 'error')
            setEnabled(!next)
        } finally {
            setBusy(false)
        }
    }

    if (!loaded) return null

    return (
        <div className="flex flex-col gap-2 w-full mt-3 p-3 rounded-lg border border-border bg-background/60">
            <div className="flex items-center gap-3">
                <Switch id="komga-sync-toggle" checked={enabled} disabled={busy} onCheckedChange={toggle} />
                <Label htmlFor="komga-sync-toggle" className="font-bold cursor-pointer">Sync to Komga</Label>
                {busy && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            </div>
            <p className="text-xs text-muted-foreground">
                {formatStatusLine({ total: totalItems, link })}
            </p>
            <p className="text-[11px] text-muted-foreground">
                Sync is one-way: <span className="font-semibold text-foreground">edits made in Komga are overwritten</span> on the next push.
            </p>
            {link?.lastError && (
                <p className="text-[11px] text-destructive flex items-start gap-1">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span className="break-words">{link.lastError}</span>
                </p>
            )}
        </div>
    )
}