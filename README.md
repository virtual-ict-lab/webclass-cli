# webclass-cli

## Installation

### CLI

Install [Bun](https://bun.sh/), then clone and link the CLI:

```sh
git clone https://github.com/mothue/webclass-cli.git
cd webclass-cli
bun install --frozen-lockfile
bun link
webclass --help
```

Keep the checkout: `bun link` points the `webclass` command at its source files.
If the command is not found, add Bun's global binary directory (shown by `bun pm bin -g`) to your `PATH`.
You can also run `bun src/cli.ts <command>` from the checkout.

### Agent skill

After installing the CLI, install the skill from the project where you use your agent:

```sh
bunx skills add mothue/webclass-cli
```

Select `webclass-cli` and your agent. Add `-g` to install across projects, or select an agent explicitly:

```sh
bunx skills add mothue/webclass-cli --skill webclass-cli -a codex -g
```

To install from a local checkout, replace `mothue/webclass-cli` with its absolute path.
The skill provides agent instructions; it does not install the CLI or sign you in.

## Usage

### Sign in

Sign in to [KOSEN WebClass](https://webclass.kosen-k.go.jp/webclass/) in your browser.
In DevTools, open Application (or Storage) > Cookies and copy the `WBT_Session` cookie.
Prepare a cookie header such as `WBT_Session=YOUR_SESSION; WCAC=Authenticated`, then pass it through stdin:

```sh
# macOS: read the cookie header from the clipboard
pbpaste | webclass login --stdin

# Any platform: read it from a private file
webclass login --stdin < /path/to/private-cookie-header.txt

webclass status --deep
webclass forget
```

`login` saves and verifies the session. `forget` removes the saved local credentials without signing out on the server.
Server-issued cookie updates preserve existing attempts when using a saved session. A manual login with different credentials does not rebind earlier attempts.
The CLI does not automate browser or SAML login. Avoid putting cookie values in shell history.

### Courses and deadlines

```sh
webclass courses --human
webclass courses --year 2026 --semester 2 --pretty
webclass course <course-id> --pretty
webclass deadlines --days 7 --human
```

Use IDs returned by `courses` and `course`. Semester values are `1` (first), `2` (second), `3` (outside term), or `all`.
Omitting the term uses WebClass's current selection; `--year all --semester all` searches all terms.
Deadlines can include the end of a material's availability period, so check the item category before treating it as an assignment.

### Download course materials

```sh
webclass materials list <course-id> --human
webclass materials download <course-id> <content-id> --out ./materials
webclass materials download <course-id> --all --out ./materials
```

Downloads include PDFs, other attachments, and text-only pages. `--all` downloads available materials in one course and reports unavailable items as skipped.
The default destination is `./downloads/webclass/<course-id>/<content-id>-<name>/`.
Identical files are reused; different files with the same name receive a hash suffix. Existing files are not overwritten.
External links are listed in the result. Opening materials may update viewing history.

### Interactive quizzes and reports

```sh
webclass quiz run
webclass quiz run <course-id> <content-id>
webclass quiz resume <attempt-id>
webclass report run
```

Run these commands in a terminal to select materials, enter answers, and confirm submission.
For a multiline text field, enter `@report.txt` to load a file.

### Answer a quiz with JSON

Start the selected quiz and retrieve all questions:

```sh
webclass quiz begin <course-id> <content-id> --yes --pretty
```

Use the returned `attempt_id` and question IDs. Create `answers.json` with an answer for every question:

```json
{"1":"100","2":["a","c"],"3":["first blank","second blank"]}
```

A single text field takes a string. A single checkbox or multiselect field takes an array of option values.
For multiple fields, use an array in the order of `fields`, nesting arrays for fields with multiple selections.
Use each option's `value`, not its display label.

```sh
webclass quiz answer <attempt-id> --answers answers.json --yes --submit-delay 30
# Or read the JSON from stdin:
webclass quiz answer <attempt-id> --answers - --yes < answers.json
```

`answer` validates all answers, saves them one question at a time, and submits the quiz.
Learning requests run sequentially with a random 2-3 second interval after each response.
`--submit-delay 30` adds a 30-second wait after all answers are saved and before submission.
The default is zero; values from 0 to 86400 seconds, including fractions, are accepted. `--delay` is an alias.

### Submit a report

```sh
webclass report open <course-id> <content-id> --yes
webclass report start <attempt-id> --yes
webclass report text <attempt-id> --question 1 --text-file report.txt
webclass report file <attempt-id> --question 2 --file report.pdf --yes
webclass report submit <attempt-id> --yes
```

Use the returned attempt ID and actual question numbers. Run `start` only when `open` returns `status: "ready"`.
`text` saves a question on the current page. Use `report next <attempt-id>` or `report prev <attempt-id>` to reach a question on another page.
Text is saved immediately; files are uploaded immediately and may replace a previous upload.
Run `submit` to finish. Report submission has been tested locally with synthetic forms, but has not been verified against a live report assignment.

### Individual quiz operations

```sh
webclass quiz open <course-id> <content-id> --yes
webclass quiz start <attempt-id> --yes
webclass quiz show <attempt-id> --pretty
webclass quiz save <attempt-id> --answers fields.json
webclass quiz next <attempt-id> --answers fields.json
webclass quiz prev <attempt-id>
webclass quiz submit <attempt-id> --answers fields.json --yes
webclass quiz list
webclass quiz abandon <attempt-id> --yes
```

Unlike `quiz answer`, `save`, `next`, `prev`, and `submit` use HTML field names as keys:

```json
{"QuestionAnswer[1][value][0]":"100"}
```

Omitted fields keep their current values. `show` reads local state without refreshing from the server.
`start` accepts exactly one attempt ID; use `begin <course-id> <content-id>` to start and collect all questions.
`abandon` ends local tracking only; it does not cancel or undo a server-side attempt.
If initial course discovery fails with code `3` (`SESSION_EXPIRED`), refresh the saved cookies with `login` before trying again.
If a command exits with code `7` (`OPERATION_UNCERTAIN`), check the attempt in WebClass before any further action. Do not automatically resend it.

### Output and configuration

Commands return JSON on stdout by default. Use `--pretty` for formatted JSON or `--human` for readable text, after the command name.
Progress and errors go to stderr. For automation, see the [agent command reference](skills/webclass-cli/references/commands.md).

| Setting | Default / behavior |
| --- | --- |
| `WEBCLASS_COOKIE` | Overrides the saved session for the current process without saving it |
| `WEBCLASS_BASE_URL` | Overrides the WebClass URL; defaults to `https://webclass.kosen-k.go.jp/webclass/` |
| `$XDG_CONFIG_HOME/webclass/config.toml` | Defaults to `~/.config/webclass/config.toml`; supports `base_url = "https://.../webclass/"` |
| `$XDG_STATE_HOME/webclass/` | Defaults to `~/.local/state/webclass/`; contains private session and attempt files |

```sh
webclass --help
webclass quiz --help
webclass report --help
webclass materials --help
```
