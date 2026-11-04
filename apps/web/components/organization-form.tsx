'use client'

import { Button, Checkbox, Field, Input, Select, Textarea } from '@workloom/ui'
import { useActionState, useState } from 'react'
import { removeLogoAction, updateOrganizationAction, uploadLogoAction } from '@/lib/actions/settings'
import { idle } from '@/lib/actions/state'
import { fieldError, FormMessage, SubmitButton } from './form-bits'

type Organization = {
  name: string
  baseCurrency: string
  timezone: string
  dateFormat: string
  legalName: string | null
  billingAddress: string | null
  taxNumber: string | null
  paymentInstructions: string | null
  paymentTermsDays: number
  fiscalYearStartMonth: number
  hasLogo: boolean
  brandColor: string | null
  paymentDetails: Array<{ label: string; value: string }>
  invoiceNotesDefault: string | null
  invoiceTermsDefault: string | null
  quoteTermsDefault: string | null
  documentFooter: string | null
  reclaimsInputTax: boolean
}

const DATE_FORMATS = [
  { value: 'DD/MM/YYYY', example: '27/10/2026' },
  { value: 'MM/DD/YYYY', example: '10/27/2026' },
  { value: 'YYYY-MM-DD', example: '2026-10-27' },
  { value: 'D MMM YYYY', example: '27 Oct 2026' },
  { value: 'D MMMM YYYY', example: '27 October 2026' },
]

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Bank details as rows a person can add to and remove from, posted as paymentDetail.N.label/value. */
function PaymentDetailsEditor({ initial, error }: { initial: Array<{ label: string; value: string }>; error?: string | undefined }) {
  const [rows, setRows] = useState(initial.length > 0 ? initial : [
    { label: 'Account Name', value: '' },
    { label: 'Account Number', value: '' },
    { label: 'Bank', value: '' },
    { label: 'Branch', value: '' },
  ])
  return (
    <div className="space-y-2 sm:col-span-2">
      <p className="text-sm font-medium">Payment details</p>
      <p className="text-xs text-muted">Printed in a box on every invoice, in this order. Leave a row empty to drop it.</p>
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2">
          <Input aria-label={`Detail ${i + 1} name`} name={`paymentDetail.${i}.label`} defaultValue={row.label} placeholder="Account Number" className="w-44" />
          <Input aria-label={`Detail ${i + 1} value`} name={`paymentDetail.${i}.value`} defaultValue={row.value} placeholder="93389900" />
          <Button type="button" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove detail ${i + 1}`}>
            Remove
          </Button>
        </div>
      ))}
      {rows.length < 8 ? (
        <Button type="button" variant="secondary" onClick={() => setRows([...rows, { label: '', value: '' }])}>
          Add a detail
        </Button>
      ) : null}
      {error ? <p className="text-sm text-critical">{error}</p> : null}
    </div>
  )
}

export function OrganizationForm({
  organization,
  canEdit,
  timezones,
}: {
  organization: Organization
  canEdit: boolean
  /**
   * From the server. Browsers and Node ship different time zone data, so a list
   * built here would differ between the server render and hydration.
   */
  timezones: string[]
}) {
  const [state, action] = useActionState(updateOrganizationAction, idle)
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <fieldset disabled={!canEdit} className="grid gap-5 sm:grid-cols-2">
        <Field id="name" label="Name" error={fieldError(state, 'name')}>
          <Input id="name" name="name" defaultValue={organization.name} required />
        </Field>
        <Field id="baseCurrency" label="Base currency"
          hint="ISO code, e.g. LKR. Existing records keep the currency they were issued in."
          error={fieldError(state, 'baseCurrency')}>
          <Input id="baseCurrency" name="baseCurrency" defaultValue={organization.baseCurrency}
            maxLength={3} className="uppercase" />
        </Field>
        <Field id="timezone" label="Time zone"
          hint="Decides when an invoice becomes overdue. For example Asia/Colombo."
          error={fieldError(state, 'timezone')}>
          <Input id="timezone" name="timezone" defaultValue={organization.timezone} list="timezones" />
        </Field>
        <Field id="dateFormat" label="Date format" error={fieldError(state, 'dateFormat')}>
          <Select id="dateFormat" name="dateFormat" defaultValue={organization.dateFormat}>
            {DATE_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>{f.example}</option>
            ))}
          </Select>
        </Field>
        <Field id="fiscalYearStartMonth" label="Financial year starts in"
          hint="April for a Sri Lankan year of assessment. Yearly numbering and the tax pack follow it."
          error={fieldError(state, 'fiscalYearStartMonth')}>
          <Select id="fiscalYearStartMonth" name="fiscalYearStartMonth" defaultValue={String(organization.fiscalYearStartMonth)}>
            {MONTHS.map((m, i) => (
              <option key={m} value={String(i + 1)}>{m}</option>
            ))}
          </Select>
        </Field>
        <div className="flex items-start gap-3 sm:col-span-2">
          <input type="hidden" name="reclaimsInputTax" value="false" />
          <Checkbox id="reclaimsInputTax" name="reclaimsInputTax" value="true" defaultChecked={organization.reclaimsInputTax} />
          <label htmlFor="reclaimsInputTax" className="text-sm">
            <span className="font-medium">We claim back tax paid on expenses</span>
            <span className="block text-muted">Untick if you are not registered for VAT or GST: tax on an expense then counts as part of what it cost.</span>
          </label>
        </div>
      </fieldset>
      <fieldset disabled={!canEdit} className="space-y-5 border-t border-line pt-5">
        <legend className="text-sm font-semibold">On quotes and invoices</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="legalName" label="Legal name" hint="The name documents are issued under, if it differs." error={fieldError(state, 'legalName')}>
            <Input id="legalName" name="legalName" defaultValue={organization.legalName ?? ''} />
          </Field>
          <Field id="taxNumber" label="Tax number" hint="TIN, VAT number, or local equivalent." error={fieldError(state, 'taxNumber')}>
            <Input id="taxNumber" name="taxNumber" defaultValue={organization.taxNumber ?? ''} />
          </Field>
          <Field id="billingAddress" label="Address" error={fieldError(state, 'billingAddress')}>
            <Textarea id="billingAddress" name="billingAddress" rows={3} defaultValue={organization.billingAddress ?? ''} />
          </Field>
          <Field id="brandColor" label="Accent colour" hint="The colour of headings and the balance bar, as #0b8a5e." error={fieldError(state, 'brandColor')}>
            <div className="flex gap-2">
              <Input id="brandColor" name="brandColor" defaultValue={organization.brandColor ?? ''} placeholder="#0b8a5e" className="font-mono" />
              <span aria-hidden className="h-9 w-9 shrink-0 rounded-md border border-line" style={{ background: organization.brandColor ?? '#0b8a5e' }} />
            </div>
          </Field>
          <PaymentDetailsEditor initial={organization.paymentDetails} error={fieldError(state, 'paymentDetails')} />
          <Field id="paymentInstructions" label="Other payment instructions" hint="Free text printed under the payment details, if you need it." error={fieldError(state, 'paymentInstructions')}>
            <Textarea id="paymentInstructions" name="paymentInstructions" rows={3} defaultValue={organization.paymentInstructions ?? ''} />
          </Field>
          <Field id="paymentTermsDays" label="Payment terms (days)" hint="The due date on a new invoice, counted from its issue date." error={fieldError(state, 'paymentTermsDays')}>
            <Input id="paymentTermsDays" name="paymentTermsDays" defaultValue={String(organization.paymentTermsDays)} inputMode="numeric" />
          </Field>
          <Field id="invoiceNotesDefault" label="Default invoice notes" hint="Starts every new invoice; change it on the invoice when needed." error={fieldError(state, 'invoiceNotesDefault')}>
            <Textarea id="invoiceNotesDefault" name="invoiceNotesDefault" rows={3} defaultValue={organization.invoiceNotesDefault ?? ''} />
          </Field>
          <Field id="invoiceTermsDefault" label="Default invoice terms" error={fieldError(state, 'invoiceTermsDefault')}>
            <Textarea id="invoiceTermsDefault" name="invoiceTermsDefault" rows={3} defaultValue={organization.invoiceTermsDefault ?? ''} />
          </Field>
          <Field id="quoteTermsDefault" label="Default quote terms" error={fieldError(state, 'quoteTermsDefault')}>
            <Textarea id="quoteTermsDefault" name="quoteTermsDefault" rows={3} defaultValue={organization.quoteTermsDefault ?? ''} />
          </Field>
          <Field id="documentFooter" label="Footer" hint="The last line of every page, after your name." error={fieldError(state, 'documentFooter')}>
            <Input id="documentFooter" name="documentFooter" defaultValue={organization.documentFooter ?? ''}
              placeholder="This is a computer-generated invoice and is valid without a signature." />
          </Field>
        </div>
      </fieldset>
      <datalist id="timezones">
        {timezones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      {canEdit ? (
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
      ) : (
        <p className="text-sm text-muted">Only owners and admins can change these settings.</p>
      )}
    </form>
  )
}

/** The printed logo: a preview, a file picker, and a way to take it off. */
export function LogoForm({ hasLogo, canEdit }: { hasLogo: boolean; canEdit: boolean }) {
  const [uploadState, upload] = useActionState(uploadLogoAction, idle)
  const [removeState, remove] = useActionState(removeLogoAction, idle)
  return (
    <div className="space-y-3">
      <FormMessage state={uploadState} />
      <FormMessage state={removeState} />
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-40 items-center justify-center rounded-md border border-line bg-surface">
          {hasLogo ? (
            <img src={`/files/organization-logo?v=${Date.now()}`} alt="Your logo" className="max-h-16 max-w-36 object-contain" />
          ) : (
            <span className="text-xs text-muted">No logo</span>
          )}
        </div>
        {canEdit ? (
          <div className="space-y-2">
            <form action={upload} className="flex items-center gap-2">
              <input type="file" name="file" accept="image/png,image/jpeg" aria-label="Logo file" className="text-sm" required />
              <SubmitButton variant="secondary" pendingLabel="Uploading…">Upload</SubmitButton>
            </form>
            {hasLogo ? (
              <form action={remove}>
                <SubmitButton variant="ghost" pendingLabel="Removing…">Remove logo</SubmitButton>
              </form>
            ) : null}
            <p className="text-xs text-muted">PNG or JPEG, up to 1 MB. A wide logo on a transparent background prints best.</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
