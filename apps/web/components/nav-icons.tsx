import {
  BuildingIcon,
  ChartIcon,
  ClockIcon,
  ContactIcon,
  CreditCardIcon,
  FileTextIcon,
  FolderIcon,
  HomeIcon,
  type IconProps,
  PipelineIcon,
  ReceiptIcon,
  SettingsIcon,
  TargetIcon,
  LifebuoyIcon,
  RepeatIcon,
  ServerIcon,
  ShieldIcon,
  TaskIcon,
  UsersIcon,
  WalletIcon,
} from '@workloom/ui'

/**
 * Navigation is described on the server, drawn on the client.
 *
 * A component cannot cross that boundary as a prop, so the server names an
 * icon and this map turns the name back into a glyph.
 */
export const NAV_ICONS = {
  home: HomeIcon,
  pipeline: PipelineIcon,
  leads: TargetIcon,
  clients: UsersIcon,
  companies: BuildingIcon,
  contacts: ContactIcon,
  quotes: FileTextIcon,
  invoices: ReceiptIcon,
  payments: CreditCardIcon,
  expenses: WalletIcon,
  reports: ChartIcon,
  projects: FolderIcon,
  tasks: TaskIcon,
  time: ClockIcon,
  tickets: LifebuoyIcon,
  maintenance: ShieldIcon,
  infrastructure: ServerIcon,
  recurring: RepeatIcon,
  settings: SettingsIcon,
} as const satisfies Record<string, (props: IconProps) => React.ReactNode>

export type NavIconName = keyof typeof NAV_ICONS
