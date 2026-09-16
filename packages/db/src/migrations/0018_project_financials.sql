-- What a project earned and what it cost.
--
-- `WITH (security_invoker = true)` is not optional and not a nicety. A view over
-- row-level-secured tables runs with the view OWNER's privileges by default,
-- which bypasses every tenant policy silently: nothing looks wrong, and a test
-- that exercises one organization sees entirely correct data. With
-- security_invoker the view executes as whoever queries it, so each underlying
-- table's policy applies, and the isolation suite both checks the reloption and
-- reads the view as the wrong tenant to prove it.
--
-- One row per project AND currency. There is no rate to convert a time entry
-- at -- the MVP records an exchange rate only on a document when it is issued --
-- so a project whose money spans currencies reports each separately rather than
-- inventing a conversion on a page about profit.
--> statement-breakpoint
CREATE VIEW project_financials_v WITH (security_invoker = true) AS
WITH line_attribution AS (
  -- Which project each invoice line earned for. An invoice can bill work from
  -- several projects, so the line is the unit, not the invoice: the time it
  -- billed knows its project, then the expense it rebilled, and only then does
  -- the invoice's own project decide.
  SELECT
    l.organization_id,
    l.invoice_id,
    i.currency,
    i.amount_paid_minor,
    -- Revenue is what the agency keeps: the line less its tax. The same figure
    -- whether the document's prices include tax or exclude it.
    (l.total_minor - l.tax_minor) AS net_revenue_minor,
    COALESCE(
      (SELECT te.project_id FROM time_entries te WHERE te.invoice_line_id = l.id LIMIT 1),
      (SELECT ex.project_id FROM expenses ex WHERE ex.invoice_line_id = l.id LIMIT 1),
      i.project_id
    ) AS project_id
  FROM invoice_lines l
  JOIN invoices i ON i.id = l.invoice_id
  -- A draft is not revenue, and a cancelled invoice never was.
  WHERE i.status NOT IN ('draft', 'cancelled')
),
project_share AS (
  SELECT organization_id, invoice_id, project_id, currency,
         sum(net_revenue_minor) AS project_net_minor,
         min(amount_paid_minor) AS amount_paid_minor
  FROM line_attribution
  GROUP BY organization_id, invoice_id, project_id, currency
),
invoice_net AS (
  SELECT organization_id, invoice_id, sum(project_net_minor) AS invoice_net_minor
  FROM project_share
  GROUP BY organization_id, invoice_id
),
billed AS (
  SELECT s.organization_id, s.project_id, s.currency,
         sum(s.project_net_minor)::bigint AS billed_minor,
         -- A payment settles the whole invoice, so a project takes its share of
         -- it. Across projects the shares can differ from the invoice by a cent.
         sum(round(s.amount_paid_minor::numeric * s.project_net_minor
                   / nullif(n.invoice_net_minor, 0)))::bigint AS collected_minor
  FROM project_share s
  JOIN invoice_net n ON n.organization_id = s.organization_id AND n.invoice_id = s.invoice_id
  WHERE s.project_id IS NOT NULL
  GROUP BY s.organization_id, s.project_id, s.currency
),
labour AS (
  -- Rounded per entry at the rate that entry was logged at, then summed -- the
  -- same rule as the project time summary, so the two never disagree. Changing
  -- someone's rate today cannot move any of this.
  SELECT organization_id, project_id, currency,
         coalesce(sum(round(duration_seconds::numeric * cost_rate_minor / 3600)), 0)::bigint AS labour_cost_minor,
         coalesce(sum(round(duration_seconds::numeric * billable_rate_minor / 3600))
                  FILTER (WHERE billable AND invoice_line_id IS NULL), 0)::bigint AS uninvoiced_minor,
         coalesce(sum(duration_seconds) FILTER (WHERE billable), 0)::bigint AS billable_seconds,
         coalesce(sum(duration_seconds) FILTER (WHERE NOT billable), 0)::bigint AS non_billable_seconds,
         count(*) FILTER (WHERE cost_rate_minor IS NULL)::int AS entries_without_cost_rate
  FROM time_entries
  WHERE duration_seconds IS NOT NULL
  GROUP BY organization_id, project_id, currency
),
spend AS (
  -- Net of tax, which is reclaimed: charging it to a project would overstate
  -- what the work cost. A rebilled expense stays a cost here and appears again
  -- as revenue above, so its markup is the margin.
  SELECT organization_id, project_id, currency,
         sum(amount_minor)::bigint AS expense_cost_minor,
         sum(amount_minor) FILTER (WHERE invoice_line_id IS NOT NULL)::bigint AS rebilled_cost_minor
  FROM expenses
  WHERE project_id IS NOT NULL
  GROUP BY organization_id, project_id, currency
),
keys AS (
  SELECT organization_id, project_id, currency FROM billed
  UNION
  SELECT organization_id, project_id, currency FROM labour
  UNION
  SELECT organization_id, project_id, currency FROM spend
)
SELECT
  k.organization_id,
  k.project_id,
  k.currency,
  coalesce(b.billed_minor, 0)::bigint          AS billed_minor,
  coalesce(b.collected_minor, 0)::bigint       AS collected_minor,
  (coalesce(b.billed_minor, 0) - coalesce(b.collected_minor, 0))::bigint AS outstanding_minor,
  coalesce(l.labour_cost_minor, 0)::bigint     AS labour_cost_minor,
  coalesce(s.expense_cost_minor, 0)::bigint    AS expense_cost_minor,
  coalesce(s.rebilled_cost_minor, 0)::bigint   AS rebilled_cost_minor,
  coalesce(l.uninvoiced_minor, 0)::bigint      AS uninvoiced_minor,
  (coalesce(b.billed_minor, 0)
     - coalesce(l.labour_cost_minor, 0)
     - coalesce(s.expense_cost_minor, 0))::bigint AS margin_minor,
  coalesce(l.billable_seconds, 0)::bigint      AS billable_seconds,
  coalesce(l.non_billable_seconds, 0)::bigint  AS non_billable_seconds,
  coalesce(l.entries_without_cost_rate, 0)::int AS entries_without_cost_rate
FROM keys k
LEFT JOIN billed b ON b.organization_id = k.organization_id AND b.project_id = k.project_id AND b.currency = k.currency
LEFT JOIN labour l ON l.organization_id = k.organization_id AND l.project_id = k.project_id AND l.currency = k.currency
LEFT JOIN spend  s ON s.organization_id = k.organization_id AND s.project_id = k.project_id AND s.currency = k.currency;
