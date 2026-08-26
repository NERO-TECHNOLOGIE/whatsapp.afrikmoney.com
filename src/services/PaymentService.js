import httpClient from './http/HttpClient.js';

/**
 * PaymentService - Manages all payment-related API operations.
 *
 * Single Responsibility: Merchant payments, P2P transfers, and status polling.
 * Does NOT handle authentication — that belongs to AuthService.
 */
class PaymentService {

    /**
     * Submit a merchant payment.
     *
     * @param {Object} data - { merchant_code, amount, object, source, payer_phone, payment_plan_id? }
     * @param {string} whatsappId - Caller's WhatsApp ID (for auth token)
     * @returns {Promise<{success: boolean, data?: any, error?: any}>}
     */
    async submitMerchantPayment(data, whatsappId) {
        return httpClient.request('POST', '/afrik/payments/merchant', data, whatsappId);
    }

    /**
     * Submit a P2P (person-to-person) transfer.
     *
     * @param {Object} data - { amount, recipient_phone, source, payer_phone, object }
     * @param {string} whatsappId - Caller's WhatsApp ID (for auth token)
     * @returns {Promise<{success: boolean, data?: any, error?: any}>}
     */
    async submitP2P(data, whatsappId) {
        return httpClient.request('POST', '/afrik/payments/p2p', data, whatsappId);
    }

    /**
     * Poll the status of a payment by its reference.
     *
     * @param {string} reference - Payment reference from submission response
     * @returns {Promise<{success: boolean, data?: any}>}
     */
    async checkPaymentStatus(reference) {
        return httpClient.request('GET', `/status/${reference}`);
    }

    /**
     * Generate a personalized KYC link for the authenticated user.
     *
     * @param {string} whatsappId - Caller's WhatsApp ID (for auth token)
     * @returns {Promise<{success: boolean, url?: string, kyc_level?: number}>}
     */
    async getKycLink(whatsappId) {
        return httpClient.request('GET', '/bot/kyc-link', null, whatsappId);
    }

    /**
     * Generate a personalized magic link that logs the user straight into
     * their web dashboard (same mechanism as the KYC link).
     *
     * @param {string} whatsappId - Caller's WhatsApp ID (for auth token)
     * @returns {Promise<{success: boolean, url?: string}>}
     */
    async getDashboardLink(whatsappId) {
        return httpClient.request('GET', '/bot/dashboard-link', null, whatsappId);
    }

    /**
     * Submit a test payout to a merchant.
     *
     * @param {Object} payoutData - { amount, phone_number, company_id, note }
     * @param {string} whatsappId - Caller's WhatsApp ID (for auth token)
     * @returns {Promise<Object>} Payout result data
     */
    async submitTestPayout(payoutData, whatsappId) {
        const result = await httpClient.request('POST', '/v1/payout/test', payoutData, whatsappId);
        if (result.success) return result.data;
        throw new Error(`Payout failed: ${result.error?.message}`);
    }
}

export default new PaymentService();
