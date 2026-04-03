import BaseHandler from '../core/BaseHandler.js';

/**
 * PaymentHandler - Manages the merchant payment flow.
 *
 * Responsible for:
 *  - Starting a payment flow (asking for merchant code)
 *  - Guiding through code → object → amount → operator → confirmation steps
 *  - Initiating payment via API
 *  - Polling for payment status
 *  - Handling payment success (including project update) and failure
 */
class PaymentHandler extends BaseHandler {

    /**
     * Begin the merchant payment flow.
     */
    async startMerchantPaymentFlow(sock, fullId, sessionId) {
        this.state.setState(sessionId, 'merchant_payment', 'code');
        const text = [
            "*Paiement d'un marchand*",
            '',
            'Veuillez entrer le *code marchand* fourni par le commerçant.',
            '',
            'Vous trouverez ce code :',
            "- Sur l'affiche *AfrikMoney* collée dans les locaux du marchand ;",
            '- Ou directement auprès du marchand ;',
            '',
            'Tapez :',
            '- Le *code* du marchand',
            '- *0* pour revenir au menu principal'
        ].join('\n');
        return this.sendMessage(sock, fullId, text);
    }

    /**
     * Handle each step of the merchant payment flow.
     * @param {string} step - code|object|amount|source|recipient_phone|confirmation
     * @param {string} text - User input
     * @param {Object} msg - Raw WhatsApp message (needed for reply checking)
     * @param {string} sessionId - Normalized session ID
     */
    async handleMerchantPayment(sock, fullId, step, text, msg, sessionId) {
        switch (step) {

            case 'code':
                return this._handleCodeStep(sock, fullId, text, sessionId);

            case 'object':
                this.state.addData(sessionId, 'object', text);
                this.state.setState(sessionId, 'merchant_payment', 'amount');
                return this.sendMessage(sock, fullId, '*Montant du paiement*\n\nTapez :\n- Le *montant* à payer en FCFA\n- *0* pour revenir au menu principal\n\n⚠️ *Important* : N\'ajoutez pas d\'espace ni de symbole.');

            case 'amount':
                return this._handleAmountStep(sock, fullId, text, sessionId);

            case 'source':
                return this._handleSourceStep(sock, fullId, text, sessionId);

            case 'recipient_phone':
                return this._handleRecipientPhoneStep(sock, fullId, text, sessionId);

            case 'confirmation':
                return this._handleConfirmationStep(sock, fullId, text, msg, sessionId);

            default:
                return this.startMerchantPaymentFlow(sock, fullId, sessionId);
        }
    }

    // ===== PRIVATE STEP HANDLERS =====

    async _handleCodeStep(sock, fullId, text, sessionId) {
        try {
            const merchantInfo = await this.merchants.checkMerchant(text.trim());
            this.state.addData(sessionId, 'merchant_code', text.trim());
            this.state.addData(sessionId, 'merchant_id', merchantInfo.id);
            this.state.addData(sessionId, 'merchant_name', merchantInfo.company_name);
            this.state.addData(sessionId, 'merchant_phone', merchantInfo.merchant_phone);
            this.state.addData(sessionId, 'service_fee', merchantInfo.service_fee || 0);
            this.state.setState(sessionId, 'merchant_payment', 'object');
            return this.sendMessage(sock, fullId, `*Marchand confirmé*\n*${merchantInfo.company_name}*\n\nTapez :\n- Le *motif* du paiement\n- *0* pour revenir au menu principal`);
        } catch {
            return this.sendMessage(sock, fullId, 'Code marchand invalide. Veuillez réessayer :');
        }
    }

    async _handleAmountStep(sock, fullId, text, sessionId) {
        const amount = parseInt(text.replace(/\D/g, ''));
        if (isNaN(amount) || amount < 1) {
            return this.sendMessage(sock, fullId, 'Montant invalide. Veuillez entrer un montant minimum de 1 FCFA.');
        }
        this.state.addData(sessionId, 'amount', amount);
        this.state.setState(sessionId, 'merchant_payment', 'source');
        const sourceText = '*Choix du moyen de paiement*\n\nSélectionnez votre opérateur Mobile Money :\n1. *MTN MOBILE MONEY*\n2. *FLOOZ*\n3. *CELTIIS CASH*\n\nTapez :\n- Le *numéro* correspondant à votre opérateur\n- *4* pour modifier le montant\n- *0* pour revenir au menu principal';
        return this.sendMessage(sock, fullId, sourceText);
    }

