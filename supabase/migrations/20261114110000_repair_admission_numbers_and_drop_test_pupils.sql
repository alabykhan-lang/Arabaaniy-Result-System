-- Two live data repairs, approved by the developer:
-- 1. The three test pupils are removed (scores, traits, fees and remarks cascade).
-- 2. Admission numbers were broken: 14 JSS 1 rows all carried STU/0002 and
--    some KG 1 rows had none. Each pupil now has their own number in class
--    order, the same way the add-pupil form hands out the next free number.
-- The updates are keyed by id, so re-running is harmless.

begin;

delete from public.students where id in (
  '5ba545e9-17d5-48a4-a617-d705879c3e84', -- Test Preview (KG 1)
  '3f6265e9-c581-4771-9538-e11aeac80efa', -- Admission Check (KG 1)
  'fec20264-c7bb-44b1-a34f-6c4c4ff1abfd'  -- Chat Check (JSS 1)
);

update public.students set admno = 'STU/0001', updated_at = now() where id = 'acca8d44-e272-478c-9051-6d1732f29866';
update public.students set admno = 'STU/0003', updated_at = now() where id = '578bf38e-ef25-42a3-91e1-51a596346633';
update public.students set admno = 'STU/0004', updated_at = now() where id = '788c65e1-e41d-49a1-9eec-3b512b4f65ed';
update public.students set admno = 'STU/0005', updated_at = now() where id = '51211eb4-f4fd-43e6-966d-369c2c9aaae9';
update public.students set admno = 'STU/0006', updated_at = now() where id = 'b072e1fa-f18b-4f6c-82df-583fcc08f411';
update public.students set admno = 'STU/0007', updated_at = now() where id = 'fb7bf936-0a98-4729-998a-68d20d584eec';
update public.students set admno = 'STU/0008', updated_at = now() where id = '64b02334-5080-4f4c-a725-e29073640b6f';
update public.students set admno = 'STU/0009', updated_at = now() where id = '49a2c3c7-2c08-4173-935a-8a60c8fcd65f';
update public.students set admno = 'STU/0010', updated_at = now() where id = '99a18602-de2c-424c-8714-06a6f6f0e272';
update public.students set admno = 'STU/0011', updated_at = now() where id = '6081eb0a-2e25-4dd3-a7cf-5b295f4778ee';
update public.students set admno = 'STU/0012', updated_at = now() where id = 'c23df2ef-6081-47ea-8e5d-6ae76669d3c4';
update public.students set admno = 'STU/0013', updated_at = now() where id = 'c88af82b-d7e2-4700-8902-a538fbf1e281';
update public.students set admno = 'STU/0014', updated_at = now() where id = '77591b61-dce1-4ba3-80b5-1559fb51abd2';

update public.students set admno = 'STU/0002', updated_at = now() where id = 'a52b1773-0bd8-4c15-b249-1c972bd1b406';
update public.students set admno = 'STU/0007', updated_at = now() where id = 'f0c30706-b5ee-4e35-96a3-1796d44923c8';

commit;
