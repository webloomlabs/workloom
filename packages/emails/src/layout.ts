/** Escapes interpolated values. Every template must pass user data through it. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Shared shell.
 *
 * Table-based and inline-styled on purpose: it is what survives Outlook and
 * Gmail. Keep it boring.
 */
export function layout(options: { heading: string; body: string; footer?: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1917;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e7e5e4;">
      <tr><td style="padding:32px;">
        <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;">${options.heading}</h1>
        ${options.body}
      </td></tr>
    </table>
    ${
      options.footer
        ? `<p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#78716c;text-align:center;">${options.footer}</p>`
        : ''
    }
  </body>
</html>`
}

export function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;background:#1c1917;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">${escapeHtml(label)}</a>`
}