    async _handleSourceStep(sock, fullId, text, sessionId) {
        // Allow going back to change amount
        if (text === '4') {
            this.state.setState(sessionId, 'merchant_payment', 'amount');
            return this.sendMessage(sock, fullId, "*Montant du paiement*\n\nTapez :\n- Le *montant* à payer en FCFA\n- *0* pour revenir au menu principal\n\n⚠️ *Important* : N'ajoutez pas d'espace ni de symbole.");
        }

        const source = this._mapOperator(text);
        if (!source) {
            return this.sendMessage(sock, fullId, 'Choix invalide.');
        }

        this.state.addData(sessionId, 'source', source);

        // Authenticate payer and get their payment number for the chosen operator
        const userId = sessionId.includes(':') ? sessionId.split(':')[1] : sessionId;
        const payer = await this.auth.authenticate(userId);
        if (!payer) {
            return this.sendMessage(sock, fullId, "❌ Vous n'êtes pas encore inscrit. Veuillez m'envoyer un message privé pour créer votre compte.");
        }

        const payerPhone = source === 'MTN' ? payer.num_mtn : (source === 'Moov' ? payer.num_moov : payer.num_celtiis);
        if (!payerPhone) {
            return this.sendMessage(sock, fullId, `Attention : Vous n'avez pas de numéro de paiement enregistré pour *${source}*. Veuillez l'ajouter dans votre profil via l'application ou demander de l'aide.`);
        }
        this.state.addData(sessionId, 'user_phone', payerPhone);

        const currentData = this.state.getData(sessionId);

        // For external P2P: ask for recipient's phone AFTER operator choice
        if (currentData.is_p2p && currentData.merchant_name === 'Destinataire Externe') {
            this.state.setState(sessionId, 'merchant_payment', 'recipient_phone');
            const opLabel = source === 'MTN' ? 'MTN' : (source === 'Moov' ? 'FLOOZ' : 'CELTIIS CASH');
            return this.sendMessage(sock, fullId, `Veuillez entrer le numéro *${opLabel}* du destinataire (ex: 229XXXXXXXX) :`);
        }

        this.state.setState(sessionId, 'merchant_payment', 'confirmation');
        const data = this.state.getData(sessionId);
        const fees = this._calculateFees(data.amount, data.service_fee || 0);
        return this._sendPaymentSummary(sock, fullId, { ...data, source, ...fees }, sessionId);
    }

    async _handleRecipientPhoneStep(sock, fullId, text, sessionId) {
        const p2pPhone = text.replace(/[^0-9]/g, '');
        if (p2pPhone.length < 8) {
            return this.sendMessage(sock, fullId, 'Numéro invalide. Veuillez entrer un numéro valide (ex: 229XXXXXXXX) :');
        }
        this.state.addData(sessionId, 'p2p_recipient_phone', p2pPhone);
        this.state.addData(sessionId, 'merchant_phone', p2pPhone);
        this.state.setState(sessionId, 'merchant_payment', 'confirmation');
        const data = this.state.getData(sessionId);
        const fees = this._calculateFees(data.amount, 0);
        return this._sendPaymentSummary(sock, fullId, { ...data, ...fees }, sessionId);
    }

    async _handleConfirmationStep(sock, fullId, text, msg, sessionId) {
        // In groups, validate that the user is replying to the correct summary message
        const quotedMsgId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        const lastSummaryId = this.state.getData(sessionId, 'last_summary_id');
        const isGroup = fullId.endsWith('@g.us');

        if (isGroup && lastSummaryId && (quotedMsgId !== lastSummaryId)) {
            return; // Silently ignore wrong reply in groups
        }

        if (text !== '1') {
            this.state.clearState(sessionId);
            return; // User cancelled — router will show main menu
        }

        const finalData = this.state.getData(sessionId);
        const isP2P = finalData.is_p2p;
        const targetId = isP2P ? finalData.p2p_recipient_phone : finalData.merchant_phone;

        if (!targetId) {
            return this.sendMessage(sock, fullId, `Erreur: Aucun numéro de paiement associé à ce ${isP2P ? 'destinataire' : 'marchand'}.`);
        }

        try {
            await this.sendMessage(sock, fullId, 'Initiation du paiement en cours... Veuillez patienter.');

            // Extract userId for API submissions
            const userId = sessionId.includes(':') ? sessionId.split(':')[1] : sessionId;

            // Submit payment (P2P or Merchant)
            const paymentResult = isP2P
                ? await this.payments.submitP2P({
                    amount: parseInt(finalData.amount),
                    recipient_phone: finalData.p2p_recipient_phone,
                    source: finalData.source || 'MTN',
                    payer_phone: finalData.user_phone || userId,
                    object: finalData.object
                }, userId)
                : await this.payments.submitMerchantPayment({
                    merchant_code: finalData.merchant_code,
                    amount: parseInt(finalData.amount),
                    object: finalData.object,
                    source: finalData.source || 'MTN',
                    payer_phone: finalData.user_phone || userId,
                    ...(finalData.payment_plan_id && { payment_plan_id: finalData.payment_plan_id })
                }, userId);

            const reference = paymentResult.data?.reference || paymentResult.reference;
            if (!paymentResult.success || !reference) {
                const errorMsg = paymentResult.error?.message || "Erreur lors de l'initiation du paiement.";
                return this.sendMessage(sock, fullId, `❌ ${errorMsg}`);
            }

            // Notify user that payment request has been sent to their phone
            const userPhoneToNotify = finalData.user_phone || userId;
            await this.sendMessage(sock, fullId,
                `*Paiement en cours…*\nUne demande de paiement de *${finalData.amount} FCFA* a été envoyée sur votre téléphone au numéro : *${userPhoneToNotify}*\n\n1. Vérifiez sur votre téléphone la notification *Mobile Money*\n2. Entrez votre *code secret* pour valider\n\n*Si la notification ne s'affiche pas* :\nOuvrez votre application Mobile Money puis vérifiez dans *Demandes en attente / Validation*\n\n_En attente de confirmation…_`
            );

            // Poll for status
            this._pollPaymentStatus(sock, fullId, sessionId, reference, finalData, isP2P, targetId);

        } catch (e) {
            console.error('[PaymentHandler] Payment error:', e);
            const errorMessage = e.message || 'Erreur inconnue';
            return this.sendMessage(sock, fullId, `Échec de l'initiation du paiement. ${errorMessage}`);
        }
    }

