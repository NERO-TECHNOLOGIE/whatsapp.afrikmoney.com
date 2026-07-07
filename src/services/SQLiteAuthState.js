import Database from 'better-sqlite3';
import { initAuthCreds, BufferJSON } from '@itsliaaa/baileys';
import path from 'path';
import fs from 'fs';

const SESSIONS_DIR = './sessions';

/**
 * SQLite-backed Baileys auth state.
 * Replaces useMultiFileAuthState — stores credentials and signal keys
 * in a single .db file per instance instead of hundreds of JSON files.
 *
 * Usage:
 *   const { state, saveCreds } = useSQLiteAuthState('BOT');
 */
export function useSQLiteAuthState(instanceId) {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

    const dbPath = path.join(SESSIONS_DIR, `session-${instanceId}.db`);
    const db = new Database(dbPath);

    db.exec(`
        CREATE TABLE IF NOT EXISTS auth_creds (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS signal_keys (
            type  TEXT NOT NULL,
            id    TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (type, id)
        );
    `);

    const stmts = {
        getCred:   db.prepare('SELECT value FROM auth_creds WHERE key = ?'),
        setCred:   db.prepare('INSERT OR REPLACE INTO auth_creds (key, value) VALUES (?, ?)'),
        getKey:    db.prepare('SELECT value FROM signal_keys WHERE type = ? AND id = ?'),
        setKey:    db.prepare('INSERT OR REPLACE INTO signal_keys (type, id, value) VALUES (?, ?, ?)'),
        deleteKey: db.prepare('DELETE FROM signal_keys WHERE type = ? AND id = ?'),
    };

    // Load or initialise credentials
    const credsRow = stmts.getCred.get('creds');
    const creds = credsRow
        ? JSON.parse(credsRow.value, BufferJSON.reviver)
        : initAuthCreds();

    const keys = {
        get(type, ids) {
            const data = {};
            for (const id of ids) {
                const row = stmts.getKey.get(type, id);
                if (row) data[id] = JSON.parse(row.value, BufferJSON.reviver);
            }
            return data;
        },

        set(data) {
            const tx = db.transaction(() => {
                for (const [type, entries] of Object.entries(data)) {
                    for (const [id, value] of Object.entries(entries)) {
                        if (value != null) {
                            stmts.setKey.run(type, id, JSON.stringify(value, BufferJSON.replacer));
                        } else {
                            stmts.deleteKey.run(type, id);
                        }
                    }
                }
            });
            tx();
        },
    };

    const saveCreds = () => {
        stmts.setCred.run('creds', JSON.stringify(creds, BufferJSON.replacer));
    };

    return { state: { creds, keys }, saveCreds };
}
