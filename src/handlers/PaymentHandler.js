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
            this.state.addData(sessionId, 'available_operators', merchantInfo.available_operators || []);
            this.state.setState(sessionId, 'merchant_payment', 'object');
            return this.sendMessage(sock, fullId, `*Marchand confirmé*\n*${merchantInfo.company_name}*\n\nTapez :\n- Le *motif* du paiement\n- *0* pour revenir au menu principal`);
        } catch {
            return this.sendMerchantNotFound(sock, fullId);
        }
    }

    async _handleAmountStep(sock, fullId, text, sessionId) {
        const amount = parseInt(text.replace(/\D/g, ''));
        if (isNaN(amount) || amount < 1) {
            return this.sendMessage(sock, fullId, 'Montant invalide. Veuillez entrer un montant minimum de 1 FCFA.');
        }
        this.state.addData(sessionId, 'amount', amount);
        this.state.setState(sessionId, 'merchant_payment', 'source');

        // Only show operators the merchant has configured
        const availOps = this.state.getData(sessionId, 'available_operators') || [];
        const hasMTN     = availOps.length === 0 || availOps.includes('mtn_bj');
        const hasMoov    = availOps.length === 0 || availOps.includes('moov_bj');
        const hasCeltiis = availOps.length === 0 || availOps.includes('celtiis_bj');

        const opButtons = [
            ...(hasMTN     ? [{ label: '🟡 MTN MOBILE MONEY', id: '1' }] : []),
            ...(hasMoov    ? [{ label: '🔵 FLOOZ (Moov)',      id: '2' }] : []),
            ...(hasCeltiis ? [{ label: '🟢 CELTIIS CASH',      id: '3' }] : []),
            { label: '✏️ Modifier le montant', id: '4' },
            { label: '🏠 Menu principal',      id: '0' },
        ];

        return this.sendNativeFlowMessage(
            sock, fullId,
            '*Choix du moyen de paiement*\n\nSélectionnez votre opérateur Mobile Money :',
            `Montant : ${amount} FCFA`,
            opButtons
        );
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
        const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;
        const payer = await this.auth.authenticate(userId);
        if (!payer) {
            return this.sendMessage(sock, fullId, "❌ Vous n'êtes pas encore inscrit. Veuillez m'envoyer un message privé pour créer votre compte.");
        }

        const payerPhone = source === 'MTN' ? payer.num_mtn : (source === 'Moov' ? payer.num_moov : payer.num_celtiis);
        if (!payerPhone) {
            const data = this.state.getData(sessionId);
            const fees = this._calculateFees(data.amount, data.service_fee || 0);
            await this.sendMessage(sock, fullId, `⚠️ Vous n'avez pas de numéro *${source}* enregistré.\n\nAjoutez-le dans votre profil ou choisissez un autre opérateur.`);
            return this.sendNativeFlowMessage(
                sock, fullId,
                `*Choix du moyen de paiement*\n\nMontant : *${data.amount} FCFA* | Total : *${fees.total} FCFA*`,
                'Choisissez un opérateur :',
                [
                    { label: '🟡 MTN MOBILE MONEY', id: '1' },
                    { label: '🔵 FLOOZ (Moov)', id: '2' },
                    { label: '🟢 CELTIIS CASH', id: '3' },
                    { label: '🏠 Menu principal', id: '0' },
                ]
            );
        }
        this.state.addData(sessionId, 'user_phone', payerPhone);

        const currentData = this.state.getData(sessionId);

        // For external P2P: ask for recipient's phone AFTER operator choice
        if (currentData.is_p2p && currentData.merchant_name === 'Destinataire Externe') {
            this.state.setState(sessionId, 'merchant_payment', 'recipient_phone');
            const opLabel = source === 'MTN' ? 'MTN' : (source === 'Moov' ? 'FLOOZ' : 'CELTIIS CASH');
            return this.sendMessage(sock, fullId, `Veuillez entrer le numéro *${opLabel}* du destinataire (ex: 229XXXXXXXX) :`);
        }

        // p2p_recipient_phone is already set to the recipient's WhatsApp ID by GroupHandler.
        // The backend resolves their mobile money number from ClientPaymentNumber using `source`.

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
        const isGroup = fullId.endsWith('@g.us');
        // Button clicks are inherently tied to the correct message — skip quoted validation
        const isButtonClick = !!(msg.message?.interactiveResponseMessage || msg.message?.buttonsResponseMessage || msg.message?.templateButtonReplyMessage);

        if (isGroup && !isButtonClick) {
            // For plain text in groups, validate that the user replies to the summary message
            const quotedMsgId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            const lastSummaryId = this.state.getData(sessionId, 'last_summary_id');
            if (lastSummaryId && quotedMsgId !== lastSummaryId) {
                return; // Silently ignore wrong reply in groups
            }
        }

        if (text === '2') {
            // Go back to operator selection (after payment failure)
            this.state.setState(sessionId, 'merchant_payment', 'source');
            const data = this.state.getData(sessionId);
            return this.sendNativeFlowMessage(
                sock, fullId,
                '*Choix du moyen de paiement*\n\nSélectionnez un autre opérateur Mobile Money :',
                `Montant : ${data.amount} FCFA`,
                [
                    { label: '🟡 MTN MOBILE MONEY', id: '1' },
                    { label: '🔵 FLOOZ (Moov)', id: '2' },
                    { label: '🟢 CELTIIS CASH', id: '3' },
                    { label: '🏠 Menu principal', id: '0' },
                ]
            );
        }

        if (text !== '1') {
            this.state.clearState(sessionId);
            return null; // Router shows main menu
        }

        const finalData = this.state.getData(sessionId);
        const isP2P = finalData.is_p2p;
        const targetId = isP2P ? finalData.p2p_recipient_phone : finalData.merchant_phone;

        // Le P2P a besoin du destinataire résolu pour savoir à qui envoyer l'argent.
        // Le paiement marchand peut passer même sans numéro configuré : la collecte
        // ne dépend pas de ce numéro, seul le payout automatique en aura besoin plus tard.
        if (isP2P && !targetId) {
            return this.sendMessage(sock, fullId, `Erreur: Aucun numéro de paiement associé à ce destinataire.`);
        }

        try {
            await this.sendMessage(sock, fullId, 'Initiation du paiement en cours... Veuillez patienter.');

            // Extract userId for API submissions
            const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;

            const payerPhone = this._normalizePhone(finalData.user_phone || userId);
            // recipient_phone is the WhatsApp ID (phone or LID) — backend resolves mobile money number
            const recipientPhone = finalData.p2p_recipient_phone;

            const paymentResult = isP2P
                ? await this.payments.submitP2P({
                    amount: parseInt(finalData.amount),
                    recipient_phone: recipientPhone,
                    source: finalData.source || 'MTN',
                    payer_phone: payerPhone,
                    object: finalData.object
                }, userId)
                : await this.payments.submitMerchantPayment({
                    merchant_code: finalData.merchant_code,
                    amount: parseInt(finalData.amount),
                    object: finalData.object,
                    source: finalData.source || 'MTN',
                    payer_phone: payerPhone,
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
     * Poll payment status every 5s (max 2 min) via lightweight DB reads.
     * Each request is short-lived (<100ms) — no PHP worker is held captive.
     * The backend throttles MTN API calls to 1 per 10s per reference.
     * @private
     */
    _pollPaymentStatus(sock, fullId, sessionId, reference, finalData, isP2P, targetId) {
        const POLL_INTERVAL_MS = 5_000;
        const MAX_POLLS        = 24; // 24 × 5s = 2 min

        this.state.addData(sessionId, 'current_payment_ref', reference);

        let pollCount = 0;

        const poll = async () => {
            if (this.state.getData(sessionId, 'current_payment_ref') !== reference) return;
            if (!sock.user) return;

            if (pollCount >= MAX_POLLS) {
                await this._handlePaymentTimeout(sock, fullId, sessionId, finalData);
                return;
            }

            pollCount++;
            try {
                const result = await this.payments.checkPaymentStatus(reference);
                // httpClient enveloppe la réponse en {success, data: body} — body contient lui-même {data: {status}}
                const status = result?.data?.data?.status ?? result?.data?.status ?? result?.status;

                if (status === 'SUCCESS' || status === 'COMPLETED') {
                    await this._handlePaymentSuccess(sock, fullId, sessionId, finalData, isP2P, targetId);
                    return;
                }
                if (status === 'FAILED') {
                    await this._handlePaymentFailure(sock, fullId, finalData);
                    return;
                }
            } catch (err) {
                console.error(`[PaymentHandler] Poll error ref:${reference.slice(0, 8)}…`, err.message);
                // Erreur réseau temporaire → on continue de poller
            }

            setTimeout(poll, POLL_INTERVAL_MS);
        };

        // Premier poll après 5s (la validation MTN prend au minimum quelques secondes)
        setTimeout(poll, POLL_INTERVAL_MS);
    }

    async _handlePaymentTimeout(sock, fullId, sessionId, finalData) {
        this.state.clearState(sessionId);
        await this.sendNativeFlowMessage(
            sock, fullId,
            `⏱️ *Délai de confirmation dépassé*\n\nNous n'avons pas reçu de confirmation pour votre paiement de *${finalData.amount} FCFA*.\n\nSi vous avez validé sur votre téléphone, le paiement sera pris en compte automatiquement. Vérifiez votre historique dans quelques instants.`,
            'Que souhaitez-vous faire ?',
            [
                { label: '📋 Voir mon historique', id: '3' },
                { label: '🏠 Menu principal', id: '0' },
            ]
        );
    }

    async _handlePaymentSuccess(sock, fullId, sessionId, finalData, isP2P, targetId) {
        const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;

        if (isP2P) {
            if (fullId.endsWith('@g.us')) {
                const senderJid = finalData.sender_jid || (userId + '@s.whatsapp.net');
                const publicMsg = [
                    '🔔 *Notification de Transfert*',
                    '',
                    `✅ *${finalData.amount} FCFA* transférés avec succès !`,
                    `De : @${senderJid.split('@')[0]}`,
                    `Vers : @${finalData.p2p_recipient_jid?.split('@')[0]}`,
                    '',
                    '_Frais de plateforme (2%) inclus._'
                ].join('\n');
                await this.sendMessage(sock, fullId, publicMsg, { mentions: [senderJid, finalData.p2p_recipient_jid] });
            } else {
                const recipientName = finalData.merchant_name || finalData.p2p_recipient_phone;
                await this.sendNativeFlowMessage(
                    sock, fullId,
                    `✅ *Transfert réussi !*\n*${finalData.amount} FCFA* ont été envoyés à *${recipientName}*.`,
                    'Que souhaitez-vous faire ensuite ?',
                    [
                        { label: '📋 Mon historique', id: '3' },
                        { label: '🏠 Menu principal', id: '0' },
                    ]
                );
            }
        } else {
            if (!fullId.endsWith('@g.us')) {
                await this.sendNativeFlowMessage(
                    sock, fullId,
                    `✅ *Paiement validé !*\nVotre paiement a bien été transféré à *${finalData.merchant_name}*.`,
                    'Que souhaitez-vous faire ensuite ?',
                    [
                        { label: '📋 Mon historique', id: '3' },
                        { label: '🏠 Menu principal', id: '0' },
                    ]
                );
            } else {
                await this.sendMessage(sock, fullId, `*Paiement valide et transféré à ${finalData.merchant_name} !*`);
            }
        }

        // Always clear state after success — in all contexts
        this.state.clearState(sessionId);
    }

    async _handlePaymentFailure(sock, fullId, finalData) {
        return this.sendNativeFlowMessage(
            sock, fullId,
            `*Paiement non effectué*\n\nVotre paiement de *${finalData.amount} FCFA* n'a pas pu être finalisé.\n\n*Causes possibles* :\n- Solde insuffisant\n- Code incorrect\n- Transaction annulée`,
            'Que souhaitez-vous faire ?',
            [
                { label: '🔄 Réessayer le paiement', id: '1' },
                { label: '🔀 Choisir un autre opérateur', id: '2' },
                { label: '🏠 Menu principal', id: '0' },
            ]
        );
    }
}

export default new PaymentHandler();
