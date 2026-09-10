import * as React from 'react'
import { CheckIcon, PlusIcon } from '@taut/ui/components/icons'
import type { AgentId, MemberKind, UserId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@taut/ui/components/command'
import { Popover, PopoverContent, PopoverTrigger } from '@taut/ui/components/popover'
import { EntityAvatar } from '@/components/entity-avatar'
import { useMentionables, type Mentionable } from '@/hooks/use-directory'

/** Discriminated so a caller that needs a `UserId` gets one without a cast. */
export type MemberRef =
  | { readonly memberKind: 'user'; readonly memberId: UserId }
  | { readonly memberKind: 'agent'; readonly memberId: AgentId }

export const toMemberRef = (candidate: Mentionable): MemberRef =>
  candidate.kind === 'user'
    ? { memberKind: 'user', memberId: candidate.id }
    : { memberKind: 'agent', memberId: candidate.id }

/** "Add member" popover over the real company directory (humans + agents). */
export function MemberPicker({
  label = 'Add member',
  exclude,
  onSelect,
  only
}: {
  label?: string
  /** Ids already in the list. */
  exclude: ReadonlySet<string>
  onSelect: (member: MemberRef) => void
  only?: MemberKind
}) {
  const [open, setOpen] = React.useState(false)
  const mentionables = useMentionables()

  const candidates = mentionables.filter(
    (candidate) => !exclude.has(candidate.id) && (only === undefined || candidate.kind === only)
  )

  const pick = (candidate: Mentionable): void => {
    onSelect(toMemberRef(candidate))
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <PlusIcon />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search people and agents…" />
          <CommandList>
            <CommandEmpty>Nobody left to add.</CommandEmpty>
            <CommandGroup>
              {candidates.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={`${candidate.name} ${candidate.handle}`}
                  onSelect={() => pick(candidate)}
                >
                  <EntityAvatar
                    onProfileNavigate={() => setOpen(false)}
                    memberId={candidate.id}
                    avatar={candidate.avatar}
                    kind={candidate.kind}
                    face={candidate.face}
                    name={candidate.name}
                    size="sm"
                  />
                  <span className="font-medium">{candidate.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">@{candidate.handle}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Single-select flavour used for "department head". */
export function MemberSelect({
  value,
  onSelect,
  placeholder = 'Pick someone',
  only
}: {
  value: string | undefined
  onSelect: (member: MemberRef) => void
  placeholder?: string
  only?: MemberKind
}) {
  const [open, setOpen] = React.useState(false)
  const mentionables = useMentionables()
  const candidates = mentionables.filter((c) => only === undefined || c.kind === only)
  const selected = candidates.find((candidate) => candidate.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-start font-normal">
          {selected === undefined ? (
            <span className="text-muted-foreground">{placeholder}</span>
          ) : (
            <>
              <EntityAvatar
                onProfileNavigate={() => setOpen(false)}
                memberId={selected.id}
                avatar={selected.avatar}
                kind={selected.kind}
                face={selected.face}
                name={selected.name}
                size="sm"
              />
              {selected.name}
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup>
              {candidates.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={`${candidate.name} ${candidate.handle}`}
                  onSelect={() => {
                    onSelect(toMemberRef(candidate))
                    setOpen(false)
                  }}
                >
                  <EntityAvatar
                    onProfileNavigate={() => setOpen(false)}
                    memberId={candidate.id}
                    avatar={candidate.avatar}
                    kind={candidate.kind}
                    face={candidate.face}
                    name={candidate.name}
                    size="sm"
                  />
                  <span>{candidate.name}</span>
                  {candidate.id === value ? <CheckIcon className="ml-auto size-4" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
