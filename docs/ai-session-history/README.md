# AI session history

The brief asks for the AI tool session history. This is it, unedited apart from one redaction described below.

`session-transcript.jsonl` is the raw Claude Code session log for the build session, exported exactly as the tool wrote it: one JSON object per line, in order, covering 2026-08-06T10:17Z to 2026-08-09T02:30Z. 1,173 lines: 503 assistant turns, 299 user turns and tool results, plus the tool's own attachment, mode and file-history records. Nothing was rewritten, reordered or tidied, so the false starts, the reversals and the four test failures that turned out to be bad tests are all still in there.

Two deliberate departures from the raw file, both stated so nothing here is silently different from what happened:

1. **A GitHub personal access token is redacted.** It appeared twice, in the output of a `git remote -v` that printed the push URL. Both occurrences now read `[redacted-pat]`. Nothing else was touched.
2. **The log is truncated before the prompt that asked for this file.** Everything up to and including the last substantive build turn is present; the request to export the transcript, and the work of exporting it, are not, because a transcript that contains its own export is a hall of mirrors.

The two-page thinking doc the brief also asks for is [docs/08-thinking.md](../08-thinking.md). It is the argument; this is the evidence.

## Reading it

The file is 5MB of JSONL, which is meant for a machine. To read the human side of the conversation:

```bash
node docs/ai-session-history/prompts.mjs          # all 52 prompts, long ones clipped
node docs/ai-session-history/prompts.mjs --full   # nothing clipped
```

The interesting ones are the corrections: the point where a scoping assumption was made without asking and had to be given up, and the point where the e2e convention was switched to the one an existing project already used.

The extractor reads two record shapes, not one, and that is worth knowing before writing your own. A message typed while a turn was already running is not stored as a user turn; it is stored as an `attachment` with a `queued_command` payload. Filtering on `type: 'user'` alone drops thirteen of the fifty-two prompts here, including several of the sharpest ones, because an interruption is exactly the moment someone corrects you.
