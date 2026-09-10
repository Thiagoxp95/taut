import * as React from 'react'
import { Link, useNavigate, useLocation } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftRightIcon,
  BellIcon,
  MailIcon,
  BellOffIcon,
  BotIcon,
  Building2Icon,
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CreditCardIcon,
  FolderGitIcon,
  FolderIcon,
  HashIcon,
  HeadphonesIcon,
  KeyRoundIcon,
  ListChecksIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquareKanbanIcon,
  SunIcon,
  UserPlusIcon,
  UsersIcon
} from '@taut/ui/components/icons'
import type { Channel, Department, Project } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@taut/ui/components/dropdown-menu'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@taut/ui/components/collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar
} from '@taut/ui/components/sidebar'
import { EntityAvatar } from '@/components/entity-avatar'
import { PresenceDot } from '@/components/presence-dot'
import { ConnectionIndicator } from '@/components/connection-indicator'
import { CreateChannelDialog } from '@/components/create-channel-dialog'
import { CreateCompanyDialog } from '@/components/create-company-dialog'
import { CreateDepartmentDialog } from '@/components/create-department-dialog'
import { InviteDialog } from '@/components/invite-dialog'
import { useCommandPalette } from '@/components/command-palette'
import { useChannelCall } from '@/hooks/use-huddle'
import { useCompanySwitcher } from '@/hooks/use-company-switcher'
import {
  useChannelGroups,
  useCurrentUser,
  useDepartmentList,
  useDmViews,
  type DmView,
  useLookupMember,
  type Mentionable
} from '@/hooks/use-directory'
import {
  useAgents,
  useCanAdminister,
  useCompanies,
  useHandovers,
  useDmInbox,
  useLogout,
  useLinearConnection,
  useMe,
  useProjects,
  useRepositories,
  useSubscriptions,
  useTasks,
  useVaultItems
} from '@/lib/api'
import { PROJECT_STATE_COLOR, PROJECT_STATE_LABEL } from '@/lib/projects'
import { usePresence, useUnread } from '@/lib/live'
import { usePush } from '@/hooks/use-push'
import { useTheme } from '@/lib/theme'
import { realtime, type ConnectionStatus } from '@/lib/ws'

/**
 * The router paints `data-status="active"` on a matched `<Link>`; the sidebar's
 * own active styling keys off `data-active`, so links opt in here instead.
 */
function InboxNavItem() {
  const inbox = useDmInbox()
  const unread = inbox.data?.items.reduce((sum, item) => sum + item.unread, 0) ?? 0
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Inbox" className={activeLinkClass}>
        <Link to="/inbox">
          <MailIcon className="opacity-70" />
          <span className="min-w-0 flex-1 truncate">Inbox</span>
          <UnreadBadge count={unread} />
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

const activeLinkClass =
  'data-[status=active]:bg-sidebar-primary data-[status=active]:font-medium data-[status=active]:text-sidebar-primary-foreground'

/** A quiet count on a company nav row; nothing at all when there is none. */
function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="ml-auto shrink-0 text-[11px] text-sidebar-foreground/45 tabular-nums">
      {count > 99 ? '99+' : count}
    </span>
  )
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="ml-auto shrink-0 rounded-full bg-destructive px-1.5 py-px text-[10px] font-semibold tabular-nums text-white">
      {count > 99 ? '99+' : count}
    </span>
  )
}

/** The one-letter/emoji tile that used to live on the company rail. */
function CompanyGlyph({
  avatar,
  name,
  className
}: {
  avatar: { kind: string; value?: string } | undefined
  name: string
  className?: string
}) {
  const glyph =
    avatar?.kind === 'emoji' && avatar.value !== undefined
      ? avatar.value
      : name.charAt(0).toUpperCase()
  return (
    <span
      aria-hidden
      className={cn(
        'flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-base leading-none select-none',
        className
      )}
    >
      {glyph}
    </span>
  )
}

