//! Folders the engine writes under (beta.018 follow-up).
//!
//! The engine container runs as root, so a saved folder it can't really use doesn't fail the way it
//! does in the web container (which runs as `node`): a relative path - `C:\Comics` under Docker, or
//! one saved with a leading space - or an absolute one that nothing is mounted at (a typo) is simply
//! CREATED, inside the container's own filesystem, and the next image update deletes whatever was
//! written there. So before writing under a saved folder the engine checks that it is a full path
//! that already exists on the server, and says what to fix when it isn't. Twin of Node's
//! src/lib/utils/stored-folder.ts, which the importer and the backup restore use.
use std::path::Path;

/// Why `folder`, as saved (never trimmed here), can't be written under - or None when it can.
/// `example` is the container path to suggest (e.g. "/data/comics"). The wording matches Node's
/// serverPathProblem, so the log and the Settings page say the same thing.
pub fn folder_problem(folder: &str, example: &str) -> Option<String> {
    if folder.trim().is_empty() {
        return Some("No folder is set.".to_string());
    }
    // Saved before Settings trimmed folders: " /data/comics" is a relative path.
    if folder != folder.trim() {
        return Some(format!(
            "\"{folder}\" starts or ends with a space. Save it again in Settings and the space is removed."
        ));
    }
    if !Path::new(folder).is_absolute() {
        let bytes = folder.as_bytes();
        let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
        if !cfg!(windows) && (drive || folder.starts_with("\\\\")) {
            let host_side = if drive {
                folder.replace('\\', "/").trim_end_matches('/').to_string()
            } else {
                "C:/Comics".to_string()
            };
            return Some(format!(
                "\"{folder}\" is a Windows path, and Omnibus runs inside a Linux container that can't see it. \
                 Map the folder into the container in your compose file (e.g. \"- {host_side}:{example}\" under volumes) \
                 and enter the container side: {example}."
            ));
        }
        return Some(if cfg!(windows) {
            format!("\"{folder}\" isn't a full path. Enter the whole folder path (e.g. C:\\Comics).")
        } else {
            format!("\"{folder}\" isn't a full path. Enter the folder as Omnibus sees it inside its container, starting with / (e.g. {example}).")
        });
    }
    match std::fs::metadata(folder) {
        Ok(meta) if meta.is_dir() => None,
        Ok(_) => Some(format!("\"{folder}\" is a file, not a folder.")),
        Err(_) => Some(format!(
            "\"{folder}\" doesn't exist on the server. Check that the folder is mapped into the container in your compose file."
        )),
    }
}

/// `dest` is `root` or somewhere under it. Case-insensitive on Windows, where the stored paths
/// don't always agree on case or slashes; component-wise elsewhere.
fn is_inside(dest: &Path, root: &Path) -> bool {
    if cfg!(windows) {
        let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
        let (dest, root) = (norm(dest), norm(root));
        dest == root || dest.starts_with(&format!("{root}/"))
    } else {
        dest.starts_with(root)
    }
}

/// Why the engine must not create or write into `dest`, a series folder, given `root` - the saved
/// Root Path of the series' library, when it has one. None when it's safe:
/// - the library's Root Path passes `folder_problem`;
/// - `dest` is a full path (a series filed while the Root Path was wrong has a relative one);
/// - a `dest` that doesn't exist yet lies inside that library, so creating it never makes a new
///   top-level folder the server may not have mapped. An existing folder elsewhere is real, and kept.
pub fn series_folder_problem(dest: &Path, root: Option<&str>) -> Option<String> {
    if let Some(root) = root {
        if let Some(problem) = folder_problem(root, "/data/comics") {
            return Some(format!("its library's Root Path can't be used: {problem} Fix it in Settings → Library & Files."));
        }
    }
    if !dest.is_absolute() {
        return Some(format!(
            "its series folder \"{}\" isn't a full path on the server (it was filed while the library's Root Path was wrong). \
             Match the series again in the Smart Matcher.",
            dest.display()
        ));
    }
    if let Some(root) = root {
        if !dest.exists() && !is_inside(dest, Path::new(root)) {
            return Some(format!(
                "its series folder \"{}\" doesn't exist and is outside its library ({root}). Match the series again in the Smart Matcher.",
                dest.display()
            ));
        }
    }
    None
}

