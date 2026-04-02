-- Create database for bank-to-ynab
-- Run: createdb bank_to_ynab

-- Mappings table: stores keyword -> YNAB category mappings
CREATE TABLE IF NOT EXISTS mappings (
    id SERIAL PRIMARY KEY,
    keyword VARCHAR(255) UNIQUE NOT NULL,
    ynab_category_id VARCHAR(255),
    ynab_category_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payees table: stores unique payees from CSV imports
CREATE TABLE IF NOT EXISTS payees (
    id SERIAL PRIMARY KEY,
    name VARCHAR(500) UNIQUE NOT NULL,
    normalized_name VARCHAR(500), -- cleaned up version for matching
    mapping_id INTEGER REFERENCES mappings(id) ON DELETE SET NULL,
    transaction_count INTEGER DEFAULT 1,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Transactions table: stores imported transactions temporarily
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    payee_id INTEGER REFERENCES payees(id) ON DELETE CASCADE,
    booking_date DATE NOT NULL,
    operation_date DATE,
    amount DECIMAL(12, 2) NOT NULL,
    raw_data JSONB, -- store original CSV row
    category_id VARCHAR(255), -- YNAB category if assigned
    imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    exported_to_ynab BOOLEAN DEFAULT FALSE
);

-- Add import_batch_id column to transactions (for tracking CSV import batches)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS import_batch_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_transactions_import_batch ON transactions(import_batch_id);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_payees_mapping ON payees(mapping_id);
CREATE INDEX IF NOT EXISTS idx_payees_normalized ON payees(normalized_name);
CREATE INDEX IF NOT EXISTS idx_mappings_keyword ON mappings(keyword);
CREATE INDEX IF NOT EXISTS idx_transactions_payee ON transactions(payee_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(booking_date);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_mappings_updated_at ON mappings;
CREATE TRIGGER update_mappings_updated_at
    BEFORE UPDATE ON mappings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_payees_updated_at ON payees;
CREATE TRIGGER update_payees_updated_at
    BEFORE UPDATE ON payees
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
