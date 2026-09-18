'use client'

import { Checkbox, Label, controlStyles, cn } from '@workloom/ui'
import { useActionState } from 'react'
import { deleteDocumentAction, updateDocumentAction, uploadDocumentAction } from '@/lib/actions/service'
import { idle } from '@/lib/actions/state'
import { options } from '@/lib/crm-labels'
import { DOCUMENT_CATEGORY_LABELS } from '@/lib/service-labels'
import { SelectField, TextAreaField, TextField, type Choice } from '../crm/fields'
import { FormMessage, SubmitButton, fieldError } from '../form-bits'

const choices = (items: Choice[]) => items.map((i) => ({ value: i.id, label: i.name }))

/** Files a document against a client. Up to 25 MB, which the procedure enforces. */
export function UploadDocumentForm({
  companyId,
  projects,
  projectId,
}: {
  companyId: string
  projects: Choice[]
  /** Fixed, when filing from a project's own page: the picker would only offer the project you are on. */
  projectId?: string
}) {
  const [state, action] = useActionState(uploadDocumentAction, idle)
  const error = fieldError(state, 'file')
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="companyId" value={companyId} />
      {projectId && <input type="hidden" name="projectId" value={projectId} />}
      <FormMessage state={state} />
      <div className="space-y-1.5">
        <Label htmlFor="file">File</Label>
        <input
          id="file"
          type="file"
          name="file"
          required
          aria-invalid={error ? true : undefined}
          className={cn(
            controlStyles,
            'py-1.5 file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-raised file:px-3 file:py-1 file:text-sm file:text-ink',
          )}
        />
        {error && <p role="alert" className="text-xs font-medium text-critical">{error}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField state={state} name="title" label="Title" hint="Defaults to the file's name." />
        <SelectField state={state} name="category" label="Category" defaultValue="contract" options={options(DOCUMENT_CATEGORY_LABELS)} />
        {!projectId && <SelectField state={state} name="projectId" label="Project" options={choices(projects)} empty="Not project-specific" />}
      </div>
      <TextAreaField state={state} name="notes" label="Notes" />
      <div className="flex items-center gap-2">
        <Checkbox id="clientVisible" name="clientVisible" />
        <Label htmlFor="clientVisible" className="font-normal text-muted">
          The client may see this in their portal
        </Label>
      </div>
      <SubmitButton size="sm" pendingLabel="Uploading…">File document</SubmitButton>
    </form>
  )
}

export function DeleteDocumentButton({ id, companyId, projectId }: { id: string; companyId: string; projectId?: string }) {
  const [, action] = useActionState(deleteDocumentAction, idle)
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="companyId" value={companyId} />
      {projectId && <input type="hidden" name="projectId" value={projectId} />}
      <SubmitButton variant="ghost" size="xs" pendingLabel="…">Delete</SubmitButton>
    </form>
  )
}

/** Flips whether the client may see a document. Submits on change. */
export function DocumentVisibilityToggle({
  id,
  companyId,
  clientVisible,
  projectId,
}: {
  id: string
  companyId: string
  clientVisible: boolean
  projectId?: string
}) {
  const [, action] = useActionState(updateDocumentAction, idle)
  return (
    <form action={action} className="flex items-center">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="companyId" value={companyId} />
      {projectId && <input type="hidden" name="projectId" value={projectId} />}
      <input type="hidden" name="clientVisiblePresent" value="1" />
      <label className="flex items-center gap-2 text-xs text-muted">
        <Checkbox
          name="clientVisible"
          defaultChecked={clientVisible}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          aria-label="Visible to the client"
        />
        <span className="sr-only">Visible to the client</span>
      </label>
      <noscript>
        <SubmitButton variant="ghost" size="xs">Save</SubmitButton>
      </noscript>
    </form>
  )
}
