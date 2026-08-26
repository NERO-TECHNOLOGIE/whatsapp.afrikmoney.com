import BaseHandler from '../core/BaseHandler.js';

/**
 * GroupHandler - Manages all group-specific interaction logic.
 *
 * Responsible for:
 *  - Parsing shorthand payment commands (#amount#code or *pay*...)
 *  - Initiating P2P transfers from group tags/mentions
 *  - Handling unregistered external P2P recipients
 */
class GroupHandler extends BaseHandler {

    /**
     * Handle a mention of the bot in a group chat when no active flow exists.
     * Parses shorthands, tagged P2P transfers, or ignores unknown messages.
     *
     * @param {Object} sock
     * @param {string} fullId - Group JID
     * @param {string} sessionId - Normalized session ID (isolation)
     * @param {string} text - Cleaned text (mentions stripped)
     * @param {Object} contextInfo - WhatsApp context info
     * @param {Array} mentions - All mentioned JIDs
     * @param {string} botPN - Bot phone number (normalized)
     * @param {string|null} botLID - Bot LID (normalized)
     * @param {string} senderJid - Full sender JID
     * @param {Function} onPaymentFlowStarted - Callback to PaymentHandler.handleMerchantPayment for shorthand confirmation
     */
    async handleGroupMention(sock, fullId, sessionId, text, contextInfo, mentions, botPN, botLID, senderJid, onPaymentFlowStarted) {
        // 1. Shorthand commands: #amount#code[#operator] or *pay*code*amount*op#
        const handled = await this._tryShorthandPayment(sock, fullId, sessionId, text, senderJid, onPaymentFlowStarted);
        if (handled) return;

        // 2. Tag + Amount → P2P transfer
        const quotedParticipant = contextInfo?.participant;
        const otherMentions = mentions.filter(m => {
            const norm = this.normalizeId(m);
            const isBot = (botPN && norm === botPN) || (botLID && norm === botLID);
            return !isBot;
        });
        const targetJid = quotedParticipant || (otherMentions.length > 0 ? otherMentions[0] : null);
        const amountMatch = text.match(/(\d+)/);
        const amount = amountMatch ? parseInt(amountMatch[1]) : null;

        if (amount && !isNaN(amount) && amount > 0) {
            if (targetJid) {
                return this.processGroupP2P(sock, fullId, sessionId, amount, targetJid, senderJid);
            }
            return this.sendMessage(sock, fullId, "Pour envoyer de l'argent, répondez au message de votre ami avec le montant, ou mentionnez-le (ex: @bot 500).");
        }

        // No shorthand, no amount — show help
        return this.sendMessage(sock, fullId,
            '*AfrikMoney Bot* 🤖\n\n' +
            'Dans ce groupe, vous pouvez :\n' +
            '• Envoyer de l\'argent : mentionnez @bot + montant (ex: _@bot 500_)\n' +
            '• Payer un marchand : `#montant#code` (ex: _#500#SHOP01_)\n' +
            '• Pour toutes les autres options, écrivez-moi en privé.'
        );
    }

