// Naming: the one place a series folder or an issue's file name is built from a naming pattern.
//
// EXACT TWIN of Node's src/lib/utils/naming.ts. Both sides must turn the same inputs into
// byte-identical names - a file lands under the same name whichever door it came through
// (Standardize, the watched folder, an import, the Smart Matcher). Pinned by
// tests/fixtures/naming_parity.json, which both test suites read.
//
// The rules, in short:
//   - one pass over the pattern: every {Token} (any case) is looked up once and its value is
//     inserted literally - a value is never expanded again, and "$&" in metadata stays "$&";
//   - an unknown token stays as written;
//   - {Issue} is padded by the issue_number_padding setting (#244), default 3 digits;
//   - a year that isn't 1900-2100 is no year: it leaves no "(0000)" and no empty "()";
//   - a folder is plain path segments (never "..", ".", a dots-only run or a drive prefix); a file
//     name is sanitized whole, so nothing in it can become a path.
use regex::{Captures, Regex};
use serde::Deserialize;
use std::sync::OnceLock;

/// The `issue_number_padding` setting: how many digits an issue number's whole part gets in a
/// file name (#244).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IssuePadding {
    None,
    Two,
    Three,
}

impl IssuePadding {
    /// "none", "2" or "3"; missing, blank or anything else is the default, 3 digits - the width
    /// Standardize always used, so a standardized library is never renamed by it.
    pub(crate) fn from_setting(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("none") => IssuePadding::None,
            Some("2") => IssuePadding::Two,
            _ => IssuePadding::Three,
        }
    }

    fn width(self) -> usize {
        match self {
            IssuePadding::None => 1,
            IssuePadding::Two => 2,
            IssuePadding::Three => 3,
        }
    }
}

/// An issue number as a file name shows it: the leading whole number loses its stored zeros and
/// is padded to the setting's width; everything after it stays as it is ("1.5" → "001.5",
/// "1A" → "001A", "-1" → "-001"). A fraction is a decimal first ("½" → "000.5"). A number that
/// doesn't start with digits ("Annual 1") is left alone.
pub(crate) fn pad_issue(number: &str, padding: IssuePadding) -> String {
    let normalized = crate::metadata::normalize_fraction_numbers(number.trim());
    let (sign, rest) = match normalized.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", normalized.as_str()),
    };
    let digits_end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    let (digits, tail) = rest.split_at(digits_end);
    if digits.is_empty() && !tail.is_empty() && !tail.starts_with('.') {
        return normalized;
    }
    format!("{sign}{:0>width$}{tail}", digits.trim_start_matches('0'), width = padding.width())
}

/// A year a name may show: 1900-2100. Anything else - 0 for unknown, a ComicVine id in <Year>,
/// a placeholder date - is no year.
fn plausible_year(year: i32) -> Option<i32> {
    (1900..=2100).contains(&year).then_some(year)
}

fn year_text(year: i32) -> String {
    plausible_year(year).map(|y| y.to_string()).unwrap_or_default()
}

/// {IssueYear} (#243): the issue's own release year, else the file's ComicInfo <Year>, else the
/// series year, else nothing.
pub(crate) fn issue_year(release_date: Option<&str>, comicinfo_year: Option<i32>, series_year: i32) -> String {
    release_date
        .and_then(|d| d.trim().get(..4))
        .and_then(|y| y.parse::<i32>().ok())
        .and_then(plausible_year)
        .or_else(|| comicinfo_year.and_then(plausible_year))
        .or_else(|| plausible_year(series_year))
        .map(|y| y.to_string())
        .unwrap_or_default()
}

/// What a name is built from. Each caller fills what it knows; blanks are fine.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct NamingInput {
    pub publisher: Option<String>,
    /// The {Series} value (a LOCAL collected edition's own name, for its books).
    pub series: String,
    /// The series' start year; 0 = unknown.
    pub series_year: i32,
    pub issue_number: String,
    pub release_date: Option<String>,
    pub comic_info_year: Option<i32>,
    pub issue_title: Option<String>,
    pub universe: Option<String>,
    pub series_group: Option<String>,
    pub imprint: Option<String>,
}

