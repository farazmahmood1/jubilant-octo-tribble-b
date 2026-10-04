-- How each person likes the dashboard laid out, kept with their account so it follows them from
-- screen to screen and from one device to another. For now only the columns each list hides:
-- `{"columns": {"orders": ["phone", "items"]}}`. A screen with no entry shows its default columns.
--
-- Display only: nothing here changes a figure, so it is not audited.
alter table users
  add column ui_preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(ui_preferences) = 'object');
