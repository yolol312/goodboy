#### schema
-- goodboy-data: schema
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'C', c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE t.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema !~ '^pg_' AND c.table_name ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' AND c.column_name ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' AND c.table_schema ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' ORDER BY c.table_schema, c.table_name, c.ordinal_position LIMIT 20001;
SELECT 'S', count(*) FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE t.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema !~ '^pg_' AND NOT (c.table_name ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' AND c.column_name ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' AND c.table_schema ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$');
SELECT 'K', n.nspname, cl.relname, a.attname, con.contype, array_position(con.conkey, a.attnum) FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = ANY (con.conkey) WHERE con.contype IN ('p', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_' AND n.nspname ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' AND cl.relname ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' AND a.attname ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' ORDER BY n.nspname, cl.relname, array_position(con.conkey, a.attnum) LIMIT 20001;
COMMIT;

#### rowcounts (two tables)
-- goodboy-data: rowcounts
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'R', 0, (SELECT count(*) FROM (SELECT 1 FROM "public"."users" LIMIT 10001) x) UNION ALL SELECT 'R', 1, (SELECT count(*) FROM (SELECT 1 FROM "public"."orders" LIMIT 10001) x);
COMMIT;

#### enum (status, active)
-- goodboy-data: enum
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'E', 0, (SELECT count(*) FROM (SELECT DISTINCT md5(CAST("status" AS text)) FROM (SELECT "status" FROM "public"."users" LIMIT 100000) s LIMIT 51) x) UNION ALL SELECT 'E', 1, (SELECT count(*) FROM (SELECT DISTINCT md5(CAST("active" AS text)) FROM (SELECT "active" FROM "public"."users" LIMIT 100000) s LIMIT 51) x);
COMMIT;

#### count, no condition
-- goodboy-data: count
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'N', count(*) FROM "public"."users";
COMMIT;

#### count with a condition
-- goodboy-data: count
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'N', count(*) FROM "public"."users" WHERE (("status" = 'O''Neil') AND ("id" > 5) AND ("created" <= '2024-03-01 10:00:00') AND (CASE WHEN CAST("name" AS text) IS NULL THEN 'null' WHEN CAST("name" AS text) = '' THEN 'empty' WHEN CAST("name" AS text) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN 'uuid' WHEN CAST("name" AS text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?)?$' THEN 'datetime' WHEN CAST("name" AS text) ~ '^[^@ ]+@[^@ ]+[.][^@ ]+$' THEN 'email-like' WHEN CAST("name" AS text) ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^ ]+$' THEN 'url' WHEN CAST("name" AS text) ~ '^-?[0-9]{1,18}$' THEN 'integer' WHEN CAST("name" AS text) ~ '^-?[0-9]+[.][0-9]+$' THEN 'decimal' WHEN CAST("name" AS text) ~ '^[+]?[0-9][0-9 ()-]{6,20}$' THEN 'phone-like' ELSE 'other' END = 'email-like') AND (("id" IS NULL) OR ("active" <> TRUE)));
COMMIT;

#### shape users.name
-- goodboy-data: shape
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'C', cat, count(*) FROM (SELECT CASE WHEN v IS NULL THEN 'null' WHEN v = '' THEN 'empty' WHEN v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN 'uuid' WHEN v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?)?$' THEN 'datetime' WHEN v ~ '^[^@ ]+@[^@ ]+[.][^@ ]+$' THEN 'email-like' WHEN v ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^ ]+$' THEN 'url' WHEN v ~ '^-?[0-9]{1,18}$' THEN 'integer' WHEN v ~ '^-?[0-9]+[.][0-9]+$' THEN 'decimal' WHEN v ~ '^[+]?[0-9][0-9 ()-]{6,20}$' THEN 'phone-like' ELSE 'other' END AS cat FROM (SELECT CAST("name" AS text) AS v FROM "public"."users" LIMIT 100000) s) c GROUP BY cat;
SELECT 'L', b, count(*) FROM (SELECT CASE WHEN char_length(v) = 0 THEN '0' WHEN char_length(v) <= 8 THEN '1-8' WHEN char_length(v) <= 32 THEN '9-32' WHEN char_length(v) <= 128 THEN '33-128' WHEN char_length(v) <= 1024 THEN '129-1024' ELSE '>1024' END AS b FROM (SELECT CAST("name" AS text) AS v FROM "public"."users" LIMIT 100000) s WHERE v IS NOT NULL) l GROUP BY b;
SELECT 'D', count(*) FROM (SELECT DISTINCT md5(v) FROM (SELECT CAST("name" AS text) AS v FROM "public"."users" LIMIT 100000) s WHERE v IS NOT NULL LIMIT 51) d;
SELECT 'T', count(*) FROM (SELECT 1 FROM "public"."users" LIMIT 100001) x;
COMMIT;

#### pick 7
-- goodboy-data: pick
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'M', count(*) FROM (SELECT 1 FROM "public"."users" WHERE (("status" = 'O''Neil') AND ("id" > 5) AND ("created" <= '2024-03-01 10:00:00') AND (CASE WHEN CAST("name" AS text) IS NULL THEN 'null' WHEN CAST("name" AS text) = '' THEN 'empty' WHEN CAST("name" AS text) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN 'uuid' WHEN CAST("name" AS text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?)?$' THEN 'datetime' WHEN CAST("name" AS text) ~ '^[^@ ]+@[^@ ]+[.][^@ ]+$' THEN 'email-like' WHEN CAST("name" AS text) ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^ ]+$' THEN 'url' WHEN CAST("name" AS text) ~ '^-?[0-9]{1,18}$' THEN 'integer' WHEN CAST("name" AS text) ~ '^-?[0-9]+[.][0-9]+$' THEN 'decimal' WHEN CAST("name" AS text) ~ '^[+]?[0-9][0-9 ()-]{6,20}$' THEN 'phone-like' ELSE 'other' END = 'email-like') AND (("id" IS NULL) OR ("active" <> TRUE))) LIMIT 10) x;
SELECT 'P', encode(convert_to(CAST("id" AS text), 'UTF8'), 'hex') FROM "public"."users" WHERE (("status" = 'O''Neil') AND ("id" > 5) AND ("created" <= '2024-03-01 10:00:00') AND (CASE WHEN CAST("name" AS text) IS NULL THEN 'null' WHEN CAST("name" AS text) = '' THEN 'empty' WHEN CAST("name" AS text) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN 'uuid' WHEN CAST("name" AS text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?)?$' THEN 'datetime' WHEN CAST("name" AS text) ~ '^[^@ ]+@[^@ ]+[.][^@ ]+$' THEN 'email-like' WHEN CAST("name" AS text) ~ '^[A-Za-z][A-Za-z0-9+.-]*://[^ ]+$' THEN 'url' WHEN CAST("name" AS text) ~ '^-?[0-9]{1,18}$' THEN 'integer' WHEN CAST("name" AS text) ~ '^-?[0-9]+[.][0-9]+$' THEN 'decimal' WHEN CAST("name" AS text) ~ '^[+]?[0-9][0-9 ()-]{6,20}$' THEN 'phone-like' ELSE 'other' END = 'email-like') AND (("id" IS NULL) OR ("active" <> TRUE))) ORDER BY random() LIMIT 7;
COMMIT;
