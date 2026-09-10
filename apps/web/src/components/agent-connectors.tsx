import * as React from 'react'
import type { AgentConnector, AgentId, ConnectorInput } from '@taut/contract'
import { PencilIcon, PlugIcon, TrashIcon } from '@taut/ui/components/icons'
import { Button } from '@taut/ui/components/button'
import { SettingsCard } from '@/components/settings'
import { ReadOnlyNote } from '@/components/page'
import { ConnectorPicker } from '@/components/connector-picker'
import { ConnectorDialog } from '@/components/connector-dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import type { ConnectorPreset } from '@/lib/connector-catalog'
import { useAddConnector, useRemoveConnector, useUpdateConnector } from '@/lib/api'

function ConnectorRows({
  connectors,
  canManage,
  onEdit,
  onRemove
}: {
  connectors: readonly AgentConnector[]
  canManage: boolean
  onEdit: (connector: AgentConnector) => void
  onRemove: (connector: AgentConnector) => void
}) {
  return connectors.length === 0 ? (
    <p className="px-6 py-8 text-sm text-muted-foreground">No connectors added</p>
  ) : (
    <ul className="divide-y">
      {connectors.map((connector) => (
        <li key={connector.id} className="flex items-center gap-3 px-6 py-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
            <PlugIcon className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{connector.name}</p>
            <p className="truncate text-xs text-muted-foreground" title={connector.url}>
              {connector.url}
            </p>
          </div>
          {canManage ? (
            <div className="flex shrink-0 gap-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Edit ${connector.name}`}
                onClick={() => onEdit(connector)}
              >
                <PencilIcon />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove ${connector.name}`}
                onClick={() => onRemove(connector)}
              >
                <TrashIcon />
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export function AgentConnectorsTab({
  agentId,
  connectors,
  canManage
}: {
  agentId: AgentId
  connectors: readonly AgentConnector[]
  canManage: boolean
}) {
  const add = useAddConnector()
  const update = useUpdateConnector()
  const remove = useRemoveConnector()
  const [draft, setDraft] = React.useState<ConnectorPreset | AgentConnector | null>(null)
  const [removing, setRemoving] = React.useState<AgentConnector | null>(null)
  const closeDraft = () => {
    setDraft(null)
    add.reset()
    update.reset()
  }
  return (
    <>
      <SettingsCard
        title="Connectors"
        description="Connect tools and services this agent can use. Changes apply to its next task."
        action={
          canManage ? (
            <div data-connector-add>
              <ConnectorPicker
                onSelect={(preset) => {
                  add.reset()
                  update.reset()
                  setDraft(preset)
                }}
              />
            </div>
          ) : undefined
        }
      >
        <ConnectorRows
          connectors={connectors}
          canManage={canManage}
          onEdit={(connector) => {
            update.reset()
            setDraft(connector)
          }}
          onRemove={(connector) => {
            remove.reset()
            setRemoving(connector)
          }}
        />
        {!canManage ? (
          <div className="px-6 pb-4">
            <ReadOnlyNote />
          </div>
        ) : null}
      </SettingsCard>
      {draft ? (
        <ConnectorDialog
          initial={draft}
          pending={add.isPending || update.isPending}
          error={('id' in draft ? update.error : add.error)?.message}
          onClose={closeDraft}
          onSave={(input) => {
            const callbacks = { onSuccess: closeDraft }
            if ('id' in draft)
              update.mutate({ agentId, connectorId: draft.id, ...input }, callbacks)
            else add.mutate({ agentId, ...input, headers: input.headers ?? {} }, callbacks)
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null)
        }}
        title={`Remove ${removing?.name ?? 'connector'}?`}
        description={
          <>
            <p>
              This agent will stop using this connector on its next task. Tasks already running keep
              their current configuration.
            </p>
            {remove.error ? (
              <p role="alert" className="text-destructive">
                {remove.error.message}
              </p>
            ) : null}
          </>
        }
        confirmLabel="Remove connector"
        pending={remove.isPending}
        onConfirm={() => {
          if (removing)
            remove.mutate(
              { agentId, connectorId: removing.id },
              { onSuccess: () => setRemoving(null) }
            )
        }}
      />
    </>
  )
}

/** Draft connectors are submitted atomically with the new agent. */
export function NewAgentConnectors({
  value,
  onChange,
  disabled
}: {
  value: readonly ConnectorInput[]
  onChange: (value: readonly ConnectorInput[]) => void
  disabled: boolean
}) {
  const [draft, setDraft] = React.useState<ConnectorPreset | AgentConnector | null>(null)
  const rows: AgentConnector[] = value.map((connector, index) => ({
    ...connector,
    id: String(index),
    headerNames: Object.keys(connector.headers)
  }))
  return (
    <>
      <SettingsCard
        title="Connectors"
        description="Optional. Add tools and services the agent can use from its first task."
        action={
          <div data-connector-add>
            <ConnectorPicker disabled={disabled} onSelect={setDraft} />
          </div>
        }
      >
        <ConnectorRows
          connectors={rows}
          canManage={!disabled}
          onEdit={setDraft}
          onRemove={(connector) =>
            onChange(value.filter((_, index) => String(index) !== connector.id))
          }
        />
      </SettingsCard>
      {draft ? (
        <ConnectorDialog
          initial={draft}
          onClose={() => setDraft(null)}
          onSave={(input) => {
            if ('id' in draft)
              onChange(
                value.map((connector, index) =>
                  String(index) === draft.id
                    ? { ...input, headers: input.headers ?? connector.headers }
                    : connector
                )
              )
            else onChange([...value, { ...input, headers: input.headers ?? {} }])
            setDraft(null)
          }}
        />
      ) : null}
    </>
  )
}
