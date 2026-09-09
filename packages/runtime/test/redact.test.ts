import { describe, expect, it } from 'vitest'

import { makeRedactor, noRedaction, secretsOf } from '../src/redact.js'

describe('Redactor', () => {
  const secret = 'sk-ant-api03-SECRETSECRETSECRET1234'
  const r = makeRedactor([secret, 'short', 'hunter2abc'])

  it('masks the raw secret with ••••<last4>', () => {
    expect(r.redact(`key=${secret} done`)).toBe('key=••••1234 done')
  })

  it('masks base64, base64url, url-encoded and json-escaped forms', () => {
    const b64 = Buffer.from(secret).toString('base64')
    expect(r.redact(`Authorization: Basic ${b64}`)).toBe('Authorization: Basic ••••1234')
    const tricky = 'p@ss/word+with=chars&more?'
    const t = makeRedactor([tricky])
    // tail `ore?` is not alphanumeric → no hint (it must be safe to embed in JSON/log lines)
    expect(t.redact(encodeURIComponent(tricky))).toBe('••••')
    expect(t.redact(Buffer.from(tricky).toString('base64url'))).toBe('••••')
    const withQuotes = 'say "hi" 12345678'
    const q = makeRedactor([withQuotes])
    expect(q.redact(JSON.stringify({ text: `token ${withQuotes} end` }))).toBe(
      '{"text":"token ••••5678 end"}'
    )
  })

  it('ignores secrets shorter than 6 chars and hides all of a short-ish secret', () => {
    expect(r.redact('short story')).toBe('short story')
    expect(r.redact('pw hunter2abc!')).toBe('pw ••••!') // < 12 chars: no last4
  })

  it('handles multiple occurrences and leaves unrelated text alone', () => {
    expect(r.redact(`${secret} ${secret}`)).toBe('••••1234 ••••1234')
    expect(r.redact('nothing here')).toBe('nothing here')
    expect(noRedaction.redact(secret)).toBe(secret)
  })

  it('add() registers a secret after construction, with all variants, longest first', () => {
    const late = makeRedactor(['first-secret-0001'])
    const before = late.size
    expect(late.redact('token later-secret-XYZ9 end')).toBe('token later-secret-XYZ9 end')
    late.add('later-secret-XYZ9')
    expect(late.size).toBeGreaterThan(before)
    expect(late.redact('token later-secret-XYZ9 end')).toBe('token ••••XYZ9 end')
    expect(late.redact(Buffer.from('later-secret-XYZ9').toString('base64'))).toBe('••••XYZ9')
    // a longer secret containing an earlier one is masked as a whole
    late.add('later-secret-XYZ9-and-more')
    expect(late.redact('x later-secret-XYZ9-and-more y')).toBe('x ••••more y')
    // idempotent + ignores short ones
    const size = late.size
    late.add('later-secret-XYZ9')
    late.add('tiny')
    expect(late.size).toBe(size)
    expect(() => noRedaction.add('whatever-secret')).not.toThrow()
    expect(noRedaction.size).toBe(0)
  })

  it('add() registers new secrets after construction, longest first, idempotent', () => {
    const r2 = makeRedactor(['inner-part-secret'])
    expect(r2.redact('outer-inner-part-secret-end')).toBe('outer-••••cret-end')
    const before = r2.size
    r2.add('outer-inner-part-secret-end')
    expect(r2.size).toBeGreaterThan(before)
    // the longer secret now wins as a whole even though it contains the earlier one
    expect(r2.redact('outer-inner-part-secret-end')).toBe('••••')
    expect(r2.redact(Buffer.from('outer-inner-part-secret-end').toString('base64'))).toBe('••••')
    const size = r2.size
    r2.add('outer-inner-part-secret-end')
    r2.add('tiny')
    expect(r2.size).toBe(size)
    const empty = makeRedactor()
    expect(empty.size).toBe(0)
    empty.add('added-later-123456')
    expect(empty.redact('x added-later-123456 y')).toBe('x ••••3456 y')
    noRedaction.add('ignored-secret-000')
    expect(noRedaction.redact('ignored-secret-000')).toBe('ignored-secret-000')
  })

  it('never emits a quote, backslash or control char in the mask: JSON lines stay parseable', () => {
    const tails = ['"', '\\', '\n', '\r', '\t', "'", '}', ' ', '\u0000']
    for (const tail of tails) {
      const secret = `vault-secret-ABCDEF-${tail}`
      const r2 = makeRedactor([secret])
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `token ${secret} end` }] }
      })
      const redacted = r2.redact(line)
      const parsed = JSON.parse(redacted) as {
        message: { content: Array<{ text: string }> }
      }
      expect(parsed.message.content[0]?.text, JSON.stringify(tail)).toBe('token •••• end')
      expect(redacted, JSON.stringify(tail)).not.toContain('ABCDEF')
      expect(redacted, JSON.stringify(tail)).not.toContain(tail.length > 0 ? `F-${tail}` : 'F-')
      // raw (non-JSON) log lines too
      expect(r2.redact(`plain ${secret} end`)).toBe('plain •••• end')
    }
    // punctuation anywhere in the tail drops the hint; an alphanumeric tail keeps it
    expect(makeRedactor(['abcdefgh-ab1"']).redact('abcdefgh-ab1"')).toBe('••••')
    expect(makeRedactor(['abcdefgh-x-y_z']).redact('abcdefgh-x-y_z')).toBe('••••')
    expect(makeRedactor(['abcdefgh-ab12']).redact('abcdefgh-ab12')).toBe('••••ab12')
  })

  it('collects env values and file contents', () => {
    expect(secretsOf({ A: '1', B: '2' }, [{ content: 'file' }])).toEqual(['1', '2', 'file'])
  })
})
