-- The vision route used Gemini while the assistant itself runs on River
-- DeepSeek. River's DeepSeek reads photos (the First Choice reader pipeline
-- uses the same model for sheet photos), so point the vision role at the same
-- model as primary and keep one model for both jobs.
update ops.model_config
set provider = 'river',
    model = 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    base_url = null,
    enabled = true,
    last_error = null,
    last_test_ok = null,
    updated_at = now()
where role = 'vision';
