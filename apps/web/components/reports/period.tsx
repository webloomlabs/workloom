import { Button, Input } from '@workloom/ui'

/**
 * The period a report covers.
 *
 * A plain GET form, so it works without JavaScript and every period is a URL
 * someone can send to a colleague.
 */
export function PeriodPicker({ from, to }: { from: string; to: string }) {
  return (
    <form action="/reports" className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="from" className="block text-xs font-medium text-neutral-500">From</label>
        <Input id="from" name="from" type="date" defaultValue={from} className="h-8" />
      </div>
      <div>
        <label htmlFor="to" className="block text-xs font-medium text-neutral-500">To</label>
        <Input id="to" name="to" type="date" defaultValue={to} className="h-8" />
      </div>
      <Button type="submit" size="sm" variant="secondary">Show</Button>
    </form>
  )
}
