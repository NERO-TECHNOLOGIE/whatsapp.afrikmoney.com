import rateLimit from 'express-rate-limit';
import { hasValidApiKey } from './auth.middleware.js';

export const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    // The backend (valid API key) is trusted: it polls instance status for the
    // admin panel and sends notifications from a single IP, which would
    // otherwise exhaust this quota and block every call for 15 minutes.
    skip: (req) => hasValidApiKey(req),
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

export const instanceLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // Limit each IP to 10 requests per minute for instance operations
    message: { error: 'Too many instance operations, please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});
