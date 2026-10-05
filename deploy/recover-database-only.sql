-- ONLY for an inactive, separately restored DB when its media volume was lost.
-- This removes unavailable local sources/results. Preserve the original DB.
BEGIN;
DELETE FROM artifacts;
DELETE FROM jobs WHERE source_id IN (SELECT id FROM sources WHERE kind NOT IN ('platform','youtube'));
DELETE FROM sources WHERE kind NOT IN ('platform','youtube');
UPDATE sources SET path='',thumbnail_path='';
UPDATE jobs SET status='failed',stage='finished',message='Temporary media unavailable after database-only recovery',
 cancel_requested=false,lease_until=NULL,lease_token=NULL,updated_at=now(),
 items=(SELECT jsonb_agg((item-'artifact') || jsonb_build_object('status','failed','message','Export again after recovery','error_code','media_lost')) FROM jsonb_array_elements(items) item);
DO $$ BEGIN
 IF to_regclass('public.source_metadata_cache') IS NOT NULL THEN DELETE FROM source_metadata_cache; END IF;
 IF to_regclass('public.storage_files') IS NOT NULL THEN DELETE FROM storage_files; END IF;
 IF to_regclass('public.storage_reservations') IS NOT NULL THEN DELETE FROM storage_reservations; END IF;
 IF to_regclass('public.storage_counters') IS NOT NULL THEN UPDATE storage_counters SET stored_bytes=0,reserved_bytes=0 WHERE id=1; END IF;
END $$;
COMMIT;
