-- 운영(postgres.js)에서 JSON 문자열을 한 번 더 감싸 jsonb 문자열로 저장한 값을 원래 배열·객체로 되돌린다.
-- 문자열 안이 배열·객체 JSON일 때만 바꾼다. 정상 값과 진짜 문자열 값은 그대로 둔다.
UPDATE "project_details" SET "deliverables" = ("deliverables" #>> '{}')::jsonb
  WHERE jsonb_typeof("deliverables") = 'string' AND left("deliverables" #>> '{}', 1) IN ('[', '{');
--> statement-breakpoint
UPDATE "ai_change_applications" SET "entries" = ("entries" #>> '{}')::jsonb
  WHERE jsonb_typeof("entries") = 'string' AND left("entries" #>> '{}', 1) IN ('[', '{');
--> statement-breakpoint
UPDATE "ai_proposal_changes" SET "before" = ("before" #>> '{}')::jsonb
  WHERE jsonb_typeof("before") = 'string' AND left("before" #>> '{}', 1) IN ('[', '{');
--> statement-breakpoint
UPDATE "ai_proposal_changes" SET "after" = ("after" #>> '{}')::jsonb
  WHERE jsonb_typeof("after") = 'string' AND left("after" #>> '{}', 1) IN ('[', '{');
