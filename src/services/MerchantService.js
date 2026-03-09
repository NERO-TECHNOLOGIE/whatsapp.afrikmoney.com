import httpClient from './http/HttpClient.js';

/**
 * MerchantService - Resolves merchant information from codes or WhatsApp identifiers.
 *
 * Single Responsibility: Anything related to merchant lookups.
 */
class MerchantService {

    /**
     * Validate and fetch merchant details by their code.
     *
     * @param {string} merchantCode
     * @returns {Promise<Object>} Merchant info: id, company_name, merchant_phone, service_fee, services[]
     * @throws {Error} If the code is invalid
     */
    async checkMerchant(merchantCode) {
        const result = await httpClient.request('POST', '/afrik/check-merchant', { merchant_code: merchantCode });
        if (result.success) return result.data.data;
        throw new Error(result.error?.message || 'Code marchand invalide');
    }

    /**
     * Look up a user by their WhatsApp ID (used to check if a P2P recipient is registered).
     *
     * @param {string} whatsappId - Normalized WhatsApp ID
     * @returns {Promise<{success: boolean, data?: {user?: Object}}>}
     */
    async findUserByWhatsapp(whatsappId) {
        return httpClient.request('POST', '/afrik/login', { whatsapp: whatsappId });
    }
}

export default new MerchantService();
