import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import FormData from 'form-data';

dotenv.config();

/**
 * ApiService - Centralized service for all API communications with Laravel backend
 * Handles authentication, data fetching, and result submissions
 */
class ApiService {
    constructor() {
        this.baseURL = process.env.API_BASE_URL || 'https://api.afrikmoney.com/api';
        this.tokens = new Map(); // Store tokens per whatsapp user
        this.maxRetries = 3;
    }

    /**
     * Make an authenticated API request
     */
    async request(method, endpoint, data = null, whatsappId = null, isFormData = false) {
        const url = `${this.baseURL}${endpoint}`;
        const headers = {};

        // Auto-authenticate if token is missing and it's not an auth endpoint
        if (whatsappId && !this.tokens.has(whatsappId) && !['/afrik/login', '/afrik/register', '/afrik/check-phone'].includes(endpoint)) {
            try {
                await this.authenticate(whatsappId);
            } catch (e) {
                console.warn(`[ApiService] Initial authentication failed for ${whatsappId}:`, e.message);
            }
        }

        // Add auth token if available
        if (whatsappId && this.tokens.has(whatsappId)) {
            headers['Authorization'] = `Bearer ${this.tokens.get(whatsappId)}`;
        }

        // Handle FormData
        if (isFormData && data instanceof FormData) {
            Object.assign(headers, data.getHeaders());
        } else if (!isFormData) {
            headers['Content-Type'] = 'application/json';
        }

        const config = {
            method,
            url,
            headers,
            ...(data && { data })
        };

        try {
            const response = await axios(config);
            return { success: true, data: response.data };
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            console.error(`[ApiService] ${method} ${endpoint} failed:`, errorMsg);

            // Handle 401 - token expired
            if (error.response?.status === 401 && whatsappId && endpoint !== '/afrik/login') {
                console.log(`[ApiService] Token expired for ${whatsappId}, clearing token...`);
                this.tokens.delete(whatsappId);

                // We attempt to re-authenticate so the NEXT retry in requestWithRetry will use a fresh token
                try {
                    await this.authenticate(whatsappId);
                } catch (reAuthError) {
                    console.error(`[ApiService] Re-authentication failed for ${whatsappId}:`, reAuthError.message);
                }
            }

            return {
                success: false,
                error: error.response?.data || { message: error.message },
                status: error.response?.status
            };
        }
    }

    /**
     * Retry wrapper for network requests
     */
    async requestWithRetry(method, endpoint, data = null, whatsappId = null, isFormData = false) {
        let lastError;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            const result = await this.request(method, endpoint, data, whatsappId, isFormData);

            if (result.success) {
                return result;
            }

            lastError = result;

            // Don't retry on client errors (4xx) except 401
            if (result.status >= 400 && result.status < 500 && result.status !== 401) {
                break;
            }

            // Wait before retry (exponential backoff)
            if (attempt < this.maxRetries) {
                const waitTime = Math.pow(2, attempt) * 1000;
                console.log(`[ApiService] Retry ${attempt}/${this.maxRetries} after ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        return lastError;
    }

    // ==================== AUTHENTICATION ====================

    /**
     * Authenticate a WhatsApp user and store token
     * Returns user data if successful, null if user doesn't exist
     */
    async authenticate(whatsappId) {
        const result = await this.requestWithRetry('POST', '/afrik/login', { whatsapp: whatsappId });

        if (result.success && result.data.token) {
            this.tokens.set(whatsappId, result.data.token);
            console.log(`[ApiService] Authenticated user: ${result.data.user.nom} ${result.data.user.prenom}`);
            return result.data.user;
        }

        if (result.status === 404) {
            console.log(`[ApiService] User not found for WhatsApp: ${whatsappId}`);
            return null;
        }

        throw new Error(`Authentication failed: ${result.error?.message || 'Unknown error'}`);
    }

    /**
     * Register a new WhatsApp user
     */
    async registerUser(data) {
        const result = await this.requestWithRetry('POST', '/afrik/register', data);

        if (result.success && result.data.token) {
            this.tokens.set(data.whatsapp, result.data.token);
            console.log(`[ApiService] Registered new user: ${result.data.user.nom} ${result.data.user.prenom}`);
            return result.data.user;
        }

        throw new Error(`Registration failed: ${JSON.stringify(result.error)}`);
    }

    /**
     * Check if a phone number is already registered
     */
    async checkPhoneExists(telephone) {
        const result = await this.requestWithRetry('POST', '/afrik/check-phone', { telephone });

        if (result.success) {
            return result.data.exists;
        }

        return false;
    }

    // ==================== AFRIKM_API ====================

    /**
     * Get user projects
     */
    async getProjects(whatsappId) {
        const result = await this.requestWithRetry('GET', '/afrik/projects', null, whatsappId);
        if (result.success) return result.data;
        throw new Error(`Failed to fetch projects: ${result.error?.message}`);
    }

    /**
     * Create a new project
     */
    async createProject(projectData, whatsappId) {
        const result = await this.requestWithRetry('POST', '/afrik/projects/create', projectData, whatsappId);
        if (result.success) return result.data;
        throw new Error(`Failed to create project: ${result.error?.message}`);
    }

    /**
     * Submit a merchant payment
     */
    async submitMerchantPayment(paymentData, whatsappId) {
        const result = await this.requestWithRetry('POST', '/afrik/payments/merchant', paymentData, whatsappId);
        if (result.success) return result.data;
        throw new Error(`Failed to submit merchant payment: ${result.error?.message}`);
    }

    /**
     * Get payment history
     */
    async getHistory(whatsappId) {
        const result = await this.requestWithRetry('GET', '/afrik/history', null, whatsappId);
        if (result.success) return result.data;
        throw new Error(`Failed to fetch history: ${result.error?.message}`);
    }

    /**
     * Clear stored token for a user (e.g., on logout or error)
     */
    clearToken(whatsappId) {
        this.tokens.delete(whatsappId);
    }

    /**
     * Ping the API to check accessibility
     */
    async ping() {
        try {
            // We use a simple GET request to the base URL or a known public endpoint
            // Since we don't have a dedicated /ping, we can try to fetch a very basic public route
            // or just check if the server responds at all.
            const response = await axios.get(`${this.baseURL}/afrik/check-phone`, {
                params: { telephone: '00000000' }, // Invalid number just to trigger a response
                timeout: 5000
            });
            return { success: true, status: response.status };
        } catch (error) {
            return {
                success: false,
                status: error.response?.status,
                message: error.message
            };
        }
    }
}

export default new ApiService();