/// Strips characters invalid in file/folder names and neutralizes dot-only values, so a value can
/// never become a "." or ".." path segment ("_" instead). Twin: Node sanitizeFilename.
pub(crate) fn sanitize_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect();
    let cleaned = cleaned.trim();
    let safe = cleaned.trim_start_matches('.').trim_end_matches('.').trim();
    if safe.is_empty() && !cleaned.is_empty() {
        return "_".to_string();
    }
    safe.to_string()
}

/// Removes what an empty token leaves behind: empty "()" and "[]", and in a file name doubled or
/// dangling " - " separators; squeezes whitespace.
fn clean_pattern_result(s: &str, file_mode: bool) -> String {
    static EMPTY_PARENS: OnceLock<Regex> = OnceLock::new();
    static EMPTY_BRACKETS: OnceLock<Regex> = OnceLock::new();
    static DOUBLE_HYPHEN: OnceLock<Regex> = OnceLock::new();
    static EDGE_HYPHEN: OnceLock<Regex> = OnceLock::new();
    static MULTI_SPACE: OnceLock<Regex> = OnceLock::new();

    let mut out = EMPTY_PARENS.get_or_init(|| Regex::new(r"\(\s*\)").unwrap()).replace_all(s, "").to_string();
    out = EMPTY_BRACKETS.get_or_init(|| Regex::new(r"\[\s*\]").unwrap()).replace_all(&out, "").to_string();
    if file_mode {
        out = DOUBLE_HYPHEN.get_or_init(|| Regex::new(r"\s*-\s*-").unwrap()).replace_all(&out, " - ").to_string();
        out = EDGE_HYPHEN.get_or_init(|| Regex::new(r"(^\s*-\s*|\s*-\s*$)").unwrap()).replace_all(&out, "").to_string();
    }
    out = MULTI_SPACE.get_or_init(|| Regex::new(r"\s+").unwrap()).replace_all(&out, " ").to_string();
    out.trim().to_string()
}

/// One pass over `pattern`: each {Token} is replaced by `value(lowercased name)`, inserted
/// literally; a token `value` doesn't know stays as written.
fn expand_tokens(pattern: &str, value: impl Fn(&str) -> Option<String>) -> String {
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    TOKEN
        .get_or_init(|| Regex::new(r"\{([A-Za-z]+)\}").unwrap())
        .replace_all(pattern, |c: &Captures| value(&c[1].to_ascii_lowercase()).unwrap_or_else(|| c[0].to_string()))
        .into_owned()
}

fn sanitized(value: &Option<String>) -> String {
    value.as_deref().map(sanitize_component).unwrap_or_default()
}

/// A folder segment that can only ever name a folder: not "..", ".", a dots-only run or a drive
/// prefix.
fn is_plain_segment(segment: &str) -> bool {
    let b = segment.as_bytes();
    let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    !segment.chars().all(|c| c == '.') && !drive
}

