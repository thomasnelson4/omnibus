// src/app/admin/settings/tabs/media-servers-tab.tsx
//
// Media Servers tab (Komga integration). Like the other tabs it reads and writes the shared state
// bag `s` from page.tsx, so every field rides the normal Save pipeline. The one piece of local
// state is the "Detect libraries" preview: it is never saved, so it does not belong in the bag.
// Client component: no server modules here (the Komga client and path normalizer live in
// @/lib/komga and run behind /api/admin/test and /api/admin/komga/libraries).
"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Server, Loader2, CheckCircle, Zap, Plus, Trash2, FolderOpen, Library, AlertTriangle, ShieldAlert, Search } from "lucide-react"
import { StatusBox } from "./shared"
import type { SettingsBag } from "./shared"

// Mirrors KOMGA_READLIST_MIN_VERSION in src/lib/komga/constants.ts (server-only module).
export const KOMGA_READLIST_MIN_VERSION = '1.23.3'
const DETECT_TIMEOUT_MS = 60_000

export interface PathMappingRow { omnibus: string; komga: string }

export interface DetectedKomgaLibrary {
    id: string;
    name: string;
    root: string;
    translatedRoot: string | null;
    omnibusLibrary: { id: string; name: string; path: string } | null;
    warnings: string[];
}

interface DetectResult { libraries: DetectedKomgaLibrary[]; warnings: string[]; version: string | null }

// Tolerant read of config.komga_path_mappings. Rows are kept exactly as typed (half-filled ones
// too) so the editor never swallows input; the server normalizes and drops incomplete rows.
export function parseMappingRows(raw: unknown): PathMappingRow[] {
    if (typeof raw !== 'string' || raw.trim() === '') return []
    try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
            .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
            .map(r => ({
                omnibus: typeof r.omnibus === 'string' ? r.omnibus : '',
                komga: typeof r.komga === 'string' ? r.komga : '',
            }))
    } catch {
        return []
    }
}

export const serializeMappingRows = (rows: PathMappingRow[]) =>
    JSON.stringify(rows.map(r => ({ omnibus: r.omnibus, komga: r.komga })))

export const isStrongWarning = (w: string) => /^\s*strongly discouraged/i.test(w)

// Compares the leading x.y.z only; Komga can report suffixed builds such as "1.28.1-SNAPSHOT".
export function isVersionBelow(version: string | null | undefined, min: string): boolean {
    const parse = (v: string) => {
        const m = v.match(/^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
        return m ? [m[1], m[2], m[3]].map(n => parseInt(n ?? '0', 10)) : null
    }
    const a = version ? parse(version) : null
    const b = parse(min)
    if (!a || !b) return false
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] < b[i]
    }
    return false
}

