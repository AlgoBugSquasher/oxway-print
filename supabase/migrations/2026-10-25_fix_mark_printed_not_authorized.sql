-- Rollback: restore mark_job_printed_no_refund_needed to its prior body (see git history) — not recommended, it reintroduces the bug below.

-- Bug: "Not authorized" on every single click of "Printed fine", even for
-- a real signed-in owner. Cause: this function checked
-- public.current_app_role() <> 'owner' internally, but it's only ever
-- called via the service-role key (lib/mark-printed.ts's supabaseAdmin()),
-- which carries no user JWT at all — current_app_role() reads auth.jwt(),
-- so that check was always false for the real owner too. The existing
-- refund RPCs (claim_refund_for_processing, complete_refund, fail_refund)
-- never do this: they're granted to service_role only, and the calling
-- route (app/api/admin/mark-printed) already independently verifies the
-- real signed-in user is an owner before ever reaching this function. Fix
-- is simply removing the redundant, broken check — the grant below is
-- still the real access boundary, unchanged.
create or replace function public.mark_job_printed_no_refund_needed(
  p_job_id uuid,
  p_reason text,
  p_actor_user_id uuid default null,
  p_actor_role text default null,
  p_ip text default null,
  p_user_agent text default null
)
returns setof print_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before print_jobs;
  v_updated_rows integer;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required.';
  end if;

  select * into v_before from print_jobs where id = p_job_id;
  if v_before.id is null then
    raise exception 'Job not found.';
  end if;
  if v_before.status <> 'print_failed' then
    raise exception 'This job is not currently marked print_failed (it is "%").', v_before.status;
  end if;
  if v_before.refund_status = 'refunded' then
    raise exception 'This job has already been refunded — cannot mark it printed instead.';
  end if;
  if v_before.refund_status = 'processing' then
    raise exception 'A refund for this job is currently being processed — try again once it resolves.';
  end if;

  update print_jobs set
    status = 'printed',
    refund_status = case when v_before.is_free or v_before.original_job_id is not null then null else 'not_needed' end,
    ready_at = coalesce(ready_at, now()),
    updated_at = now()
  where id = p_job_id and status = 'print_failed'
    and coalesce(refund_status, '') not in ('refunded', 'processing');
  get diagnostics v_updated_rows = row_count;

  if v_updated_rows = 0 then
    raise exception 'Could not update this job — it may have changed state just now. Please refresh and try again.';
  end if;

  perform public.log_audit(
    p_action := 'job_marked_printed_no_refund',
    p_actor_user_id := p_actor_user_id,
    p_actor_role := p_actor_role,
    p_target_type := 'print_job',
    p_target_id := p_job_id::text,
    p_details := jsonb_build_object(
      'reason', p_reason,
      'previous_error', v_before.error,
      'previous_refund_status', v_before.refund_status
    ),
    p_ip := p_ip,
    p_user_agent := p_user_agent
  );

  return query select * from print_jobs where id = p_job_id;
end;
$$;

grant execute on function public.mark_job_printed_no_refund_needed(uuid, text, uuid, text, text, text) to service_role;
