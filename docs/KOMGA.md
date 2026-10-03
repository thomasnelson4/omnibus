# Komga Integration — User Guide

[← Back to Main README](../README.md)

Omnibus can keep a [Komga](https://kadvyr.github.io/komga/) server in step with your library:

- **Scan on change.** After Omnibus adds, moves, renames or deletes files, it asks Komga to rescan
  the affected library. Changes are batched, so a burst of imports produces one scan about a minute
  after the last change.
- **Identity map.** Omnibus remembers which Komga book is which Omnibus issue, so a reading list
  pushed to Komga contains the right books.
- **Reading lists.** Omnibus can copy a reading list to Komga as a Komga read list.

Omnibus **never** modifies your Komga books, series, libraries or settings. Its only writes to
Komga are *library scans* and *creating / updating / deleting read lists that Omnibus itself pushed*.

Everything in this guide lives under **Admin → Settings → Media Servers**.

---

## 1. Requirements

| | |
| --- | --- |
| Minimum Komga version | **1.20.0** — this is the release that introduced API-key authentication. |
| Recommended | **1.23.5 or newer.** Below 1.23.5, API-key requests could return empty content. |
| Reading lists | **1.23.3 or newer.** 1.23.2 could not create read lists; 1.23.3 fixed it. |

Omnibus reads the version from Komga's `/actuator/info` (`build.version`) during **Test Connection**
and refuses to save an integration against a server older than 1.20.0. During development this
integration was verified against a real **Komga 1.28.1** server.

---

## 2. Create the Komga user and its API key

Omnibus needs an API key that belongs to a **Komga admin** with **no content restrictions**.

1. In Komga, create a dedicated user for Omnibus, e.g. `omnibus`, and make it an **ADMIN**.
2. On that user, leave **every content restriction empty**:
   - **Age restriction:** none.
   - **Labels allow / exclude:** empty.
   - **Shared libraries:** all of them (an admin normally sees everything).
3. On the same account page, open **API Keys**, create a key (a comment such as `omnibus` is handy)
   and copy it.

> **Why the restrictions matter.** Komga hides books from a restricted user *even when that user is
> an admin*: the book list comes back empty and a direct book fetch answers `403`. Omnibus would then
> see a working connection, match nothing, and silently push empty read lists. **Test Connection**
> checks for this and refuses the key.

### What Omnibus does with the key

The key is a full Komga admin credential. Omnibus stores it encrypted, shows it as `********`
everywhere after you save it, never returns it to the browser, never writes it to the logs, and
never includes it in the ID-map export. If the key is ever leaked, delete it in Komga and paste a new
one here.

---

## 3. Fill in the settings

| Field | Meaning |
| --- | --- |
| **Komga URL** | How Omnibus reaches Komga, including any sub-path: `http://192.168.1.100:25600`, `https://books.example.com/komga`. |
| **API Key** | The key from step 2. |
| **Enable Komga Integration** | Master switch. Everything is a no-op while this is off. |
| **Scan Komga When Files Change** | On by default. Turns the scan trigger on. |
| **Push Reading Lists to Komga** | Off by default. Must also be on *per reading list*. |

Press **Save**. When the master switch is on, Omnibus runs **Test Connection** first: if it fails,
Komga stays disabled and the reason is shown rather than silently half-enabled. You can also press
**Test Connection** by hand at any time, and **Detect Libraries** to preview how Komga's libraries
line up with yours before saving.

The URL and key must be reachable **from the Omnibus container**, not from your laptop — see
[§4](#4-path-mappings) if Komga is in Docker on the same host.

---

## 4. Path mappings

Komga and Omnibus compare files by their **absolute path as each server sees it**. If those paths
differ, add a mapping row: Omnibus path on the left, the path Komga uses for the same files on the
right. If both servers see identical paths, no mappings are needed.

**Docker on the same host (the common case).** Omnibus stores comics under `/data/comics` inside its
container, while Komga mounts the same host folder at `/comics`:

| Omnibus path | Komga path |
| --- | --- |
| `/data/comics` | `/comics` |

**Two machines.** Map the Omnibus-side path to the Komga-side path of the same share:

| Omnibus path | Komga path |
| --- | --- |
| `/mnt/media/comics` | `/books/comics` |
| `/mnt/media/comics/Manga` | `/books/manga` |

Rules:

- Paths are **case-sensitive** and match **whole folders** only.
- The longest matching prefix wins, so a more specific row beats a broader one.
- Both sides may be nested in either direction: a Komga library that sits *above* an Omnibus
  library serves it, and so does one that sits *inside* it.
- Trailing slashes, duplicate slashes and Windows-style backslashes are normalised away.

Press **Detect Libraries** afterwards. The table shows each Komga library with the Omnibus library it
resolves to, and it warns about Omnibus libraries Komga never sees.

---

## 5. Recommended Komga library settings

These are per-library settings **inside Komga** (Library → *Analysis* and *Settings*). Omnibus only
*reads* them — to warn you and to decide what to sync — it never changes them.

| Komga setting | Recommended | Why |
| --- | --- | --- |
| `hashFiles` | **on** | Without a page hash, a renamed or re-converted file gets a **new book id** in Komga. Hashing keeps ids stable across renames. |
| `importComicInfoBook` | **on** | Picks up the `ComicInfo.xml` Omnibus writes, so Komga shows Omnibus's metadata (including the provider link Omnibus matches on). |
| `importComicInfoReadList` | **off** while Omnibus owns reading lists | Otherwise Komga also creates and rewrites read lists from `ComicInfo.xml`, and the two systems fight over the same list. |
| `convertToCbz` | **off** | Converting an archive changes the file, which changes its hash and id. |
| `repairExtensions` | **off** | Renaming files behind Omnibus's back breaks the path↔book identity. |
| `emptyTrashAfterScan` | your call | See below. |
| `scanCbx` / `scanPdf` / `scanEpub` | on for what you use | Standard. |
| `scanForceModifiedTime` | off | Forcing mtimes hides real changes from the post-scan verification. |

### The `emptyTrashAfterScan` trade-off

Komga soft-deletes a book whose file has vanished and moves it to its trash. A book in the trash
still counts as a member of a read list.

- **On (`emptyTrashAfterScan = true`):** the trash empties itself after each scan, so books you
  delete in Omnibus leave your Komga read lists on their own. Good if you want Komga's lists to
  self-heal.
- **Off (Komga's default):** a deleted Omnibus issue can linger inside a pushed Komga read list as a
  "deleted" entry until you empty the trash manually (Library → *Analysis* → *Empty trash*, or the
  scan-time toggle). Omnibus will re-push that list when its membership changes, but on its own it
  never empties your trash for you.

Either setting is safe. Pick based on whether you want the trash cleared automatically or under your
control.

### `.cb7` files

**Komga cannot read 7z archives, so `.cb7` files never appear in Komga** — not through a scan, not
through a scan Omnibus requests. An issue that exists only as `.cb7` can therefore never be part of a
pushed read list. **Detect Libraries** reports how many `.cb7` issues sit in the libraries Komga
serves; convert them to `.cbz` first if you want them in Komga.

---

## 6. What is pushed to Komga

Reading lists are pushed only when **both** are true: the global **Push Reading Lists to Komga**
switch is on, **and** the individual list has been opted in (a Komga toggle on the reading list's own
page).

**What goes in.** Every issue in the list that Omnibus can resolve to a linked Komga book, in list
order. An issue is skipped when it has no file on disk, when it is outside any library Komga serves,
when its book id is not (or no longer) in Komga, or when the `.cb7` rule above applies.

**Naming.** Komga read-list names are unique and case-insensitive, so Omnibus builds a name that
cannot collide with something you made by hand:

| Omnibus list | Name in Komga |
| --- | --- |
| Global list `My Reading` | `My Reading` |
| Personal list `My Reading` owned by `alice` | `My Reading (alice)` |
| Either of the above, but the name is taken | `My Reading (alice) (Omnibus)` |

Whitespace is collapsed and the name is trimmed before comparison or sending.

**The ownership marker.** After the list description, Omnibus appends a small marker line that
records which Omnibus instance and which list own this remote list. It is what lets Omnibus:

- recognise a list it pushed after a restore or a rename on the Omnibus side, and update it instead
  of creating a duplicate;
- refuse to touch a read list you created in Komga yourself;
- clean up a remote list whose Omnibus list has been deleted (the "orphan sweep", run by the daily
  reconcile).

If you edit a pushed list's description and delete the marker, Omnibus stops managing it — it will
not overwrite your version or delete it.

### One-way, not two-way

**Omnibus → Komga only.** Reading lists are pushed, and re-pushed when the Omnibus list changes.

- **Edits you make in Komga are overwritten** by the next push of that list.
- Reordering, renaming or deleting a pushed list in Komga does not change the Omnibus list, and the
  deletion is undone by the next push.
- The exception is deletion from the Komga *side* of an Omnibus list: turn **Push Reading Lists to
  Komga** off (or un-opt the list) and the remote list is deleted, but only after the ownership
  marker confirms it belongs to that list.

Progress, reading state and series metadata are never pushed. Those stay in Omnibus.

---

## 7. Day-to-day operation

### Automatic

- A file change in Omnibus marks that library dirty. Within about a minute of the last change,
  Omnibus asks Komga to scan it. Omnibus waits for Komga's task queue to go idle, checks that every
  file it expected is really in Komga, and retries once with a deep scan if not.
- A full reconcile runs **once a day**: it re-syncs every mapped library and rebuilds the identity
  map, so a missed file event or a dropped callback repairs itself within a day.
- Saving a Komga setting (URL, key, mappings, or any toggle) queues a reconcile immediately.

### Manual — Admin → Jobs

Three buttons run the same work on demand:

| Button | What it runs |
| --- | --- |
| **Komga: sync mapped libraries** | A `KOMGA_SYNC` for every Omnibus library a Komga library serves. |
| **Komga: rebuild ID map** | A `KOMGA_RECONCILE`: full sync of every mapped library plus the ID map. |
| **Komga: push reading lists** | A push for every reading list that is opted in. |

These Komga jobs run on their own background queue (`omnibus-komga`) — not on the queue the other
admin jobs use — and they never block the other jobs.

### System Health

**Admin → Health** gains a **Komga** section, driven purely from the database (it never calls Komga,
so it stays fast). It reports consecutive sync failures and the last error, Komga libraries with no
Omnibus mapping, tripped reconcile safety valves, an identity map that has not been reconciled for
more than 48 hours, and paths that Komga never picked up in the last 24 hours. Every entry links back
to **Admin → Settings → Media Servers**.

### Logs and history

- **Admin → Logs** shows the job history. Komga entries appear as `KOMGA SCAN`, `KOMGA RECONCILE` and
  `KOMGA READLIST SYNC`.
- Every Komga line in the system log is prefixed **`[Komga]`**, so `grep '\[Komga\]'` on the log file
  gives you the whole story.
- Settings changes, toggles and manual triggers are recorded in the **audit log** under
  `KOMGA_SETTINGS_CHANGED` and `KOMGA_ADMIN_TRIGGERED`. Only field *names* are recorded — never the
  API key.

---

## 8. Exporting the ID map

The identity map is a plain database read, so you can export it **even while Komga is down** —
which is exactly when you need it. As an admin, open:

```http
GET /api/admin/komga/id-map
```

(for example `http://your-omnibus:3000/api/admin/komga/id-map` — it returns JSON, so
`curl -o id-map.json` or "Save link as" both work). The response contains:

- `libraries` — each Komga library, its root, the Omnibus library it resolves to, and how many books
  are linked;
- `series` — Omnibus series id → Komga series id;
- `books` — Omnibus issue id, Komga book id, both paths, how the link was made (`PATH` or `LINK`) and
  when it was last verified;
- `truncated` — `true` when the map is capped at 50 000 rows.

The API key is never part of the export. There is no button for this yet; the endpoint is the
supported way in.

---

## 9. Troubleshooting

**"Test Connection" fails with "not a Komga admin" / "has content restrictions".**
The key belongs to the wrong user. Create a dedicated admin with no age restriction and no label
restrictions (see [§2](#2-create-the-komga-user-and-its-api-key)).

**"No Komga server found at this URL (the health endpoint returned 404)".**
Wrong address. Check the port, and remember that a Komga served under a sub-path needs that sub-path
in the URL (`https://host/komga`).

**"Komga health check failed" / "did not answer within 10 s".**
Omnibus cannot reach Komga. Check it from the Omnibus container, not from your machine. A Komga in
Docker on the same host is usually reachable by container name, not `localhost`.

**Nothing ever scans.**
Check that the master switch and **Scan Komga When Files Change** are both on, and that Omnibus
actually sees the library — an Omnibus library that is not inside any Komga library is listed in the
**Detect Libraries** warnings. Then try **Komga: sync mapped libraries** on Admin → Jobs and watch
the `[Komga]` lines in Admin → Logs.

**Scans run, but books never get linked.**
Almost always a path problem: the paths the two servers report for the same file differ. Re-check
your path mappings and press **Detect Libraries**. You can also export the ID map
([§8](#8-exporting-the-id-map)) and compare `komgaPath` with `omnibusPath` for one book.

**"Komga did not pick up N path(s) … giving up".**
Komga's scan finished but the file was not in the listing. Common causes: a file type Komga cannot
read (`.cb7`), a directory exclusion or hidden folder in the Komga library, or a write that did not
change the folder's modified time (a plain overwrite instead of a temp-file-and-rename — Omnibus's
own writes always use temp+rename). System Health surfaces these; a nightly reconcile retries them.

**"reconcile safety valve" in System Health.**
The reconcile found the Komga listing untrustworthy (usually "Komga listed 0 books while N links
exist", or a pass that wanted to delete far more links than allowed) and refused to rewrite the map —
that is the valve doing its job, protecting you from a mass unlink. Fix the underlying cause (Komga
mid-scan, an unmounted share, a wrong mapping), then press **Komga: rebuild ID map**.

**A reading list is empty in Komga.**
Every issue in it was skipped. Press nothing first — open the list on the reading-list page: the Komga
panel shows what was pushed and what was skipped and why. `.cb7` issues and issues outside a mapped
library can never be pushed.

**Komga keeps overwriting my edits to a pushed read list.**
That is the one-way design. Turn the push off for that list (or globally) and edit or delete it in
Komga freely — but understand that turning the push back on, or editing the Omnibus list again, will
push over it again.

**Reading lists are never pushed.**
The global switch is off, the list itself is not opted in, or Komga is older than 1.23.3 (the version
is checked at connection time and shown as a red warning on the settings tab).

---

## 10. Backups

Backups do **not** contain the Komga tables. The `KomgaLibrary`, `KomgaSyncState`, `KomgaBookLink`,
`KomgaSeriesLink` and `KomgaReadListLink` tables are caches that Omnibus rebuilds by talking to
Komga — and your reading lists, including which ones are opted in for Komga, are part of a normal
backup like any other data. Restoring onto a fresh instance re-scans and re-maps automatically; the
first reconcile after a restore also re-adopts the read lists it pushed before, by their ownership
marker.
