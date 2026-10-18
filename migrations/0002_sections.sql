-- Exam ids changed when sections 2 and 3 were added:
--   part exams 1..18 are numbered globally; section finals are 101, 102, 103.
-- The old "final exam" (id 7) is now the Section 1 final (id 101).
UPDATE attempts SET exam = 101 WHERE exam = 7;
UPDATE unlocks  SET exam = 101 WHERE exam = 7;
