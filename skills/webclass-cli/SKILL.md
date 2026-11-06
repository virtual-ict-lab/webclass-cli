---
name: webclass-cli
description: Use when working with KOSEN WebClass through the webclass CLI, including installation, cookie login, courses, deadlines, course materials and PDFs, quizzes, report submissions, or CLI troubleshooting.
---

# WebClass CLI

Operate KOSEN WebClass using `webclass`. Use this skill for end-user operations and agent automation; implementation changes belong to the repository's development instructions.

## Set up

The skill contains instructions, not the executable. Check `webclass --help`. If unavailable, install [Bun](https://bun.sh/) and clone into a user-chosen location:

```sh
git clone https://github.com/mothue/webclass-cli.git
cd webclass-cli
bun install --frozen-lockfile
bun link
webclass --help
```

Keep the checkout because the linked command uses its source. If `webclass` is still unavailable, add the directory from `bun pm bin -g` to `PATH`, or invoke `bun /absolute/path/to/webclass-cli/src/cli.ts`. Skill installation alone does not install or authenticate the CLI. Do not assume an npm package exists.

## Authenticate

Run `webclass status --deep`. On exit 3, have the user sign in through their browser and import a fresh cookie header with `webclass login --stdin`. The header needs `WBT_Session`; it can also include `WCAC=Authenticated`. SAML cookies alone are insufficient.

Use private stdin or an existing `WEBCLASS_COOKIE` environment variable. Keep credentials, raw authenticated HTML, and attempt-state files out of messages, logs, and repositories. Do not automate SAML login.

## Choose the workflow

| User request | Command / reference |
| --- | --- |
| Find courses | `webclass courses` |
| Find a course's contents | `webclass course <course-id>` |
| Upcoming deadlines | `webclass deadlines --days 7` |
| List materials | `webclass materials list <course-id>` |
| Download one material | `webclass materials download <course-id> <content-id> --out ./materials` |
| Download a course's materials | `webclass materials download <course-id> --all --out ./materials` |
| Start and answer a quiz | Read [learning.md](references/learning.md) |
| Submit report text or a file | Read [learning.md](references/learning.md) |

Discover IDs from returned data. Check the selected course, content name, category, and `openable` before opening it. Use existing user authorization for the requested operation; a listing request alone does not authorize starting a quiz or submitting work.

Use default JSON stdout for automation. Progress and errors use stderr; `--pretty` formats JSON and `--human` selects text. Put flags after the command name. Read [commands.md](references/commands.md) for term selection, response fields, configuration, and errors.

## Interpret results

- Check `deadlines.errors`; a partial scan is not an empty schedule. Material availability end dates are also deadlines.
- Downloads can include non-PDF attachments and update viewing history. Report `skipped` items and external `links`; `--all` covers one course. Process multiple courses sequentially.
- Quiz `answer` saves and submits. Do not submit again after it succeeds. The CLI handles pacing and optional final delay.
- Exit 7 / `OPERATION_UNCERTAIN`, `pending`, or `uncertain`: stop retransmission and verify the attempt in the WebClass browser. `show` is cached; `abandon` only ends local tracking. Neither reconciles server state. Do not clear locks or edit state to force a retry.
- `news` and `inbox` are not implemented. Report submissions are locally tested but live-unverified; do not claim a successful submission without a confirmed result.
