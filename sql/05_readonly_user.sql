-- Read-only ClickHouse user for the dashboard and the RCA agent.
-- SELECT-only is enforced HERE, at the database level — not in prompts or app
-- code. readonly=2 also permits SET for per-query limits; writes are impossible.
CREATE USER IF NOT EXISTS ro_viewer IDENTIFIED WITH sha256_password BY 'wastedspend_ro'
SETTINGS readonly = 2 READONLY,
         max_execution_time = 10 READONLY,
         max_result_rows = 10000 READONLY,
         max_memory_usage = 1200000000 READONLY; -- fail politely, never OOM the shared server
GRANT SELECT ON default.* TO ro_viewer;
ALTER USER ro_viewer
SETTINGS readonly = 2 READONLY,
         max_execution_time = 10 READONLY,
         max_result_rows = 10000 READONLY,
         max_memory_usage = 1200000000 READONLY;
