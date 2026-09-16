-- Multi-step jargon inference: remember the count at which a jargon was last
-- inferred so we only re-infer once it crosses the NEXT threshold tier.
ALTER TABLE jargons ADD COLUMN last_inference_count INTEGER NOT NULL DEFAULT 0;
