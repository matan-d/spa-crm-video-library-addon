/**
 * Prints just the human prompts from the committed session transcript, in order.
 *
 * The raw JSONL is 5MB and most of it is tool calls and their results. This is
 * the human side of the conversation, which is the part worth reading: the
 * corrections are where the build changed direction.
 *
 *   node docs/ai-session-history/prompts.mjs
 *   node docs/ai-session-history/prompts.mjs --full   # no truncation
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('./session-transcript.jsonl', import.meta.url))
const full = process.argv.includes('--full')

/** Joins the text parts of a message content field, which may be a string. */
function joinText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p?.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
}

/**
 * A record's human-typed text, or null.
 *
 * Two record shapes carry a prompt. `type: 'user'` is the normal turn. A message
 * sent while a turn was already running is instead recorded as
 * `type: 'attachment'` with a `queued_command` payload, so filtering on the user
 * type alone silently drops every mid-turn interruption, which in this session
 * is where several of the sharpest corrections were made.
 */
function humanText(record) {
  if (record.type === 'attachment') {
    const attachment = record.attachment
    if (attachment?.type !== 'queued_command') return null
    if (attachment.origin?.kind !== 'human') return null
    return joinText(attachment.prompt) || null
  }
  if (record.type !== 'user') return null
  const text = joinText(record.message?.content)
  if (!text) return null
  // Tool-injected turns are user-role but are not something a person typed.
  if (text.startsWith('<') || text.startsWith('Base directory for this skill:')) return null
  if (text.startsWith('This session is being continued')) return null
  return text
}

let n = 0
for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
  const text = humanText(JSON.parse(line))
  if (!text) continue
  n += 1
  const shown = full || text.length <= 700 ? text : `${text.slice(0, 700)}\n[...${text.length - 700} more characters]`
  console.log(`\n=== prompt ${n} ===\n${shown}`)
}
console.log(`\n${n} prompts.`)
