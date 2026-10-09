// src/lib/komga/types.ts
//
// Hand-written Komga DTOs (no codegen dependency), checked field by field against Komga 1.28.1's
// docs/openapi.json and the Kotlin classes in interfaces/api/rest/dto (LibraryDto, BookDto,
// BookMetadataDto, MediaDto, WebLinkDto, ReadListDto, ReadListCreationDto, ReadListUpdateDto,
// UserDto), interfaces/sse/dto/TaskQueueSseDto and Spring Data's PageImpl JSON. Fields that newer
// Komga versions added, or that the integration never reads, are optional so older servers and small
// test fixtures both type-check. Timestamps are Komga's `yyyy-MM-dd'T'HH:mm:ss'Z'` strings (UTC,
// whole seconds).

export interface KomgaLibraryDto {
    id: string;
    name: string;
    /** Komga-host filesystem path (Library.root URL → toFilePath()). Empty string for non-admins. */
    root: string;
    importComicInfoBook: boolean;
    importComicInfoSeries: boolean;
    importComicInfoCollection: boolean;
    importComicInfoReadList: boolean;
    importComicInfoSeriesAppendVolume?: boolean;
    importEpubBook: boolean;
    importEpubSeries: boolean;
    importMylarSeries: boolean;
    importLocalArtwork: boolean;
    importBarcodeIsbn: boolean;
    scanForceModifiedTime: boolean;
    /** DISABLED | HOURLY | EVERY_6H | EVERY_12H | DAILY | WEEKLY */
    scanInterval?: string;
    scanOnStartup: boolean;
    scanCbx: boolean;
    scanPdf: boolean;
    scanEpub: boolean;
    scanDirectoryExclusions: string[];
    repairExtensions: boolean;
    convertToCbz: boolean;
    emptyTrashAfterScan: boolean;
    /** FIRST | FIRST_UNREAD_OR_FIRST | FIRST_UNREAD_OR_LAST | LAST */
    seriesCover?: string;
    hashFiles: boolean;
    hashPages: boolean;
    hashKoreader?: boolean;
    analyzeDimensions: boolean;
    oneshotsDirectory: string | null;
    /** true when Komga could not find the root on its last scan (unavailableDate != null). */
    unavailable: boolean;
}

export interface KomgaWebLinkDto { label: string; url: string }

export interface KomgaAuthorDto { name: string; role: string }

export interface KomgaBookMetadataDto {
    title: string;
    /** The issue number as text (ComicInfo <Number>), unlike BookDto.number. */
    number: string;
    numberSort: number;
    /** ComicInfo <Web> split on single spaces; label = URL host. */
    links: KomgaWebLinkDto[];
    /** ComicInfo <GTIN>. */
    isbn: string;
    titleLock?: boolean;
    summary?: string;
    summaryLock?: boolean;
    numberLock?: boolean;
    numberSortLock?: boolean;
    /** yyyy-MM-dd */
    releaseDate?: string | null;
    releaseDateLock?: boolean;
    authors?: KomgaAuthorDto[];
    authorsLock?: boolean;
    tags?: string[];
    tagsLock?: boolean;
    isbnLock?: boolean;
    linksLock?: boolean;
    created?: string;
    lastModified?: string;
}

export interface KomgaMediaDto {
    /** READY | UNKNOWN | ERROR | UNSUPPORTED | OUTDATED */
    status: string;
    mediaType: string;
    pagesCount: number;
    comment?: string;
    epubDivinaCompatible?: boolean;
    epubIsKepub?: boolean;
    mediaProfile?: string;
}

export interface KomgaReadProgressDto {
    page: number;
    completed: boolean;
    readDate: string;
    created: string;
    lastModified: string;
    deviceId?: string;
    deviceName?: string;
}

export interface KomgaBookDto {
    id: string;
    seriesId: string;
    seriesTitle: string;
    libraryId: string;
    /** File name without extension. */
    name: string;
    /**
     * For an ADMIN principal: the plain Komga-host filesystem path, produced by
     * `URL(url).toFilePath()` = `toURI().toPath().pathString` in BookDtoDao (decoded, no `file:`
     * scheme, no percent-encoding; backslashes on a Windows host). Non-admins get only the bare
     * file name (BookDto.restrictUrl), which is why the integration requires an ADMIN key.
     */
    url: string;
    /** 1-based position in the series after Komga's sort, NOT the issue number (see metadata.number). */
    number: number;
    created: string;
    /** Book row; bumped on file/URL/hash changes and soft delete, not on metadata-only changes. */
    lastModified: string;
    fileLastModified: string;
    sizeBytes: number;
    /** Human-readable size, e.g. "12.3 MiB". */
    size: string;
    media: KomgaMediaDto;
    metadata: KomgaBookMetadataDto;
    readProgress?: KomgaReadProgressDto | null;
    deleted: boolean;
    /** Lowercase hex XXH3-128 of the file, or "" until Komga's HashBook task has run. */
    fileHash: string;
    oneshot: boolean;
}

