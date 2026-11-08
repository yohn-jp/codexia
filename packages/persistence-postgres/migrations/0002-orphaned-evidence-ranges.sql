ALTER TABLE text_anchor
  DROP CONSTRAINT text_anchor_check,
  ADD CONSTRAINT text_anchor_range_check CHECK (to_utf16 >= from_utf16);

ALTER TABLE anchor_history
  DROP CONSTRAINT anchor_history_check,
  ADD CONSTRAINT anchor_history_range_check CHECK (to_utf16 >= from_utf16);
