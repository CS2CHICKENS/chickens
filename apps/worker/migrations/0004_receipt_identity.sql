CREATE UNIQUE INDEX payout_receipt_identity ON payout_receipts(LOWER(tx));
CREATE UNIQUE INDEX cook_buy_identity ON cook_receipts(LOWER(buyTx),token);
CREATE UNIQUE INDEX cook_burn_identity ON cook_receipts(LOWER(burnTx),token);
