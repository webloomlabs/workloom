import { Badge } from '@workloom/ui'

export function EndpointStatus({ enabled, disabledReason }: { enabled: boolean; disabledReason: string | null }) {
  if (enabled) return <Badge tone="positive">Active</Badge>
  return (
    <Badge tone={disabledReason ? 'critical' : 'neutral'}>
      {disabledReason ? 'Disabled automatically' : 'Disabled'}
    </Badge>
  )
}
