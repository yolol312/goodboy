---
name: prepare-migration
description: 마이그레이션 준비 워크플로 — 마이그레이션·롤백 작성과 로컬 dry run까지 (공유·운영 환경 적용은 사용자가 따로 실행). 위험도 위험. 사용 예 /prepare-migration <설명>
effort: xhigh
risk_default: risky
required_inputs:
  - name: rollback_plan
    question: "롤백 계획은?"
    allow_unknown: true
  - name: downtime_acceptable
    question: "다운타임이 허용되나요? 몇 분까지?"
    allow_unknown: true
  - name: validation_env
    question: "로컬 검증 환경은? (컨테이너 DB, 덤프 복사본, 임시 DB 등 — 공유·운영 환경 적용은 직접 하시게 됩니다)"
    allow_unknown: true
  - name: data_at_risk
    question: "위험 데이터/스키마는?"
    allow_unknown: true
---

# prepare-migration

Prepare a schema, data or infra migration up to a proven local dry run. Applying it to a
shared or production environment is the user's own, separate step.

## Steps
1. Inputs: ask for what the hook reports missing in one AskUserQuestion (each question with a
   "확인 필요" option). A rollback plan that stays "확인 필요" stops the work: ask again.
2. Approval: this category is risky. The risk gate denies the first edit and names the user's
   approval command for this session (`! touch .claude/.goodboy-risk-approved-<tag>.txt`; it
   lasts until the next category command); show the user the plan (rollback, environment,
   data at risk, downtime) and ask them to run it.
3. Rationale: `## 근거` (사실, 판단, 가정, 추측) or `## Rationale`; the rollback goes under the
   facts as exact commands or SQL, not words.
4. Write the migration and its rollback (tool skill write-migration, or `goodboy:build-data`;
   infra changes: edit-infra-safely or `goodboy:build-infra`).
5. Dry run on a local copy: forward, rollback, forward again, with each command and output.
6. Tests and review: `goodboy:test-unit` (category `prepare-migration`), then `review-axes` and
   one `goodboy:review-all` per axis; ask the security axis for rollback and data-loss checks.
7. Hand off: the exact apply and rollback commands for the target environment, for the user
   to run.

## Done when
- [ ] Forward, rollback and forward again passed locally; their output is in the hand-off.
- [ ] The user has the apply and rollback commands; nothing was applied beyond local.

## Never
- Never run a migration against a shared, staging or production system (R2).
- Never lower this category's risk to skip the approval.
