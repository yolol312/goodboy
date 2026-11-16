#### matches (two picks)
-- goodboy-data: matches
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'M', 0, (SELECT count(*) FROM (SELECT 1 FROM "public"."users" WHERE ("status" = 'O''Neil') LIMIT 10) x) UNION ALL SELECT 'M', 1, (SELECT count(*) FROM (SELECT 1 FROM "public"."pairs" WHERE ("a" > 0) LIMIT 10) x);
COMMIT;

#### matches (a pick only)
-- goodboy-data: matches
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'M', 0, (SELECT count(*) FROM (SELECT 1 FROM "public"."users" WHERE ("status" = 'O''Neil') LIMIT 10) x);
COMMIT;

#### collision (five generators)
-- goodboy-data: collision
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'X', 0, (SELECT count(*) FROM (SELECT 1 FROM (SELECT "email" AS v FROM "public"."users" LIMIT 100000) s WHERE CAST(v AS text) LIKE 'gbx-%' LIMIT 1) x) UNION ALL SELECT 'X', 1, (SELECT count(*) FROM (SELECT 1 FROM (SELECT "name" AS v FROM "public"."users" LIMIT 100000) s WHERE CAST(v AS text) LIKE 'gbx-%' LIMIT 1) x) UNION ALL SELECT 'X', 2, (SELECT count(*) FROM (SELECT 1 FROM (SELECT "phone" AS v FROM "public"."users" LIMIT 100000) s WHERE CAST(v AS text) LIKE '010-0000-%' LIMIT 1) x) UNION ALL SELECT 'X', 3, (SELECT count(*) FROM (SELECT 1 FROM (SELECT "serial" AS v FROM "public"."users" LIMIT 100000) s WHERE v >= 9000000000000 LIMIT 1) x) UNION ALL SELECT 'X', 4, (SELECT count(*) FROM (SELECT 1 FROM (SELECT "price" AS v FROM "public"."users" LIMIT 100000) s WHERE v >= 9000000000000 LIMIT 1) x);
COMMIT;

#### precision (two decimal columns)
-- goodboy-data: precision
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'D', 0, (SELECT COALESCE(MAX(numeric_precision - COALESCE(numeric_scale, 0)), 99) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'price') UNION ALL SELECT 'D', 1, (SELECT COALESCE(MAX(numeric_precision - COALESCE(numeric_scale, 0)), 99) FROM information_schema.columns WHERE table_schema = 'audit' AND table_name = 'log' AND column_name = 'amount');
COMMIT;

#### resolve
-- goodboy-data: resolve
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'V', 'activeUser', md5(CAST(s.p1 AS text)), CASE u.k WHEN 1 THEN 'name' WHEN 2 THEN 'nick' WHEN 3 THEN 'email' END, CASE u.k WHEN 1 THEN (CASE WHEN s.c1 IS NULL THEN '~' WHEN char_length(CAST(s.c1 AS text)) > 2000 THEN '!' ELSE encode(convert_to(CAST(s.c1 AS text), 'UTF8'), 'hex') END) WHEN 2 THEN (CASE WHEN s.c2 IS NULL THEN '~' WHEN char_length(CAST(s.c2 AS text)) > 2000 THEN '!' ELSE encode(convert_to(CAST(s.c2 AS text), 'UTF8'), 'hex') END) WHEN 3 THEN (CASE WHEN s.c3 IS NULL THEN '~' WHEN char_length(CAST(s.c3 AS text)) > 2000 THEN '!' ELSE encode(convert_to(CAST(s.c3 AS text), 'UTF8'), 'hex') END) END FROM (SELECT "name" AS c1, "nick" AS c2, "email" AS c3, "id" AS p1 FROM "public"."users" WHERE ("status" = 'O''Neil') ORDER BY random() LIMIT 3) s CROSS JOIN (SELECT 1 AS k UNION ALL SELECT 2 UNION ALL SELECT 3) u;
SELECT 'V', 'pair', md5(CAST(s.p1 AS text) || '|' || CAST(s.p2 AS text)), CASE u.k WHEN 1 THEN 'v' END, CASE u.k WHEN 1 THEN (CASE WHEN s.c1 IS NULL THEN '~' WHEN char_length(CAST(s.c1 AS text)) > 2000 THEN '!' ELSE encode(convert_to(CAST(s.c1 AS text), 'UTF8'), 'hex') END) END FROM (SELECT "v" AS c1, "a" AS p1, "b" AS p2 FROM "public"."pairs" WHERE ("a" > 0) ORDER BY random() LIMIT 2) s CROSS JOIN (SELECT 1 AS k) u;
SELECT 'N', 'activeUsers', (SELECT count(*) FROM "public"."users" WHERE ("status" = 'active'));
SELECT 'N', 'everyone', (SELECT count(*) FROM "public"."users");
SELECT 'G', 'newUserEmail', 'email', 'abcd1234';
SELECT 'G', 'newName', 'text', 'abcd1234';
SELECT 'G', 'newPhone', 'phone', 'abcd1234';
SELECT 'G', 'newSerial', 'number', 'abcd1234';
SELECT 'G', 'newPrice', 'number', 'abcd1234';
COMMIT;

#### resolve (a count only)
-- goodboy-data: resolve
SET statement_timeout = '5s';
BEGIN READ ONLY;
SELECT 'N', 'everyone', (SELECT count(*) FROM "public"."users");
COMMIT;

#### write script
rm -f /goodboy-data/v.tmp /goodboy-data/values.tsv; if e=$('psql' '-X' '-q' '-U' 'goodboy_reader' '-d' 'shop' '-v' 'ON_ERROR_STOP=1' '-v' 'VERBOSITY=sqlstate' '-A' '-t' '-F' '<TAB>' '-f' '-' 2>&1 > /goodboy-data/v.tmp); then b=$(( $(wc -c < /goodboy-data/v.tmp) )); if [ "$b" -gt 4194304 ]; then rm -f /goodboy-data/v.tmp; exit 125; fi; mv -f /goodboy-data/v.tmp /goodboy-data/values.tsv && echo "$(( $(wc -l < /goodboy-data/values.tsv) )) $b"; else rm -f /goodboy-data/v.tmp; case "$e" in *57014*|*'ERROR 3024 '*|*'ERROR 1969 '*) exit 124;; esac; exit 1; fi