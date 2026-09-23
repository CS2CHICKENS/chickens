CREATE TABLE publication_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  round INTEGER NOT NULL,
  owedWei TEXT NOT NULL DEFAULT '0',
  unpaidDelta INTEGER NOT NULL DEFAULT 0,
  distributedDelta INTEGER NOT NULL DEFAULT 0,
  cookedWei TEXT NOT NULL DEFAULT '0',
  devWei TEXT NOT NULL DEFAULT '0'
);
CREATE TABLE publication_totals (id INTEGER PRIMARY KEY CHECK(id=1), owedWei TEXT NOT NULL, devWei TEXT NOT NULL);
INSERT INTO publication_totals VALUES(1,'0','0');
CREATE TABLE publication_round_totals (round INTEGER PRIMARY KEY, owedWei TEXT NOT NULL, unpaidCount INTEGER NOT NULL, distributedCount INTEGER NOT NULL, cookedWei TEXT NOT NULL);
CREATE TABLE history_dirty (page INTEGER PRIMARY KEY);
CREATE TABLE history_wins (family TEXT PRIMARY KEY, wins INTEGER NOT NULL);
CREATE TABLE wallet_history_dirty (wallet TEXT NOT NULL, page INTEGER NOT NULL, PRIMARY KEY(wallet,page));
CREATE TABLE wallet_metric_jobs (wallet TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE INDEX balance_wallet_cursor ON balance_events(wallet,block,logIndex,id);
CREATE INDEX payouts_wallet_round ON payouts(wallet,round);
CREATE INDEX payout_receipts_round ON payout_receipts(round,block,tx);
CREATE INDEX cooks_round ON cooks(round,tx);
CREATE INDEX round_weights_wallet_round ON round_weights(wallet,round);
CREATE TRIGGER wallet_metric_job_insert AFTER INSERT ON wallet_metric_jobs BEGIN
  INSERT INTO wallet_dirty(wallet) SELECT NEW.wallet WHERE NOT EXISTS(SELECT 1 FROM wallet_dirty WHERE wallet=NEW.wallet);
END;
CREATE TRIGGER wallet_metric_job_update AFTER UPDATE ON wallet_metric_jobs BEGIN
  INSERT INTO wallet_dirty(wallet) SELECT NEW.wallet WHERE NOT EXISTS(SELECT 1 FROM wallet_dirty WHERE wallet=NEW.wallet);
END;

-- The database seeds the journal without returning the historical ledger to a Worker.
INSERT INTO publication_changes(round,owedWei,unpaidDelta,distributedDelta)
SELECT round,CASE WHEN status='PUBLISHED' THEN amountWei ELSE '0' END,CASE WHEN status<>'DISTRIBUTED' THEN 1 ELSE 0 END,CASE WHEN status='DISTRIBUTED' THEN 1 ELSE 0 END FROM payouts;
INSERT INTO publication_changes(round,cookedWei) SELECT round,ethIn FROM cooks;
INSERT INTO publication_changes(round,devWei) SELECT 0,devWei FROM split_releases;
INSERT OR IGNORE INTO history_dirty SELECT CAST((id-1)/100 AS INTEGER) FROM rounds;
INSERT INTO history_wins SELECT winner,COUNT(*) FROM rounds WHERE winner IS NOT NULL GROUP BY winner;
INSERT OR IGNORE INTO wallet_history_dirty SELECT wallet,CAST((round-1)/100 AS INTEGER) FROM payouts WHERE status='DISTRIBUTED';

CREATE TRIGGER publication_payout_insert AFTER INSERT ON payouts BEGIN
  INSERT INTO publication_changes(round,owedWei,unpaidDelta,distributedDelta) VALUES(NEW.round,CASE WHEN NEW.status='PUBLISHED' THEN NEW.amountWei ELSE '0' END,CASE WHEN NEW.status<>'DISTRIBUTED' THEN 1 ELSE 0 END,CASE WHEN NEW.status='DISTRIBUTED' THEN 1 ELSE 0 END);
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((NEW.round-1)/100 AS INTEGER));
  INSERT OR IGNORE INTO wallet_history_dirty SELECT NEW.wallet,CAST((NEW.round-1)/100 AS INTEGER) WHERE NEW.status='DISTRIBUTED';
END;
CREATE TRIGGER publication_payout_delete AFTER DELETE ON payouts BEGIN
  INSERT INTO publication_changes(round,owedWei,unpaidDelta,distributedDelta) VALUES(OLD.round,CASE WHEN OLD.status='PUBLISHED' THEN '-'||OLD.amountWei ELSE '0' END,CASE WHEN OLD.status<>'DISTRIBUTED' THEN -1 ELSE 0 END,CASE WHEN OLD.status='DISTRIBUTED' THEN -1 ELSE 0 END);
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((OLD.round-1)/100 AS INTEGER));
  INSERT OR IGNORE INTO wallet_history_dirty SELECT OLD.wallet,CAST((OLD.round-1)/100 AS INTEGER) WHERE OLD.status='DISTRIBUTED';