    /**
     * Poll payment status until SUCCESS, FAILED, or max attempts reached.
     * @private
     */
    _pollPaymentStatus(sock, fullId, sessionId, reference, finalData, isP2P, targetId) {
        let attempts = 0;
        const maxAttempts = 20; // 20 × 3s = 60s

        const checkStatus = async () => {
            if (attempts >= maxAttempts) return; // Stop silently

            try {
                const statusResult = await this.payments.checkPaymentStatus(reference);
                const status = statusResult.data?.status || statusResult.status;

                if (status === 'SUCCESS' || status === 'COMPLETED') {
                    await this._handlePaymentSuccess(sock, fullId, sessionId, finalData, isP2P, targetId);
                } else if (status === 'FAILED') {
                    await this._handlePaymentFailure(sock, fullId, finalData);
                } else {
                    attempts++;
                    setTimeout(checkStatus, 3000);
                }
            } catch {
                attempts++;
                setTimeout(checkStatus, 3000);
            }
        };

        setTimeout(checkStatus, 3000);
    }

    async _handlePaymentSuccess(sock, fullId, sessionId, finalData, isP2P, targetId) {
        const userId = sessionId.includes(':') ? sessionId.split(':')[1] : sessionId;

        if (isP2P) {
            // Group: send a public notification with mentions
            if (fullId.endsWith('@g.us')) {
                const publicMsg = [
                    '🔔 *Notification de Transfert*',
                    '',
                    `✅ *${finalData.amount} FCFA* transférés avec succès !`,
                    `De : @${userId}`,
                    `Vers : @${finalData.p2p_recipient_jid?.split('@')[0]}`,
                    '',
                    '_Frais de plateforme (2%) inclus._'
                ].join('\n');
                await this.sendMessage(sock, fullId, publicMsg, { mentions: [userId + '@s.whatsapp.net', finalData.p2p_recipient_jid] });
            } else {
                const recipientName = finalData.merchant_name || finalData.p2p_recipient_phone;
                await this.sendMessage(sock, fullId, `Transfert réussi ! *${finalData.amount} FCFA* ont été envoyés à ${recipientName}.`);
            }
        } else {
            // Merchant payment: Success notification (payout is handled by backend)
            await this.sendMessage(sock, fullId, `*Paiement valide et transféré à ${finalData.merchant_name} !*`);
        }

        // If paying a project installment, refresh the project view
        if (finalData.payment_plan_id) {
            await this.sendMessage(sock, fullId, 'Mise a jour de votre progression...');
            await new Promise(r => setTimeout(r, 5000));
            try {
                const projectsResult = await this.projects.getProjects(userId);
                const projects = Array.isArray(projectsResult) ? projectsResult : (projectsResult.data || []);
                const updatedProject = projects.find(p => p.id == finalData.payment_plan_id);
                if (updatedProject) {
                    // Return the project to show its details — handled by caller/router
                    return updatedProject;
                }
            } catch (err) {
                console.error('[PaymentHandler] Project refresh error:', err);
            }
        }

        // Groups: don't show the main menu again
        if (fullId.endsWith('@g.us')) {
            this.state.clearState(sessionId);
            return;
        }
        return null; // Signal to router to show main menu
    }

    async _handlePaymentFailure(sock, fullId, finalData) {
        const text = [
            '*Paiement non effectué*',
            `Votre paiement de *${finalData.amount} FCFA* n'a pas pu être finalisé.`,
            '',
            '*Les causes possibles sont* :',
            '- Solde insuffisant',
            '- Code incorrect',
            '- Transaction annulée',
            '',
            'Tapez :',
            '- *1* pour réessayer le paiement',
            '- *2* pour choisir un autre opérateur',
            '- *0* pour revenir au menu principal'
        ].join('\n');
        return this.sendMessage(sock, fullId, text);
    }
}

export default new PaymentHandler();
