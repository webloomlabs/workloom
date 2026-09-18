import type { SVGProps } from 'react'
import { cn } from './cn.ts'

/**
 * The icon set.
 *
 * Hand-drawn 24x24 strokes rather than an icon dependency: the whole set is a
 * few kilobytes, a self-hosted install pulls nothing at build time, and every
 * glyph inherits `currentColor` and the 1.6 stroke that the rest of the chrome
 * is drawn with.
 *
 * Icons are decorative by default (`aria-hidden`); give one a `title` only
 * when it is the sole content of a control and nothing else names it.
 */
export type IconProps = SVGProps<SVGSVGElement> & { title?: string }

function icon(path: React.ReactNode, displayName: string) {
  function Glyph({ className, title, ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={title ? undefined : true}
        role={title ? 'img' : undefined}
        className={cn('size-4 shrink-0', className)}
        {...props}
      >
        {title && <title>{title}</title>}
        {path}
      </svg>
    )
  }
  Glyph.displayName = displayName
  return Glyph
}

export const HomeIcon = icon(
  <>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20h14V9.5" />
    <path d="M9.5 20v-6h5v6" />
  </>,
  'HomeIcon',
)

export const SparkleIcon = icon(
  <>
    <path d="M12 3.5 13.7 9l5.3 1.8-5.3 1.9L12 18l-1.7-5.3L5 10.8 10.3 9 12 3.5Z" />
    <path d="M18.5 16.5 19.2 18.6 21 19.4l-1.8.7-.7 2.1-.7-2.1-1.8-.7 1.8-.8.7-2.1Z" />
  </>,
  'SparkleIcon',
)

export const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </>,
  'SearchIcon',
)

export const BellIcon = icon(
  <>
    <path d="M18 9a6 6 0 1 0-12 0c0 4.5-1.5 6-1.5 6h15S18 13.5 18 9Z" />
    <path d="M10.3 19a2 2 0 0 0 3.4 0" />
  </>,
  'BellIcon',
)

export const PlusIcon = icon(
  <>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </>,
  'PlusIcon',
)

export const CheckIcon = icon(<path d="m5 12.5 4.5 4.5L19 7" />, 'CheckIcon')

export const XIcon = icon(
  <>
    <path d="m6 6 12 12" />
    <path d="m18 6-12 12" />
  </>,
  'XIcon',
)

export const ChevronDownIcon = icon(<path d="m6 9 6 6 6-6" />, 'ChevronDownIcon')
export const ChevronRightIcon = icon(<path d="m9 6 6 6-6 6" />, 'ChevronRightIcon')
export const ChevronLeftIcon = icon(<path d="m15 6-6 6 6 6" />, 'ChevronLeftIcon')
export const ArrowRightIcon = icon(
  <>
    <path d="M5 12h14" />
    <path d="m13 6 6 6-6 6" />
  </>,
  'ArrowRightIcon',
)
export const ArrowUpIcon = icon(
  <>
    <path d="M12 19V5" />
    <path d="m6 11 6-6 6 6" />
  </>,
  'ArrowUpIcon',
)
export const ArrowDownIcon = icon(
  <>
    <path d="M12 5v14" />
    <path d="m6 13 6 6 6-6" />
  </>,
  'ArrowDownIcon',
)

export const TargetIcon = icon(
  <>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
  </>,
  'TargetIcon',
)

export const BuildingIcon = icon(
  <>
    <path d="M4 20h16" />
    <path d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4h7A1.5 1.5 0 0 1 15 5.5V20" />
    <path d="M15 10h3.5A1.5 1.5 0 0 1 20 11.5V20" />
    <path d="M8 8h4M8 12h4M8 16h4" />
  </>,
  'BuildingIcon',
)

export const UsersIcon = icon(
  <>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.5a3.5 3.5 0 0 1 0 6.9" />
    <path d="M17.5 14.6a5.5 5.5 0 0 1 3 4.9" />
  </>,
  'UsersIcon',
)

export const ContactIcon = icon(
  <>
    <circle cx="12" cy="9" r="3.5" />
    <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    <rect x="3" y="3" width="18" height="18" rx="3" />
  </>,
  'ContactIcon',
)

export const PipelineIcon = icon(
  <>
    <rect x="3" y="4" width="5" height="16" rx="1.5" />
    <rect x="10" y="4" width="5" height="11" rx="1.5" />
    <rect x="17" y="4" width="4" height="7" rx="1.5" />
  </>,
  'PipelineIcon',
)

export const FileTextIcon = icon(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </>,
  'FileTextIcon',
)

export const ReceiptIcon = icon(
  <>
    <path d="M6 3v18l2-1.3 2 1.3 2-1.3 2 1.3 2-1.3 2 1.3V3l-2 1.3L14 3l-2 1.3L10 3 8 4.3 6 3Z" />
    <path d="M9.5 9h5M9.5 13h5" />
  </>,
  'ReceiptIcon',
)

export const CreditCardIcon = icon(
  <>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M2.5 10h19" />
    <path d="M6 15h3" />
  </>,
  'CreditCardIcon',
)

export const WalletIcon = icon(
  <>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v2" />
    <path d="M3 7.5V17a2.5 2.5 0 0 0 2.5 2.5H19a1 1 0 0 0 1-1V9.5a1 1 0 0 0-1-1H5.5A2.5 2.5 0 0 1 3 7.5Z" />
    <circle cx="16" cy="14" r="1.1" fill="currentColor" stroke="none" />
  </>,
  'WalletIcon',
)