    /**
     * Process a P2P (person-to-person) transfer initiated in a group.
     * Checks if the recipient is registered on the platform.
     */
    async processGroupP2P(sock, fullId, sessionId, amount, targetJid, senderJid) {
        const isLid = targetJid.endsWith('@lid');
        let resolvedPhone = targetJid.split('@')[0].split(':')[0];

        // LID is kept as-is: the backend's findUserByWhatsapp and submitP2P both accept LIDs
        const targetIdShort = resolvedPhone;

        try {
            const recipient = await this.merchants.findUserByWhatsapp(targetIdShort);

            if (recipient.success && recipient.data.user) {
                this._setupRegisteredP2P(sessionId, amount, targetJid, targetIdShort, recipient.data.user, senderJid);
                const fees = this._calculateFees(amount, 0);
                const msgText = [
                    '🎁 *Transfert d\'argent*',
                    '',
                    `Destinataire: *${recipient.data.user.prenom}* (@${targetIdShort})`,
                    `Montant Net: *${fees.net} FCFA*`,
                    `Frais: *${fees.fees} FCFA*`,
                    `*Total à Payer: ${fees.total} FCFA*`,
                ].join('\n');
                return this.sendNativeFlowMessage(
                    sock, fullId,
                    msgText,
                    'Choisissez l\'opérateur de paiement :',
                    [
                        { label: '🟡 MTN MOBILE MONEY', id: '1' },
                        { label: '🔵 FLOOZ (Moov)', id: '2' },
                        { label: '🟢 CELTIIS CASH', id: '3' },
                        { label: '❌ Annuler', id: '0' },
                    ],
                    { mentions: [targetJid, senderJid] }
                );

            } else {
                // Recipient is not registered — will ask for phone number after operator choice
                this._setupExternalP2P(sessionId, amount, targetJid, targetIdShort, senderJid);
                const fees = this._calculateFees(amount, 0);
                const msgText = [
                    '🎁 *Transfert d\'argent*',
                    '',
                    `Destinataire: @${targetIdShort} (*Non inscrit*)`,
                    `Montant Net: *${fees.net} FCFA*`,
                    `Frais: *${fees.fees} FCFA*`,
                    `*Total à Payer: ${fees.total} FCFA*`,
                ].join('\n');
                return this.sendNativeFlowMessage(
                    sock, fullId,
                    msgText,
                    'Choisissez l\'opérateur de paiement :',
                    [
                        { label: '🟡 MTN MOBILE MONEY', id: '1' },
                        { label: '🔵 FLOOZ (Moov)', id: '2' },
                        { label: '🟢 CELTIIS CASH', id: '3' },
                        { label: '❌ Annuler', id: '0' },
                    ],
                    { mentions: [targetJid, senderJid] }
                );
            }
        } catch (e) {
            console.error('[GroupHandler] P2P Error:', e);
            return this.sendMessage(sock, fullId, 'Erreur lors de la recherche du destinataire.');
        }
    }

    // ===== PRIVATE =====

