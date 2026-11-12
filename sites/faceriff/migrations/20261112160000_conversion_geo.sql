-- Localization data: country (request.cf.country, never IP) and primary browser language (short whitelisted tag)
-- at signup, at order creation (checkout) and when the buyer's own return page sees the payment captured.
-- Nullable, filled from deploy time on; earlier rows stay NULL ("未记录").
ALTER TABLE user_attribution ADD COLUMN signup_country text;
ALTER TABLE user_attribution ADD COLUMN signup_language text;
ALTER TABLE orders ADD COLUMN country text;
ALTER TABLE orders ADD COLUMN language text;
ALTER TABLE orders ADD COLUMN paid_country text;
ALTER TABLE orders ADD COLUMN paid_language text;