export const BankIcon = icon(
  <>
    <path d="M3 9.5 12 4l9 5.5" />
    <path d="M4.5 9.5V18" />
    <path d="M9.5 9.5V18" />
    <path d="M14.5 9.5V18" />
    <path d="M19.5 9.5V18" />
    <path d="M2.5 20.5h19" />
  </>,
  'BankIcon',
)

export const ChartIcon = icon(
  <>
    <path d="M4 20V4" />
    <path d="M4 20h16" />
    <path d="M8 16V11" />
    <path d="M13 16V7" />
    <path d="M18 16v-3" />
  </>,
  'ChartIcon',
)

export const FolderIcon = icon(
  <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V7.5Z" />,
  'FolderIcon',
)

export const TaskIcon = icon(
  <>
    <rect x="3.5" y="4" width="17" height="17" rx="3" />
    <path d="m8 12.5 2.5 2.5L16 9.5" />
  </>,
  'TaskIcon',
)

export const ClockIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </>,
  'ClockIcon',
)

export const SettingsIcon = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a1.9 1.9 0 1 1-3.8 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3.6a1.9 1.9 0 1 1 0-3.8h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 2.7-1.1V3.6a1.9 1.9 0 1 1 3.8 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a1.9 1.9 0 1 1 0 3.8h-.2a1.6 1.6 0 0 0-1.5 1.1Z" />
  </>,
  'SettingsIcon',
)

export const LogOutIcon = icon(
  <>
    <path d="M9 4.5H6.5A2.5 2.5 0 0 0 4 7v10a2.5 2.5 0 0 0 2.5 2.5H9" />
    <path d="M15 8.5 19 12l-4 3.5" />
    <path d="M19 12H9.5" />
  </>,
  'LogOutIcon',
)

export const SunIcon = icon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
  </>,
  'SunIcon',
)

export const MoonIcon = icon(
  <path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z" />,
  'MoonIcon',
)

export const MenuIcon = icon(
  <>
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h16" />
  </>,
  'MenuIcon',
)

export const PanelLeftIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9.5 4v16" />
  </>,
  'PanelLeftIcon',
)

export const AlertIcon = icon(
  <>
    <path d="M12 4.5 2.8 20h18.4L12 4.5Z" />
    <path d="M12 10v4" />
    <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
  </>,
  'AlertIcon',
)

export const InfoIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </>,
  'InfoIcon',
)

export const CheckCircleIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.3 2.4 2.4 4.6-4.9" />
  </>,
  'CheckCircleIcon',
)

export const MailIcon = icon(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="m3.8 7 7.3 5.3a1.5 1.5 0 0 0 1.8 0L20.2 7" />
  </>,
  'MailIcon',
)

export const PhoneIcon = icon(
  <path d="M7.5 3.5 9.8 4l1 3.2-1.8 1.4a11 11 0 0 0 5.4 5.4l1.4-1.8 3.2 1 .5 2.3a1.6 1.6 0 0 1-1.6 2C11.4 17.2 6.8 12.6 5.5 5.1a1.6 1.6 0 0 1 2-1.6Z" />,
  'PhoneIcon',
)

export const CalendarIcon = icon(
  <>
    <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
    <path d="M3.5 9.5h17" />
    <path d="M8 3.5v3M16 3.5v3" />
  </>,
  'CalendarIcon',
)

export const DownloadIcon = icon(
  <>
    <path d="M12 4v10" />
    <path d="m8 11 4 3.5 4-3.5" />
    <path d="M4.5 18.5h15" />
  </>,
  'DownloadIcon',
)

export const ExternalLinkIcon = icon(
  <>
    <path d="M14 4h6v6" />
    <path d="m20 4-8.5 8.5" />
    <path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5" />
  </>,
  'ExternalLinkIcon',
)

export const PlayIcon = icon(<path d="M7.5 5.5 18 12 7.5 18.5v-13Z" />, 'PlayIcon')
export const StopIcon = icon(<rect x="6.5" y="6.5" width="11" height="11" rx="2" />, 'StopIcon')

export const FilterIcon = icon(
  <path d="M4 5.5h16l-6.2 7.2V19l-3.6-2v-4.3L4 5.5Z" />,
  'FilterIcon',
)

export const KeyIcon = icon(
  <>
    <circle cx="8" cy="12" r="4" />
    <path d="M12 12h8" />
    <path d="M17 12v3M20 12v2.5" />
  </>,
  'KeyIcon',
)

export const WebhookIcon = icon(
  <>
    <circle cx="7" cy="17" r="3" />
    <circle cx="17" cy="17" r="3" />
    <circle cx="12" cy="6.5" r="3" />
    <path d="M10.5 9.1 8.4 13.9M13.5 9.1l2.2 4.8M10 17h4" />
  </>,
  'WebhookIcon',
)

export const LifebuoyIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="m6 6 3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5" />
  </>,
  'LifebuoyIcon',
)

export const ShieldIcon = icon(
  <>
    <path d="M12 3.5 5 6v6c0 4 2.9 7.3 7 8.5 4.1-1.2 7-4.5 7-8.5V6l-7-2.5Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </>,
  'ShieldIcon',
)

export const ServerIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </>,
  'ServerIcon',
)

export const RepeatIcon = icon(
  <>
    <path d="M4 10V9a3 3 0 0 1 3-3h10.5" />
    <path d="m15 3.5 3 2.5-3 2.5" />
    <path d="M20 14v1a3 3 0 0 1-3 3H6.5" />
    <path d="m9 20.5-3-2.5 3-2.5" />
  </>,
  'RepeatIcon',
)
