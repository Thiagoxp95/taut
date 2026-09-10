/** Run against a daemon: TAUT_TEST_DOCKER=1 pnpm --filter @taut/runtime test -- docker-namespace */
import Dockerode from 'dockerode'
import { Effect, Option } from 'effect'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDockerProvider } from '../src/machine/docker.js'
import { specFor, tempHome } from './helpers.js'

/* eslint-disable turbo/no-undeclared-env-vars */
const enabled = process.env['TAUT_TEST_DOCKER'] === '1'
const image = process.env['TAUT_TEST_DOCKER_IMAGE'] ?? 'taut/agent:latest'
/* eslint-enable turbo/no-undeclared-env-vars */

describe.skipIf(!enabled)('Docker installation isolation', () => {
  const docker = new Dockerode()
  const containers = new Set<string>()
  const networks = new Set<string>()
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const id of containers)
      await docker
        .getContainer(id)
        .remove({ force: true })
        .catch(() => {})
    for (const name of networks)
      await docker
        .getNetwork(name)
        .remove()
        .catch(() => {})
    for (const cleanup of cleanups) await cleanup()
    containers.clear()
    networks.clear()
    cleanups.length = 0
  })

  it('isolates ensure, get, list, stop and destroy with identical company and agent identities', async () => {
    const token = randomUUID().slice(0, 8)
    const companySlug = `ns-test-${token}`
    const agentId = `agt_${token}`
    const companyId = `cmp_${token}`
    const providers = [
      makeDockerProvider({
        docker,
        image,
        namespace: `one-${token}`,
        apiNetwork: `one-${token}-api`
      }),
      makeDockerProvider({
        docker,
        image,
        namespace: `two-${token}`,
        apiNetwork: `two-${token}-api`
      }),
      makeDockerProvider({ docker, image })
    ]
    const machines = []
    for (const [index, provider] of providers.entries()) {
      const { home, cleanup } = await tempHome()
      cleanups.push(cleanup)
      const namespace = index === 0 ? `one-${token}` : index === 1 ? `two-${token}` : undefined
      const prefix = namespace === undefined ? 'taut' : `taut-${namespace}-`
      if (namespace !== undefined) {
        const apiNetwork = `${namespace}-api`
        networks.add(apiNetwork)
        await docker.createNetwork({ Name: apiNetwork, Labels: { 'taut.instance': namespace } })
      }
      const expectedName = `${prefix}-${companySlug}-probe`
      networks.add(`${prefix}-${companySlug}`)
      // Also collect legacy names so the failing pre-fix run cleans up its own resources.
      networks.add(`taut-${companySlug}`)
      const machine = await Effect.runPromise(
        provider.ensure(specFor(home, { companySlug, agentId, companyId, handle: 'probe' }))
      )
      containers.add(machine.id)
      machines.push(machine)
      expect(machine.id).toBe(expectedName)
      const info = await docker.getContainer(machine.id).inspect()
      expect(info.Config.Labels['taut.instance']).toBe(namespace)
      if (namespace !== undefined)
        expect(info.NetworkSettings.Networks).toHaveProperty(`${namespace}-api`)
      const network = await docker.getNetwork(info.HostConfig.NetworkMode!).inspect()
      expect(network.Labels?.['taut.instance']).toBe(namespace)
      expect((await Effect.runPromise(provider.ensure(machine.spec))).id).toBe(machine.id)
    }
    expect(new Set(machines.map((machine) => machine.id)).size).toBe(3)
    for (const [index, provider] of providers.entries()) {
      const found = Option.getOrThrow(await Effect.runPromise(provider.get(agentId)))
      expect(found.paths.hostHome).toBe(machines[index]!.paths.hostHome)
      expect(
        (await Effect.runPromise(provider.list(companyId))).map((machine) => machine.id)
      ).toEqual([machines[index]!.id])
    }
    await Effect.runPromise(machines[0]!.stop())
    expect(await Effect.runPromise(machines[1]!.status())).toBe('running')
    await Effect.runPromise(providers[0]!.destroy(agentId))
    expect(Option.isNone(await Effect.runPromise(providers[0]!.get(agentId)))).toBe(true)
    expect(await Effect.runPromise(providers[0]!.list(companyId))).toEqual([])
    expect(await Effect.runPromise(machines[1]!.status())).toBe('running')
    expect(await Effect.runPromise(machines[2]!.status())).toBe('running')
  }, 60_000)

  it.each(['network', 'container', 'api network'])(
    'refuses a same-name %s owned by another installation',
    async (resource) => {
      const token = randomUUID().slice(0, 8)
      const namespace = `owner-${token}`
      const companySlug = `ns-test-${token}`
      const network = `taut-${namespace}--${companySlug}`
      const name = `${network}-probe`
      const { home, cleanup } = await tempHome()
      cleanups.push(cleanup)
      networks.add(network)
      networks.add(`taut-${companySlug}`)
      containers.add(name)
      containers.add(`taut-${companySlug}-probe`)
      const apiNetwork = `${namespace}-api`
      networks.add(apiNetwork)
      if (resource === 'api network') {
        await docker.createNetwork({ Name: apiNetwork, Labels: { 'taut.instance': 'other' } })
      } else if (resource === 'network') {
        await docker.createNetwork({ Name: network, Labels: { 'taut.instance': 'other' } })
      } else {
        await docker.createContainer({
          name,
          Image: image,
          Cmd: ['sleep', 'infinity'],
          Labels: { 'taut.instance': 'other' }
        })
      }
      const provider = makeDockerProvider({
        docker,
        image,
        namespace,
        ...(resource === 'api network' ? { apiNetwork } : {})
      })
      const failure = await Effect.runPromise(
        Effect.flip(provider.ensure(specFor(home, { companySlug, handle: 'probe' })))
      )
      expect(failure._tag).toBe('MachineUnavailable')
      expect(failure.reason).toContain('different installation')
    },
    60_000
  )
})

