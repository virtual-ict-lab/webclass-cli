# Quiz and Report Implementation Plan

> Continue implementation in the current session. The user has requested all features together.

**Goal:** Implement interactive and non-interactive quizzes, text submissions, and file submissions.
**Architecture:** Separate network requests, form parsing, attempt state, and CLI presentation.
**Tech Stack:** Bun / TypeScript / node-html-parser / curl (live verification)
**Spec:** ../specs/2026-11-06-write-operations-design.md

## Global Constraints

- Do not submit reports to the live server.
- Keep cookies and authentication URLs out of stdout and fixtures.
- Serialize read requests with at least one second between them. Serialize learning and material requests with 2–3 seconds between them. Never automatically retry mutation operations.

## Review Focus

- Do not resubmit after a redirect fails following a successful POST.
- Preserve omitted answers; clear checkboxes when explicitly given an empty array.
- Reject user input that changes hidden or unknown fields.
- Prevent duplicate sends from concurrent commands or after Ctrl-C.
- Do not treat login or unknown pages as successful submissions.

## Tasks

- [x] 1. src/http.ts, src/urlpolicy.ts, src/errors.ts: GET/POST, multipart, and retry control. Run tests/write-http.test.ts to confirm failure, implement, then rerun.
- [x] 2. src/parsers/attempt.ts, src/forms.ts: parse start screens, questions, results, forms, choices, and text/file constraints from captured fixtures. Confirm failure with tests/attempt-parser.test.ts, implement, then rerun.
- [x] 3. src/attempt-store.ts, src/attempts.ts: open/start/save/next/prev/submit, pending state, and locking. Test mocked transitions and connection loss in tests/attempts.test.ts before implementation.
- [x] 4. src/learning-cli.ts and src/cli.ts: JSON and interactive input/output. Verify report file/text/submit with a mock HTTP server. Add CLI subprocess tests before implementation.
- [x] 5. Update README/CLAUDE.md and fixture provenance, anonymize fixtures, run all tests and type checking, and verify the implementation live with curl.

## Progress

- Investigation: confirmed start, answer saving, and grading with curl. No live report submission.
- Additional user request: `begin` retrieves all questions; `answer` accepts all answers as JSON and saves them one at a time. Space requests 2–3 seconds apart and support `--submit-delay` (alias `--delay`) for an additional wait before final submission.
- Verified the final batch flow live with curl: five answer saves, a minimum request interval of 2042 ms, and a three-second wait before submission.
- Addressed review findings about POST 3xx resends, missing unsupported questions, submission result validation, and retrieval starting on a later page; added regression tests.

## Additional Request: Course Materials

- [x] Inspect actual material screens and attachment URLs with curl, then create anonymized fixtures.
- [x] Implement `materials list / download` for a single item or `--all`, safe filenames, preservation of existing files, and binary downloads, starting with tests.
- [x] Confirm PDF retrieval with curl. Add local-server regression tests for bulk downloads, errors, and output. Update README.

- Materials: retrieved a PDF with curl and verified its signature and file integrity.
- Addressed review findings about direct binary responses and missing media. Added regression tests for finish-screen validation, preservation of existing files, and multiple chapters.
