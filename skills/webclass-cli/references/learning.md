# Quizzes and report submissions

Opening, starting, saving, uploading, and submitting change server state; stay within the user's requested scope.
Opening a material can itself reset or create state. Do not use `open` as a harmless preview.
Use IDs from `courses` and `course`, and check local attempts with `quiz list` before starting a new one.

## Agent quiz workflow

```sh
webclass quiz begin <course-id> <content-id> --yes --pretty
```

`begin` starts the quiz, traverses all pages, and returns to the first page.
`start` accepts exactly one existing attempt ID; it is not an alias for `begin`.
Keep the returned `attempt_id`; do not start another attempt to obtain an ID again.

Read every returned `questions` entry: `id`, `text`, `images` (`url`, `alt`), and `fields`.
Fields contain their native `name`, `type`, current `values`, and available `options` (`value`, `label`), plus applicable constraints.
Use option **values** in answers. Inspect images when needed; text and alt text may not contain enough information to answer.
Image URLs may require browser authentication; do not invent answers or expose credentials to retrieve them.

Create an object keyed by **question ID**. For example, for a text question, a single multiselect question, and a question with a text field followed by a multiselect:

```json
{"1":"100","2":["a","c"],"3":["hello",["b","c"]]}
```

- Single scalar field: string.
- Single checkbox/multiselect field: array of option values; `[]` clears selections.
- Multiple fields: array matching `fields` order, with a nested array for each multiselect.
- Include every question. Unknown IDs, omitted answers, invalid options, and incompatible shapes are rejected before sending.

```sh
webclass quiz answer <attempt-id> --answers answers.json --yes --submit-delay 30
# Equivalent stdin input:
webclass quiz answer <attempt-id> --answers - --yes --submit-delay 30 < answers.json
```

`answer` saves **each question separately**, moves between pages as needed, then submits and returns the result.
Confirm the returned `status` is `submitted`; inspect `summary` and any `score` / `total` fields to describe the result.
Do not follow successful `answer` with another `submit`.
The CLI waits a random 2-3 seconds after each learning response before the next request; do not parallelize commands or add a shell loop around each question.
`--submit-delay N` adds a wait after all answers are saved, before final submission. Default 0; accepts 0-86400 seconds including fractions.
`--delay` is an alias; specify only one. Account for remaining quiz time when choosing a delay.

Branching questions, pages that cannot be revisited, and unrecognized dynamic question widgets are unsupported.
If the CLI refuses them, stop and use the browser for the unsupported work; do not silently omit questions.
If `begin` returns `PARSE_ERROR` while cached status remains `active`, the last confirmed page is available for supported page-by-page operations. Inspect `show` first. The partial catalog is discarded; do not use `answer` for an incomplete multi-page catalog.

## Page-by-page operations

```sh
webclass quiz open <course-id> <content-id> --yes
webclass quiz start <attempt-id> --yes
webclass quiz show <attempt-id> --pretty
webclass quiz save <attempt-id> --answers fields.json
webclass quiz next <attempt-id> --answers fields.json
webclass quiz prev <attempt-id>
webclass quiz submit <attempt-id> --answers fields.json --yes --submit-delay 10
```

Call `start <attempt-id>` only if `open` returned `ready`; an `active` attempt has already started.
`show` reads cached local state, not the current server state.
For `save`, `next`, `prev`, and `submit`, answers use **native HTML field names** from the returned fields, unlike `quiz answer`:

```json
{"QuestionAnswer[1][value][0]":"100"}
```

Omitted fields preserve current values. An empty array clears a multiselect. Hidden authentication fields cannot be overridden.
Standalone `submit --submit-delay N` waits before its submission request; use `save` first if answers must be stored before the wait.

## Reports

Report submission has been tested with synthetic forms and a local HTTP server, but not against a live report assignment. Unexpected forms must not be treated as successful submissions.

```sh
webclass report open <course-id> <content-id> --yes
webclass report start <attempt-id> --yes
webclass report show <attempt-id> --pretty
webclass report text <attempt-id> --question 1 --text-file report.txt
webclass report file <attempt-id> --question 2 --file report.pdf --yes
webclass report submit <attempt-id> --yes
```

Use the returned ID and actual question numbers. Run `start` only for `ready` state.
`text` accepts questions on the current page only. Use `report next <attempt-id>` or `report prev <attempt-id>` to reach a question on another page before saving its text.
`text` immediately saves the question's single textarea. `file` immediately uploads and checks a receipt, and may replace an existing upload.
File format and size constraints come from the form. An upload receipt alone is not final submission: finish with `submit` and inspect the confirmed result.
The final result must have `status: "submitted"`; report the returned `summary`. An `active` state is not confirmation, and report assignments may have no numeric grade.

## Interactive use

```sh
webclass quiz run
webclass quiz run <course-id> <content-id> --submit-delay 30
webclass quiz resume <attempt-id>
webclass report run
```

These commands require an interactive terminal; agents should use the JSON workflows above.
For textareas, `@report.txt` loads multiline text. Empty input keeps the current value.
`quit` discards unsent input but retains the local attempt. It does not undo earlier saves or uploads.

## Uncertain or interrupted operations

Initial read-only discovery can return exit 3 (`SESSION_EXPIRED`) before opening content. Refresh cookies with `webclass login --stdin`, then retry discovery. A safe read retains its original error code; exit 7 applies when a state-changing request was sent and its result could not be verified.

Server-issued cookie rotation preserves an attempt's identity across processes when using the saved session. A manual login with different credentials does not rebind earlier attempts. `WEBCLASS_COOKIE` overrides do not inherit the saved identity. If the session differs, check the earlier attempt in WebClass instead of editing local state to force a match.

On exit 7 (`OPERATION_UNCERTAIN`), or local `pending`/`uncertain` state, stop sending learning requests.
Inspect `quiz list` / `quiz show <attempt-id>` for cached context, then check the attempt in WebClass through the browser.
Report whether it was submitted, remains active, or cannot be determined. Never report an unconfirmed submission as successful.

`resume` is not an uncertain-state repair command. No refresh, sync, or force-retry command exists.
Do not edit state, remove locks, or abandon an attempt merely to bypass retry protection.
If the user intentionally ends local tracking after verifying server state, `quiz abandon <attempt-id> --yes` marks it abandoned locally. This neither cancels the server attempt nor reverses saved work.
