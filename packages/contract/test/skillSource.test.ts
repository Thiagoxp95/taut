/**
 * `parseSkillSource` is the whole "drop me a link" promise (docs/build-plan-skills.md D2/D3).
 * Every shape a human might hand an agent is here, including the two the owner gave verbatim.
 */
import { Either } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  describeSkillSource,
  formatSkillSource,
  parseSkillSource,
  type SkillSource
} from '../src/domain/skillSource.js'

const ok = (input: string): SkillSource => {
  const result = parseSkillSource(input)
  if (Either.isLeft(result))
    throw new Error(`expected a source for ${input}: ${result.left.reason}`)
  return result.right
}

const reason = (input: string): string => {
  const result = parseSkillSource(input)
  if (Either.isRight(result)) throw new Error(`expected a failure for ${input}`)
  return result.left.reason
}

describe('parseSkillSource — the owner’s two inputs', () => {
  it('parses the npx command from the aihero page', () => {
    expect(ok('npx skills@latest add mattpocock/skills --skill=grill-with-docs')).toEqual({
      kind: 'github',
      owner: 'mattpocock',
      repo: 'skills',
      skills: ['grill-with-docs']
    })
  })

  it('treats an unrecognised page as a page to resolve, keeping the slug', () => {
    expect(ok('https://www.aihero.dev/skills-grill-with-docs')).toEqual({
      kind: 'page',
      url: 'https://www.aihero.dev/skills-grill-with-docs',
      slug: 'grill-with-docs'
    })
  })
})

describe('parseSkillSource — npx command shapes', () => {
  it.each([
    ['npx skills@latest add mattpocock/skills --skill=grill-with-docs', ['grill-with-docs']],
    ['npx skills add mattpocock/skills --skill grill-with-docs', ['grill-with-docs']],
    ['npx -y skills@latest add mattpocock/skills -s grill-with-docs', ['grill-with-docs']],
    ['npx skills@latest add mattpocock/skills -s a,b,c', ['a', 'b', 'c']],
    ['npx skills@latest add mattpocock/skills --skill="a, b , c"', ['a', 'b', 'c']],
    ['bunx skills add mattpocock/skills --skill=grill-with-docs', ['grill-with-docs']],
    ['pnpm dlx skills@latest add mattpocock/skills --skill=grill-with-docs', ['grill-with-docs']],
    ['yarn dlx skills add mattpocock/skills --skill=grill-with-docs', ['grill-with-docs']],
    ['npx skills@latest add mattpocock/skills --all', []],
    ['npx skills@latest add mattpocock/skills --skill "*"', []]
  ])('%s', (input, skills) => {
    expect(ok(input)).toEqual({
      kind: 'github',
      owner: 'mattpocock',
      repo: 'skills',
      skills
    })
  })

  it('ignores the flags that only say where the CLI would have installed', () => {
    expect(
      ok(
        'npx skills@latest add vercel-labs/agent-skills --agent claude-code --copy -g -y --skill=x'
      )
    ).toEqual({
      kind: 'github',
      owner: 'vercel-labs',
      repo: 'agent-skills',
      skills: ['x']
    })
  })

  it('survives a command split across lines with a backslash', () => {
    expect(ok('npx skills@latest add mattpocock/skills \\\n  --skill=grill-with-docs')).toEqual({
      kind: 'github',
      owner: 'mattpocock',
      repo: 'skills',
      skills: ['grill-with-docs']
    })
  })

  it('re-parses a command whose package argument is a full URL', () => {
    expect(
      ok('npx skills add https://github.com/mattpocock/skills --skill=grill-with-docs')
    ).toEqual({ kind: 'github', owner: 'mattpocock', repo: 'skills', skills: ['grill-with-docs'] })
  })
})

describe('parseSkillSource — repo shorthand', () => {
  it.each([
    ['mattpocock/skills', { owner: 'mattpocock', repo: 'skills', skills: [] }],
    [
      'mattpocock/skills#grill-with-docs',
      { owner: 'mattpocock', repo: 'skills', skills: ['grill-with-docs'] }
    ],
    ['mattpocock/skills@next', { owner: 'mattpocock', repo: 'skills', ref: 'next', skills: [] }],
    [
      'mattpocock/skills@v2#grill-with-docs',
      { owner: 'mattpocock', repo: 'skills', ref: 'v2', skills: ['grill-with-docs'] }
    ],
    [
      'mattpocock/skills/skills/engineering/grill-with-docs',
      {
        owner: 'mattpocock',
        repo: 'skills',
        path: 'skills/engineering/grill-with-docs',
        skills: ['grill-with-docs']
      }
    ],
    ['vercel-labs/skills.git', { owner: 'vercel-labs', repo: 'skills', skills: [] }]
  ])('%s', (input, expected) => {
    expect(ok(input)).toEqual({ kind: 'github', ...expected })
  })
})

