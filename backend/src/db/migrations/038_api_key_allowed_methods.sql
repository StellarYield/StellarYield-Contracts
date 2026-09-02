-- Restrict an API key to a set of HTTP methods (#935).
-- NULL (the default, and the value for every existing key) means all methods
-- are allowed, so this is backwards compatible.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_methods TEXT[];

-- Keep the column to uppercase, real HTTP methods so the middleware can compare
-- against req.method directly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_allowed_methods_valid'
  ) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_allowed_methods_valid
      CHECK (
        allowed_methods IS NULL
        OR allowed_methods <@ ARRAY['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']::TEXT[]
      );
  END IF;
END
$$;
