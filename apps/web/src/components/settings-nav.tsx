import {
  BuildingIcon,
  CreditCardIcon,
  FolderGitIcon,
  KeyRoundIcon,
  SquareKanbanIcon,
  UsersIcon
} from '@taut/ui/components/icons'
import { SettingsNav, SettingsNavLink } from '@/components/settings'

/**
 * The rail shared by every workspace-level settings page, so the reader keeps the
 * same left-hand column whichever one they are on.
 */
export function WorkspaceSettingsNav() {
  return (
    <SettingsNav aria-label="Workspace settings">
      <SettingsNavLink to="/settings/company" icon={<BuildingIcon />}>
        Organization
      </SettingsNavLink>
      <SettingsNavLink to="/settings/repositories" icon={<FolderGitIcon />}>
        Repositories
      </SettingsNavLink>
      <SettingsNavLink to="/settings/linear" icon={<SquareKanbanIcon />}>
        Linear
      </SettingsNavLink>
      <SettingsNavLink to="/members" icon={<UsersIcon />}>
        Members
      </SettingsNavLink>
      <SettingsNavLink to="/subscriptions" icon={<CreditCardIcon />}>
        Providers
      </SettingsNavLink>
      <SettingsNavLink to="/vault" icon={<KeyRoundIcon />}>
        Vault
      </SettingsNavLink>
    </SettingsNav>
  )
}
