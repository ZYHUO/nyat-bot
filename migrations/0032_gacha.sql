-- Gacha / 抽卡 — collectible 猫娘 cards with a coin economy + peer wishlist trading.
-- Closes the loop on checkin's reward_coins (previously a display-only number with
-- no sink): coins now accumulate in a wallet and are spent on rolls; wishlist
-- matching manufactures cross-user trades. Ported from Karitham/WaifuBot.

-- Spendable per-(chat,user) wallet. Credited by checkin, spent on rolls.
CREATE TABLE IF NOT EXISTS gacha_wallets (
    chat_id        INTEGER NOT NULL,
    uid            INTEGER NOT NULL,
    coins          INTEGER NOT NULL DEFAULT 0,
    rolls_since_sr INTEGER NOT NULL DEFAULT 0,  -- soft-pity counter
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (chat_id, uid)
);

-- Owned cards (count = duplicates held).
CREATE TABLE IF NOT EXISTS gacha_collection (
    chat_id   INTEGER NOT NULL,
    uid       INTEGER NOT NULL,
    card_id   TEXT    NOT NULL,
    count     INTEGER NOT NULL DEFAULT 1,
    first_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (chat_id, uid, card_id)
);
CREATE INDEX IF NOT EXISTS idx_gacha_collection_card ON gacha_collection(chat_id, card_id);

-- Wishlist — cards a user wants (drives peer trade matching).
CREATE TABLE IF NOT EXISTS gacha_wishlist (
    chat_id    INTEGER NOT NULL,
    uid        INTEGER NOT NULL,
    card_id    TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (chat_id, uid, card_id)
);
CREATE INDEX IF NOT EXISTS idx_gacha_wishlist_card ON gacha_wishlist(chat_id, card_id);
