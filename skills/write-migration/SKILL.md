---
name: write-migration
description: Write a forward database migration with its rollback, and prove both with a dry run on a local copy of the database.
when_to_use: Use for schema changes, data backfills and index changes.
user-invocable: false
effort: xhigh
---

# write-migration

Change a schema in a way that can be checked before and undone after.

## Inputs
- The schema change, the migration tool the project uses, a way to get a local database
  (compose service, a dump of test data, a fresh schema).

## Steps
1. Follow the project's tool and naming (Prisma, Knex, Alembic, Flyway, Rails, plain SQL).
2. Write the forward migration. For large tables avoid long locks: add columns nullable, add
   indexes concurrently where the database supports it, backfill in batches.
3. Write the rollback that returns to the previous schema; for data that cannot come back
   (a dropped column), say so and keep a copy step in the forward migration.
4. Start a local database (`docker compose up -d db`, or a temp SQLite file) and load the
   current schema and representative test data.
5. Dry run: forward, check the schema and a row count; rollback, check the schema is back;
   forward again. Keep each command and its output.
6. Check the code that reads and writes the changed tables still works against the new schema
   (run its tests).

## Output
- The two migration files and the dry-run commands with their output in the hand-back.

## Done when
- [ ] Forward, rollback and forward again ran on the local copy without errors.
- [ ] Irreversible steps are named, with how their data is kept.

## Never
- Never run a migration against a shared, staging or production database (R2); return
  `blocked` with the command for the user.
- Never edit a migration that has already run anywhere; add a new one.
