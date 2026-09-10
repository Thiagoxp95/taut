export interface ConnectorPreset {
  name: string
  url?: string
  auth?: 'oauth'
  children?: readonly ConnectorPreset[]
}

// Endpoint suggestions only; authentication must be configured separately.
// Providers without a shared endpoint require a workspace-specific URL.
export const CONNECTOR_CATALOG: readonly ConnectorPreset[] = [
  // https://amplitude.com/docs/amplitude-ai/amplitude-mcp
  {
    name: 'Amplitude',
    auth: 'oauth',
    children: [
      { name: 'Amplitude (US)', url: 'https://mcp.amplitude.com/mcp', auth: 'oauth' },
      { name: 'Amplitude (EU)', url: 'https://mcp.eu.amplitude.com/mcp', auth: 'oauth' }
    ]
  },
  // https://docs.attio.com/mcp/overview
  { name: 'Attio', url: 'https://mcp.attio.com/mcp', auth: 'oauth' },
  // https://betterstack.com/docs/getting-started/integrations/mcp/
  { name: 'BetterStack', url: 'https://mcp.betterstack.com' },
  // https://github.com/datadog-labs/mcp-server (current path and regional domains)
  // https://docs.aws.amazon.com/devopsagent/latest/userguide/connecting-telemetry-sources-connecting-datadog.html (region hostnames)
  {
    name: 'Datadog',
    children: [
      { name: 'Datadog (US1 - East)', url: 'https://mcp.datadoghq.com/v1/mcp' },
      { name: 'Datadog (US3 - West)', url: 'https://mcp.us3.datadoghq.com/v1/mcp' },
      { name: 'Datadog (US5 - Central)', url: 'https://mcp.us5.datadoghq.com/v1/mcp' },
      { name: 'Datadog (EU1 - Europe)', url: 'https://mcp.datadoghq.eu/v1/mcp' },
      { name: 'Datadog (AP1 - Japan)', url: 'https://mcp.ap1.datadoghq.com/v1/mcp' },
      { name: 'Datadog (AP2 - Australia)', url: 'https://mcp.ap2.datadoghq.com/v1/mcp' }
    ]
  },
  // https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/' },
  // https://docs.glean.com/administration/platform/mcp/create-mcp-servers
  { name: 'Glean' },
  // https://docs.granola.ai/help-center/sharing/integrations/mcp
  { name: 'Granola', url: 'https://mcp.granola.ai/mcp', auth: 'oauth' },
  // https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server
  { name: 'HubSpot', url: 'https://mcp.hubspot.com', auth: 'oauth' },
  // https://docs.incident.io/ai/remote-mcp
  { name: 'incident.io', url: 'https://mcp.incident.io/mcp' },
  // https://developers.intercom.com/docs/guides/mcp
  { name: 'Intercom', url: 'https://mcp.intercom.com/mcp' },
  // https://jam.dev/docs/jam-mcp
  { name: 'Jam', url: 'https://mcp.jam.dev/mcp' },
  // https://developers.notion.com/guides/mcp/get-started-with-mcp
  { name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
  // https://posthog.com/docs/model-context-protocol/faq
  { name: 'PostHog', url: 'https://mcp.posthog.com/mcp' },
  // https://www.sanity.io/docs/ai/mcp-server
  { name: 'Sanity', url: 'https://mcp.sanity.io' },
  // https://mcp.sentry.dev/
  { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth' },
  // https://docs.slack.dev/ai/slack-mcp-server
  { name: 'Slack Personal', url: 'https://mcp.slack.com/mcp', auth: 'oauth' },
  // https://docs.stripe.com/mcp
  { name: 'Stripe', url: 'https://mcp.stripe.com' },
  // https://docs.zapier.com/mcp/overview/how-connections-work
  { name: 'Zapier', url: 'https://mcp.zapier.com/api/v1/connect' }
]
