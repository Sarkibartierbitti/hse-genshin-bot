-- Existing deployments may contain duplicate source rows from a reclaimed update lease.
-- Keep the first stored copy. Delivery jobs already have their own unique source key.
DELETE FROM suggestions
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM suggestions GROUP BY user_id, chat_id, message_id
);

CREATE UNIQUE INDEX suggestions_source ON suggestions (user_id, chat_id, message_id);
