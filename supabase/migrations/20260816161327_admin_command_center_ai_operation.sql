-- The admin command center is a billed, read-only Gemini operation.
alter table public.ai_usage_ledger
  drop constraint if exists ai_usage_ledger_operation_check;

alter table public.ai_usage_ledger
  add constraint ai_usage_ledger_operation_check
  check (operation in ('ocr_scores', 'ocr_student_names', 'admin_command_center'));
