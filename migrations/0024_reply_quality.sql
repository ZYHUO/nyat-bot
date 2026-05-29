-- Reply quality scoring (ASI) — adds rubric dims + friction flags + final ASI to reply_outcomes
-- SQLite requires one ADD COLUMN per statement.
ALTER TABLE reply_outcomes ADD COLUMN rubric_social_presence REAL;
ALTER TABLE reply_outcomes ADD COLUMN rubric_warmth REAL;
ALTER TABLE reply_outcomes ADD COLUMN rubric_competence REAL;
ALTER TABLE reply_outcomes ADD COLUMN rubric_appropriateness REAL;
ALTER TABLE reply_outcomes ADD COLUMN rubric_uncanny_risk REAL;
ALTER TABLE reply_outcomes ADD COLUMN friction_explicit_negative INTEGER;
ALTER TABLE reply_outcomes ADD COLUMN friction_repair_loop INTEGER;
ALTER TABLE reply_outcomes ADD COLUMN asi_final REAL;