    /**
     * Attempt to parse and handle a shorthand payment command.
     * Returns true if a shorthand was matched, false otherwise.
     */
    async _tryShorthandPayment(sock, fullId, sessionId, text, senderJid, onPaymentFlowStarted) {
        const shorthandMatch = text.match(/^#(\d+)#([a-zA-Z0-9]+)(?:#([a-zA-Z0-9]+))?$/);
        const newShorthandMatch = text.match(/^\*pay\*([a-zA-Z0-9]+)\*(\d+)\*([a-zA-Z0-9]+)#$/);

        if (!shorthandMatch && !newShorthandMatch) return false;

        let amount, target, rawOp;
        if (shorthandMatch) {
            amount = parseInt(shorthandMatch[1]);
            target = shorthandMatch[2];
            rawOp = shorthandMatch[3];
        } else {
            target = newShorthandMatch[1];
            amount = parseInt(newShorthandMatch[2]);
            rawOp = newShorthandMatch[3];
        }

        if (isNaN(amount) || amount <= 0) return false;

        const op = this._mapOperator(rawOp);

        // Try as merchant first
        try {
            const merchantInfo = await this.merchants.checkMerchant(target);
            this.state.setState(sessionId, 'merchant_payment', op ? 'confirmation' : 'source');
            this.state.addData(sessionId, 'merchant_code', target);
            this.state.addData(sessionId, 'merchant_id', merchantInfo.id);
            this.state.addData(sessionId, 'merchant_name', merchantInfo.company_name);
            this.state.addData(sessionId, 'merchant_phone', merchantInfo.merchant_phone);
            this.state.addData(sessionId, 'service_fee', merchantInfo.service_fee || 0);
            this.state.addData(sessionId, 'amount', amount);
            this.state.addData(sessionId, 'object', 'Paiement Rapide');

            const fees = this._calculateFees(amount, merchantInfo.service_fee || 0);

            if (op) {
                this.state.addData(sessionId, 'source', op);
                // Fetch payer_phone for the chosen operator (skipped _handleSourceStep)
                const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;
                const payer = await this.auth.authenticate(userId);
                if (payer) {
                    const payerPhone = op === 'MTN' ? payer.num_mtn : (op === 'Moov' ? payer.num_moov : payer.num_celtiis);
                    if (payerPhone) this.state.addData(sessionId, 'user_phone', payerPhone);
                }
                if (onPaymentFlowStarted) await onPaymentFlowStarted(sock, fullId, 'confirmation', '1', {}, sessionId);
                return true;
            }

            const msgText = [
                '✅ *Paiement Marchand*',
                '',
                `Destinataire: *${merchantInfo.company_name}*`,
                `Montant Net: *${fees.net} FCFA*`,
                `Frais: *${fees.fees} FCFA*`,
                `*Total à Payer: ${fees.total} FCFA*`,
            ].join('\n');
            await this.sendNativeFlowMessage(
                sock, fullId,
                msgText,
                'Choisissez votre opérateur :',
                [
                    { label: '🟡 MTN MOBILE MONEY', id: '1' },
                    { label: '🔵 FLOOZ (Moov)', id: '2' },
                    { label: '🟢 CELTIIS CASH', id: '3' },
                    { label: '❌ Annuler', id: '0' },
                ],
                { mentions: [senderJid] }
            );
            return true;

        } catch {
            // Not a merchant — try as a registered user (P2P via phone)
            const recipient = await this.merchants.findUserByWhatsapp(target);
            if (recipient.success && recipient.data.user) {
                this._setupRegisteredP2P(sessionId, amount, target + '@s.whatsapp.net', target, recipient.data.user);
                const fees = this._calculateFees(amount, 0);

                if (op) {
                    this.state.addData(sessionId, 'source', op);
                    const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;
                    const payer = await this.auth.authenticate(userId);
                    if (payer) {
                        const payerPhone = op === 'MTN' ? payer.num_mtn : (op === 'Moov' ? payer.num_moov : payer.num_celtiis);
                        if (payerPhone) this.state.addData(sessionId, 'user_phone', payerPhone);
                    }
                    if (onPaymentFlowStarted) await onPaymentFlowStarted(sock, fullId, 'confirmation', '1', {}, sessionId);
                    return true;
                }

                const msgText = [
                    '🎁 *Transfert d\'argent*',
                    '',
                    `Destinataire: *${recipient.data.user.prenom}* (${target})`,
                    `Montant Net: *${fees.net} FCFA*`,
                    `Frais: *${fees.fees} FCFA*`,
                    `*Total à Payer: ${fees.total} FCFA*`,
                ].join('\n');
                await this.sendNativeFlowMessage(
                    sock, fullId,
                    msgText,
                    'Choisissez votre opérateur :',
                    [
                        { label: '🟡 MTN MOBILE MONEY', id: '1' },
                        { label: '🔵 FLOOZ (Moov)', id: '2' },
                        { label: '🟢 CELTIIS CASH', id: '3' },
                        { label: '❌ Annuler', id: '0' },
                    ],
                    { mentions: [senderJid] }
                );
                return true;
            } else {
                await this.sendMessage(sock, fullId, `❌ Code marchand ou utilisateur *${target}* introuvable.`);
                return true; // Handled (with error response)
            }
        }
    }

    _setupRegisteredP2P(sessionId, amount, targetJid, targetIdShort, user, senderJid) {
        this.state.setState(sessionId, 'merchant_payment', 'source');
        this.state.addData(sessionId, 'amount', amount);
        this.state.addData(sessionId, 'object', `Transfert vers @${targetIdShort}`);
        this.state.addData(sessionId, 'is_p2p', true);
        this.state.addData(sessionId, 'p2p_recipient_phone', targetIdShort);
        this.state.addData(sessionId, 'p2p_recipient_jid', targetJid);
        this.state.addData(sessionId, 'sender_jid', senderJid);
        this.state.addData(sessionId, 'merchant_code', 'P2P');
        this.state.addData(sessionId, 'merchant_name', user.prenom);
    }

    _setupExternalP2P(sessionId, amount, targetJid, targetIdShort, senderJid) {
        this.state.setState(sessionId, 'merchant_payment', 'source');
        this.state.addData(sessionId, 'amount', amount);
        this.state.addData(sessionId, 'object', `Transfert vers @${targetIdShort}`);
        this.state.addData(sessionId, 'is_p2p', true);
        this.state.addData(sessionId, 'p2p_recipient_jid', targetJid);
        this.state.addData(sessionId, 'sender_jid', senderJid);
        this.state.addData(sessionId, 'merchant_code', 'P2P');
        this.state.addData(sessionId, 'merchant_name', 'Destinataire Externe');
    }
}

export default new GroupHandler();