/// The series folder for `pattern`, as the path segments under the library root. None when a
/// segment isn't a plain name or nothing is left - a series folder is always a folder INSIDE the
/// library. Twin: Node seriesFolderSegments.
pub(crate) fn folder_segments(pattern: &str, v: &NamingInput) -> Option<Vec<String>> {
    let publisher = match v.publisher.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() && p != "Unknown" => sanitize_component(p),
        _ => "Other".to_string(),
    };
    let series = sanitize_component(if v.series.trim().is_empty() { "Unknown" } else { &v.series });
    let year = year_text(v.series_year);
    let expanded = expand_tokens(pattern, |token| match token {
        "imprint" => Some(sanitized(&v.imprint)),
        "publisher" => Some(publisher.clone()),
        "series" => Some(series.clone()),
        "year" | "volumeyear" => Some(year.clone()),
        "universename" => Some(sanitized(&v.universe)),
        "seriesgroup" => Some(sanitized(&v.series_group)),
        _ => None,
    });
    let segments: Vec<String> = clean_pattern_result(&expanded, false)
        .split(['/', '\\'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if segments.is_empty() || !segments.iter().all(|s| is_plain_segment(s)) {
        return None;
    }
    Some(segments)
}

/// One issue's file name for `pattern`, without the extension. None when nothing is left.
/// Publisher and series go in as they are (the whole name is sanitized at the end, so a name
/// keeps an inner or trailing period); the other text values are sanitized on the way in.
/// Twin: Node issueFileName.
pub(crate) fn file_name(pattern: &str, v: &NamingInput, padding: IssuePadding) -> Option<String> {
    let publisher = match v.publisher.as_deref() {
        Some(p) if !p.trim().is_empty() => p.to_string(),
        _ => "Unknown".to_string(),
    };
    let series = if v.series.trim().is_empty() { "Unknown".to_string() } else { v.series.clone() };
    let year = year_text(v.series_year);
    let issue_year = issue_year(v.release_date.as_deref(), v.comic_info_year, v.series_year);
    let issue = pad_issue(&v.issue_number, padding);
    let expanded = expand_tokens(pattern, |token| match token {
        "imprint" => Some(sanitized(&v.imprint)),
        "publisher" => Some(publisher.clone()),
        "series" => Some(series.clone()),
        "year" | "volumeyear" => Some(year.clone()),
        "issueyear" => Some(issue_year.clone()),
        "issue" => Some(issue.clone()),
        "issuetitle" => Some(sanitized(&v.issue_title)),
        "universename" => Some(sanitized(&v.universe)),
        "seriesgroup" => Some(sanitized(&v.series_group)),
        _ => None,
    });
    let name = sanitize_component(&clean_pattern_result(&expanded, true));
    (!name.is_empty()).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==== Parity with Node (src/lib/utils/naming.ts): both suites read the same cases.

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Parity {
        pad_issue: Vec<(String, String, String)>,
        issue_year: Vec<YearCase>,
        files: Vec<FileCase>,
        folders: Vec<FolderCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct YearCase {
        release_date: Option<String>,
        comic_info_year: Option<i32>,
        series_year: i32,
        expected: String,
    }

    #[derive(Deserialize)]
    struct FileCase {
        label: String,
        pattern: String,
        padding: String,
        input: NamingInput,
        expected: Option<String>,
    }

    #[derive(Deserialize)]
    struct FolderCase {
        label: String,
        pattern: String,
        input: NamingInput,
        expected: Option<Vec<String>>,
    }

    fn parity() -> Parity {
        serde_json::from_str(include_str!("../tests/fixtures/naming_parity.json")).expect("naming_parity.json parses")
    }

    #[test]
    fn issue_numbers_pad_the_leading_whole_number_and_keep_the_rest() {
        let mut wrong = Vec::new();
        for (number, padding, expected) in parity().pad_issue {
            let got = pad_issue(&number, IssuePadding::from_setting(Some(&padding)));
            if got != expected {
                wrong.push(format!("{number:?} at {padding:?}: got {got:?}, want {expected:?}"));
            }
        }
        assert!(wrong.is_empty(), "padding mismatches:\n{}", wrong.join("\n"));
    }

    #[test]
    fn the_issue_year_is_the_issues_own_then_the_files_then_the_series_and_never_implausible() {
        let mut wrong = Vec::new();
        for c in parity().issue_year {
            let got = issue_year(c.release_date.as_deref(), c.comic_info_year, c.series_year);
            if got != c.expected {
                wrong.push(format!("{:?}/{:?}/{}: got {got:?}, want {:?}", c.release_date, c.comic_info_year, c.series_year, c.expected));
            }
        }
        assert!(wrong.is_empty(), "issue-year mismatches:\n{}", wrong.join("\n"));
    }

    #[test]
    fn file_names_match_the_parity_table() {
        let mut wrong = Vec::new();
        for c in parity().files {
            let got = file_name(&c.pattern, &c.input, IssuePadding::from_setting(Some(&c.padding)));
            if got != c.expected {
                wrong.push(format!("{}: got {got:?}, want {:?}", c.label, c.expected));
            }
        }
        assert!(wrong.is_empty(), "file-name mismatches:\n{}", wrong.join("\n"));
    }

    #[test]
    fn folders_match_the_parity_table() {
        let mut wrong = Vec::new();
        for c in parity().folders {
            let got = folder_segments(&c.pattern, &c.input);
            if got != c.expected {
                wrong.push(format!("{}: got {got:?}, want {:?}", c.label, c.expected));
            }
        }
        assert!(wrong.is_empty(), "folder mismatches:\n{}", wrong.join("\n"));
    }

    #[test]
    fn the_padding_setting_defaults_to_three_digits() {
        assert_eq!(IssuePadding::from_setting(None), IssuePadding::Three);
        assert_eq!(IssuePadding::from_setting(Some("")), IssuePadding::Three);
        assert_eq!(IssuePadding::from_setting(Some("4")), IssuePadding::Three);
        assert_eq!(IssuePadding::from_setting(Some(" 2 ")), IssuePadding::Two);
        assert_eq!(IssuePadding::from_setting(Some("none")), IssuePadding::None);
    }

    // ==== Kept from renamer.rs / watched_sync.rs, where these rules used to live.

    #[test]
    fn sanitize_component_matches_node_sanitize_filename() {
        assert_eq!(sanitize_component("Batman: Year One"), "Batman Year One");
        assert_eq!(sanitize_component("  What?  "), "What");
        assert_eq!(sanitize_component(".."), "_");
        assert_eq!(sanitize_component("..evil"), "evil");
        assert_eq!(sanitize_component("trailing..."), "trailing");
        assert_eq!(sanitize_component(""), "");
        for dots in ["..", ".", "...", " .. "] {
            assert_eq!(sanitize_component(dots), "_", "{dots:?}");
        }
        assert_eq!(sanitize_component("../.."), "_");
        assert_eq!(sanitize_component("..\\etc"), "etc");
        assert_eq!(sanitize_component("Mr. Miracle"), "Mr. Miracle");
    }

    #[test]
    fn clean_pattern_result_matches_node_replace_chains() {
        // Folder mode: empty () / [] dropped, whitespace collapsed.
        assert_eq!(clean_pattern_result("DC/Batman ( )", false), "DC/Batman");
        assert_eq!(clean_pattern_result("Marvel/X [ ]  Men", false), "Marvel/X Men");
        // File mode also collapses double hyphens and strips edge hyphens.
        assert_eq!(clean_pattern_result("Batman - - 001", true), "Batman - 001");
        assert_eq!(clean_pattern_result(" - Batman 001 - ", true), "Batman 001");
    }

    #[test]
    fn non_ascii_pattern_text_and_values_pass_through() {
        let v = NamingInput { series: "Ästhetik".into(), issue_number: "1".into(), ..Default::default() };
        assert_eq!(file_name("{Series} – Nº {Issue}", &v, IssuePadding::Three).as_deref(), Some("Ästhetik – Nº 001"));
    }

    #[test]
    fn dot_dot_metadata_can_never_climb_out_of_the_library_root() {
        let v = NamingInput {
            publisher: Some("..".into()),
            series: "../../etc".into(),
            universe: Some("..".into()),
            series_group: Some("..\\..".into()),
            imprint: Some("..".into()),
            ..Default::default()
        };
        let segments = folder_segments("{Imprint}/{Publisher}/{UniverseName}/{SeriesGroup}/{Series}", &v).expect("plain segments");
        assert!(segments.iter().all(|s| s != ".." && s != "."), "{segments:?}");
    }
}
