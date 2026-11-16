#### schema
-- goodboy-data: schema
SET SESSION max_statement_time = 5;
START TRANSACTION READ ONLY;
SELECT 'C', 'public', c.table_name, c.column_name, c.data_type, c.is_nullable FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE t.table_type = 'BASE TABLE' AND c.table_schema = DATABASE() AND c.table_name REGEXP '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' AND c.column_name REGEXP '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' ORDER BY c.table_name, c.ordinal_position LIMIT 20001;
SELECT 'S', count(*) FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE t.table_type = 'BASE TABLE' AND c.table_schema = DATABASE() AND NOT (c.table_name REGEXP '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' AND c.column_name REGEXP '^[A-Za-z_][A-Za-z0-9_$]{0,62}$');
SELECT 'K', 'public', k.table_name, k.column_name, IF(k.constraint_name = 'PRIMARY', 'p', 'f'), k.ordinal_position FROM information_schema.key_column_usage k WHERE k.table_schema = DATABASE() AND (k.constraint_name = 'PRIMARY' OR k.referenced_table_name IS NOT NULL) AND k.table_name REGEXP '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' AND k.column_name REGEXP '^[A-Za-z_][A-Za-z0-9_$]{0,62}$' ORDER BY k.table_name, k.ordinal_position LIMIT 20001;
COMMIT;

#### rowcounts (two tables)
-- goodboy-data: rowcounts
SET SESSION max_statement_time = 5;
START TRANSACTION READ ONLY;
SELECT 'R', 0, (SELECT count(*) FROM (SELECT 1 FROM `users` LIMIT 10001) x) UNION ALL SELECT 'R', 1, (SELECT count(*) FROM (SELECT 1 FROM `orders` LIMIT 10001) x);
COMMIT;

#### enum (status, active)
-- goodboy-data: enum
SET SESSION max_statement_time = 5;
START TRANSACTION READ ONLY;
SELECT 'E', 0, (SELECT count(*) FROM (SELECT DISTINCT MD5(CAST(`status` AS CHAR)) FROM (SELECT `status` FROM `users` LIMIT 100000) s LIMIT 51) x) UNION ALL SELECT 'E', 1, (SELECT count(*) FROM (SELECT DISTINCT MD5(CAST(`active` AS CHAR)) FROM (SELECT `active` FROM `users` LIMIT 100000) s LIMIT 51) x);
COMMIT;

#### count, no condition
-- goodboy-data: count
SET SESSION max_statement_time = 5;
START TRANSACTION READ ONLY;
SELECT 'N', count(*) FROM `users`;
COMMIT;

