import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import stateService from '../services/StateService.js';
import authService from '../services/AuthService.js';
import paymentService from '../services/PaymentService.js';
import merchantService from '../services/MerchantService.js';
import projectService from '../services/ProjectService.js';
import userService from '../services/UserService.js';
import companyService from '../services/CompanyService.js';

const _assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets');

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
    get companies() { return companyService; }

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
    // Minimum gap between consecutive messages to the same JID (anti-ban)
    _lastSentAt = new Map();

    async sendMessage(sock, jid, text, options = {}) {
        await this._humanDelay(jid);
        return sock.sendMessage(jid, { text, ...options });
    }

    /**
     * Send a message with native WhatsApp buttons (nativeFlow).
     * @param {Object} sock - Baileys socket
     * @param {string} jid - Recipient JID
     * @param {string} text - Message body
     * @param {string} footer - Footer text (shown below buttons)
     * @param {Array<{label: string, id?: string, url?: string}>} buttons - Button definitions
     * @param {Object} options - Extra options (quoted, mentions, etc.)
     */
    async sendNativeFlowMessage(sock, jid, text, footer, buttons, options = {}) {
        await this._humanDelay(jid);
        const nativeFlow = buttons.map(b => {
            if (b.url) return { text: b.label, url: b.url };
            return { text: b.label, id: b.id };
        });
        return sock.sendMessage(jid, { text, footer: footer ?? '', nativeFlow, ...options });
    }

    /**
     * Send a WhatsApp interactive list message (opens a picker overlay when tapped).
     * Only works in private chats — use sendNativeFlowMessage for groups.
     */
    async sendListMessage(sock, jid, text, footer, buttonText, rows) {
        await this._humanDelay(jid);
        return sock.sendMessage(jid, {
            text,
            footer: footer ?? '',
            buttonText,
            sections: [{
                rows: rows.map(r => ({
                    title: r.label,
                    rowId: r.id,
                    description: r.description || ''
                }))
            }]
        });
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
     * @param {string} sessionId - Normalized session ID
     * @param {Object|null} quoted - Optional quoted message for context
     */
    async _sendPaymentSummary(sock, fullId, data, sessionId, quoted = null) {
        const operatorLabel = data.source === 'MTN' ? 'MTN MoMo'
            : (data.source === 'Moov' ? 'Moov Money' : 'Celtiis Cash');

        const detailLines = [
            data.is_p2p
                ? `Transfert → ${data.p2p_recipient_phone}`
                : `Marchand : ${data.merchant_name} (${data.merchant_code})`,
            `Motif : ${data.object}`,
            `Net : ${data.net} FCFA  |  Frais : ${data.fees} FCFA`,
            `Total : ${data.total} FCFA  |  Via : ${operatorLabel}`,
        ].join('\n');

        const thumbnail = this._loadThumbnail();

        let confirmMsg;

        if (thumbnail) {
            // Order card (visual) + boutons de confirmation
            await sock.sendMessage(fullId, { orderText: detailLines, thumbnail }, { quoted });

            confirmMsg = await this.sendNativeFlowMessage(
                sock, fullId,
                `*Récapitulatif — ${data.merchant_name}*\n${detailLines}`,
                'Confirmez-vous ce paiement ?',
                [
                    { label: '✅ Confirmer le paiement', id: '1' },
                    { label: '❌ Annuler', id: '0' },
                ]
            );
        } else {
            // Fallback : nativeFlow seul avec tous les détails
            const summary = [
                '*Récapitulatif du paiement*',
                '',
                data.is_p2p
                    ? `Type : *Transfert d'argent*\nNuméro : *${data.p2p_recipient_phone}*`
                    : `Destinataire : *${data.merchant_name}*\nCode : *${data.merchant_code}*`,
                `Motif : *${data.object}*`,
                '───────────────',
                `Montant Net : *${data.net} FCFA*`,
                `Frais : *${data.fees} FCFA*`,
                `*Total : ${data.total} FCFA*`,
                '───────────────',
                `Via : *${operatorLabel}*`,
            ].join('\n');

            confirmMsg = await this.sendNativeFlowMessage(
                sock, fullId,
                summary,
                'Confirmez-vous ce paiement ?',
                [
                    { label: '✅ Confirmer le paiement', id: '1' },
                    { label: '❌ Annuler', id: '0' },
                ],
                { quoted }
            );
        }

        if (confirmMsg?.key) {
            this.state.addData(sessionId, 'last_summary_id', confirmMsg.key.id);
        }

        return confirmMsg;
    }

    _loadThumbnail(filename = 'logo.jpg') {
        try {
            const p = path.join(_assetsDir, filename);
            if (fs.existsSync(p)) return fs.readFileSync(p);
        } catch { }
        return null;
    }

    /**
     * Normalize a phone number to the canonical Benin format: 229XXXXXXXX (11 digits).
     *
     * The platform stores some numbers with extra digits (e.g. 2290166250296 → 22966250296).
     * The local number (last 8 digits) is always correct — only the prefix is corrupted.
     */
    /**
     * Add a small random gap between consecutive messages to the same JID.
     * If the bot just sent to this JID within the last 1.5s, wait a bit.
     * This prevents back-to-back message bursts that look bot-like.
     */
    async _humanDelay(jid) {
        const now = Date.now();
        const last = this._lastSentAt.get(jid) || 0;
        const gap = now - last;
        const MIN_GAP = 400 + Math.random() * 400; // 400–800ms between messages
        if (gap < MIN_GAP) {
            await new Promise(r => setTimeout(r, MIN_GAP - gap));
        }
        this._lastSentAt.set(jid, Date.now());
        // Prevent Map growth: drop entries older than 30s
        if (this._lastSentAt.size > 500) {
            const cutoff = Date.now() - 30_000;
            for (const [k, v] of this._lastSentAt) {
                if (v < cutoff) this._lastSentAt.delete(k);
            }
        }
    }

    _normalizePhone(phone) {
        if (!phone) return phone;
        const digits = String(phone).replace(/\D/g, '');
        if (/^229\d{8}$/.test(digits))  return digits;   // 229 + 8 chiffres (ancien format)
        if (/^229\d{10}$/.test(digits)) return digits;   // 229 + 10 chiffres (nouveau format BJ)
        if (digits.length === 8)  return '229' + digits; // local 8 chiffres
        if (digits.length === 10) return '229' + digits; // local 10 chiffres
        if (digits.length === 9 && digits.startsWith('0'))
            return '229' + digits.slice(1);               // 0XXXXXXXXX → drop leading 0
        return digits;
    }

    /**
     * Whether text normalizes to a plausible Benin phone number (229 + 8-10 digits).
     * Used to validate every phone-shaped field collected in chat (telephone,
     * whatsapp, mtn/moov/celtiis payment numbers) with one consistent rule.
     */
    _isValidBeninPhone(text) {
        const normalized = this._normalizePhone(text);
        return /^229\d{8,10}$/.test(normalized || '');
    }

    /** A person's first/last name: letters (incl. accents), spaces, hyphens, apostrophes only. */
    _isValidPersonName(text) {
        return /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ' -]{1,49}$/.test(String(text || '').trim());
    }

    /** A company name: looser than a person's name (digits/&/./- allowed) but must contain a letter. */
    _isValidCompanyName(text) {
        const trimmed = String(text || '').trim();
        return /^(?=.*[A-Za-zÀ-ÖØ-öø-ÿ])[\w À-ÖØ-öø-ÿ'&.-]{2,100}$/.test(trimmed);
    }

    /**
     * A Benin IFU (tax ID): no officially documented format exists anywhere in this
     * codebase (checked: no regex/length precedent in any backend Request class or
     * frontend form) — 12-14 digits is a conservative constraint derived from the
     * one seeded example (13 digits), not an authoritative spec.
     */
    _isValidIfu(text) {
        const digits = String(text || '').replace(/\D/g, '');
        return /^\d{12,14}$/.test(digits);
    }
}

export default BaseHandler;
