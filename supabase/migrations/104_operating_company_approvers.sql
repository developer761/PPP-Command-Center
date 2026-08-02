-- R1d: editable proposal-approver email list on the singleton operating company.
ALTER TABLE commercial_operating_company ADD COLUMN IF NOT EXISTS approver_emails text[] NOT NULL DEFAULT '{}';
