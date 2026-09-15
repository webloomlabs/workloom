'use client'

import { Field, Input, Select, Textarea } from '@workloom/ui'
import type { ActionState } from '@/lib/actions/state'
import type { Option } from '@/lib/crm-labels'
import { fieldError } from '../form-bits'

export type Choice = { id: string; name: string }

/** The submitted value after a failed action, else the record's own value. */
export function initial(state: ActionState<unknown>, name: string, fallback: string | null | undefined): string {
  return (state.status === 'error' ? state.values?.[name] : undefined) ?? fallback ?? ''
}

type Common = {
  state: ActionState<unknown>
  name: string
  label: string
  hint?: string | undefined
  /** Defaults to `name`. Set it when one page holds several forms with the same fields. */
  id?: string | undefined
}

export function TextField({
  state,
  name,
  id = name,
  label,
  hint,
  defaultValue,
  type = 'text',
  required,
  placeholder,
}: Common & { defaultValue?: string | null | undefined; type?: string | undefined; required?: boolean | undefined; placeholder?: string | undefined }) {
  const error = fieldError(state, name)
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={initial(state, name, defaultValue)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
    </Field>
  )
}

export function TextAreaField({ state, name, label, hint, defaultValue }: Common & { defaultValue?: string | null | undefined }) {
  const error = fieldError(state, name)
  return (
    <Field id={name} label={label} hint={hint} error={error}>
      <Textarea id={name} name={name} rows={3} defaultValue={initial(state, name, defaultValue)} aria-invalid={error ? true : undefined} />
    </Field>
  )
}

export function SelectField({
  state,
  name,
  id = name,
  label,
  hint,
  defaultValue,
  options,
  empty,
}: Common & { defaultValue?: string | null | undefined; options: Option[]; empty?: string | undefined }) {
  const error = fieldError(state, name)
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Select id={id} name={name} defaultValue={initial(state, name, defaultValue)} aria-invalid={error ? true : undefined}>
        {empty !== undefined && <option value="">{empty}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </Select>
    </Field>
  )
}

/** People who can own a record. Defaults to "unassigned" when there is no current owner. */
export function OwnerField({
  state,
  members,
  defaultValue,
}: {
  state: ActionState<unknown>
  members: Choice[]
  defaultValue: string | null
}) {
  return (
    <SelectField
      state={state}
      name="ownerId"
      label="Owner"
      defaultValue={defaultValue}
      empty="Unassigned"
      options={members.map((m) => ({ value: m.id, label: m.name }))}
    />
  )
}

export const choices = (items: Choice[]): Option[] => items.map((i) => ({ value: i.id, label: i.name }))