describe('Docker namespace discovery', () => {
  it.each(['one', 'two', undefined])(
    'only discovers its own resources for namespace %s',
    async (namespace) => {
      const docker = new Dockerode()
      const rows = ['two', 'one', undefined].map((owner): Dockerode.ContainerInfo => ({
        Id: `container-${owner ?? 'legacy'}`,
        Names: [`/container-${owner ?? 'legacy'}`],
        Image: image,
        ImageID: 'image-id',
        Command: 'sleep infinity',
        Created: 1,
        Ports: [],
        State: 'running',
        Status: 'Up',
        HostConfig: { NetworkMode: 'bridge' },
        NetworkSettings: { Networks: {} },
        Mounts: [],
        Labels: {
          'taut.agent': 'agt_test',
          'taut.spec': JSON.stringify(specFor(`/data/${owner ?? 'legacy'}`)),
          ...(owner === undefined ? {} : { 'taut.instance': owner })
        }
      }))
      // Docker is the external boundary; return all installations to prove ownership checks.
      const listing = vi.spyOn(docker, 'listContainers').mockResolvedValue(rows)
      try {
        const provider = makeDockerProvider({
          docker,
          ...(namespace === undefined ? {} : { namespace })
        })
        const found = Option.getOrThrow(await Effect.runPromise(provider.get('agt_test')))
        expect(found.paths.hostHome).toBe(`/data/${namespace ?? 'legacy'}`)
        const all = await Effect.runPromise(provider.list('cmp_test'))
        expect(all.map((machine) => machine.paths.hostHome)).toEqual([
          `/data/${namespace ?? 'legacy'}`
        ])
        if (namespace !== undefined) {
          expect(
            listing.mock.calls.every(([options]) =>
              JSON.parse(String(options?.filters)).label.includes(`taut.instance=${namespace}`)
            )
          ).toBe(true)
        }
      } finally {
        listing.mockRestore()
      }
    }
  )
})
