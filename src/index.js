import express from 'express';
import instanceManager from './services/InstanceManager.js';
import apiService from './services/ApiService.js';
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
        status: 'UP',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Protect all following routes with API Key
app.use(authMiddleware);

// Backend API accessibility check
app.get('/ping-api', async (req, res) => {
    const result = await apiService.ping();
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
        const qrBuffer = await qrcode.toBuffer(instance.qr);
        res.setHeader('Content-Type', 'image/png');
        res.send(qrBuffer);
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

app.listen(port, () => {
    console.log(`Baileys Management API listening at http://localhost:${port}`);
});
