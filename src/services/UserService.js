import httpClient from './http/HttpClient.js';

/**
 * UserService - Manages user profile and transaction history queries.
 *
 * Single Responsibility: Read-only user data that is not related to auth or payments.
 */
class UserService {

    /**
     * Get the payment history for a user.
     *
     * @param {string} whatsappId - User's normalized WhatsApp ID (for auth)
     * @returns {Promise<Array>} List of transaction objects
     */
    async getHistory(whatsappId) {
        const result = await httpClient.request('GET', '/afrik/history', null, whatsappId);
        if (result.success) return result.data;
        throw new Error(`Failed to fetch history: ${result.error?.message}`);
    }

    /**
     * Ping the backend API to verify it is reachable.
     *
     * @returns {Promise<{success: boolean, status?: number, message?: string}>}
     */
    async ping() {
        return httpClient.ping();
    }
}

export default new UserService();
