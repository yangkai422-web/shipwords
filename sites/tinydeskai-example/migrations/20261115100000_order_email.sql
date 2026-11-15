-- Contact email collected at checkout and stored on the order.
ALTER TABLE orders ADD COLUMN email text;