END;
CREATE TRIGGER publication_payout_update AFTER UPDATE ON payouts BEGIN
  INSERT INTO publication_changes(round,owedWei,unpaidDelta,distributedDelta) VALUES(OLD.round,CASE WHEN OLD.status='PUBLISHED' THEN '-'||OLD.amountWei ELSE '0' END,CASE WHEN OLD.status<>'DISTRIBUTED' THEN -1 ELSE 0 END,CASE WHEN OLD.status='DISTRIBUTED' THEN -1 ELSE 0 END);
  INSERT INTO publication_changes(round,owedWei,unpaidDelta,distributedDelta) VALUES(NEW.round,CASE WHEN NEW.status='PUBLISHED' THEN NEW.amountWei ELSE '0' END,CASE WHEN NEW.status<>'DISTRIBUTED' THEN 1 ELSE 0 END,CASE WHEN NEW.status='DISTRIBUTED' THEN 1 ELSE 0 END);
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((OLD.round-1)/100 AS INTEGER));
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((NEW.round-1)/100 AS INTEGER));
  INSERT OR IGNORE INTO wallet_history_dirty SELECT OLD.wallet,CAST((OLD.round-1)/100 AS INTEGER) WHERE OLD.status='DISTRIBUTED';
  INSERT OR IGNORE INTO wallet_history_dirty SELECT NEW.wallet,CAST((NEW.round-1)/100 AS INTEGER) WHERE NEW.status='DISTRIBUTED';
END;
CREATE TRIGGER publication_cook_insert AFTER INSERT ON cooks BEGIN
  INSERT INTO publication_changes(round,cookedWei) VALUES(NEW.round,NEW.ethIn);
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((NEW.round-1)/100 AS INTEGER));
END;
CREATE TRIGGER publication_cook_delete AFTER DELETE ON cooks BEGIN
  INSERT INTO publication_changes(round,cookedWei) VALUES(OLD.round,'-'||OLD.ethIn);
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((OLD.round-1)/100 AS INTEGER));
END;
CREATE TRIGGER publication_cook_update AFTER UPDATE ON cooks BEGIN
  INSERT INTO publication_changes(round,cookedWei) VALUES(OLD.round,'-'||OLD.ethIn);
  INSERT INTO publication_changes(round,cookedWei) VALUES(NEW.round,NEW.ethIn);
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((OLD.round-1)/100 AS INTEGER));
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((NEW.round-1)/100 AS INTEGER));
END;
CREATE TRIGGER publication_release_insert AFTER INSERT ON split_releases BEGIN
  INSERT INTO publication_changes(round,devWei) VALUES(0,NEW.devWei);
END;
CREATE TRIGGER publication_release_delete AFTER DELETE ON split_releases BEGIN
  INSERT INTO publication_changes(round,devWei) VALUES(0,'-'||OLD.devWei);
END;
CREATE TRIGGER publication_release_update AFTER UPDATE ON split_releases BEGIN
  INSERT INTO publication_changes(round,devWei) VALUES(0,'-'||OLD.devWei);
  INSERT INTO publication_changes(round,devWei) VALUES(0,NEW.devWei);
END;
CREATE TRIGGER publication_round_insert AFTER INSERT ON rounds BEGIN
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((NEW.id-1)/100 AS INTEGER));
  INSERT INTO history_wins(family,wins) SELECT NEW.winner,1 WHERE NEW.winner IS NOT NULL ON CONFLICT(family) DO UPDATE SET wins=wins+1;
END;
CREATE TRIGGER publication_round_update AFTER UPDATE ON rounds BEGIN
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((NEW.id-1)/100 AS INTEGER));
  UPDATE history_wins SET wins=wins-1 WHERE family=OLD.winner AND OLD.winner IS NOT NEW.winner;
  INSERT INTO history_wins(family,wins) SELECT NEW.winner,1 WHERE NEW.winner IS NOT NULL AND OLD.winner IS NOT NEW.winner ON CONFLICT(family) DO UPDATE SET wins=wins+1;
END;
CREATE TRIGGER publication_round_delete AFTER DELETE ON rounds BEGIN
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((OLD.id-1)/100 AS INTEGER));
  UPDATE history_wins SET wins=wins-1 WHERE family=OLD.winner;
END;
CREATE TRIGGER publication_manifest_insert AFTER INSERT ON manifests BEGIN
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((NEW.round-1)/100 AS INTEGER));
END;
CREATE TRIGGER publication_manifest_update AFTER UPDATE ON manifests BEGIN
  INSERT OR IGNORE INTO history_dirty VALUES(CAST((NEW.round-1)/100 AS INTEGER));
END;
