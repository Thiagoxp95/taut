#!/usr/bin/env node
/**
 * ANSWERED, 2026-09-09: **TURN BOUNDARY.** The marker only appeared after the first turn closed.
 * D8 was therefore dropped rather than shipped — `TAUT_STREAM_STDIN`, `ExecOptions.stdinLines`,
 * the adapter's `--input-format stream-json` mode and its `encodeInput` are all gone, and
 * steering rides entirely on the tool-result path (D6) and the one deflection (D7).
 *
 * This script is kept because the answer belongs to a `claude` version, not to Taut: re-run it
 * after a runtime upgrade and, if it ever says MID-TURN, D8 becomes worth building again.
 * `docs/build-plan-steering-reactions.md` §D8 records the reasoning.
 *
 * What it settles (docs/build-plan-steering-reactions.md D8): when a second user message is
 * written to an open stdin **while claude is mid-turn**, does it reach the model during that
 * turn, or is it queued until the turn ends?
 *
 * The answer decides whether streaming stdin is worth shipping at all. Delivery at the turn
 * boundary is useless here: by then the agent has already posted the answer we were trying to
 * stop it from duplicating.
 *
 *   node scripts/verify-streaming-stdin.mjs
 *
 * Needs a working `claude` on PATH and whatever credential it normally uses. It spends real
 * tokens on a deliberately slow first turn, so it is a script you run, not a test.
 *
 * How it reads: the first message asks for a slow count. Two seconds in — well inside that
 * turn — a second message asks for a word that appears nowhere else. If the transcript shows
 * the model reacting to that word *before* it finished counting, delivery is mid-turn and D8
 * is real. If the reaction only shows up in a later assistant turn, delivery is at the turn
 * boundary and D8 should be dropped.
 */
import { spawn } from 'node:child_process'

const MARKER = 'pomegranate'
const INJECT_AFTER_MS = 2_000
const GIVE_UP_MS = 120_000

const userMessage = (text) =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`

const child = spawn(
  'claude',
  ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
  { stdio: ['pipe', 'pipe', 'inherit'] }
)

const startedAt = Date.now()
const at = () => `${String(Date.now() - startedAt).padStart(6)}ms`

let firstTurnEnded = false
let markerSeenDuringFirstTurn = false
let markerSeenAtAll = false
let injectedAt

child.stdin.write(
  userMessage(
    'Count slowly from 1 to 40. Put each number on its own line and say nothing else. ' +
      'Take your time — this is deliberately a long answer.'
  )
)

const injectTimer = setTimeout(() => {
  injectedAt = Date.now()
  console.log(`${at()}  >>> writing the second user message (marker "${MARKER}")`)
  child.stdin.write(
    userMessage(
      `Stop counting. Reply with exactly one word: ${MARKER}. Ignore the counting task entirely.`
    )
  )
}, INJECT_AFTER_MS)

const giveUp = setTimeout(() => {
  console.log(`${at()}  giving up after ${GIVE_UP_MS / 1000}s`)
  child.kill('SIGTERM')
}, GIVE_UP_MS)

let rest = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  rest += chunk
  const lines = rest.split('\n')
  rest = lines.pop() ?? ''
  for (const line of lines) {
    if (line.trim() === '') continue
    let json
    try {
      json = JSON.parse(line)
    } catch {
      continue
    }
    if (json.type === 'assistant') {
      const text = (json.message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (text.toLowerCase().includes(MARKER)) {
        markerSeenAtAll = true
        if (!firstTurnEnded) markerSeenDuringFirstTurn = true
        console.log(`${at()}  <<< marker in an assistant message (first turn: ${!firstTurnEnded})`)
      }
    }
    if (json.type === 'result') {
      firstTurnEnded = true
      console.log(`${at()}  <<< turn ended (${json.subtype})`)
      // One turn is all this experiment needs; a queued message would start a second one.
      setTimeout(() => child.kill('SIGTERM'), 3_000)
    }
  }
})

child.on('exit', () => {
  clearTimeout(injectTimer)
  clearTimeout(giveUp)
  const injectedInTurn = injectedAt !== undefined && !firstTurnEnded
  console.log('\n--- verdict ---')
  if (markerSeenDuringFirstTurn) {
    console.log('MID-TURN: the second message reached the model during the first turn.')
    console.log('D8 is real. TAUT_STREAM_STDIN is worth turning on.')
  } else if (markerSeenAtAll) {
    console.log('TURN BOUNDARY: the marker only appeared after the first turn closed.')
    console.log('D8 buys nothing over the tool-result path (D6). Drop the flag.')
  } else {
    console.log('INCONCLUSIVE: the marker never appeared.')
    console.log(
      injectedInTurn
        ? 'The message was written mid-turn but nothing came back — check credentials and the claude version.'
        : 'The first turn ended before the message was written; raise INJECT_AFTER_MS or make the first task slower.'
    )
  }
})
