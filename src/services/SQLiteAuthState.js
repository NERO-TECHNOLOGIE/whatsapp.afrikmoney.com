import Database from 'better-sqlite3';
import { initAuthCreds, BufferJSON } from '@itsliaaa/baileys';
import fs from 'fs';

const DB_PATH = process.env.SESSION_DB_PATH || './bot.db';

// Shared database — one file for all instances
let _db = null;
function getDb() {
    if (_db) return _db;

    _db = new Database(DB_PATH);
    _db.exec(`
        CREATE TABLE IF NOT EXISTS auth_creds (
            instance_id TEXT NOT NULL,
            key         TEXT NOT NULL,
            value       TEXT NOT NULL,
            PRIMARY KEY (instance_id, key)
        );
        CREATE TABLE IF NOT EXISTS signal_keys (
            instance_id TEXT NOT NULL,
            type        TEXT NOT NULL,
            id          TEXT NOT NULL,
            value       TEXT NOT NULL,
            PRIMARY KEY (instance_id, type, id)
        );
    `);
    return _db;
}

/**
 * SQLite-backed Baileys auth state.
 * All instances share a single bot.db file — no sessions/ folder needed.
 *
 * Usage:
 *   const { state, saveCreds } = useSQLiteAuthState('BOT');
 */
export function useSQLiteAuthState(instanceId) {
    const db = getDb();

    const stmts = {
        getCred:   db.prepare('SELECT value FROM auth_creds WHERE instance_id = ? AND key = ?'),
        setCred:   db.prepare('INSERT OR REPLACE INTO auth_creds (instance_id, key, value) VALUES (?, ?, ?)'),
        getKey:    db.prepare('SELECT value FROM signal_keys WHERE instance_id = ? AND type = ? AND id = ?'),
        setKey:    db.prepare('INSERT OR REPLACE INTO signal_keys (instance_id, type, id, value) VALUES (?, ?, ?, ?)'),
        deleteKey: db.prepare('DELETE FROM signal_keys WHERE instance_id = ? AND type = ? AND id = ?'),
        clearAll:  db.prepare('DELETE FROM auth_creds WHERE instance_id = ?'),
        clearKeys: db.prepare('DELETE FROM signal_keys WHERE instance_id = ?'),
    };

    // Load or initialise credentials for this instance
    const credsRow = stmts.getCred.get(instanceId, 'creds');
    const creds = credsRow
        ? JSON.parse(credsRow.value, BufferJSON.reviver)
        : initAuthCreds();

    const keys = {
        get(type, ids) {
            const data = {};
            for (const id of ids) {
                const row = stmts.getKey.get(instanceId, type, id);
                if (row) data[id] = JSON.parse(row.value, BufferJSON.reviver);
            }
            return data;
        },

        set(data) {
            const tx = db.transaction(() => {
                for (const [type, entries] of Object.entries(data)) {
                    for (const [id, value] of Object.entries(entries)) {
                        if (value != null) {
                            stmts.setKey.run(instanceId, type, id, JSON.stringify(value, BufferJSON.replacer));
                        } else {
                            stmts.deleteKey.run(instanceId, type, id);
                        }
                    }
                }
            });
            tx();
        },
    };

    const saveCreds = () => {
        stmts.setCred.run(instanceId, 'creds', JSON.stringify(creds, BufferJSON.replacer));
    };

    /**
     * Remove all data for this instance from the DB (called on logout).
     */
    const clearSession = () => {
        stmts.clearAll.run(instanceId);
        stmts.clearKeys.run(instanceId);
    };

    return { state: { creds, keys }, saveCreds, clearSession };
}

/**
 * Return all instance IDs that have credentials stored in bot.db.
 * Used on startup to auto-reconnect without a new QR scan.
 */
export function getStoredInstanceIds() {
    const db = getDb();
    const rows = db.prepare("SELECT DISTINCT instance_id FROM auth_creds WHERE key = 'creds'").all();
    return rows.map(r => r.instance_id);
}
