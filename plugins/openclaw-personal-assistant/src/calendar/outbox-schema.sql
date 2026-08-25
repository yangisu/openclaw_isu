CREATE TABLE IF NOT EXISTS calendar_requests (
  request_id TEXT PRIMARY KEY
    CHECK (
      length(request_id) = 36
      AND substr(request_id, 9, 1) = '-'
      AND substr(request_id, 14, 1) = '-'
      AND substr(request_id, 19, 1) = '-'
      AND substr(request_id, 24, 1) = '-'
      AND length(replace(request_id, '-', '')) = 32
      AND lower(request_id) = request_id
      AND replace(request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  status TEXT NOT NULL
    CHECK (status IN ('draft','confirmed','submitting','pending_reconcile','succeeded','failed')),
  uid TEXT NOT NULL CHECK (length(uid) > 0),
  calendar_id TEXT NOT NULL CHECK (length(calendar_id) > 0),
  payload_ical TEXT NOT NULL CHECK (length(payload_ical) > 0),
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  confirmed_by INTEGER CHECK (confirmed_by > 0),
  confirmed_at TEXT CHECK (
    confirmed_at IS NULL OR
    (length(confirmed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) = confirmed_at)
  ),
  confirmation_expires_at TEXT CHECK (
    confirmation_expires_at IS NULL OR
    (length(confirmation_expires_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', confirmation_expires_at) = confirmation_expires_at)
  ),
  confirmation_consumed_at TEXT CHECK (
    confirmation_consumed_at IS NULL OR
    (length(confirmation_consumed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', confirmation_consumed_at) = confirmation_consumed_at)
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  last_attempt_at TEXT CHECK (
    last_attempt_at IS NULL OR
    (length(last_attempt_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', last_attempt_at) = last_attempt_at)
  ),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at) = created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', updated_at) = updated_at),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  process_type TEXT CHECK (process_type IN ('create','modify')),
  returned_ical_uid TEXT CHECK (returned_ical_uid IS NULL OR length(returned_ical_uid) > 0),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) > 0),
  CHECK (
    (status = 'draft' AND confirmed_by IS NULL AND confirmed_at IS NULL
      AND confirmation_expires_at IS NULL AND confirmation_consumed_at IS NULL)
    OR
    (status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
      AND confirmation_expires_at IS NOT NULL AND confirmation_consumed_at IS NULL)
    OR
    (status IN ('submitting','pending_reconcile','succeeded','failed')
      AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
      AND confirmation_expires_at IS NOT NULL AND confirmation_consumed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS calendar_requests_status_updated_idx
  ON calendar_requests (status, updated_at, request_id);

CREATE TABLE IF NOT EXISTS calendar_reconcile_warnings (
  request_id TEXT NOT NULL,
  warning_kind TEXT NOT NULL CHECK (warning_kind IN ('pending','confirmation_required')),
  warned_at TEXT NOT NULL
    CHECK (length(warned_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', warned_at) = warned_at),
  PRIMARY KEY (request_id, warning_kind),
  FOREIGN KEY (request_id) REFERENCES calendar_requests(request_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS calendar_outbox_audit (
  request_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL
    CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  completed_at TEXT NOT NULL
    CHECK (length(completed_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', completed_at) = completed_at),
  deleted_at TEXT NOT NULL
    CHECK (length(deleted_at) = 20 AND strftime('%Y-%m-%dT%H:%M:%SZ', deleted_at) = deleted_at),
  backup_manifest_id TEXT NOT NULL CHECK (length(backup_manifest_id) > 0)
) STRICT;
