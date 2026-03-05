import httpClient from './http/HttpClient.js';

/**
 * AuthService - Manages user authentication and registration.
 *
 * Single Responsibility: All operations related to user identity.
 *  - Login (token acquisition)
 *  - Registration
 *  - Phone number existence check
 */
class AuthService {

    /**
     * Authenticate a WhatsApp user against the backend.
     * Stores the token in HttpClient on success.
     *
     * @param {string} whatsappId - Normalized WhatsApp ID (phone number or JID prefix)
     * @returns {Promise<Object|null>} User object or null if not found
     */
    async authenticate(whatsappId) {
        // Auto-authenticate only if token is missing
        if (!httpClient.hasToken(whatsappId)) {
            await this._doLogin(whatsappId);
        }
        return this._doLogin(whatsappId);
    }

    /**
     * @private
     */
    async _doLogin(whatsappId) {
        const result = await httpClient.request('POST', '/afrik/login', { whatsapp: whatsappId });

        if (result.success && result.data?.token) {
            httpClient.setToken(whatsappId, result.data.token);
            console.log(`[AuthService] Authenticated: ${result.data.user?.nom} ${result.data.user?.prenom}`);
            return result.data.user;
        }

        if (result.status === 404) {
            console.log(`[AuthService] User not found: ${whatsappId}`);
            return null;
        }

        const msg = result.error?.message || result.error?.error || 'Unknown error';
        throw new Error(`Authentication failed: ${msg}`);
    }

    /**
     * Register a new user and store their token.
     *
     * @param {Object} userData - { nom, prenom, telephone, whatsapp, ... }
     * @returns {Promise<Object>} Registered user object
     */
    async registerUser(userData) {
        const result = await httpClient.request('POST', '/afrik/register', userData);

        if (result.success && result.data.token) {
            httpClient.setToken(userData.whatsapp, result.data.token);
            console.log(`[AuthService] Registered: ${result.data.user.nom} ${result.data.user.prenom}`);
            return result.data.user;
        }

        throw new Error(`Registration failed: ${JSON.stringify(result.error)}`);
    }

    /**
     * Check whether a phone number is already registered.
     *
     * @param {string} telephone
     * @returns {Promise<boolean>}
     */
    async checkPhoneExists(telephone) {
        const result = await httpClient.request('POST', '/afrik/check-phone', { telephone });
        return result.success ? result.data.exists : false;
    }

    /**
     * Clear the stored token for a user (logout).
     * @param {string} whatsappId
     */
    logout(whatsappId) {
        httpClient.clearToken(whatsappId);
    }
}

export default new AuthService();
