/**
 * The syntax-highlighting subset shipped to the client.
 *
 * `rehype-highlight` defaults to highlight.js' "common" bundle — ~40 grammars,
 * most of which never appear in a Taut channel. Registering an explicit set
 * keeps the chat bundle small while still covering what agents actually post.
 */
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

export const highlightLanguages = {
  bash,
  css,
  diff,
  dockerfile,
  go,
  ini,
  javascript,
  json,
  markdown,
  plaintext,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml
} as const

/** Auto-detection is limited to these so a stray fence never guesses Perl. */
export const highlightSubset = [
  'typescript',
  'javascript',
  'json',
  'bash',
  'python',
  'sql',
  'yaml',
  'xml',
  'css',
  'go',
  'rust',
  'diff'
]
