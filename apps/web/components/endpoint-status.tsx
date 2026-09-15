import { Badge } from '@workloom/ui'

export function EndpointStatus({ enabled, disabledReason }: { enabled: boolean; disabledReason: string | null }) {
  if (enabled) return <Badge tone="green">Active</Badge>
  return (
    <Badge tone={disabledReason ? 'red' : 'neutral'}>
      {disabledReason ? 'Disabled automatically' : 'Disabled'}
    </Badge>
  )
}
