CREATE TABLE settlement_pages(round INTEGER NOT NULL,page INTEGER NOT NULL,contentHash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(round,page));
CREATE INDEX settlement_page_commitment ON settlement_pages(round,contentHash,page);
CREATE INDEX balance_settlement ON balance_events(wallet,block,logIndex);
