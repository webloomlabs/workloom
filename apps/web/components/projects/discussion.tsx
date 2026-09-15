'use client'

import { Badge, Button, Textarea } from '@workloom/ui'
import { useActionState } from 'react'
import { deleteAttachmentAction, deleteCommentAction, postCommentAction, uploadAttachmentAction } from '@/lib/actions/projects'
import { idle } from '@/lib/actions/state'
import { FormMessage, SubmitButton, fieldError } from '../form-bits'

type Scope = { projectId: string; taskId?: string | undefined; returnTo: string }

function ScopeFields({ projectId, taskId, returnTo }: Scope) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      {taskId && <input type="hidden" name="taskId" value={taskId} />}
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  )
}

export type CommentEntry = {
  id: string
  authorName: string | null
  body: string
  when: string
  clientVisible: boolean
  editable: boolean
}

export function CommentForm({ canPublish, placeholder, ...scope }: Scope & { canPublish: boolean; placeholder: string }) {
  const [state, action] = useActionState(postCommentAction, idle)
  return (
    <form action={action} className="space-y-2" noValidate>
      <ScopeFields {...scope} />
      <label htmlFor={`comment-${scope.taskId ?? scope.projectId}`} className="sr-only">{placeholder}</label>
      <Textarea
        id={`comment-${scope.taskId ?? scope.projectId}`}
        name="body"
        rows={3}
        placeholder={placeholder}
        defaultValue={state.status === 'error' ? state.values?.body : ''}
        aria-invalid={fieldError(state, 'body') ? true : undefined}
      />
      {fieldError(state, 'body') && <p role="alert" className="text-xs text-red-600">{fieldError(state, 'body')}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Posting…">Post</SubmitButton>
        {canPublish && (
          <label className="flex items-center gap-2 text-xs text-neutral-600">
            <input type="checkbox" name="clientVisible" /> Visible to the client
          </label>
        )}
        {state.status === 'error' && !fieldError(state, 'body') && <FormMessage state={state} />}
      </div>
    </form>
  )
}

export function CommentList({ comments, ...scope }: Scope & { comments: CommentEntry[] }) {
  if (comments.length === 0) return <p className="px-5 py-6 text-center text-sm text-neutral-500">Nothing posted yet.</p>
  return (
    <ol className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {comments.map((c) => (
        <li key={c.id} className="px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <span className="font-medium text-neutral-700 dark:text-neutral-300">{c.authorName ?? 'Former member'}</span>
              <span>{c.when}</span>
              {c.clientVisible && <Badge tone="green">Client-visible</Badge>}
            </div>
            {c.editable && (
              <form action={deleteCommentAction} onSubmit={(e) => { if (!confirm('Delete this comment?')) e.preventDefault() }}>
                <ScopeFields {...scope} />
                <input type="hidden" name="id" value={c.id} />
                <Button type="submit" size="sm" variant="ghost">Delete</Button>
              </form>
            )}
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm">{c.body}</p>
        </li>
      ))}
    </ol>
  )
}

export type FileEntry = {
  id: string
  filename: string
  size: string
  uploaderName: string | null
  when: string
  clientVisible: boolean
  deletable: boolean
}

export function UploadForm({ canPublish, maxLabel, ...scope }: Scope & { canPublish: boolean; maxLabel: string }) {
  const [state, action] = useActionState(uploadAttachmentAction, idle)
  return (
    <form action={action} className="space-y-2" noValidate>
      <ScopeFields {...scope} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          <span className="sr-only">File</span>
          <input type="file" name="file" className="text-sm file:mr-3 file:rounded-md file:border file:border-neutral-300 file:bg-white file:px-3 file:py-1.5 file:text-sm dark:file:border-neutral-700 dark:file:bg-neutral-900" />
        </label>
        {canPublish && (
          <label className="flex items-center gap-2 text-xs text-neutral-600">
            <input type="checkbox" name="clientVisible" /> Visible to the client
          </label>
        )}
        <SubmitButton size="sm" pendingLabel="Uploading…">Upload</SubmitButton>
      </div>
      <p className="text-xs text-neutral-500">Up to {maxLabel}. Files always download rather than open in the browser.</p>
      {state.status === 'error' && <p role="alert" className="text-xs text-red-600">{fieldError(state, 'file') ?? state.message}</p>}
      {state.status === 'success' && <FormMessage state={state} />}
    </form>
  )
}

export function FileList({ files, ...scope }: Scope & { files: FileEntry[] }) {
  if (files.length === 0) return <p className="px-5 py-6 text-center text-sm text-neutral-500">No files yet.</p>
  return (
    <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {files.map((f) => (
        <li key={f.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
          <div className="min-w-0">
            <a href={`/files/attachments/${f.id}`} className="block truncate font-medium hover:underline">{f.filename}</a>
            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <span>{f.size}</span>
              <span>{f.uploaderName ?? 'Former member'}</span>
              <span>{f.when}</span>
              {f.clientVisible && <Badge tone="green">Client-visible</Badge>}
            </div>
          </div>
          {f.deletable && (
            <form action={deleteAttachmentAction} onSubmit={(e) => { if (!confirm(`Delete ${f.filename}?`)) e.preventDefault() }}>
              <ScopeFields {...scope} />
              <input type="hidden" name="id" value={f.id} />
              <Button type="submit" size="sm" variant="ghost" aria-label={`Delete ${f.filename}`}>Delete</Button>
            </form>
          )}
        </li>
      ))}
    </ul>
  )
}
