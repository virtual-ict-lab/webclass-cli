# webclass-cli

A CLI for KOSEN WebClass, built with Bun and TypeScript. It provides interactive commands for people and JSON output for agents. See README.md for usage and skills/webclass-cli/ for the agent interface.

## Network and data

- Route network requests through `WebClassClient`. The default access is read-only; quiz and report operations use `access: "learning"`.
- Material downloads use `access: "materials"`. This mode blocks quiz screens and saves only material attachments from the same origin. List external links without fetching them. Do not overwrite existing files.
- Use curl for live investigation and verification, as requested by the user. Pass cookies through stdin configuration or an equivalent mechanism that keeps them out of command arguments and logs.
- Never automatically retry learning GET or POST requests. Serialize requests and wait a random 2–3 seconds after the previous response completes. After accepting a batch of answers, save each answer in sequence, then submit.
- `--submit-delay` (alias `--delay`) adds a wait in seconds between saving all answers and the final submission.
- Enforce origin, path, and purpose-specific allowlists. Reject logout and arbitrary URLs. New routes require evidence from actual pages and tests.
- Keep cookies and authentication URLs out of stdout, errors, and logs.
- Anonymize fixtures and record whether they were captured from the server or synthesized. Keep raw HTML and credentials out of the repository.
- Live report submission tests are on hold at the user's request. Verify with synthetic forms and local HTTP servers.
- Never silently skip unsupported questions or report unconfirmed submissions as successful. Never automatically resend operations in pending or uncertain states.

## Development

- `bun test` / `bun run typecheck`
- Use Bun and preserve existing uncommitted files.
- Use English for code comments, test names, error messages, CLI text, and documentation. Preserve Japanese server labels and fixture values where they are protocol or test input data, including non-ASCII anonymization cases.
