import express from 'express';
import instanceManager from './services/InstanceManager.js';
import userService from './services/UserService.js';
import qrcode from 'qrcode';
import dotenv from 'dotenv';
import path from 'path';
import cors from 'cors';

import { authMiddleware } from './middleware/auth.middleware.js';
import { validateSessionId, validateInitInstance } from './middleware/validation.middleware.js';
import { globalLimiter, instanceLimiter } from './middleware/rate-limit.middleware.js';

dotenv.config();

const app = express();
const port = process.env.BOT_BAILEYS_PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(globalLimiter);

// Health check route (Public)
app.get('/health', (req, res) => {
    res.json({
        status: 'AFRIKMONEY',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Protect all following routes with API Key
app.use(authMiddleware);

// Backend API accessibility check
app.get('/ping-api', async (req, res) => {
    const result = await userService.ping();
    if (result.success) {
        res.json({ status: 'accessible', ...result });
    } else {
        res.status(502).json({ status: 'unreachable', ...result });
    }
});

// Initialize a new instance
app.post('/instances/init/:id', validateInitInstance, instanceLimiter, async (req, res) => {
    const { id } = req.params;
    const result = await instanceManager.initInstance(id);
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

// Get status of all instances
app.get('/instances/status', (req, res) => {
    const statuses = instanceManager.getAllInstances();
    res.json(statuses);
});

// Get QR code for a specific instance (Returns PNG Image)
app.get('/instances/qr/:id', validateSessionId, async (req, res) => {
    const { id } = req.params;
    const instance = instanceManager.getInstance(id);

    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    if (instance.status === 'ready') {
        return res.json({ message: 'Instance is already connected' });
    }

    if (!instance.qr) {
        return res.status(202).json({ message: 'QR code not yet generated' });
    }

    try {
        const qrDataUrl = await qrcode.toDataURL(instance.qr);
        res.send(`<img src="${qrDataUrl}" style="display: block; margin: auto; width: 300px;" />`);
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR image' });
    }
});

// Stop an instance
app.post('/instances/stop/:id', validateSessionId, instanceLimiter, async (req, res) => {
    const { id } = req.params;
    const success = await instanceManager.stopInstance(id);
    if (success) {
        res.json({ message: `Instance ${id} stopped` });
    } else {
        res.status(404).json({ error: 'Instance not found' });
    }
});

// Send a plain WhatsApp text message from this instance — used by the backend
// for events that don't originate from a chat message (e.g. a company created
// via the public web registration form, not the bot's own chat flow).
app.post('/instances/:id/notify', validateSessionId, async (req, res) => {
    const { id } = req.params;
    const { jid, text, domain } = req.body || {};

    if (!jid || !text) {
        return res.status(400).json({ success: false, error: 'jid and text are required' });
    }

    const instance = instanceManager.getInstance(id);
    if (!instance || !instance.ready || !instance.sock) {
        return res.status(503).json({ success: false, error: 'Instance not connected' });
    }

    try {
        // 'lid' when the identity came from an active chat session that WhatsApp
        // addresses via LID (see RegistrationHandler.sendClientSignupLink) — a
        // plain phone number typed on a form is always addressed as a normal JID.
        const suffix = domain === 'lid' ? '@lid' : '@s.whatsapp.net';
        const targetJid = `${String(jid).replace(/\D/g, '')}${suffix}`;
        await instance.sock.sendMessage(targetJid, { text });
        res.json({ success: true });
    } catch (err) {
        console.error(`[Instance ${id}] notify send error:`, err);
        res.status(500).json({ success: false, error: 'Failed to send message' });
    }
});

// Resolve a typed phone number to the identity WhatsApp actually addresses it with
// right now — a LID for accounts that have migrated (the vast majority, see
// clients.whatsapp's LID architecture), the plain number otherwise. Nobody can type
// their own LID, so a public web form (e.g. CompanySignup, reachable outside any bot
// chat session) can't just trust what was typed; this asks WhatsApp's own servers via
// a live USync query, the same mechanism Baileys uses internally for any contact —
// not limited to numbers this bot has already talked to.
app.post('/instances/:id/resolve-whatsapp-identity', validateSessionId, async (req, res) => {
    const { id } = req.params;
    const { phone } = req.body || {};

    if (!phone) {
        return res.status(400).json({ success: false, error: 'phone is required' });
    }

    const instance = instanceManager.getInstance(id);
    if (!instance || !instance.ready || !instance.sock) {
        return res.status(503).json({ success: false, error: 'Instance not connected' });
    }

    try {
        const digits = String(phone).replace(/\D/g, '');
        const pnJid = `${digits}@s.whatsapp.net`;

        const lid = await instance.sock.signalRepository.lidMapping.getLIDForPN(pnJid);
        if (lid) {
            const lidUser = lid.split('@')[0].split(':')[0];
            return res.json({ success: true, exists: true, whatsapp: lidUser, is_lid: true });
        }

        // No LID mapping — either an older account still addressed by phone number,
        // or the lookup found nothing. Fall back to a plain existence check.
        const [result] = await instance.sock.onWhatsApp(pnJid);
        if (result?.exists) {
            return res.json({ success: true, exists: true, whatsapp: digits, is_lid: false });
        }

        return res.json({ success: true, exists: false });
    } catch (err) {
        console.error(`[Instance ${id}] resolve-whatsapp-identity error:`, err);
        res.status(500).json({ success: false, error: 'Resolution failed' });
    }
});

app.listen(port, () => {
    console.log(`Baileys Management API listening at http://localhost:${port}`);
    // Auto-reconnect any instance that has credentials in bot.db
    instanceManager.restorePersistedInstances();
});
