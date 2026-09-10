import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'
import { ModelCatalogs, type CatalogInput } from '../src/services/modelCatalog.js'

const catalog = (input: CatalogInput, payload: unknown, status = 200) => {
  const requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = []
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      requests.push({ url: url.toString(), headers: request.headers })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(payload), {
            status,
            headers: { 'content-type': 'application/json' }
          })
        )
      )
    })
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ModelCatalogs
      return { result: yield* service.get(input), requests }
    }).pipe(Effect.provide(ModelCatalogs.DefaultWithoutDependencies.pipe(Layer.provide(http))))
  )
}

describe('Codex model discovery', () => {
  const oauth: CatalogInput = {
    key: 'chatgpt-seat',
    runtime: 'codex',
    credential: {
      kind: 'openai.oauth',
      secret: Redacted.make(
        JSON.stringify({
          tokens: { access_token: 'test-access-token', account_id: 'test-account' }
        })
      )
    }
  }

  it('lists visible account models using ChatGPT authentication', async () => {
    const { result, requests } = await catalog(oauth, {
      models: [
        { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 0 },
        { slug: 'codex-auto-review', display_name: 'Auto review', visibility: 'hide', priority: 1 },
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 2 }
      ]
    })
    expect(result.source).toBe('live')
    expect(result.models).toEqual([
      { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }
    ])
    expect(requests[0]?.url).toMatch(
      /^https:\/\/chatgpt.com\/backend-api\/codex\/models\?client_version=/
    )
    expect(requests[0]?.headers).toMatchObject({
      authorization: 'Bearer test-access-token',
      'chatgpt-account-id': 'test-account'
    })
  })

  it('keeps current reasoning model families in the API-key catalogue', async () => {
    const { result, requests } = await catalog(
      {
        key: 'api-seat',
        runtime: 'codex',
        credential: { kind: 'openai.api_key', secret: Redacted.make('test-api-key') }
      },
      {
        data: [
          { id: 'gpt-6-astra' },
          { id: 'gpt-5.6-sol' },
          { id: 'gpt-6-audio' },
          { id: 'text-embedding-3-small' }
        ]
      }
    )
    expect(result.models.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'gpt-6-astra'])
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/models')
  })

  it('offers current fallback models after an authentication failure without leaking credentials', async () => {
    const { result } = await catalog(oauth, {}, 401)
    expect(result.source).toBe('fallback')
    expect(result.models.some((model) => model.id === 'gpt-6-astra')).toBe(true)
    expect(result.models.some((model) => model.id === 'gpt-5-codex')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('test-access-token')
  })
})
