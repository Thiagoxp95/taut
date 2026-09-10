import { describe, expect, it } from 'vitest'

import { Authentication, TautApi } from '../src/api/index.js'

const groups = TautApi.groups

/** `ReadonlySet<TagClassAny>` is covariant, so viewing it as `ReadonlySet<unknown>` is cast-free. */
const hasMiddleware = (set: ReadonlySet<unknown>, tag: unknown): boolean => set.has(tag)

const endpointNames = (group: string): ReadonlyArray<string> => {
  const g = groups[group]
  if (g === undefined) throw new Error(`missing group ${group}`)
  return Object.keys(g.endpoints)
}

describe('TautApi', () => {
  it('has one group per line of the build plan', () => {
    expect(Object.keys(groups).sort()).toEqual(
      [
        'auth',
        'invites',
        'companies',
        'departments',
        'channels',
        'messages',
        'attachments',
        'push',
        'vault',
        'subscriptions',
        'agents',
        'tasks',
        'routines',
        'signals',
        'handovers',
        'search',
        'repositories',
        'projects',
        'calls',
        'hooks'
      ].sort()
    )
  })

  it('exposes the expected endpoints', () => {
    expect(endpointNames('auth')).toEqual(['signup', 'login', 'logout', 'me'])
    expect(endpointNames('invites')).toEqual(['create', 'list', 'preview', 'accept', 'revoke'])
    expect(endpointNames('companies')).toEqual([
      'create',
      'list',
      'get',
      'update',
      'delete',
      'switch',
      'members',
      'setRole'
    ])
    expect(endpointNames('departments')).toEqual([
      'list',
      'create',
      'get',
      'update',
      'delete',
      'addMember',
      'removeMember',
      'setHead'
    ])
    expect(endpointNames('channels')).toEqual([
      'list',
      'inbox',
      'create',
      'dm',
      'get',
      'update',
      'delete',
      'members',
      'addMember',
      'removeMember',
      'context',
      'markRead',
      'canvases',
      'canvas'
    ])
    expect(endpointNames('messages')).toEqual([
      'list',
      'create',
      'edit',
      'delete',
      'thread',
      'react',
      'unreact',
      'authorization',
      'decideAuthorization'
    ])
    expect(endpointNames('attachments')).toEqual(['upload', 'get', 'content'])
    expect(endpointNames('vault')).toEqual(['list', 'add', 'revoke'])
    expect(endpointNames('subscriptions')).toEqual([
      'list',
      'add',
      'remove',
      'setWeight',
      'setUsageCredential',
      'models',
      'clearCooldown',
      'check'
    ])
    expect(endpointNames('push')).toEqual(['key', 'subscribe', 'unsubscribe', 'list'])
    expect(endpointNames('agents')).toEqual([
      'list',
      'create',
      'get',
      'update',
      'delete',
      'addConnector',
      'updateConnector',
      'removeConnector',
      'getSkill',
      'putSkill',
      'deleteSkill',
      'previewSkill',
      'installSkill',
      'approveSkill',
      'checkSkill',
      'updateSkill',
      'skillSettings',
      'listFiles',
      'uploadFile',
      'grantFile',
      'revokeFileGrant',
      'readFile',
      'listRepoGrants',
      'grantRepo',
      'revokeRepo',
      'getMachine',
      'startMachine',
      'stopMachine',
      'listProcesses'
    ])
    expect(endpointNames('tasks')).toEqual(['list', 'get', 'cancel'])
    expect(endpointNames('routines')).toEqual(['list', 'create', 'update', 'delete', 'run'])
    expect(endpointNames('signals')).toEqual(['list', 'delete'])
    expect(endpointNames('handovers')).toEqual(['list', 'raise', 'dismiss'])
    expect(endpointNames('repositories')).toEqual([
      'githubConnection',
      'githubManifest',
      'githubInstallUrl',
      'githubDisconnect',
      'available',
      'list',
      'attach',
      'detach'
    ])
  })

  it('exposes the call endpoints', () => {
    expect(endpointNames('calls')).toEqual(['config', 'active', 'join', 'leave'])
    expect(endpointNames('hooks')).toEqual(['livekit'])
  })

  it('mounts every endpoint under /api/<group>', () => {
    for (const [name, group] of Object.entries(groups)) {
      for (const endpoint of Object.values(group.endpoints)) {
        expect(endpoint.path.startsWith(`/api/${name}`)).toBe(true)
      }
    }
  })

  it('has no duplicate method+path pairs', () => {
    const seen = new Set<string>()
    for (const group of Object.values(groups)) {
      for (const endpoint of Object.values(group.endpoints)) {
        const key = `${endpoint.method} ${endpoint.path}`
        expect(seen.has(key), `duplicate route ${key}`).toBe(false)
        seen.add(key)
      }
    }
  })

  it('protects everything except signup/login/logout/accept/preview with Authentication', () => {
    const publicEndpoints = new Set([
      'auth.signup',
      'auth.login',
      'auth.logout',
      'invites.preview',
      'invites.accept',
      // LiveKit signs the body with the API secret and the server verifies that signature,
      // so this one carries its own authentication (docs/build-plan-calls.md D2).
      'hooks.livekit'
    ])
    for (const [groupName, group] of Object.entries(groups)) {
      const groupProtected = hasMiddleware(group.middlewares, Authentication)
      for (const endpoint of Object.values(group.endpoints)) {
        const isProtected = groupProtected || hasMiddleware(endpoint.middlewares, Authentication)
        const key = `${groupName}.${endpoint.name}`
        expect(
          isProtected,
          `${key} should ${publicEndpoints.has(key) ? 'not ' : ''}be protected`
        ).toBe(!publicEndpoints.has(key))
      }
    }
  })

  it('declares the session cookie security scheme on the middleware', () => {
    const session = Authentication.security.session
    expect(session._tag).toBe('ApiKey')
    if (session._tag === 'ApiKey') {
      expect(session.in).toBe('cookie')
      expect(session.key).toBe('taut_session')
    }
  })
})