function WarningList({ warnings }: { warnings: string[] }) {
    return (
        <ul className="space-y-1">
            {warnings.map((w, i) => {
                const strong = isStrongWarning(w)
                return (
                    <li
                        key={i}
                        data-severity={strong ? 'strong' : 'warning'}
                        className={`flex items-start gap-1.5 text-[11px] leading-snug ${strong ? 'font-bold text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}
                    >
                        {strong
                            ? <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
                            : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
                        <span>{w}</span>
                    </li>
                )
            })}
        </ul>
    )
}

export function MediaServersTab({ s }: { s: SettingsBag }) {
    const { config, setConfig, handleTest, testing, testResults, setTestResults } = s

    const [detecting, setDetecting] = useState(false)
    const [detected, setDetected] = useState<DetectResult | null>(null)
    const [detectError, setDetectError] = useState<string | null>(null)

    const mappings = parseMappingRows(config.komga_path_mappings)
    const canConnect = !!String(config.komga_url ?? '').trim() && !!String(config.komga_api_key ?? '').trim()
    const readListsOn = config.komga_readlists_enabled === 'true'
    const readListsTooOld = readListsOn && isVersionBelow(detected?.version, KOMGA_READLIST_MIN_VERSION)

    const setFlag = (key: string, on: boolean) => setConfig({ ...config, [key]: on ? 'true' : 'false' })

    // Test and detection results describe the server they ran against; drop them when the URL or
    // key changes so a stale "connected" never sits under a different server.
    const setConnectionField = (key: 'komga_url' | 'komga_api_key', value: string) => {
        setConfig({ ...config, [key]: value })
        if (testResults?.komga) setTestResults(prev => ({ ...prev, komga: null }))
        setDetected(null)
        setDetectError(null)
    }

    // Translated roots and library matches depend on the mappings, so edits invalidate a preview.
    const setMappings = (rows: PathMappingRow[]) => {
        setConfig({ ...config, komga_path_mappings: serializeMappingRows(rows) })
        setDetected(null)
    }
    const addMapping = () => setMappings([...mappings, { omnibus: '', komga: '' }])
    const updateMapping = (i: number, side: keyof PathMappingRow, value: string) =>
        setMappings(mappings.map((r, j) => (j === i ? { ...r, [side]: value } : r)))
    const removeMapping = (i: number) => setMappings(mappings.filter((_, j) => j !== i))

    const detectLibraries = async () => {
        setDetecting(true)
        setDetectError(null)
        setDetected(null)
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), DETECT_TIMEOUT_MS)
        try {
            // Unsaved values on purpose: this previews what Komga would look like with them.
            // A masked '********' key is resolved to the stored one by the route. Mappings are sent
            // as the editor shows them, so a corrupt stored value previews as "no mappings".
            const res = await fetch('/api/admin/komga/libraries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: config.komga_url ?? '',
                    apiKey: config.komga_api_key ?? '',
                    pathMappings: serializeMappingRows(mappings),
                }),
                signal: abort.signal,
            })
            const data = await res.json().catch(() => null)
            if (!res.ok || !data || !Array.isArray(data.libraries)) {
                setDetectError(data?.error || `Komga library detection failed (HTTP ${res.status}).`)
                return
            }
            setDetected({
                libraries: data.libraries.map((l: DetectedKomgaLibrary) => ({ ...l, warnings: Array.isArray(l?.warnings) ? l.warnings : [] })),
                warnings: Array.isArray(data.warnings) ? data.warnings : [],
                version: typeof data.version === 'string' ? data.version : null,
            })
        } catch (e) {
            setDetectError((e as { name?: string } | null)?.name === 'AbortError'
                ? `Library detection failed: no answer after ${DETECT_TIMEOUT_MS / 1000} seconds.`
                : 'Library detection failed: could not reach Omnibus.')
        } finally {
            clearTimeout(timer)
            setDetecting(false)
        }
    }

    return (
        <Card className="shadow-sm border-border bg-background">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-foreground"><Server className="w-5 h-5 text-primary" /> Komga</CardTitle>
                <CardDescription className="text-muted-foreground">
                    Keep a Komga server in step with your library: Omnibus asks Komga to rescan after files change, and can push reading lists to Komga as read lists. Omnibus never changes Komga&apos;s library settings.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-8">

                <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                    <Switch
                        id="komga-enabled"
                        checked={config.komga_enabled === 'true'}
                        onCheckedChange={(c) => setFlag('komga_enabled', c)}
                        className="scale-110 sm:scale-100"
                    />
                    <div className="grid gap-1 ml-2">
                        <Label htmlFor="komga-enabled" className="cursor-pointer font-bold text-base text-foreground">Enable Komga Integration</Label>
                        <p className="text-[11px] text-muted-foreground">When you save with this switched on, Omnibus first tests the connection below. If the test fails, Komga stays off and the reason is shown.</p>
                    </div>
                </div>

                {/* --- CONNECTION --- */}
                <div className="space-y-4">
                    <h3 className="text-lg font-bold border-b border-border pb-2 text-foreground">Connection</h3>
                    <div className="grid gap-2">
                        <Label htmlFor="komga-url" className="text-foreground font-semibold">Komga URL</Label>
                        <Input
                            id="komga-url"
                            value={config.komga_url ?? ""}
                            onChange={(e) => setConnectionField('komga_url', e.target.value)}
                            placeholder="http://192.168.1.100:25600"
                            className="h-12 sm:h-10 bg-muted/50 border-border text-foreground"
                        />
                        <p className="text-[0.8rem] text-muted-foreground">The address Omnibus uses to reach Komga, including any sub-path (for example <code>https://host/komga</code>).</p>
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="komga-api-key" className="text-foreground font-semibold">API Key</Label>
                        <Input
                            id="komga-api-key"
                            type="password"
                            autoComplete="new-password"
                            value={config.komga_api_key ?? ""}
                            onChange={(e) => setConnectionField('komga_api_key', e.target.value)}
                            placeholder="Paste a Komga API key"
                            className="h-12 sm:h-10 bg-muted/50 border-border text-foreground font-mono"
                        />
                        <p className="text-[0.8rem] text-muted-foreground">
                            Generate it in Komga under your account&apos;s <span className="font-semibold">API Keys</span> page (Komga 1.20.0 or newer). Use a dedicated <strong>admin</strong> user that can see all libraries and has no age or label restrictions. The key is stored encrypted and stays masked after saving; leave the dots in place to keep it.
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        className="w-full h-12 sm:h-10 font-bold border-border hover:bg-muted text-foreground transition-colors"
                        onClick={() => handleTest('komga')}
                        disabled={!!testing || !canConnect}
                    >
                        {testing === 'komga' ? (
                            <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary" />
                        ) : testResults?.komga?.success ? (
                            <CheckCircle className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-green-500" />
                        ) : (
                            <Zap className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary" />
                        )}
                        Test Connection
                    </Button>
                    <StatusBox result={testResults?.komga ?? null} />
                </div>

                {/* --- SYNC BEHAVIOUR --- */}
                <div className="space-y-4">
                    <h3 className="text-lg font-bold border-b border-border pb-2 text-foreground">Sync</h3>
                    <div className="flex items-center space-x-2 bg-muted/30 p-4 rounded-lg border border-border">
                        <Switch
                            id="komga-scan-on-change"
                            checked={config.komga_scan_on_change !== 'false'}
                            onCheckedChange={(c) => setFlag('komga_scan_on_change', c)}
                            className="scale-110 sm:scale-100"
                        />
                        <div className="grid gap-1 ml-2">
                            <Label htmlFor="komga-scan-on-change" className="cursor-pointer font-bold text-base text-foreground">Scan Komga When Files Change</Label>
                            <p className="text-[11px] text-muted-foreground">After Omnibus adds, replaces, renames, or deletes files, it asks Komga to rescan the affected library. Changes are batched, so a burst of imports triggers one scan about a minute after the last change.</p>
                        </div>
                    </div>
                    <div className="bg-muted/30 p-4 rounded-lg border border-border space-y-2">
                        <div className="flex items-center space-x-2">
                            <Switch
                                id="komga-readlists-enabled"
                                checked={readListsOn}
                                onCheckedChange={(c) => setFlag('komga_readlists_enabled', c)}
                                className="scale-110 sm:scale-100"
                            />
                            <div className="grid gap-1 ml-2">
                                <Label htmlFor="komga-readlists-enabled" className="cursor-pointer font-bold text-base text-foreground">Push Reading Lists to Komga</Label>
                                <p className="text-[11px] text-muted-foreground">Copies Omnibus reading lists to Komga as read lists. Needs Komga {KOMGA_READLIST_MIN_VERSION} or newer, and each list must also be opted in from its own page. Lists that are not opted in are never sent.</p>
                            </div>
                        </div>
                        {readListsTooOld && (
                            <p className="text-[11px] font-bold text-red-600 dark:text-red-400">
                                The detected Komga version ({detected?.version}) is older than {KOMGA_READLIST_MIN_VERSION}, so read lists will not be pushed. Upgrade Komga first.
                            </p>
                        )}
                    </div>
                </div>

                {/* --- PATH MAPPINGS --- */}
                <div className="space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-2">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2"><FolderOpen className="w-5 h-5 text-primary" /> Path Mappings</h3>
                        <Button variant="outline" size="sm" onClick={addMapping} className="h-12 sm:h-9 font-bold w-full sm:w-auto border-border hover:bg-muted text-foreground">
                            <Plus className="w-5 h-5 sm:w-4 sm:h-4 mr-1 text-primary" /> Add Mapping
                        </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                        Only needed when Komga sees your comics under different folders than Omnibus does (for example different Docker volume mounts). Each row pairs an Omnibus folder with the folder Komga uses for the same files. Paths are case-sensitive and match whole folders only.
                    </p>
                    {mappings.length === 0 ? (
                        <p className="text-sm text-muted-foreground italic bg-muted/20 p-4 rounded-md border border-border">No mappings. Komga is assumed to see the same paths as Omnibus.</p>
                    ) : (
                        <div className="space-y-3">
                            <div className="hidden sm:grid sm:grid-cols-[1fr_1fr_2.5rem] gap-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                                <span>Omnibus path</span><span>Komga path</span><span />
                            </div>
                            {mappings.map((m, i) => (
                                <div key={i} className="flex flex-col sm:grid sm:grid-cols-[1fr_1fr_2.5rem] gap-2 bg-muted/30 p-2 rounded-md sm:bg-transparent sm:p-0 sm:rounded-none border border-border sm:border-0">
                                    <Input
                                        aria-label={`Omnibus path ${i + 1}`}
                                        placeholder="Omnibus path (e.g. /data/comics)"
                                        value={m.omnibus}
                                        onChange={(e) => updateMapping(i, 'omnibus', e.target.value)}
                                        className="h-12 sm:h-10 bg-background border-border font-mono text-sm text-foreground"
                                    />
                                    <div className="flex gap-2 sm:contents">
                                        <Input
                                            aria-label={`Komga path ${i + 1}`}
                                            placeholder="Komga path (e.g. /comics)"
                                            value={m.komga}
                                            onChange={(e) => updateMapping(i, 'komga', e.target.value)}
                                            className="h-12 sm:h-10 flex-1 bg-background border-border font-mono text-sm text-foreground"
                                        />
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={`Remove mapping ${i + 1}`}
                                            onClick={() => removeMapping(i)}
                                            className="h-12 w-12 sm:h-10 sm:w-10 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 shrink-0 border border-transparent hover:border-red-200"
                                        >
                                            <Trash2 className="h-5 w-5 sm:h-4 sm:w-4" />
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* --- DETECTED LIBRARIES --- */}
                <div className="space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-2">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2"><Library className="w-5 h-5 text-primary" /> Komga Libraries</h3>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={detectLibraries}
                            disabled={detecting || !canConnect}
                            className="w-full sm:w-auto h-12 sm:h-9 font-bold bg-muted hover:bg-muted/80 text-foreground transition-colors"
                        >
                            {detecting
                                ? <Loader2 className="w-5 h-5 sm:w-4 sm:h-4 animate-spin mr-2 text-primary" />
                                : <Search className="w-5 h-5 sm:w-4 sm:h-4 mr-2 text-primary" />}
                            Detect Libraries
                        </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                        Lists Komga&apos;s libraries using the values above (saved or not), shows which Omnibus library each one covers, and flags Komga settings that work against the integration. Change those settings in Komga.
                    </p>

                    <StatusBox result={detectError ? { success: false, text: detectError } : null} />

                    {!detected && !detectError && (
                        <div className="border-2 border-dashed border-border rounded-lg p-8 text-center text-sm text-muted-foreground">
                            {canConnect
                                ? <>Click &quot;Detect Libraries&quot; to check how Komga&apos;s libraries line up with yours.</>
                                : <>Enter a Komga URL and API key, then click &quot;Detect Libraries&quot;.</>}
                        </div>
                    )}

                    {detected && (
                        <div className="space-y-4">
                            <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                                <Badge variant="secondary" className="bg-primary/10 text-primary">
                                    {detected.version ? `Komga ${detected.version}` : 'Komga version unknown'}
                                </Badge>
                                <span className="text-muted-foreground">
                                    {detected.libraries.length === 1 ? '1 library detected' : `${detected.libraries.length} libraries detected`}
                                </span>
                            </div>

                            {detected.warnings.length > 0 && (
                                <div className="rounded-lg border border-amber-300 dark:border-amber-800/60 bg-amber-50/40 dark:bg-amber-900/10 p-3">
                                    <WarningList warnings={detected.warnings} />
                                </div>
                            )}

                            {detected.libraries.length === 0 ? (
                                <p className="text-sm text-muted-foreground italic bg-muted/20 p-4 rounded-md border border-border">Komga reported no libraries. Create a Komga library over your comics folder, then detect again.</p>
                            ) : (
                                <div className="rounded-lg border border-border">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Library</TableHead>
                                                <TableHead className="hidden sm:table-cell">Komga root</TableHead>
                                                <TableHead className="hidden sm:table-cell">Omnibus path</TableHead>
                                                <TableHead>Omnibus library</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        {/* Warnings are sentences, so they get a full-width row under their library
                                            instead of a column that the path cells would squeeze off-screen. On
                                            phones the two path columns fold into the Library cell. */}
                                        {detected.libraries.map(lib => (
                                            <TableBody key={lib.id} data-library-id={lib.id} className="border-b last:border-b-0 [&_tr]:border-b-0">
                                                <TableRow className="hover:bg-transparent [&>td]:align-top [&>td]:whitespace-normal">
                                                    <TableCell className="min-w-[7rem]">
                                                        <span className="font-bold text-foreground">{lib.name}</span>
                                                        <span className="sm:hidden mt-1 grid gap-0.5 font-mono text-[10px] break-all text-muted-foreground">
                                                            <span>Komga: {lib.root}</span>
                                                            <span>Omnibus: {lib.translatedRoot ?? 'no mapping covers it'}</span>
                                                        </span>
                                                        {lib.warnings.length === 0 && (
                                                            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-green-700 dark:text-green-400"><CheckCircle className="w-3.5 h-3.5" /> No warnings</span>
                                                        )}
                                                    </TableCell>
                                                    <TableCell className="hidden sm:table-cell font-mono text-xs break-all min-w-[6rem]">{lib.root}</TableCell>
                                                    <TableCell className="hidden sm:table-cell font-mono text-xs break-all min-w-[6rem]">
                                                        {lib.translatedRoot ?? <span className="font-sans italic break-normal text-muted-foreground">Outside every mapping</span>}
                                                    </TableCell>
                                                    <TableCell className="min-w-[7rem]">
                                                        {lib.omnibusLibrary ? (
                                                            <div className="grid gap-0.5">
                                                                <span className="font-semibold text-foreground">{lib.omnibusLibrary.name}</span>
                                                                <span className="font-mono text-[10px] break-all text-muted-foreground">{lib.omnibusLibrary.path}</span>
                                                            </div>
                                                        ) : (
                                                            <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400">Not mapped</Badge>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                                {lib.warnings.length > 0 && (
                                                    <TableRow className="hover:bg-transparent">
                                                        <TableCell colSpan={4} className="whitespace-normal pt-0 pb-3">
                                                            <WarningList warnings={lib.warnings} />
                                                        </TableCell>
                                                    </TableRow>
                                                )}
                                            </TableBody>
                                        ))}
                                    </Table>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}
