# Fixtures

## Usage

Run the parser and fixture checks from the repository root:

```sh
bun test
bun scripts/anonymize.ts --check tests/fixtures/*.html
```

Load fixture HTML with `fixture(name)` from `tests/helpers.ts`. Network tests use local mock responses; these files do not authenticate to WebClass.

| Files | Intended use |
| --- | --- |
| `index.html`, `course.html` | Course lists, timetable deduplication, folders, deadlines, and availability |
| `pagejump-expired.html`, `course-login-jump.html` | HTTP 200 JavaScript redirects |
| `login-page.synthetic.html` | A minimal synthetic expired-session screen |
| `news*.html`, `inbox*.html` | Empty news screens and message-list structures |
| `quiz-start.html`, `quiz-frame.html` | Start forms and mobile question routing |
| `quiz-questions.html`, `quiz-saved.html`, `quiz-result.html` | Question fields, save responses, and result parsing |
| `material-start.html`, `material-frame.html`, `material-textbook.html`, `material-loadit.html`, `material-pdf-link.html` | The material viewer and PDF wrapper chain |

Except for the explicitly synthetic login page, HTML structures were captured with curl and then sanitized. Course and resource IDs, names, timetable entries, question text, answers, grades, timestamps, message subjects, and attachment metadata are fictional replacements. Authentication tokens and opaque session state are dummy values. These files are structural fixtures, not records of an individual's coursework. No original PDF is included.

Report forms, pagination variations, direct binary responses, and embedded media cases are synthetic HTML or responses inside the tests. Live report submission has not been verified.

To prepare another fixture:

```sh
bun scripts/anonymize.ts /private/raw.html /private/sanitized.html --name "Example Teacher"
```

The anonymizer removes recognizable user labels, email addresses, and `acs_` tokens. It does not remove every school-specific or personal field. Before copying sanitized HTML into this directory, replace course/resource/message IDs, school and course names, question text, answers, grades, submission history, file metadata, and hidden session state. Inspect URL-encoded and JSON-escaped values too. Preserve the DOM structure needed by the test.

Use `00x_000001` for the example course, distinct `d`-prefixed 32-character dummy hex IDs for resources, `00_0XX00` for user IDs, and `00000000` for `acs_`. Update related fixtures and expectations together, then run the checks above. Keep raw captures and mapping tables outside the repository.