export interface KomgaReadListDto {
    id: string;
    name: string;
    summary: string;
    ordered: boolean;
    /** In list order. */
    bookIds: string[];
    createdDate: string;
    lastModifiedDate: string;
    /** true when the caller's library access / content restrictions hid some books. */
    filtered: boolean;
}

/** ReadListCreationDto: name @NotBlank, bookIds @NotEmpty @UniqueElements. */
export interface KomgaReadListCreateDto { name: string; summary: string; ordered: boolean; bookIds: string[] }

/** ReadListUpdateDto: omitted fields are left alone; bookIds (when present) fully replaces membership. */
export interface KomgaReadListUpdateDto { name?: string; summary?: string; ordered?: boolean; bookIds?: string[] }

/** GET /api/v2/users/me. */
export interface KomgaUserDto {
    id: string;
    email: string;
    /** User roles plus a synthetic "USER": ADMIN, FILE_DOWNLOAD, PAGE_STREAMING, KOBO_SYNC, KOREADER_SYNC. */
    roles: string[];
    sharedAllLibraries: boolean;
    sharedLibrariesIds: string[];
    labelsAllow: string[];
    labelsExclude: string[];
    /**
     * Komga omits this field when unset (@JsonInclude NON_NULL); KomgaClient.getMe() normalizes the
     * missing field to null. restriction: ALLOW_ONLY | EXCLUDE.
     */
    ageRestriction: { age: number; restriction: string } | null;
}

/** Spring Data PageImpl as serialized directly (Komga does not opt into PagedModel / VIA_DTO). */
export interface KomgaPage<T> {
    content: T[];
    totalElements: number;
    totalPages: number;
    /** 0-based page index. */
    number: number;
    size: number;
    numberOfElements: number;
    first: boolean;
    last: boolean;
    empty: boolean;
    pageable?: unknown;
    sort?: unknown;
}

/** SSE `event:TaskQueueStatus` payload (admin-only, every 10 s while a client is connected). */
export interface KomgaTaskQueueStatus {
    count: number;
    /** Global across libraries; keys are Task simple names (ScanLibrary, AnalyzeBook, HashBook, …). */
    countByType: Record<string, number>;
}

/** GET /actuator/metrics/{name}. */
export interface KomgaMetricDto {
    name: string;
    description?: string;
    baseUnit?: string;
    measurements: { statistic: string; value: number }[];
    availableTags: { tag: string; values: string[] }[];
}

export type KomgaErrorKind = 'unreachable' | 'unauthorized' | 'forbidden' | 'notFound' | 'badRequest' | 'server' | 'timeout';

/**
 * Every failure KomgaClient surfaces. `message` is safe to show an admin and never contains the API
 * key. `detail` is Komga's own JSON `message` (or joined validation violations) when it sent one,
 * e.g. "Read list name already exists", for callers that branch on it.
 */
export class KomgaError extends Error {
    readonly status: number | null;
    readonly kind: KomgaErrorKind;
    readonly detail: string | null;

    constructor(kind: KomgaErrorKind, status: number | null, message: string, detail?: string | null) {
        super(message);
        this.name = 'KomgaError';
        this.kind = kind;
        this.status = status;
        this.detail = detail ?? null;
    }
}

const KOMGA_ERROR_KINDS: ReadonlySet<string> = new Set<KomgaErrorKind>(
    ['unreachable', 'unauthorized', 'forbidden', 'notFound', 'badRequest', 'server', 'timeout'],
);

/** instanceof plus a structural fallback: route bundles and the instrumentation bundle can each load their own copy of this class. */
export function isKomgaError(e: unknown): e is KomgaError {
    if (e instanceof KomgaError) return true;
    if (typeof e !== 'object' || e === null) return false;
    const o = e as { name?: unknown; kind?: unknown };
    return o.name === 'KomgaError' && typeof o.kind === 'string' && KOMGA_ERROR_KINDS.has(o.kind);
}
