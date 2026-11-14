-- The portal offers every class in its picker, but the assistant only saw the
-- classes stored in app_config.depts. KG 2 had 19 learners and was invisible,
-- so the assistant answered "there is no KG 2". Fill in every class the portal
-- already offers, with the portal's own subject lists. Existing class entries
-- keep their subjects. Empty classes are included so a pupil can be added to
-- one before it has a roster.

update public.app_config
set config = jsonb_set(config, '{depts,kg2}', $${"label": "KG 2", "subjects": ["English Language", "Mathematics", "Phonics", "Handwriting", "Quantitative Reasoning", "Verbal Reasoning", "Basic Science", "Social Studies", "Cultural & Creative Arts", "Computer Studies", "Religious & National Values"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'kg2');

update public.app_config
set config = jsonb_set(config, '{depts,nursery1}', $${"label": "Nursery 1", "subjects": ["English Language", "Mathematics", "Phonics", "Handwriting", "Quantitative Reasoning", "Verbal Reasoning", "Basic Science", "Social Studies", "Cultural & Creative Arts", "Computer Studies", "Religious & National Values"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'nursery1');

update public.app_config
set config = jsonb_set(config, '{depts,nursery2}', $${"label": "Nursery 2", "subjects": ["English Language", "Mathematics", "Phonics", "Handwriting", "Quantitative Reasoning", "Verbal Reasoning", "Basic Science", "Social Studies", "Cultural & Creative Arts", "Computer Studies", "Religious & National Values"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'nursery2');

update public.app_config
set config = jsonb_set(config, '{depts,primary2}', $${"label": "Primary 2", "subjects": ["English Language", "Mathematics", "Phonics", "Handwriting", "Quantitative Reasoning", "Verbal Reasoning", "Basic Science", "Social Studies", "Cultural & Creative Arts", "Computer Studies", "Religious & National Values"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'primary2');

update public.app_config
set config = jsonb_set(config, '{depts,primary3}', $${"label": "Primary 3", "subjects": ["English Language", "Mathematics", "Phonics", "Handwriting", "Quantitative Reasoning", "Verbal Reasoning", "Basic Science", "Social Studies", "Cultural & Creative Arts", "Computer Studies", "Religious & National Values"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'primary3');

update public.app_config
set config = jsonb_set(config, '{depts,primary4}', $${"label": "Primary 4", "subjects": ["English Language", "Mathematics", "Phonics", "Handwriting", "Quantitative Reasoning", "Verbal Reasoning", "Basic Science", "Social Studies", "Cultural & Creative Arts", "Computer Studies", "Religious & National Values"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'primary4');

update public.app_config
set config = jsonb_set(config, '{depts,primary5}', $${"label": "Primary 5", "subjects": ["English Language", "Mathematics", "Phonics", "Handwriting", "Quantitative Reasoning", "Verbal Reasoning", "Basic Science", "Social Studies", "Cultural & Creative Arts", "Computer Studies", "Religious & National Values"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'primary5');

update public.app_config
set config = jsonb_set(config, '{depts,jss2}', $${"label": "JSS 2", "subjects": ["English Language", "Mathematics", "Basic Science", "Basic Technology", "Social Studies", "Civic Education", "Cultural & Creative Arts", "Agricultural Science", "Computer Studies", "French", "Yoruba", "Christian Religious Studies", "Home Economics", "Physical & Health Education", "Business Studies"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'jss2');

update public.app_config
set config = jsonb_set(config, '{depts,jss3}', $${"label": "JSS 3", "subjects": ["English Language", "Mathematics", "Basic Science", "Basic Technology", "Social Studies", "Civic Education", "Cultural & Creative Arts", "Agricultural Science", "Computer Studies", "French", "Yoruba", "Christian Religious Studies", "Home Economics", "Physical & Health Education", "Business Studies"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'jss3');

update public.app_config
set config = jsonb_set(config, '{depts,ss1-general}', $${"label": "SS1 - General", "subjects": ["English Language", "Mathematics", "Digital Technology", "Economics", "Citizenship & Heritage Studies", "Biology", "Physics", "Chemistry", "Literature", "Government", "I.R.S", "Financial Accounting", "Commerce", "Geography", "Agricultural Science"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'ss1-general');

update public.app_config
set config = jsonb_set(config, '{depts,ss1-science}', $${"label": "SS1 - Science", "subjects": ["English Language", "Mathematics", "Digital Technology", "Economics", "Citizenship & Heritage Studies", "Biology", "Physics", "Chemistry", "Agricultural Science", "Geography"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'ss1-science');

update public.app_config
set config = jsonb_set(config, '{depts,ss1-arts}', $${"label": "SS1 - Arts", "subjects": ["English Language", "Mathematics", "Digital Technology", "Economics", "Citizenship & Heritage Studies", "Literature", "Government", "I.R.S", "Yoruba"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'ss1-arts');

update public.app_config
set config = jsonb_set(config, '{depts,ss1-business}', $${"label": "SS1 - Commercial", "subjects": ["English Language", "Mathematics", "Digital Technology", "Economics", "Citizenship & Heritage Studies", "Financial Accounting", "Commerce", "Government"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'ss1-business');

update public.app_config
set config = jsonb_set(config, '{depts,ss2-science}', $${"label": "SS2 - Science", "subjects": ["English Language", "Mathematics", "Digital Technology", "Economics", "Citizenship & Heritage Studies", "Biology", "Physics", "Chemistry", "Agricultural Science", "Livestock Farming", "Geography"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'ss2-science');

update public.app_config
set config = jsonb_set(config, '{depts,ss2-arts}', $${"label": "SS2 - Arts", "subjects": ["English Language", "Mathematics", "Digital Technology", "Economics", "Citizenship & Heritage Studies", "Literature", "Government", "I.R.S", "Yoruba"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'ss2-arts');

update public.app_config
set config = jsonb_set(config, '{depts,ss2-business}', $${"label": "SS2 - Commercial", "subjects": ["English Language", "Mathematics", "Digital Technology", "Economics", "Citizenship & Heritage Studies", "Financial Accounting", "Commerce", "Government"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'ss2-business');

update public.app_config
set config = jsonb_set(config, '{depts,ss3-science}', $${"label": "SS3 - Science", "subjects": ["English Language", "Mathematics", "Digital Technology", "Economics", "Citizenship & Heritage Studies", "Biology", "Physics", "Chemistry", "Agricultural Science", "Livestock Farming", "Geography"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'ss3-science');

update public.app_config
set config = jsonb_set(config, '{depts,ss3-arts}', $${"label": "SS3 - Arts", "subjects": ["English Language", "Mathematics", "Digital Technology", "Economics", "Citizenship & Heritage Studies", "Literature", "Government", "I.R.S", "Yoruba"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'ss3-arts');

update public.app_config
set config = jsonb_set(config, '{depts,ss3-business}', $${"label": "SS3 - Commercial", "subjects": ["English Language", "Mathematics", "Digital Technology", "Economics", "Citizenship & Heritage Studies", "Financial Accounting", "Commerce", "Government"]}$$::jsonb, true)
where id = 1 and not (coalesce(config -> 'depts', '{}'::jsonb) ? 'ss3-business');
