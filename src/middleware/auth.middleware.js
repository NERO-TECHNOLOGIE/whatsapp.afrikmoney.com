import dotenv from 'dotenv';
dotenv.config();

/**
 * Middleware to check API Key.
 * Accepts key via 'X-API-KEY' header OR 'api_key' query parameter.
 */
export const authMiddleware = (req, res, next) => {
    const apiKey = process.env.API_KEY || 'zap_noweb_key_67890';
    const providedKey = req.headers['x-api-key'] || req.query.api_key;

    if (!providedKey || providedKey !== apiKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    }

    next();
};
