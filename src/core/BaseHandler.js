import stateService from '../services/StateService.js';
import authService from '../services/AuthService.js';
import paymentService from '../services/PaymentService.js';
import merchantService from '../services/MerchantService.js';
import projectService from '../services/ProjectService.js';
import userService from '../services/UserService.js';

/**
 * BaseHandler - Abstract base class for all bot flow handlers.
 *
 * Provides shared utility methods following the Dependency Inversion Principle:
 * all handlers interact with injected service dependencies rather than
 * importing them directly.
 *
 * Principles Applied:
 *  - SRP: Only contains generic, reusable cross-cutting utilities
 *  - LSP: All subclasses can safely use and extend these methods
 *  - DIP: Services are injected/accessible via shared singletons
 */
class BaseHandler {
    // =====================
    // Shared services (Dependency Inversion)
    // =====================
    get state() { return stateService; }
    get auth() { return authService; }
    get payments() { return paymentService; }
    get merchants() { return merchantService; }
    get projects() { return projectService; }
    get users() { return userService; }

    // =====================
    // Messaging
    // =====================

    /**
     * Send a WhatsApp text message.
     * @param {Object} sock - Baileys socket
     * @param {string} jid - Recipient JID
     * @param {string} text - Message text
     * @param {Object} options - Extra options (mentions, quoted, etc.)
     */
    async sendMessage(sock, jid, text, options = {}) {
        return sock.sendMessage(jid, { text, ...options });
    }

    /**
     * Send a vCard contact for the Afrikmoney business account.
     */
    async sendContact(sock, jid) {
        const vcard = [
            'BEGIN:VCARD',
            'VERSION:3.0',
            'FN:Afrikmoney',
            'ORG:Afrikmoney;',
            'TEL;type=CELL;type=VOICE;waid=22951248454:+229 51 24 84 54',
            'END:VCARD'
        ].join('\n');

        return sock.sendMessage(jid, {
            contacts: {
                displayName: 'Afrikmoney',
                contacts: [{ vcard }]
            }
        });
    }

    // =====================
    // ID Utilities
    // =====================

    /**
     * Normalize a WhatsApp JID to a plain phone number string.
     * @param {string} id - Full JID like "22997000000@s.whatsapp.net" or "22997000000:0@..."
     * @returns {string}
     */
    normalizeId(id) {
        if (!id || typeof id !== 'string') return '';
        return id.split('@')[0].split(':')[0];
    }

    // =====================
    // Fee Calculation
    // =====================

    /**
     * Calculate fees and total for a payment.
     * @param {number} amount - Net amount
     * @param {number} serviceFee - Additional fee % from merchant (default 0)
     * @returns {{ net: number, fees: number, total: number }}
     */
    _calculateFees(amount, serviceFee = 0) {
        const feePercent = (parseFloat(serviceFee) || 0) + 2; // Always add 2% platform fee
        const fees = Math.round(amount * feePercent / 100);
        return {
            net: Number(amount),
            fees: Number(fees),
            total: Number(amount) + Number(fees)
        };
    }

    // =====================
    // Operator Mapping
    // =====================

    /**
     * Map a raw operator text input to a canonical operator string.
     * @param {string} input - User input like "1", "mtn", "flooz"
     * @returns {'MTN'|'Moov'|'Celtiis'|null}
     */
    _mapOperator(input) {
        if (!input) return null;
        const low = input.toLowerCase().trim();
        if (['mtn', 'm', '1'].includes(low)) return 'MTN';
        if (['moov', 'mo', 'f', 'flooz', '2'].includes(low)) return 'Moov';
        if (['celtiis', 'c', '3'].includes(low)) return 'Celtiis';
        return null;
    }

    // =====================
    // Payment Summary
    // =====================

    /**
     * Send the payment confirmation summary message and store its ID for reply tracking.
     * Includes a group-specific instruction to "Reply to this message".
     * @param {Object} sock
     * @param {string} fullId
     * @param {Object} data - Payment data (amount, fee, operator, etc.)
     * @param {Object|null} quoted - Optional quoted message for context
     */
    async _sendPaymentSummary(sock, fullId, data, quoted = null) {
        const from = this.normalizeId(fullId);
        const operatorLabel = data.source === 'MTN' ? 'MTN MoMo'
            : (data.source === 'Moov' ? 'Moov Money' : 'Celtiis Cash');

        let summary = `*Récapitulatif du paiement*\n\n`;
        summary += `Destinataire : *${data.merchant_name}*\n`;

        if (data.is_p2p) {
            summary += `Type : *Transfert d'argent*\n`;
            summary += `Numéro : *${data.p2p_recipient_phone}*\n`;
        } else {
            summary += `Code marchand : *${data.merchant_code}*\n`;
        }

        summary += `Motif : *${data.object}*\n`;
        summary += `--------------------------\n`;
        summary += `Montant Net : *${data.net} FCFA*\n`;
        summary += `Frais (2%) : *${data.fees} FCFA*\n`;
        summary += `*Total à Payer : ${data.total} FCFA*\n`;
        summary += `--------------------------\n`;
        summary += `Paiement via : *${operatorLabel}*\n\n`;

        if (fullId.endsWith('@g.us')) {
            summary += `\n⚠️ *NOTE* : Répondez à ce message en glissant ce message à droite puis choisissez le numéro 1 pour valider.`;
        }

        summary += `\n\nTapez :\n`;
        summary += `- *1* pour confirmer le paiement\n`;
        summary += `- *0* pour revenir au menu principal`;

        const sent = await this.sendMessage(sock, fullId, summary, { quoted });

        // Store the message ID so group replies can be validated later
        if (sent?.key) {
            this.state.addData(from, 'last_summary_id', sent.key.id);
        }

        return sent;
    }
}

export default BaseHandler;
