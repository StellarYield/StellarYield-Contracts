-- Issue #994: Add global notification opt-out endpoint
-- Reuses the existing app_config key/value table (#804) so the flag can be
-- read/written through the same mechanism as other runtime settings.
INSERT INTO app_config (key, value) VALUES
  ('notificationsGloballyEnabled', 'true')
ON CONFLICT (key) DO NOTHING;