function ChannelNavItem({ channel }: { channel: Channel }) {
  const { unread, mentions } = useUnread(channel.id)
  // Channel huddles notify nobody (D8); this row is the whole of how they surface.
  const huddle = useChannelCall(channel.id)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        size="sm"
        tooltip={huddle === undefined ? channel.name : `${channel.name} · huddle`}
        className={cn(activeLinkClass, unread > 0 && 'font-medium text-sidebar-foreground')}
      >
        <Link to="/c/$channelId" params={{ channelId: channel.id }}>
          <HashIcon className="opacity-70" />
          <span className="min-w-0 flex-1 truncate">{channel.name}</span>
          {huddle === undefined ? null : (
            <HeadphonesIcon
              role="img"
              aria-label="Huddle in progress"
              className="size-3.5 shrink-0 text-emerald-500"
            />
          )}
          <UnreadBadge count={mentions > 0 ? mentions : unread} />
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function DmNavItem({
  channelId,
  label,
  partner,
  archived = false
}: {
  channelId: string
  label: string
  partner: Mentionable | undefined
  /** The agent on the other side is archived: no presence, no unread, dimmed. */
  archived?: boolean
}) {
  const { unread } = useUnread(channelId)
  const presence = usePresence(partner?.id, partner?.defaultPresence ?? 'offline')
  const name = partner?.name ?? label

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip={archived ? `${name} (archived)` : name}
        className={cn(
          activeLinkClass,
          unread > 0 && !archived && 'font-medium text-sidebar-foreground',
          archived && 'text-sidebar-foreground/50'
        )}
      >
        <Link to="/dm/$channelId" params={{ channelId }}>
          <EntityAvatar
            memberId={partner?.id}
            avatar={partner?.avatar ?? { kind: 'emoji', value: '💬' }}
            kind={partner?.kind ?? 'user'}
            face={partner?.face}
            name={name}
            presence={archived ? 'offline' : presence}
            size="sm"
          />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {partner?.kind === 'agent' && !archived ? (
            <PresenceDot presence={presence} className="shrink-0" />
          ) : null}
          {archived ? null : <UnreadBadge count={unread} />}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * DMs whose agent has been archived. Folded away rather than dropped: the history is still
 * readable, it just stops competing with the conversations that can still answer.
 */
function ArchivedDms({ views }: { views: readonly DmView[] }) {
  const [open, setOpen] = React.useState(false)
  if (views.length === 0) return null

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip="Archived conversations"
          onClick={() => setOpen((value) => !value)}
          className="text-sidebar-foreground/50"
        >
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          <span className="min-w-0 flex-1 truncate text-left">Archived</span>
          <span className="shrink-0 text-[11px] tabular-nums">{views.length}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {open
        ? views.map((view) => (
            <DmNavItem
              key={view.channel.id}
              channelId={view.channel.id}
              label={view.label}
              partner={view.partner}
              archived
            />
          ))
        : null}
    </>
  )
}

/** Top of the sidebar: which company you are in, and what you can do to it. */
function CompanyHeader({ onInvite }: { onInvite: () => void }) {
  const me = useMe().data
  const navigate = useNavigate()
  const activeCompany = me?.memberships.find(
    (entry) => entry.company.id === me.activeCompanyId
  )?.company

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          tooltip={activeCompany?.name ?? 'Taut'}
          className="data-[state=open]:bg-sidebar-accent"
        >
          <CompanyGlyph avatar={activeCompany?.avatar} name={activeCompany?.name ?? 'Taut'} />
          <span className="grid min-w-0 flex-1 text-left leading-tight">
            <span className="truncate text-[15px] font-bold">{activeCompany?.name ?? 'Taut'}</span>
            <span className="truncate text-xs text-sidebar-foreground/60">
              {activeCompany === undefined ? 'Loading…' : `taut.sh/${activeCompany.slug}`}
            </span>
          </span>
          <ChevronDownIcon className="shrink-0 text-sidebar-foreground/60" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {activeCompany?.name ?? 'Company'}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void navigate({ to: '/settings/company' })}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onInvite}>
          <UserPlusIcon />
          Invite people
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void navigate({ to: '/members' })}>
          <UsersIcon />
          Members
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Bottom of the sidebar: the other companies you belong to, and the door to a
 * new one. This is what the old 64px company rail collapsed into.
 */
