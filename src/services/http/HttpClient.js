import axios from 'axios';
import dotenv from 'dotenv';
import FormData from 'form-data';

dotenv.config();

/**
 * HttpClient - The sole HTTP layer for all API communication.
 *
 * Single Responsibility: Handle raw HTTP requests, token management,
 * and error normalisation. Does NOT know anything about business domain.
 *
 * All other services depend on this class (Dependency Inversion).
 */
class HttpClient {
    constructor() {
        this.baseURL = process.env.API_BASE_URL || 'https://api.afrikmoney.com/api';
        /** @type {Map<string, string>} Per-user auth token store */
        this.tokens = new Map();
    }

    /**
     * Make an HTTP request with automatic auth header injection.
     *
     * @param {string} method - HTTP method (GET, POST, etc.)
     * @param {string} endpoint - API path (e.g. /afrik/login)
     * @param {Object|FormData|null} data - Request body
     * @param {string|null} whatsappId - User identifier for token lookup
     * @param {boolean} isFormData - Whether data is a FormData instance
     * @returns {Promise<{success: boolean, data?: any, error?: any, status?: number}>}
     */
    async request(method, endpoint, data = null, whatsappId = null, isFormData = false) {
        const url = `${this.baseURL}${endpoint}`;
        const headers = {};

        // Build auth header if a token is available
        if (whatsappId && this.tokens.has(whatsappId)) {
            headers['Authorization'] = `Bearer ${this.tokens.get(whatsappId)}`;
        }

        // Set Content-Type header
        if (isFormData && data instanceof FormData) {
            Object.assign(headers, data.getHeaders());
        } else if (!isFormData) {
            headers['Content-Type'] = 'application/json';
        }

        try {
            const response = await axios({ method, url, headers, ...(data && { data }) });
            return { success: true, data: response.data };
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            console.error(`[HttpClient] ${method} ${endpoint} failed: ${errorMsg}`);

            if (error.response?.data) {
                console.error(`[HttpClient] Error data:`, JSON.stringify(error.response.data, null, 2));
            }

            // On 401: clear stale token so next call can re-authenticate
            if (error.response?.status === 401 && whatsappId && endpoint !== '/afrik/login') {
                console.log(`[HttpClient] Token expired for ${whatsappId}, clearing...`);
                this.tokens.delete(whatsappId);
            }

            return {
                success: false,
                error: error.response?.data || { message: error.message },
                status: error.response?.status
            };
        }
    }

    /**
     * Store an auth token for a given user.
     * @param {string} whatsappId
     * @param {string} token
     */
    setToken(whatsappId, token) {
        this.tokens.set(whatsappId, token);
    }

    /**
     * Remove the stored token for a user (e.g. on logout).
     * @param {string} whatsappId
     */
    clearToken(whatsappId) {
        this.tokens.delete(whatsappId);
    }

    /**
     * Check if a token exists for a user.
     * @param {string} whatsappId
     * @returns {boolean}
     */
    hasToken(whatsappId) {
        return this.tokens.has(whatsappId);
    }

    /**
     * Ping the API to verify connectivity.
     * @returns {Promise<{success: boolean, status?: number, message?: string}>}
     */
    async ping() {
        try {
            const response = await axios.get(`${this.baseURL}/afrik/check-phone`, {
                params: { telephone: '00000000' },
                timeout: 5000
            });
            return { success: true, status: response.status };
        } catch (error) {
            return { success: false, status: error.response?.status, message: error.message };
        }
    }
}

// Singleton: one shared HTTP client for the entire application
export default new HttpClient();