describe('parseSkillSource — links', () => {
  it('a repo link', () => {
    expect(ok('https://github.com/mattpocock/skills')).toEqual({
      kind: 'github',
      owner: 'mattpocock',
      repo: 'skills',
      skills: []
    })
  })

  it('a link to the SKILL.md itself keeps the ref and drops the filename', () => {
    expect(
      ok(
        'https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md'
      )
    ).toEqual({
      kind: 'github',
      owner: 'mattpocock',
      repo: 'skills',
      ref: 'main',
      path: 'skills/engineering/grill-with-docs',
      skills: ['grill-with-docs']
    })
  })

  it('a link to the folder', () => {
    expect(
      ok('https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs')
    ).toEqual({
      kind: 'github',
      owner: 'mattpocock',
      repo: 'skills',
      ref: 'main',
      path: 'skills/engineering/grill-with-docs',
      skills: ['grill-with-docs']
    })
  })

  it('raw.githubusercontent resolves as a repo, so siblings and updates still work', () => {
    expect(
      ok(
        'https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/grill-with-docs/SKILL.md'
      )
    ).toEqual({
      kind: 'github',
      owner: 'mattpocock',
      repo: 'skills',
      ref: 'main',
      path: 'skills/engineering/grill-with-docs',
      skills: ['grill-with-docs']
    })
  })

  it.each(['https://skills.sh/mattpocock/skills', 'https://skills.sh/b/mattpocock/skills'])(
    '%s',
    (input) => {
      expect(ok(input)).toEqual({
        kind: 'github',
        owner: 'mattpocock',
        repo: 'skills',
        skills: []
      })
    }
  )

  it('a skills.sh link naming one skill', () => {
    expect(ok('https://skills.sh/mattpocock/skills/grill-with-docs')).toEqual({
      kind: 'github',
      owner: 'mattpocock',
      repo: 'skills',
      skills: ['grill-with-docs']
    })
  })

  it('a markdown file anywhere else is a raw source', () => {
    expect(ok('https://example.com/skills/deploy/SKILL.md')).toEqual({
      kind: 'raw',
      url: 'https://example.com/skills/deploy/SKILL.md',
      name: 'deploy'
    })
  })
})

describe('parseSkillSource — pasted markdown', () => {
  it('takes a SKILL.md verbatim', () => {
    const md = '---\nname: deploy\ndescription: ship it\n---\n\n# Deploy\n\nDo the thing.\n'
    expect(ok(md)).toEqual({ kind: 'inline', markdown: md.trim() })
  })

  it('refuses frontmatter that never closes', () => {
    expect(reason('---\nname: deploy\n')).toMatch(/never closes/)
  })

  it('refuses frontmatter with neither a name nor a description', () => {
    expect(reason('---\nfoo: bar\n---\n\nbody')).toMatch(/name.*description/)
  })
})

describe('parseSkillSource — refusals', () => {
  it.each([
    '',
    '   ',
    'just some words a human typed',
    'https://',
    'notarepo',
    '/skills',
    'mattpocock/',
    'npx skills@latest add',
    'https://github.com/mattpocock',
    'https://github.com/mattpocock/skills/issues/12'
  ])('%s', (input) => {
    const result = parseSkillSource(input)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left.reason.length).toBeGreaterThan(0)
  })
})

describe('formatSkillSource', () => {
  it.each([
    'github:mattpocock/skills',
    'github:mattpocock/skills#grill-with-docs',
    'github:mattpocock/skills@v2#grill-with-docs',
    'github:mattpocock/skills/skills/engineering/grill-with-docs',
    'raw:https://example.com/a/SKILL.md',
    'page:https://www.aihero.dev/skills-grill-with-docs'
  ])('round-trips %s', (canonical) => {
    expect(formatSkillSource(ok(canonical))).toBe(canonical)
  })

  it('has no address for pasted markdown', () => {
    const source = ok('---\nname: deploy\ndescription: ship it\n---\n\nbody')
    expect(formatSkillSource(source)).toBe('inline')
    expect(describeSkillSource(source)).toBe('pasted markdown')
  })

  it('drops the scheme when describing a source to a human', () => {
    expect(describeSkillSource(ok('mattpocock/skills#grill-with-docs'))).toBe(
      'mattpocock/skills#grill-with-docs'
    )
  })
})