function CompanySwitcher() {
  const companies = useCompanies()
  const me = useMe().data
  const switchTo = useCompanySwitcher()
  const [creating, setCreating] = React.useState(false)

  const items = companies.data?.items ?? []
  const activeId = me?.activeCompanyId
  const others = items.filter(({ company }) => company.id !== activeId).length

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip="Switch company"
            className="text-sidebar-foreground/80 data-[state=open]:bg-sidebar-accent"
          >
            <Building2Icon className="opacity-70" />
            <span className="min-w-0 flex-1 truncate text-left">Companies</span>
            {others > 0 ? (
              <span className="shrink-0 text-[11px] text-sidebar-foreground/45 tabular-nums">
                {others + 1}
              </span>
            ) : null}
            <ChevronsUpDownIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-60">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Switch company
          </DropdownMenuLabel>
          {items.map(({ company, role }) => {
            const active = company.id === activeId
            return (
              <DropdownMenuItem
                key={company.id}
                onSelect={() => {
                  if (!active) void switchTo(company.id)
                }}
              >
                <CompanyGlyph
                  avatar={company.avatar}
                  name={company.name}
                  className="size-5 rounded-[5px] bg-muted text-[11px]"
                />
                <span className="min-w-0 flex-1 truncate">{company.name}</span>
                {active ? (
                  <CheckIcon className="size-3.5 shrink-0 opacity-70" />
                ) : (
                  <span className="shrink-0 text-[11px] text-muted-foreground capitalize">
                    {role}
                  </span>
                )}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <PlusIcon />
            Create a company
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateCompanyDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

function DepartmentGroup({
  department,
  channels,
  defaultOpen
}: {
  department: Department
  channels: readonly Channel[]
  defaultOpen: boolean
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const [creating, setCreating] = React.useState(false)
  const lookup = useLookupMember()
  const head = lookup(department.headUserId)
  const { state, isMobile, setOpen: setSidebarOpen } = useSidebar()
  const collapsed = !isMobile && state === 'collapsed'

  return (
    <>
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          if (!collapsed) setOpen(next)
        }}
        className="group/dept"
        asChild
      >
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton
              tooltip={department.name}
              className="pr-14 font-medium text-sidebar-foreground/90"
              onClick={() => {
                // In icon mode the sub-list is hidden, so open the sidebar instead.
                if (collapsed) setSidebarOpen(true)
              }}
            >
              <span className="taut-sidebar-disclosure-icon">
                <ChevronRightIcon className={cn('taut-sidebar-chevron', open && 'rotate-90')} />
                <FolderIcon className="taut-sidebar-folder" />
              </span>
              <span className="min-w-0 flex-1 truncate text-left">{department.name}</span>
              {head === undefined ? null : (
                <EntityAvatar
                  memberId={head.id}
                  avatar={head.avatar}
                  name={head.name}
                  size="sm"
                  className="shrink-0 opacity-80"
                />
              )}
            </SidebarMenuButton>
          </CollapsibleTrigger>

          <div className="absolute top-1 right-1 flex items-center opacity-0 transition-opacity group-focus-within/dept:opacity-100 group-hover/dept:opacity-100 group-data-[collapsible=icon]:hidden">
            <button
              type="button"
              title={`New channel in ${department.name}`}
              onClick={() => setCreating(true)}
              className="flex size-6 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <PlusIcon className="size-3.5" />
              <span className="sr-only">New channel in {department.name}</span>
            </button>
            <Link
              to="/departments/$departmentId/settings"
              params={{ departmentId: department.id }}
              title={`${department.name} settings`}
              className="flex size-6 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <SettingsIcon className="size-3.5" />
              <span className="sr-only">{department.name} settings</span>
            </Link>
          </div>

          <CollapsibleContent>
            <SidebarMenuSub className="mr-0">
              {channels.length === 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    onClick={() => setCreating(true)}
                    className="text-sidebar-foreground/50"
                  >
                    <PlusIcon />
                    <span>Create the first channel</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : (
                channels.map((channel) => <ChannelNavItem key={channel.id} channel={channel} />)
              )}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>

      <CreateChannelDialog
        open={creating}
        onOpenChange={setCreating}
        departmentId={department.id}
        departmentName={department.name}
      />
    </>
  )
}

/** How many projects the group shows before it stops and offers the full page. */
const SIDEBAR_PROJECTS = 8
/** Remembered per browser, like every other sidebar disclosure. */
const PROJECTS_OPEN_KEY = 'taut.sidebar.projects'

function ProjectNavItem({ project }: { project: Project }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild size="sm" tooltip={project.name} className={activeLinkClass}>
        <Link to="/projects/$projectId" params={{ projectId: project.id }}>
          <CircleIcon
            className={cn('size-2.5 shrink-0', PROJECT_STATE_COLOR[project.state])}
            aria-label={PROJECT_STATE_LABEL[project.state]}
          />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * Projects mirrored from Linear (docs/build-plan-projects.md D8). The group is a
 * disclosure over the list rather than a single row with a count, so the projects
 * themselves are one click away.
 *
 * Anyone who could connect Linear sees the group whether or not it is connected,
 * with a row that starts the connection — a feature nobody can find is a feature
 * nobody has. A plain member of a company that does not use Linear sees nothing,
 * because for them the group would never fill.
 */
function ProjectsGroup() {
  const connection = useLinearConnection()
  const projects = useProjects().data?.items ?? []
  const canAdminister = useCanAdminister()
  const { state, isMobile, setOpen: setSidebarOpen } = useSidebar()
  const collapsed = !isMobile && state === 'collapsed'

  const [open, setOpen] = React.useState(() => {
    try {
      return window.localStorage.getItem(PROJECTS_OPEN_KEY) !== 'closed'
    } catch {
      return true
    }
  })

  const toggle = (next: boolean) => {
    setOpen(next)
    try {
      window.localStorage.setItem(PROJECTS_OPEN_KEY, next ? 'open' : 'closed')
    } catch {
      // A browser that refuses storage still gets a working disclosure.
    }
  }

  const connected = connection.data?.state === 'connected'
  if (!connected && !canAdminister) return null

  const shown = projects.slice(0, SIDEBAR_PROJECTS)
  const rest = projects.length - shown.length

  return (
    <SidebarGroup className="py-0">
      <SidebarGroupContent>
        <SidebarMenu>
          <Collapsible
            open={open}
            onOpenChange={(next) => {
              if (!collapsed) toggle(next)
            }}
            asChild
          >
            <SidebarMenuItem>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton
                  tooltip="Projects"
                  className="pr-14 font-medium text-sidebar-foreground/90"
                  onClick={() => {
                    // In icon mode the sub-list is hidden, so open the sidebar instead.
                    if (collapsed) setSidebarOpen(true)
                  }}
                >
                  <span className="taut-sidebar-disclosure-icon">
                    <ChevronRightIcon className={cn('taut-sidebar-chevron', open && 'rotate-90')} />
                    <SquareKanbanIcon className="taut-sidebar-folder" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">Projects</span>
                  <CountBadge count={projects.length} />
                </SidebarMenuButton>
              </CollapsibleTrigger>

              <CollapsibleContent>
                <SidebarMenuSub className="mr-0">
                  {!connected ? (
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild size="sm" className="text-sidebar-foreground/50">
                        <Link to="/settings/linear">
                          <PlusIcon />
                          <span>Connect Linear</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : shown.length === 0 ? (
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild size="sm" className="text-sidebar-foreground/50">
                        <Link to="/projects">
                          <span>No projects in Linear yet</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : (
                    shown.map((project) => <ProjectNavItem key={project.id} project={project} />)
                  )}
                  {rest > 0 ? (
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild size="sm" className="text-sidebar-foreground/50">
                        <Link to="/projects">
                          <span>{rest} more</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : null}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/**
 * Web Push for this browser. Per-device by design: turning it on on your laptop
 * says nothing about your phone. Hidden where the browser cannot do push at all;
 * on iOS it stays visible and explains that the app has to be installed first.
 */
function NotificationsItem() {
  const push = usePush()
  if (push.state === 'unsupported') return null

  const on = push.state === 'on'
  const label = on
    ? 'Notifications on'
    : push.state === 'denied'
      ? 'Notifications blocked'
      : push.state === 'needs-install'
        ? 'Notifications (install first)'
        : 'Turn on notifications'

  return (
    <DropdownMenuItem
      disabled={push.busy}
      // Keeps the menu open so a permission prompt does not fight the closing animation.
      onSelect={(event) => {
        event.preventDefault()
        push.toggle()
      }}
    >
      {on ? <BellIcon /> : <BellOffIcon />}
      {label}
    </DropdownMenuItem>
  )
}

function UserFooter() {
  const user = useCurrentUser()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const logout = useLogout()
  const { preference, setPreference, resolved } = useTheme()
  const presence = usePresence(user?.id, 'online')

  const signOut = (): void => {
    logout.mutate(undefined, {
      onSuccess: () => {
        realtime.close()
        queryClient.clear()
        void navigate({ to: '/login' })
      }
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          tooltip={user?.name ?? 'Account'}
          className="data-[state=open]:bg-sidebar-accent"
        >
          <EntityAvatar
            memberId={user?.id}
            avatar={user?.avatar ?? { kind: 'emoji', value: '👤' }}
            name={user?.name ?? ''}
            presence={presence}
            size="md"
          />
          <span className="grid min-w-0 flex-1 text-left leading-tight">
            <span className="truncate text-[13px] font-medium">{user?.name ?? 'Loading…'}</span>
            <span className="truncate text-[11px] text-sidebar-foreground/60">
              {user?.subtitle ?? ''}
            </span>
          </span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {user?.email ?? ''}
        </DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {resolved === 'dark' ? <MoonIcon /> : <SunIcon />}
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={preference}
              onValueChange={(value) => {
                if (value === 'light' || value === 'dark' || value === 'system') {
                  setPreference(value)
                }
              }}
            >
              <DropdownMenuRadioItem value="light">
                <SunIcon />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <MoonIcon />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <MonitorIcon />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <NotificationsItem />
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={signOut}>
          <LogOutIcon />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppSidebar({
  connection,
  lastSeq
}: {
  connection: ConnectionStatus
  lastSeq: number
}) {
  const pathname = useLocation({ select: (location) => location.pathname })
  const { setOpenMobile } = useSidebar()
  React.useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])
  const { departments } = useDepartmentList()
  const { company: allCompany, byDepartment } = useChannelGroups()
  /*
   * The hidden channels that back issue threads (docs/build-plan-issues.md D9).
   * Real in every other way — an unread message in one still badges, still
   * notifies, still shows in search — they just have no row of their own to
   * click, because their home is the ticket.
   *
   * Only this list is filtered: a hidden channel has `department_id = NULL` like
   * a DM (D21), so the company group is the only bucket one can land in.
   */
  const company = React.useMemo(() => allCompany.filter((channel) => !channel.hidden), [allCompany])
  const dms = useDmViews()
  const palette = useCommandPalette()
  const canAdminister = useCanAdminister()

  const agentCount = (useAgents().data?.items ?? []).filter(
    (agent) => agent.archivedAt === undefined
  ).length
  // Any member may list vault metadata and subscriptions; the pages hide the write actions.
  const vaultCount = useVaultItems().data?.items.length ?? 0
  const subscriptionCount = useSubscriptions().data?.items.length ?? 0
  const repositoryCount = useRepositories().data?.items.length ?? 0
  const runningTasks = useTasks({ status: 'running' }).data?.items.length ?? 0
  // Empty for everyone but the head of the department an agent tried to leave (and admins),
  // so the entry appears only when somebody actually has to decide something.
  const openHandovers = useHandovers('open').data?.length ?? 0

  const [inviting, setInviting] = React.useState(false)
  const [creatingChannel, setCreatingChannel] = React.useState(false)
  const [creatingDepartment, setCreatingDepartment] = React.useState(false)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="taut-sidebar-header border-b border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem className="relative min-w-0">
            <CompanyHeader onInvite={() => setInviting(true)} />
            <SidebarTrigger className="taut-sidebar-toggle text-sidebar-foreground/60" />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="pb-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Search"
                  onClick={() => palette.open('all')}
                  className="border border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground/60 group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent"
                >
                  <SearchIcon />
                  <span className="min-w-0 flex-1 text-left">Search</span>
                  <kbd className="shrink-0 rounded border border-sidebar-border px-1 py-px font-sans text-[10px]">
                    ⌘K
                  </kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <InboxNavItem />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <ProjectsGroup />

        {company.length === 0 ? null : (
          <SidebarGroup className="py-0">
            <SidebarGroupLabel>Channels</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {company.map((channel) => (
                  <ChannelNavItem key={channel.id} channel={channel} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup className="py-0">
          <SidebarGroupLabel>Departments</SidebarGroupLabel>
          <SidebarGroupAction
            title="Create a channel"
            className="top-1.5"
            onClick={() => setCreatingChannel(true)}
          >
            <PlusIcon />
            <span className="sr-only">Create a channel</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {departments.map((department, index) => (
                <DepartmentGroup
                  key={department.id}
                  department={department}
                  defaultOpen={index === 0}
                  channels={byDepartment.get(department.id) ?? []}
                />
              ))}
              {canAdminister ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip="Add department"
                    onClick={() => setCreatingDepartment(true)}
                    className="text-sidebar-foreground/60"
                  >
                    <PlusIcon />
                    <span>
                      {departments.length === 0 ? 'Create your first department' : 'Add department'}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="py-0">
          <SidebarGroupLabel>Direct messages</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {dms
                .filter((view) => !view.archived)
                .map((view) => (
                  <DmNavItem
                    key={view.channel.id}
                    channelId={view.channel.id}
                    label={view.label}
                    partner={view.partner}
                  />
                ))}
              <ArchivedDms views={dms.filter((view) => view.archived)} />
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="New message"
                  onClick={() => palette.open('dm')}
                  className="text-sidebar-foreground/60"
                >
                  <PencilIcon />
                  <span>New message</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="pt-0">
          <SidebarGroupLabel>Company</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Agents" className={activeLinkClass}>
                  <Link to="/agents">
                    <BotIcon className="opacity-70" />
                    <span className="min-w-0 flex-1 truncate">Agents</span>
                    <CountBadge count={agentCount} />
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Tasks" className={activeLinkClass}>
                  <Link to="/tasks">
                    <ListChecksIcon className="opacity-70" />
                    <span className="min-w-0 flex-1 truncate">Tasks</span>
                    {runningTasks > 0 ? (
                      <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-medium text-amber-600 tabular-nums dark:text-amber-500">
                        <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
                        {runningTasks}
                      </span>
                    ) : null}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {openHandovers > 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Handovers" className={activeLinkClass}>
                    <Link to="/handovers">
                      <ArrowLeftRightIcon className="opacity-70" />
                      <span className="min-w-0 flex-1 truncate">Handovers</span>
                      <CountBadge count={openHandovers} />
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Vault" className={activeLinkClass}>
                  <Link to="/vault">
                    <KeyRoundIcon className="opacity-70" />
                    <span className="min-w-0 flex-1 truncate">Vault</span>
                    <CountBadge count={vaultCount} />
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Repositories" className={activeLinkClass}>
                  <Link to="/settings/repositories">
                    <FolderGitIcon className="opacity-70" />
                    <span className="min-w-0 flex-1 truncate">Repositories</span>
                    <CountBadge count={repositoryCount} />
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Providers" className={activeLinkClass}>
                  <Link to="/subscriptions">
                    <CreditCardIcon className="opacity-70" />
                    <span className="min-w-0 flex-1 truncate">Providers</span>
                    <CountBadge count={subscriptionCount} />
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Members" className={activeLinkClass}>
                  <Link to="/members">
                    <UsersIcon className="opacity-70" />
                    <span className="min-w-0 flex-1 truncate">Members</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator className="mx-0" />

      <SidebarFooter className="gap-1">
        <div className="taut-sidebar-connection">
          <ConnectionIndicator status={connection} lastSeq={lastSeq} />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <CompanySwitcher />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <UserFooter />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />

      <InviteDialog open={inviting} onOpenChange={setInviting} />
      <CreateChannelDialog open={creatingChannel} onOpenChange={setCreatingChannel} />
      <CreateDepartmentDialog open={creatingDepartment} onOpenChange={setCreatingDepartment} />
    </Sidebar>
  )
}
