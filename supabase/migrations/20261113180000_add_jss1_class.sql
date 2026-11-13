-- JSS 1 has 14 learners and recorded scores, but it was missing from the
-- school class map, so the assistant could not see or open it and the
-- whole-school snapshot skipped it. The portal already falls back to the
-- standard JSS subject list for this class, so use that same list here.
update public.app_config
set config = jsonb_set(
  config,
  '{depts,jss1}',
  jsonb_build_object(
    'label', 'JSS 1',
    'subjects', jsonb_build_array(
      'English Language',
      'Mathematics',
      'Basic Science',
      'Basic Technology',
      'Social Studies',
      'Civic Education',
      'Cultural & Creative Arts',
      'Agricultural Science',
      'Computer Studies',
      'French',
      'Yoruba',
      'Christian Religious Studies',
      'Home Economics',
      'Physical & Health Education',
      'Business Studies'
    )
  ),
  true
)
where id = 1
  and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'jss1');
