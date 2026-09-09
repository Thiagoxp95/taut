export interface MenuActions {
  readonly switchInstance: () => void
  /** ⌘, — the closest thing Taut has to preferences. */
  readonly openSettings: () => void
}
/** Standard Edit/View/Window menus plus the two things this shell adds. */
export declare const installMenu: (actions: MenuActions) => void
