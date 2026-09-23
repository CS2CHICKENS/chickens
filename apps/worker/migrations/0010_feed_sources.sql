CREATE TABLE feed_source_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  volumeWei TEXT NOT NULL,
  creatorFeeWei TEXT,
  feeVerified INTEGER,
  direction INTEGER NOT NULL CHECK(direction IN (-1,1))
);
CREATE TABLE feed_source_totals (
  token TEXT PRIMARY KEY,
  volumeWei TEXT NOT NULL,
  creatorFeeWei TEXT NOT NULL,
  unverifiedCount INTEGER NOT NULL
);

INSERT INTO feed_source_changes(token,volumeWei,creatorFeeWei,feeVerified,direction)
SELECT token,CASE WHEN kind='trade' THEN volume ELSE '0' END,creatorFeeWei,feeVerified,1 FROM swaps;

CREATE TRIGGER feed_source_insert AFTER INSERT ON swaps BEGIN
  INSERT INTO feed_source_changes(token,volumeWei,creatorFeeWei,feeVerified,direction)
  VALUES(NEW.token,CASE WHEN NEW.kind='trade' THEN NEW.volume ELSE '0' END,NEW.creatorFeeWei,NEW.feeVerified,1);
END;
CREATE TRIGGER feed_source_delete AFTER DELETE ON swaps BEGIN
  INSERT INTO feed_source_changes(token,volumeWei,creatorFeeWei,feeVerified,direction)
  VALUES(OLD.token,CASE WHEN OLD.kind='trade' THEN OLD.volume ELSE '0' END,OLD.creatorFeeWei,OLD.feeVerified,-1);
END;
CREATE TRIGGER feed_source_update AFTER UPDATE OF token,kind,volume,creatorFeeWei,feeVerified ON swaps BEGIN
  INSERT INTO feed_source_changes(token,volumeWei,creatorFeeWei,feeVerified,direction)
  VALUES(OLD.token,CASE WHEN OLD.kind='trade' THEN OLD.volume ELSE '0' END,OLD.creatorFeeWei,OLD.feeVerified,-1);
  INSERT INTO feed_source_changes(token,volumeWei,creatorFeeWei,feeVerified,direction)
  VALUES(NEW.token,CASE WHEN NEW.kind='trade' THEN NEW.volume ELSE '0' END,NEW.creatorFeeWei,NEW.feeVerified,1);
END;