/// Why the engine must not write a download to `dest_path`. None when it's safe. Node asks for
/// "<Download Scan Root>/GetComics/<file>"; the engine may create that one "GetComics" folder,
/// never the Download Scan Root itself - a root that doesn't exist here was mistyped or isn't
/// mapped into this container, and the web app could never pick the file up from it.
pub fn download_destination_problem(dest_path: &str) -> Option<String> {
    let dest = Path::new(dest_path);
    if !dest.is_absolute() {
        return Some(format!(
            "The download destination \"{dest_path}\" isn't a full path on the server. Set the Download Scan Root in \
             Settings → Library & Files to a container path (e.g. /data/downloads)."
        ));
    }
    let folder = dest.parent();
    if folder.is_some_and(Path::is_dir) || folder.and_then(Path::parent).is_some_and(Path::is_dir) {
        return None;
    }
    let root = folder.and_then(Path::parent).unwrap_or(dest);
    Some(format!(
        "The download folder \"{}\" doesn't exist on the server. Check the Download Scan Root in Settings → Library & Files, \
         and that it's mapped into the engine container too.",
        root.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        let base = std::env::temp_dir().join(format!("omnibus_server_paths_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    // ==== folder_problem: a saved folder the engine may write under

    #[test]
    fn an_existing_full_path_is_fine() {
        let base = fixture();
        assert_eq!(folder_problem(&base.to_string_lossy(), "/data/comics"), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_empty_folder_is_not_set() {
        assert_eq!(folder_problem("", "/data/comics").as_deref(), Some("No folder is set."));
        assert_eq!(folder_problem("   ", "/data/comics").as_deref(), Some("No folder is set."));
    }

    #[test]
    fn a_folder_saved_with_a_space_around_it_is_refused_as_saved() {
        // Saved before Settings trimmed it: " /data/comics" is a RELATIVE path.
        let base = fixture();
        let padded = format!(" {}", base.to_string_lossy());
        let problem = folder_problem(&padded, "/data/comics").expect("refused");
        assert!(problem.contains("starts or ends with a space"), "{problem}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_relative_folder_is_refused() {
        let problem = folder_problem("comics", "/data/comics").expect("refused");
        assert!(problem.contains("\"comics\" isn't a full path"), "{problem}");
    }

    #[cfg(not(windows))]
    #[test]
    fn a_windows_path_off_windows_says_how_to_map_it() {
        let problem = folder_problem("C:\\Comics\\Library", "/data/comics").expect("refused");
        assert!(problem.contains("\"C:\\Comics\\Library\" is a Windows path"), "{problem}");
        assert!(problem.contains("C:/Comics/Library:/data/comics"), "{problem}");
    }

    #[test]
    fn a_full_path_nothing_is_mounted_at_is_refused() {
        // A typo or an unmapped volume: creating it would write inside the container.
        let base = fixture();
        let missing = base.join("not-mounted");
        let problem = folder_problem(&missing.to_string_lossy(), "/data/comics").expect("refused");
        assert!(problem.contains("doesn't exist on the server"), "{problem}");
        assert!(!missing.exists(), "checking never creates it");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_file_is_not_a_folder() {
        let base = fixture();
        let file = base.join("comics.txt");
        std::fs::write(&file, b"x").unwrap();
        let problem = folder_problem(&file.to_string_lossy(), "/data/comics").expect("refused");
        assert!(problem.contains("is a file, not a folder"), "{problem}");
        let _ = std::fs::remove_dir_all(&base);
    }

    // ==== series_folder_problem: where an import may land

    #[test]
    fn a_new_series_folder_inside_a_good_library_is_fine() {
        let root = fixture();
        let dest = root.join("DC Comics").join("Batman (2016)");
        assert_eq!(series_folder_problem(&dest, Some(&root.to_string_lossy())), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_library_root_that_cannot_be_used_stops_the_import() {
        let base = fixture();
        let root = base.join("not-mounted");
        let dest = root.join("DC Comics").join("Batman (2016)");
        let problem = series_folder_problem(&dest, Some(&root.to_string_lossy())).expect("refused");
        assert!(problem.contains("Root Path"), "{problem}");
        assert!(problem.contains("doesn't exist on the server"), "{problem}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_relative_series_folder_stops_the_import_even_in_a_good_library() {
        // Saved while the library's Root Path was wrong ("C:\Comics/DC Comics/Batman" under Docker).
        let root = fixture();
        let problem = series_folder_problem(Path::new("Comics/DC Comics/Batman (2016)"), Some(&root.to_string_lossy())).expect("refused");
        assert!(problem.contains("isn't a full path"), "{problem}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_series_folder_outside_its_library_is_not_created() {
        let root = fixture();
        let elsewhere = fixture();
        let dest = elsewhere.join("gone").join("Batman (2016)");
        let problem = series_folder_problem(&dest, Some(&root.to_string_lossy())).expect("refused");
        assert!(problem.contains("outside its library"), "{problem}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn an_existing_series_folder_outside_its_library_is_still_used() {
        // A library whose Root Path moved after the series was filed: the old folder is real.
        let root = fixture();
        let elsewhere = fixture();
        assert_eq!(series_folder_problem(&elsewhere, Some(&root.to_string_lossy())), None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn a_series_without_a_library_only_needs_a_full_path() {
        let base = fixture();
        assert_eq!(series_folder_problem(&base.join("Batman (2016)"), None), None);
        assert!(series_folder_problem(Path::new("Batman (2016)"), None).is_some());
        let _ = std::fs::remove_dir_all(&base);
    }

    // ==== download_destination_problem: where a stream download may be written

    #[test]
    fn a_download_into_an_existing_scan_root_is_fine() {
        // The engine may create the one "GetComics" folder Node asks for, never the root itself.
        let root = fixture();
        let dest = root.join("GetComics").join("Batman 001.cbz");
        assert_eq!(download_destination_problem(&dest.to_string_lossy()), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_relative_download_destination_is_refused() {
        let problem = download_destination_problem("downloads/GetComics/Batman 001.cbz").expect("refused");
        assert!(problem.contains("isn't a full path"), "{problem}");
    }

    #[test]
    fn a_download_under_a_scan_root_that_does_not_exist_is_refused() {
        let base = fixture();
        let dest = base.join("not-mounted").join("GetComics").join("Batman 001.cbz");
        let problem = download_destination_problem(&dest.to_string_lossy()).expect("refused");
        assert!(problem.contains("doesn't exist on the server"), "{problem}");
        let _ = std::fs::remove_dir_all(&base);
    }
}