#### count with a condition
-- goodboy-data: count
SET SESSION max_statement_time = 5;
START TRANSACTION READ ONLY;
SELECT 'N', count(*) FROM `users` WHERE ((`status` = 'O''Neil') AND (`id` > 5) AND (`created` <= '2024-03-01 10:00:00') AND (CASE WHEN CAST(`name` AS CHAR) IS NULL THEN 'null' WHEN CAST(`name` AS CHAR) = '' THEN 'empty' WHEN CAST(`name` AS CHAR) REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN 'uuid' WHEN CAST(`name` AS CHAR) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?)?$' THEN 'datetime' WHEN CAST(`name` AS CHAR) REGEXP '^[^@ ]+@[^@ ]+[.][^@ ]+$' THEN 'email-like' WHEN CAST(`name` AS CHAR) REGEXP '^[A-Za-z][A-Za-z0-9+.-]*://[^ ]+$' THEN 'url' WHEN CAST(`name` AS CHAR) REGEXP '^-?[0-9]{1,18}$' THEN 'integer' WHEN CAST(`name` AS CHAR) REGEXP '^-?[0-9]+[.][0-9]+$' THEN 'decimal' WHEN CAST(`name` AS CHAR) REGEXP '^[+]?[0-9][0-9 ()-]{6,20}$' THEN 'phone-like' ELSE 'other' END = 'email-like') AND ((`id` IS NULL) OR (`active` <> 1)));
COMMIT;

#### shape users.name
-- goodboy-data: shape
SET SESSION max_statement_time = 5;
START TRANSACTION READ ONLY;
SELECT 'C', cat, count(*) FROM (SELECT CASE WHEN v IS NULL THEN 'null' WHEN v = '' THEN 'empty' WHEN v REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN 'uuid' WHEN v REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?)?$' THEN 'datetime' WHEN v REGEXP '^[^@ ]+@[^@ ]+[.][^@ ]+$' THEN 'email-like' WHEN v REGEXP '^[A-Za-z][A-Za-z0-9+.-]*://[^ ]+$' THEN 'url' WHEN v REGEXP '^-?[0-9]{1,18}$' THEN 'integer' WHEN v REGEXP '^-?[0-9]+[.][0-9]+$' THEN 'decimal' WHEN v REGEXP '^[+]?[0-9][0-9 ()-]{6,20}$' THEN 'phone-like' ELSE 'other' END AS cat FROM (SELECT CAST(`name` AS CHAR) AS v FROM `users` LIMIT 100000) s) c GROUP BY cat;
SELECT 'L', b, count(*) FROM (SELECT CASE WHEN CHAR_LENGTH(v) = 0 THEN '0' WHEN CHAR_LENGTH(v) <= 8 THEN '1-8' WHEN CHAR_LENGTH(v) <= 32 THEN '9-32' WHEN CHAR_LENGTH(v) <= 128 THEN '33-128' WHEN CHAR_LENGTH(v) <= 1024 THEN '129-1024' ELSE '>1024' END AS b FROM (SELECT CAST(`name` AS CHAR) AS v FROM `users` LIMIT 100000) s WHERE v IS NOT NULL) l GROUP BY b;
SELECT 'D', count(*) FROM (SELECT DISTINCT MD5(v) FROM (SELECT CAST(`name` AS CHAR) AS v FROM `users` LIMIT 100000) s WHERE v IS NOT NULL LIMIT 51) d;
SELECT 'T', count(*) FROM (SELECT 1 FROM `users` LIMIT 100001) x;
COMMIT;

#### pick 7
-- goodboy-data: pick
SET SESSION max_statement_time = 5;
START TRANSACTION READ ONLY;
SELECT 'M', count(*) FROM (SELECT 1 FROM `users` WHERE ((`status` = 'O''Neil') AND (`id` > 5) AND (`created` <= '2024-03-01 10:00:00') AND (CASE WHEN CAST(`name` AS CHAR) IS NULL THEN 'null' WHEN CAST(`name` AS CHAR) = '' THEN 'empty' WHEN CAST(`name` AS CHAR) REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN 'uuid' WHEN CAST(`name` AS CHAR) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?)?$' THEN 'datetime' WHEN CAST(`name` AS CHAR) REGEXP '^[^@ ]+@[^@ ]+[.][^@ ]+$' THEN 'email-like' WHEN CAST(`name` AS CHAR) REGEXP '^[A-Za-z][A-Za-z0-9+.-]*://[^ ]+$' THEN 'url' WHEN CAST(`name` AS CHAR) REGEXP '^-?[0-9]{1,18}$' THEN 'integer' WHEN CAST(`name` AS CHAR) REGEXP '^-?[0-9]+[.][0-9]+$' THEN 'decimal' WHEN CAST(`name` AS CHAR) REGEXP '^[+]?[0-9][0-9 ()-]{6,20}$' THEN 'phone-like' ELSE 'other' END = 'email-like') AND ((`id` IS NULL) OR (`active` <> 1))) LIMIT 10) x;
SELECT 'P', HEX(CAST(`id` AS CHAR)) FROM `users` WHERE ((`status` = 'O''Neil') AND (`id` > 5) AND (`created` <= '2024-03-01 10:00:00') AND (CASE WHEN CAST(`name` AS CHAR) IS NULL THEN 'null' WHEN CAST(`name` AS CHAR) = '' THEN 'empty' WHEN CAST(`name` AS CHAR) REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN 'uuid' WHEN CAST(`name` AS CHAR) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?)?$' THEN 'datetime' WHEN CAST(`name` AS CHAR) REGEXP '^[^@ ]+@[^@ ]+[.][^@ ]+$' THEN 'email-like' WHEN CAST(`name` AS CHAR) REGEXP '^[A-Za-z][A-Za-z0-9+.-]*://[^ ]+$' THEN 'url' WHEN CAST(`name` AS CHAR) REGEXP '^-?[0-9]{1,18}$' THEN 'integer' WHEN CAST(`name` AS CHAR) REGEXP '^-?[0-9]+[.][0-9]+$' THEN 'decimal' WHEN CAST(`name` AS CHAR) REGEXP '^[+]?[0-9][0-9 ()-]{6,20}$' THEN 'phone-like' ELSE 'other' END = 'email-like') AND ((`id` IS NULL) OR (`active` <> 1))) ORDER BY RAND() LIMIT 7;
COMMIT;
