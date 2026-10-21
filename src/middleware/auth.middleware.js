import dotenv from 'dotenv';
dotenv.config();

/** True when the request carries the bot's API key (X-API-KEY header or ?api_key). */
export const hasValidApiKey = (req) => {
    const apiKey = process.env.API_KEY || 'zap_noweb_key_67890';
    const providedKey = req.headers['x-api-key'] || req.query.api_key;
    return !!providedKey && providedKey === apiKey;
};

/**
 * Middleware to check API Key.
 * Accepts key via 'X-API-KEY'.
 */
export const authMiddleware = (req, res, next) => {
    if (!hasValidApiKey(req)) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    }

    next();
};
