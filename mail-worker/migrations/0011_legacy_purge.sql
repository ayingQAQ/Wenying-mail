CREATE INDEX attachments_object_reference ON attachments(key,storage_backend,email_id);
-- Legacy shared keys cannot gain or change references during physical cleanup.
-- New generation keys remain independent and may publish while cleanup runs.
CREATE TRIGGER legacy_attachment_insert_guard BEFORE INSERT ON attachments
WHEN (NEW.storage_version='legacy' OR (NEW.key LIKE 'attachments/%' AND instr(substr(NEW.key,13),'/')=0))
AND EXISTS(SELECT 1 FROM storage_maintenance WHERE singleton=1 AND kind='PURGE')
BEGIN SELECT RAISE(ABORT,'LEGACY_STORAGE_BUSY'); END;
CREATE TRIGGER legacy_attachment_update_guard BEFORE UPDATE ON attachments
WHEN (OLD.storage_version='legacy' OR NEW.storage_version='legacy'
OR (OLD.key LIKE 'attachments/%' AND instr(substr(OLD.key,13),'/')=0)
OR (NEW.key LIKE 'attachments/%' AND instr(substr(NEW.key,13),'/')=0))
AND EXISTS(SELECT 1 FROM storage_maintenance WHERE singleton=1 AND kind='PURGE')
BEGIN SELECT RAISE(ABORT,'LEGACY_STORAGE_BUSY'); END;
