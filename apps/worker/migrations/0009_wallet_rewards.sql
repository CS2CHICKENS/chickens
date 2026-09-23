CREATE TABLE wallet_reward_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  amountWei TEXT NOT NULL,
  countDelta INTEGER NOT NULL
);
CREATE INDEX wallet_reward_change_cursor ON wallet_reward_changes(wallet,sequence);
CREATE TABLE wallet_reward_totals (wallet TEXT PRIMARY KEY, amountWei TEXT NOT NULL, entries INTEGER NOT NULL);
CREATE INDEX payouts_wallet_status_round ON payouts(wallet,status,round,category);

INSERT INTO wallet_reward_changes(wallet,amountWei,countDelta)
SELECT wallet,amountWei,1 FROM payouts WHERE status='PUBLISHED';
INSERT OR IGNORE INTO wallet_dirty SELECT DISTINCT wallet FROM payouts WHERE status='PUBLISHED';

CREATE TRIGGER wallet_reward_insert AFTER INSERT ON payouts WHEN NEW.status='PUBLISHED' BEGIN
  INSERT INTO wallet_reward_changes(wallet,amountWei,countDelta) VALUES(NEW.wallet,NEW.amountWei,1);
  INSERT INTO wallet_dirty(wallet) SELECT NEW.wallet WHERE NOT EXISTS(SELECT 1 FROM wallet_dirty WHERE wallet=NEW.wallet);
END;
CREATE TRIGGER wallet_reward_delete AFTER DELETE ON payouts WHEN OLD.status='PUBLISHED' BEGIN
  INSERT INTO wallet_reward_changes(wallet,amountWei,countDelta) VALUES(OLD.wallet,'-'||OLD.amountWei,-1);
  INSERT INTO wallet_dirty(wallet) SELECT OLD.wallet WHERE NOT EXISTS(SELECT 1 FROM wallet_dirty WHERE wallet=OLD.wallet);
END;
CREATE TRIGGER wallet_reward_update AFTER UPDATE ON payouts WHEN OLD.status='PUBLISHED' OR NEW.status='PUBLISHED' BEGIN
  INSERT INTO wallet_reward_changes(wallet,amountWei,countDelta) SELECT OLD.wallet,'-'||OLD.amountWei,-1 WHERE OLD.status='PUBLISHED';
  INSERT INTO wallet_reward_changes(wallet,amountWei,countDelta) SELECT NEW.wallet,NEW.amountWei,1 WHERE NEW.status='PUBLISHED';
  INSERT INTO wallet_dirty(wallet) SELECT OLD.wallet WHERE NOT EXISTS(SELECT 1 FROM wallet_dirty WHERE wallet=OLD.wallet);
  INSERT INTO wallet_dirty(wallet) SELECT NEW.wallet WHERE NOT EXISTS(SELECT 1 FROM wallet_dirty WHERE wallet=NEW.wallet);
END;
