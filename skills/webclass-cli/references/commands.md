# Commands, output, and configuration

All examples assume `webclass` is installed. JSON is the default; do not add `--json`.
Place `--pretty` and `--human` after the command name, for example `webclass materials list <course-id> --pretty`.

## Authentication and configuration

Sign in through the browser at the configured WebClass URL, then obtain the `WBT_Session` cookie from DevTools > Application/Storage > Cookies.
Pass a cookie header such as `WBT_Session=YOUR_SESSION; WCAC=Authenticated` through private stdin:

```sh
webclass login --stdin < /path/to/private-cookie-header.txt
# macOS, when the header is already on the clipboard:
pbpaste | webclass login --stdin
webclass status --deep
webclass forget
```

`login` saves the cookies and verifies them; `--no-verify` skips verification.
With no input flags, `login` reads `WEBCLASS_COOKIE`. For other commands, this environment variable overrides the saved session without persisting it.
`forget` deletes only the local session file and does not log out on the server.

The default URL is `https://webclass.kosen-k.go.jp/webclass/`.
`WEBCLASS_BASE_URL` overrides `base_url` in `$XDG_CONFIG_HOME/webclass/config.toml` (default `~/.config/webclass/config.toml`).
HTTPS is required, except for localhost testing.

Session data lives in `$XDG_STATE_HOME/webclass/session.json` (default `~/.local/state/webclass/session.json`).
Attempt data lives in the adjacent `attempts/` directory. State files are private and may contain authenticated form data: inspect them only when needed for debugging, and never share raw contents.

## Courses and deadlines

```sh
webclass courses --year 2026 --semester 2
webclass courses --year all --semester all
webclass course <course-id>
webclass deadlines --days 7
```

`courses`, `course`, and `deadlines` accept `--year` (four digits or `all`) and `--semester` (`1`, `2`, `3`, or `all`).
Semesters are first, second, and outside term respectively. Omitted values use the server's current selection.
`course` searches all terms when the requested ID is missing from the default course list.

`courses` returns `{year, semester, semester_label, courses}`.
Each course has `id`, `name`, and `schedule`; each schedule entry has `day`, `weekday` (Sunday=0 through Saturday=6, or null), and `period`.
An empty schedule does not mean the course is inaccessible.

`course` returns `{course, folders}`. Each folder has `id`, `name`, and `contents`:

| Content field | Meaning |
| --- | --- |
| `id`, `name`, `folder_id` | Material identity and folder |
| `category` | The server's label, e.g. `資料`, `自習`, `ユニット`; may be null |
| `openable` | Whether the material can currently be opened |
| `end_date`, `end_date_unix` | Deadline in ISO 8601 with JST offset, and Unix seconds; nullable |
| `available_from`, `available_until` | Availability in JST; nullable |
| `exec_count` | Usage count; not proof of successful submission |
| `resubmit_available` | Whether resubmission is available |
| `is_new` | Whether WebClass marks the content as new |
| `unit_contents` | Child material names within a unit |

`deadlines` returns `{generated_at, days, year, semester, courses_scanned, items, errors}`.
Items add `course_id`, `course_name`, `folder_name`, and `seconds_left` to content fields.
They are sorted by deadline; expired and undated items are omitted. Default horizon: seven days.
There is no category filter: a material's publication end can appear alongside assignment deadlines.
Inspect `errors` before claiming the scan is complete. Session expiry aborts the whole command.

## Downloads

```sh
webclass materials list <course-id>
webclass materials download <course-id> <content-id> --out ./materials
webclass materials download <course-id> --all --out ./materials
```

Only the `資料` category is downloaded. `--all` covers available materials in one course, not all enrolled courses; run separate courses sequentially.
There is no PDF-only flag. Supported resources include PDF viewer attachments, direct PDF/Office downloads, embedded media, and `.txt` files for pages without attachments.
External links are returned without following them or forwarding cookies.

Result shape: `{course_id, materials, skipped}`. Each downloaded material has `id`, `name`, `pages`, `files`, and `links`.
Files include `path`, `bytes`, `sha256`, and `status` (`saved` or `existing`). Links include `url` and `label`.
Unavailable materials appear in `skipped`. If a later download fails, already saved files remain; inspect error details for partial results.

The output root defaults to `./downloads/webclass`; each course and material gets a subdirectory.
Identical existing files are reused; changed files with the same name get a hash suffix. Existing files are never overwritten.
Limits: 100 pages per material and 100 MiB per file.
Downloads open and close materials, so viewing history can change. An unfinished local learning attempt blocks downloads.

## Errors and recovery

Success returns JSON on stdout with exit 0. Failure writes `{"error":{"code":"...","message":"...","details":{}}}` to stderr and exits nonzero; `details` is optional.
Learning/download progress also uses stderr, so do not parse the entire stderr stream as one JSON object.

| Exit | Error code | Action |
| --- | --- | --- |
| 1 | `ERROR`, `COURSE_NOT_FOUND`, `NOT_IMPLEMENTED` | Inspect the message and chosen IDs |
| 2 | `USAGE` | Correct arguments using `webclass --help` or the command's `--help` |
| 3 | `NOT_LOGGED_IN`, `SESSION_EXPIRED` | Obtain a fresh browser session; do not repeat failed login requests |
| 4 | `HTTP_ERROR` | A read request failed after retries; retry later if still needed |
| 5 | `BLOCKED_URL` | Stop; do not bypass the URL policy |
| 6 | `PARSE_ERROR`, `UNEXPECTED_PAGE` | Stop and report the unsupported page structure |
| 7 | `OPERATION_UNCERTAIN` | Check server state in the browser; do not replay the operation |

Read commands run sequentially with at least one second between requests and at most two retries.
Learning and download requests run sequentially, wait 2-3 seconds after responses, and are not automatically retried.
An interrupted learning operation may remain `pending` or `uncertain` even after the process stops.
There is no CLI command to reconcile an uncertain attempt with the server. Do not infer success from `status --deep`, which checks authentication only.
