-- designer-waitlist schema. Run once on the shared CNPG postgres cluster
-- (cluster: postgres, database/role: designer_waitlist). See
-- infrastructure stacks/apps/designer-waitlist.
CREATE TABLE IF NOT EXISTS waitlist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  confirm_token   text,
  consent_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  unsubscribed_at timestamptz,
  source          text DEFAULT 'designer-landing',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS waitlist_status_idx ON waitlist (status);
