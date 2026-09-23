CREATE TABLE fee_collection_events (
  id TEXT PRIMARY KEY,
  block INTEGER NOT NULL,
  logIndex INTEGER NOT NULL,
  tx TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('project','other','claim','direct')),
  token TEXT,
  amountWei TEXT NOT NULL
);
CREATE INDEX fee_collection_history ON fee_collection_events(block,logIndex);
