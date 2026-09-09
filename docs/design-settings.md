# Settings surfaces

Every place in Taut where something is configured — the organization, a department, a
channel, an agent, the vault, the seat pool, the member list — wears the same shape. This
document is the contract for that shape. The primitives live in
`apps/web/src/components/settings.tsx`; each one composes shadcn components from
`@taut/ui/components` and re-implements no control of its own.

## The shape

```
┌─ rail ────┐  ┌─ callout (optional) ────────────────────────────┐
│ Section 1 │  │ ⚠  One thing worth doing.   [Dismiss] [Update]  │
│ Section 2 │  └─────────────────────────────────────────────────┘
│ Section 3 │  ┌─ card ──────────────────────────────────────────┐
│ Danger    │  │ Title                                           │
└───────────┘  │ One line saying what the card is for.           │
               ├─────────────────────────────────────────────────┤
               │ Label            Badge │  [ control ]           │
               │ What it means, in one  │                        │
               │ or two lines.          │                        │
               ├─────────────────────────────────────────────────┤
               │ …more rows…                                     │
               ├─────────────────────────────────────────────────┤
               │                          [Cancel] [Save changes] │
               └─────────────────────────────────────────────────┘
```

Left is what the setting is. Right is the control that changes it. A card that can be
saved ends in a footer whose two buttons are both dead until something is dirty, so the
page always says whether there is unsaved work without a banner.

## The primitives

| Primitive                                        | What it is                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `SettingsShell`                                  | Rail plus content column. The rail stacks above the content below `md`.                               |
| `SettingsNav` / `SettingsNavLink`                | A rail whose items are routes — used by the workspace-level pages.                                    |
| `SettingsTabs` / `SettingsTab` / `SettingsPanel` | A rail for one page's own sections, driven by Radix `Tabs` so arrow keys walk it.                     |
| `SettingsCallout`                                | The banner above the cards: one thing worth doing, with the buttons that do it.                       |
| `SettingsCard`                                   | A card whose body is a stack of rows. `onSubmit` turns it into a form.                                |
| `SettingsSection`                                | A card whose body is one padded block — a list, a table, an editor.                                   |
| `SettingsRow`                                    | Label plus description on the left, control on the right. `stacked` gives the control the full width. |
| `SettingsField`                                  | A labelled control inside a row that carries more than one.                                           |
| `SettingsSave`                                   | Cancel plus Save. `dirty` drives both.                                                                |
| `InputAffix` + `affixInputClass`                 | An input with a fixed lead-in: `@` before a handle, `#` before a channel, `https://` before a site.   |
| `DangerZone`                                     | The destructive card at the bottom of a page.                                                         |

`Alert` (`@taut/ui/components/alert.tsx`) is the shadcn primitive `SettingsCallout`
composes; its `attention` variant is the amber nudge, never an error.

## Rules

1. **A row's label is a noun, its description is a sentence.** "Slug" / "Used in URLs and
   as the folder name on disk." Never repeat the label in the description.
2. **A value that cannot change carries a `Fixed` badge** and a read-only control, not a
   missing control. A handle, a slug and a channel's department are all fixed.
3. **Save is per card.** One card, one form, one footer. A control that applies
   immediately (a `Switch`, a role `Select`) has no footer and no dirty state.
4. **Destructive actions live in `DangerZone`, on their own rail item**, behind a
   `ConfirmDialog`. Nothing destructive sits next to a Save button.
5. **A viewer who cannot change a thing sees `ReadOnlyNote` where the footer would be**,
   never a disabled Save button with no explanation.
6. **The rail is the page's table of contents.** Workspace pages share
   `WorkspaceSettingsNav` so the column never disappears mid-journey.

## Where it is used

| Surface       | Route                                 |
| ------------- | ------------------------------------- |
| Organization  | `/settings/company`                   |
| Repositories  | `/settings/repositories`              |
| Members       | `/members`                            |
| Subscriptions | `/subscriptions`                      |
| Vault         | `/vault`                              |
| Department    | `/departments/$departmentId/settings` |
| Channel       | `/channels/$channelId/settings`       |
| Agent         | `/agents/$agentId`                    |
