/** One place for every TanStack Query key, so realtime updates can find them. */
export const qk = {
  me: ['me'] as const,
  companies: ['companies'] as const,
  members: ['members'] as const,
  invites: ['invites'] as const,
  /** Public: what `/invite/$token` can show before the invite is accepted. */
  invitePreview: (token: string) => ['invites', 'preview', token] as const,
  departments: ['departments'] as const,
  department: (departmentId: string) => ['departments', departmentId] as const,
  channels: ['channels'] as const,
  channel: (channelId: string) => ['channels', 'one', channelId] as const,
  channelMembers: (channelId: string) => ['channel-members', channelId] as const,
  channelContext: (channelId: string) => ['channel-context', channelId] as const,
  messages: (channelId: string) => ['messages', channelId] as const,
  allMessages: ['messages'] as const,
  thread: (threadId: string) => ['thread', threadId] as const,
  allThreads: ['thread'] as const,
  agents: ['agents'] as const,
  agent: (agentId: string) => ['agents', agentId] as const,
  agentFiles: (agentId: string, path: string) => ['agents', agentId, 'files', path] as const,
  skill: (agentId: string, name: string) => ['agents', agentId, 'skills', name] as const,
  /** No `agentId` = the company vault; an `agentId` = that agent's own items. */
  vault: (agentId?: string) =>
    agentId === undefined ? (['vault'] as const) : (['vault', agentId] as const),
  /** Prefix of every vault key, company and agent alike. */
  allVaults: ['vault'] as const,
  subscriptions: ['subscriptions'] as const,
  /**
   * The models a runtime can reach (docs/build-plan-run-overrides.md D6). Keyed
   * by runtime *and* seat, because two seats on the same runtime can be two
   * different accounts with two different model lists.
   */
  modelCatalog: (runtime: string, subscriptionId?: string) =>
    ['subscriptions', 'models', runtime, subscriptionId ?? 'auto'] as const,
  /** Prefix of everything the Repositories page reads. */
  repositories: ['repositories'] as const,
  /** The company's GitHub connection state. Metadata only, never a secret. */
  githubConnection: ['repositories', 'github'] as const,
  /** Where to send someone to install the App and tick repositories on GitHub. */
  githubInstallUrl: ['repositories', 'install-url'] as const,
  /** The repositories attached to the company. */
  repositoryList: ['repositories', 'list'] as const,
  /** Everything the installation can see, attached or not. */
  availableRepositories: ['repositories', 'available'] as const,
  /** Prefix of everything the Projects pages read (docs/build-plan-projects.md). */
  projects: ['projects'] as const,
  /** The company's Linear connection state. Metadata only, never the API key. */
  linearConnection: ['projects', 'linear'] as const,
  /** The mirrored projects — what the sidebar group lists. */
  projectList: ['projects', 'list'] as const,
  /** The Linear workspace's people and the Taut humans they map to (D15). */
  linearUsers: ['projects', 'linear', 'users'] as const,
  /** One project with its milestones. */
  project: (projectId: string) => ['projects', 'one', projectId] as const,
  /** One project's issues, as the Issues tab reads them (D19). */
  projectIssues: (projectId: string) => ['projects', 'one', projectId, 'issues'] as const,
  tasks: ['tasks'] as const,
  /** `scope` is the serialised filter, so `/tasks` and an agent's tab cache apart. */
  taskList: (scope: string) => ['tasks', 'list', scope] as const,
  routines: ['routines'] as const,
  /** `scope` is the agent the list is filtered to, so each agent's tab caches apart. */
  routineList: (scope: string) => ['routines', 'list', scope] as const,
  /** Prefix of every signal list (docs/build-plan-triggers.md D26). */
  signals: ['signals'] as const,
  /**
   * `scope` is the status the list asked for. The thread row asks for `pending` and narrows to
   * its own thread in the hook, because `ListSignalsQuery` has no `threadId` filter.
   */
  signalList: (scope: string) => ['signals', 'list', scope] as const,
  handovers: ['handovers'] as const,
  /** `status` keys the head's queue: `open` drives the sidebar badge. */
  handoverList: (status: string) => ['handovers', 'list', status] as const,
  /** ⌘K full-text search; keyed by the debounced query. */
  search: (q: string) => ['search', q] as const,
  /** Whether this deployment can hold a huddle at all (docs/build-plan-calls.md D3). */
  callsConfig: ['calls', 'config'] as const,
  /** Every open huddle the user can see; `call.*` events patch it in place. */
  activeCalls: ['calls', 'active'] as const
}

/** Every list endpoint in the contract returns this shape. */
export interface PageOf<A> {
  readonly items: readonly A[]
  readonly nextCursor?: string | undefined
}
