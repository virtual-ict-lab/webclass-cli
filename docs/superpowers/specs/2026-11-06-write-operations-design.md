# WebClass CLI Quiz and Report Operations

User request: implement interactive quizzes, text and file report submissions, and non-interactive commands for agents together. Use curl for live requests. Do not submit reports to the live server; verify them locally.

## Design

- Preserve the read-only policy for existing list commands. The learning client allows GET and POST only on observed content routes while enforcing the same origin, base path, and logout restrictions.
- Never retry POST or learning GET requests. Connection loss after sending, HTTP 5xx responses, and result retrieval failures produce `OPERATION_UNCERTAIN` (exit 7). Stop on POST 307/308 redirects without resending; convert 301/302/303 redirects to GET.
- Provide `quiz open/start/show/save/next/prev/submit/run`. `open` resolves the content link from the course listing and stores the start screen; `start` submits its start button. Use the observed mobile forms for navigation.
- `quiz run` is interactive; the other commands return JSON. Accept answers as JSON keyed by the actual form field names. Preserve server hidden values and reject attempts to override them through answer JSON.
- Non-interactive commands use a local attempt ID. Store pages, forms, and state in XDG state files with mode 0600. Persist `pending` before each operation so crashes and connection loss cannot replay stale pages. Lock each attempt against concurrent operations.
- `report` uses the same start flow and state management, with `text/file/submit/run` commands. Upload files as multipart data to `mbl.php/questions/api?api=upload`, using `set_contents_id`, `question_no`, and `upload_file` as observed in the page JavaScript. Stop with a parsing error on unknown pages.
- Display question text, image links, choices, current values, and constraints. Stop explicitly on unsupported dynamic questions instead of submitting incomplete answers.
- Update configuration, documentation, and tests. Preserve the existing uncommitted implementation. Do not commit or push during this work.

## Live evidence

2026-11-06: a self-study quiz followed `show_info.php` with the server's `next=開始` field, then `do_contents.php`, `qstn_frame.php`, and `mbl.php/questions/`. `QstnSession[cmd]=restart` saved answers, and `finish` graded them. Saving five answers and retrieving the grading result were verified with curl. No report was submitted.
