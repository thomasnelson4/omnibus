// src/lib/schedule-defaults.ts
//
// The cadence each scheduled job runs on until an admin saves Admin → Jobs. ONE map, read by the Jobs
// page (what it shows) and by syncSchedules (what runs). The page used to hard-code these values while
// syncSchedules scheduled only the jobs whose setting was stored - and a fresh install stores none (the
// Setup Wizard writes no schedules) - so the library scan, metadata sync, the series monitor, backups
// and Discover never ran until someone pressed Save, while the page showed them on these cadences.
//
// Values are hours ('0' = off); the *_day keys are the weekday (0 = Sunday) of the weekly jobs.
// Client-safe: no server imports.
export const SCHEDULE_DEFAULTS = {
    library_sync_schedule: '12',
    metadata_sync_schedule: '24',
    monitor_sync_schedule: '24',
    diagnostics_sync_schedule: '168',
    backup_sync_schedule: '168',
    backup_sync_day: '1',
    popular_sync_schedule: '24',
    weekly_digest_schedule: '168',
    weekly_digest_day: '1',
    cbr_conversion_schedule: '24',
    embed_metadata_schedule: '0',
    series_json_schedule: '0',
    cache_cleanup_schedule: '24',
    watched_sync_schedule: '0.25',
    health_check_schedule: '0.25',
    unmatched_sweep_schedule: '1',
    download_reaper_schedule: '1',
} as const;

export type ScheduleKey = keyof typeof SCHEDULE_DEFAULTS;

export const SCHEDULE_KEYS = Object.keys(SCHEDULE_DEFAULTS) as ScheduleKey[];

/** A schedule's saved value, or its default when it was never saved (or saved blank). */
export function scheduleValue(saved: Record<string, string | null | undefined>, key: ScheduleKey): string {
    const value = saved[key];
    return typeof value === 'string' && value.trim() !== '' ? value : SCHEDULE_DEFAULTS[key];
}
