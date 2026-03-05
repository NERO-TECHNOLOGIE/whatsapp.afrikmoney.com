import stateService from './StateService.js';
import apiService from './ApiService.js';
import navigationService from './NavigationService.js';

const AFRIK_DISCLAIMER = `INFORMATION IMPORTANTE

Confidentialite : Vos donnees sont traitees de maniere securisee et confidentielle conformement aux lois en vigueur.

Conditions : En utilisant ce bot, vous acceptez nos Conditions Generales d'Utilisation (CGU) et notre politique de confidentialite.

Tapez 1 pour accepter et continuer, ou 0 pour quitter.`;

class BotLogic {
    async handleMessage(sock, msg) {
        const fullId = msg.key.remoteJid;
        if (!fullId || fullId === 'status@broadcast') return;

        const isGroup = fullId.endsWith('@g.us');
        const botJid = sock.user?.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : null;
        const senderJid = isGroup ? msg.key.participant : fullId;
        if (!senderJid) return; // Skip if no sender (system messages, etc.)
        const from = this.normalizeId(senderJid);

        let text = (msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            '').trim();

        const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const botPN = botJid ? this.normalizeId(botJid) : null;
        const botLID = (sock.user?.lid || sock.authState?.creds?.me?.lid) ? this.normalizeId(sock.user?.lid || sock.authState?.creds?.me?.lid) : null;
        const botIDRaw = sock.user?.id;

        const isMentioned = botJid && (
            mentions.some(m => {
                const norm = this.normalizeId(m);
                return (botPN && norm === botPN) || (botLID && norm === botLID);
            }) ||
            (botPN && text.includes(botPN)) ||
            (botLID && text.includes(botLID))
        );

        // Check if this is a reply to THE BOT
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedParticipant = contextInfo?.participant;
        const isReplyToBot = quotedParticipant && (
            this.normalizeId(quotedParticipant) === botPN ||
            this.normalizeId(quotedParticipant) === botLID
        );

        // Group logic: react if mentioned, if it's a direct button reply, OR if it's a simple text reply to the bot
        if (isGroup && !isMentioned && !isReplyToBot && !msg.message?.buttonsResponseMessage && !msg.message?.templateButtonReplyMessage) return;

        if (isGroup && (isMentioned || isReplyToBot)) {
            console.log(`[BotLogic] Group Activity from ${from}: "${text}" (Mention: ${isMentioned}, Reply: ${isReplyToBot})`);
        }

        // Strip mentions from text for cleaner command processing
        if (isMentioned) {
            text = text.replace(/@\d+/g, '').trim();
        }

        if (!text && !msg.message?.buttonsResponseMessage && !msg.message?.templateButtonReplyMessage) return;

        try {
            await sock.sendPresenceUpdate('composing', fullId);
            // Longer typing for better visibility in groups
            const typingDuration = isGroup ? 2000 : 1000;
            await new Promise(resolve => setTimeout(resolve, typingDuration));
            await sock.sendPresenceUpdate('paused', fullId);
        } catch (e) {
            console.warn(`[BotLogic] Presence update error:`, e.message);
        }

        try {
            const currentFlow = stateService.getCurrentFlow(from);
            const currentStep = stateService.getCurrentStep(from);

            // Group-specific logic: STRICTLY limited to @bot [amount] or Shorthands
            if (isGroup && isMentioned && !currentFlow) {
                // 1. Shorthand Pay/Transfer: #montant#numero[#operateur] OR *pay*...
                const shorthandMatch = text.match(/^#(\d+)#([a-zA-Z0-9]+)(?:#([a-zA-Z0-9]+))?$/);
                const newShorthandMatch = text.match(/^\*pay\*([a-zA-Z0-9]+)\*(\d+)\*([a-zA-Z0-9]+)#$/);

                if (shorthandMatch || newShorthandMatch) {
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
                    const op = this._mapOperator(rawOp);

                    if (!isNaN(amount) && amount > 0) {
                        try {
                            const merchantInfo = await apiService.checkMerchant(target);
                            stateService.setState(from, 'merchant_payment', op ? 'confirmation' : 'source');
                            stateService.addData(from, 'merchant_code', target);
                            stateService.addData(from, 'merchant_id', merchantInfo.id);
                            stateService.addData(from, 'merchant_name', merchantInfo.company_name);
                            stateService.addData(from, 'merchant_phone', merchantInfo.merchant_phone);
                            stateService.addData(from, 'service_fee', merchantInfo.service_fee || 0);
                            stateService.addData(from, 'amount', amount);
                            stateService.addData(from, 'object', 'Paiement Rapide');

                            const fees = this._calculateFees(amount, merchantInfo.service_fee || 0);

                            if (op) {
                                stateService.addData(from, 'source', op);
                                return this.handleMerchantPayment(sock, fullId, 'confirmation', '1', msg, from);
                            }

                            const msgText = `✅ *Paiement Marchand*\n\n` +
                                `Destinataire: *${merchantInfo.company_name}*\n` +
                                `Montant Net: *${fees.net} FCFA*\n` +
                                `Frais: *${fees.fees} FCFA*\n` +
                                `*Total à Payer: ${fees.total} FCFA*\n\n` +
                                `Choisissez votre opérateur : \n1. MTN MOBILE MONEY\n2. FLOOZ\n3. CELTIIS CASH`;

                            return this.sendMessage(sock, fullId, msgText, { mentions: [senderJid] });
                        } catch (e) {
                            // If not a merchant, try as a P2P recipient (Phone number)
                            const recipient = await apiService.request('POST', '/afrik/login', { whatsapp: target });
                            if (recipient.success && recipient.data.user) {
                                stateService.setState(from, 'merchant_payment', op ? 'confirmation' : 'source');
                                stateService.addData(from, 'amount', amount);
                                stateService.addData(from, 'object', `Transfert vers ${target}`);
                                stateService.addData(from, 'is_p2p', true);
                                stateService.addData(from, 'p2p_recipient_phone', target);
                                stateService.addData(from, 'p2p_recipient_jid', target + '@s.whatsapp.net');
                                stateService.addData(from, 'merchant_code', 'P2P');
                                stateService.addData(from, 'merchant_name', recipient.data.user.prenom);

                                const fees = this._calculateFees(amount, 0);

                                if (op) {
                                    stateService.addData(from, 'source', op);
                                    return this.handleMerchantPayment(sock, fullId, 'confirmation', '1', msg, from);
                                }

                                const msgText = `🎁 *Transfert d'argent*\n\n` +
                                    `Destinataire: *${recipient.data.user.prenom}* (${target})\n` +
                                    `Montant Net: *${fees.net} FCFA*\n` +
                                    `Frais: *${fees.fees} FCFA*\n` +
                                    `*Total à Payer: ${fees.total} FCFA*\n\n` +
                                    `Choisissez votre opérateur :\n1. MTN MOBILE MONEY\n2. FLOOZ\n3. CELTIIS CASH`;

                                return this.sendMessage(sock, fullId, msgText, { mentions: [senderJid] });
                            } else {
                                return this.sendMessage(sock, fullId, `❌ Code marchand ou utilisateur *${target}* introuvable.`);
                            }
                        }
                    }
                }

                // 2. Tag + Amount (Reply or Additional Mention)
                const quotedParticipant = contextInfo?.participant;
                const otherMentions = mentions.filter(m => {
                    const norm = this.normalizeId(m);
                    return (botPN && norm !== botPN) && (botLID && norm !== botLID);
                });

                const targetJid = quotedParticipant || (otherMentions.length > 0 ? otherMentions[0] : null);
                const amountMatch = text.match(/(\d+)/);
                const amount = amountMatch ? parseInt(amountMatch[1]) : null;

                if (amount && !isNaN(amount) && amount > 0) {
                    if (targetJid) {
                        return this._processGroupP2P(sock, fullId, from, amount, targetJid, senderJid);
                    } else {
                        // User tagged bot with an amount but no target (no reply, no extra mention)
                        return this.sendMessage(sock, fullId, "Pour envoyer de l'argent, répondez au message de votre ami avec le montant, ou mentionnez-le (ex: @bot 500).");
                    }
                }

                // ONLY allow continuation if the user is replying to a bot message
                const isReplyToBot = contextInfo?.participant && (this.normalizeId(contextInfo.participant) === botPN || this.normalizeId(contextInfo.participant) === botLID);

                if (currentFlow && isReplyToBot) {
                    // Fall through to handle continuation
                } else {
                    // Strictly ignore everything else in groups to avoid "delirium"
                    return;
                }
            }

            // --- PRIVATE CHAT OR CONTINUING FLOWS ---

            // Send vCard if new discussion (Private Only)
            if (!isGroup && !currentFlow && !stateService.getData(from, 'vcard_sent', false)) {
                await this.sendContact(sock, fullId);
                stateService.addData(from, 'vcard_sent', true);
                await this.sendMessage(sock, fullId, "Enregistrez mon contact pour ne rien manquer !");
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Disclaimer Acceptance
            if (currentFlow === 'welcome' && currentStep === 'disclaimer') {
                if (text === '1') {
                    stateService.addData(from, 'disclaimer_accepted', true);
                    return this.showWelcome(sock, fullId);
                } else if (text === '0') {
                    stateService.clearState(from);
                    return this.sendMessage(sock, fullId, "Session terminée. Merci.");
                }
                return this.sendMessage(sock, fullId, "Veuillez taper 1 pour accepter ou 0 pour quitter.");
            }

            // Cancel operation
            const isSkippingRegistrationPayment = currentFlow === 'registration' && ['mtn', 'moov', 'celtiis'].includes(currentStep);
            if (text === '0' && currentFlow !== 'main_menu' && !isSkippingRegistrationPayment) {
                stateService.clearState(from);
                return this.showMainMenu(sock, fullId);
            }

            if (!currentFlow || currentFlow === 'main_menu') {
                // If we are in a group but fell through shorthands/amount, and it's not a button reply, STOP.
                if (isGroup && !msg.message?.buttonsResponseMessage && !msg.message?.templateButtonReplyMessage) return;

                let user = null;
                try {
                    user = await apiService.authenticate(from);
                } catch (error) {
                    console.log(`[BotLogic] Auth check failed for ${from}:`, error.message);
                }

                if (!user) {
                    const hasAccepted = stateService.getData(from, 'disclaimer_accepted', false);
                    if (!hasAccepted) return this.showWelcome(sock, fullId);

                    if (text === '1') return this.startRegistrationFlow(sock, fullId);
                    return this.showWelcome(sock, fullId);
                } else {
                    // Store user phone for payment initiation
                    stateService.addData(from, 'user_phone', user.telephone);

                    switch (text) {
                        case '1': return this.showProjects(sock, fullId, from);
                        case '2': return this.startMerchantPaymentFlow(sock, fullId, from);
                        case '3': return this.showHistory(sock, fullId, from);
                        case '4': return this.showProfile(sock, fullId, user, from);
                        case '5': return this.startProjectCreationFlow(sock, fullId, from);
                        case '6': return this.showSupport(sock, fullId, from);
                        default: return this.showMainMenu(sock, fullId, user, from);
                    }
                }
            }

            switch (currentFlow) {
                case 'registration':
                    return this.handleRegistration(sock, fullId, currentStep, text, from);
                case 'merchant_payment':
                    return this.handleMerchantPayment(sock, fullId, currentStep, text, msg, from);
                case 'create_project':
                    return this.handleProjectCreation(sock, fullId, currentStep, text, from);
                case 'projects_list':
                    return this.handleProjectListSelection(sock, fullId, currentStep, text, from);
                case 'project_details':
                    return this.handleProjectDetails(sock, fullId, currentStep, text, from);
                case 'support':
                    return this.handleSupport(sock, fullId, currentStep, text, from);
                default:
                    return this.showMainMenu(sock, fullId, null, from);
            }
        } catch (error) {
            console.error(`[BotLogic] Error:`, error);
            await this.sendMessage(sock, fullId, "Une erreur est survenue. Réessayez plus tard.");
        }
    }

    async sendMessage(sock, jid, text, options = {}) {
        // If it's a group, we might want to tag the user (optional but helpful)
        const isGroup = jid.endsWith('@g.us');
        return sock.sendMessage(jid, { text, ...options });
    }

    async sendContact(sock, jid) {
        const vcard = 'BEGIN:VCARD\n'
            + 'VERSION:3.0\n'
            + 'FN:Afrikmoney\n'
            + 'ORG:Afrikmoney;\n'
            + 'TEL;type=CELL;type=VOICE;waid=22951248454:+229 51 24 84 54\n'
            + 'END:VCARD';

        return sock.sendMessage(jid, {
            contacts: {
                displayName: 'Afrikmoney',
                contacts: [{ vcard }]
            }
        });
    }

    async showWelcome(sock, fullId, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        const hasAccepted = stateService.getData(from, 'disclaimer_accepted', false);

        if (!hasAccepted) {
            stateService.setState(from, 'welcome', 'disclaimer');
            return this.sendMessage(sock, fullId, AFRIK_DISCLAIMER);
        }

        const text = "Bienvenue sur Afrikmoney Bot !\n\n" +
            "Votre assistant whatsapp pour gérer vos projets de paiement et payer vos marchands en toute simplicité.\n\n" +
            "1- M'inscrire\n\n" +
            "Tapez 1 pour commencer.";
        stateService.setState(from, 'main_menu', 'init');
        return this.sendMessage(sock, fullId, text);
    }

    async showMainMenu(sock, fullId, user = null, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        if (!user) user = await apiService.authenticate(from);

        if (!user) {
            // Never show welcome/main menu in groups if user is not found
            if (fullId.endsWith('@g.us')) return;

            const hasAccepted = stateService.getData(from, 'disclaimer_accepted', false);
            if (!hasAccepted) return this.showWelcome(sock, fullId);
            return this.showWelcome(sock, fullId);
        }

        let text = `Bienvenue sur la plateforme de paiement AFRIKMONEY\n`;
        text += `Bonjour ${user.prenom} ${user.nom}\n`;
        text += `Tapez un numéro pour choisir :\n`;
        text += "1 - Voir mes projets\n";
        text += "2 - Faire un paiement\n";
        text += "3 - Voir mon historique\n";
        text += "4 - Mon profil\n";
        text += "5 - Créer un projet\n";
        text += "6 - Besoin d’aide";

        stateService.clearState(from);
        stateService.setState(from, 'main_menu', 'selection');
        return this.sendMessage(sock, fullId, text);
    }

    // --- REGISTRATION FLOW ---
    async startRegistrationFlow(sock, fullId) {
        const from = this.normalizeId(fullId);
        stateService.setState(from, 'registration', 'nom');
        return this.sendMessage(sock, fullId, "Inscription Afrikmoney\n\nQuel est votre NOM ? (ou 0 pour annuler)");
    }

    async handleRegistration(sock, fullId, step, text, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        switch (step) {
            case 'nom':
                stateService.addData(from, 'nom', text.trim());
                stateService.setState(from, 'registration', 'prenom');
                return this.sendMessage(sock, fullId, "Quel est votre PRENOM ?");

            case 'prenom':
                stateService.addData(from, 'prenom', text.trim());
                stateService.setState(from, 'registration', 'telephone');
                return this.sendMessage(sock, fullId, "Entrez votre NUMERO DE TELEPHONE (Commencez par 229, ex: 2290197XXXXXX) :");

            case 'telephone':
                let tel = text.replace(/[^0-9]/g, '');
                if (!tel.startsWith('229') || tel.length < 11) {
                    return this.sendMessage(sock, fullId, "Numéro invalide. Il doit commencer par 229 et avoir au moins 11 chiffres. Réessayez :");
                }
                const phoneExists = await apiService.checkPhoneExists(tel);
                if (phoneExists) {
                    return this.sendMessage(sock, fullId, "Ce numéro est déjà enregistré.");
                }
                stateService.addData(from, 'telephone', tel);
                stateService.setState(from, 'registration', 'whatsapp');
                return this.sendMessage(sock, fullId, "Entrez votre NUMERO WHATSAPP (Commencez par 229, ex: 2290197XXXXXX) :");

            case 'whatsapp':
                let wa = text.replace(/[^0-9]/g, '');
                if (!wa.startsWith('229') || wa.length < 11) {
                    return this.sendMessage(sock, fullId, "Numéro WhatsApp invalide. Réessayez :");
                }
                stateService.addData(from, 'whatsapp_num', wa);
                stateService.setState(from, 'registration', 'mtn');
                return this.sendMessage(sock, fullId, "Entrez votre numéro de paiement MTN (ou 0 si aucun) :");

            case 'mtn':
                stateService.addData(from, 'num_mtn', text === '0' ? null : text.trim());
                stateService.setState(from, 'registration', 'moov');
                return this.sendMessage(sock, fullId, "Entrez votre numéro de paiement MOOV (ou 0 si aucun) :");

            case 'moov':
                stateService.addData(from, 'num_moov', text === '0' ? null : text.trim());
                stateService.setState(from, 'registration', 'celtiis');
                return this.sendMessage(sock, fullId, "Entrez votre numéro de paiement CELTIIS (ou 0 si aucun) :");

            case 'celtiis':
                stateService.addData(from, 'num_celtiis', text === '0' ? null : text.trim());
                return this.completeRegistration(sock, fullId);
        }
    }

    async completeRegistration(sock, fullId) {
        const from = this.normalizeId(fullId);
        const data = stateService.getData(from);
        try {
            // We use 'from' (the actual WhatsApp JID) as the 'whatsapp' field to ensure
            // the bot can authenticate the user automatically later.
            // The manually entered number (data.whatsapp_num) is collected but we prioritize the real JID for auth.
            const user = await apiService.registerUser({
                ...data,
                whatsapp: from,
                whatsapp_number: data.whatsapp_num,
            });

            // Clear the flow but keep the user info in state so we don't need to re-fetch immediately
            // although showMainMenu will probably fetch if we don't pass 'user'
            stateService.clearFlow(from);

            await this.sendMessage(sock, fullId, `Inscription réussie, ${user.prenom} !`);
            return this.showMainMenu(sock, fullId, user);
        } catch (e) {
            console.error(e);
            const errorMsg = e.response?.data?.message || "Erreur inconnue";
            return this.sendMessage(sock, fullId, `Erreur lors de l'inscription: ${errorMsg}. Réessayez.`);
        }
    }

    // --- MERCHANT PAYMENT FLOW ---
    async startMerchantPaymentFlow(sock, fullId, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        stateService.setState(from, 'merchant_payment', 'code');
        const text = "Paiement d’un marchand\n\nVeuillez entrer le code marchand fourni par le commerçant.\n\nVous trouverez ce code :\n-Sur l’affiche AfrikMoney collée dans les locaux du marchand ;\n-Ou directement auprès du marchand ;\n\nTapez :\n-Le code du marchand\n-0 pour revenir au menu principal";
        return this.sendMessage(sock, fullId, text);
    }

    async handleMerchantPayment(sock, fullId, step, text, msg, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        switch (step) {
            case 'recipient_phone': {
                let p2pPhone = text.replace(/[^0-9]/g, '');
                if (p2pPhone.length < 8) {
                    return this.sendMessage(sock, fullId, "Numéro invalide. Veuillez entrer un numéro valide (ex: 229XXXXXXXX) :");
                }
                stateService.addData(from, 'p2p_recipient_phone', p2pPhone);
                stateService.addData(from, 'merchant_phone', p2pPhone); // For validation

                stateService.setState(from, 'merchant_payment', 'confirmation');
                const data = stateService.getData(from);
                const fees = this._calculateFees(data.amount, 0);
                return this._sendPaymentSummary(sock, fullId, { ...data, ...fees });
            }

            case 'code':
                try {
                    const merchantInfo = await apiService.checkMerchant(text.trim());
                    stateService.addData(from, 'merchant_code', text.trim());
                    stateService.addData(from, 'merchant_id', merchantInfo.id);
                    stateService.addData(from, 'merchant_name', merchantInfo.company_name);
                    stateService.addData(from, 'merchant_phone', merchantInfo.merchant_phone);
                    stateService.addData(from, 'service_fee', merchantInfo.service_fee || 0);

                    stateService.setState(from, 'merchant_payment', 'object');
                    return this.sendMessage(sock, fullId, `Marchand confirmé\n${merchantInfo.company_name}\n\nTapez :\n-Le motif du paiement\n-0 pour revenir au menu principal`);
                } catch (e) {
                    return this.sendMessage(sock, fullId, "Code marchand invalide. Veuillez réessayer :");
                }
            case 'object':
                stateService.addData(from, 'object', text);
                stateService.setState(from, 'merchant_payment', 'amount');
                return this.sendMessage(sock, fullId, "Montant du paiement\n\nTapez :\n-Le montant à payer en FCFA\n-0 pour revenir au menu principal\n\nImportant : N’ajoutez pas d’espace ni de symbole.");
            case 'amount':
                const amount = parseInt(text.replace(/\D/g, '')); // Remove non-digits
                if (isNaN(amount) || amount < 1) {
                    return this.sendMessage(sock, fullId, "Montant invalide. Veuillez entrer un montant minimum de 1 FCFA.");
                }
                stateService.addData(from, 'amount', amount);
                stateService.setState(from, 'merchant_payment', 'source');
                const sourceText = "Choix du moyen de paiement\n\nSélectionnez votre opérateur Mobile Money :\n1. MTN MOBILE MONEY\n2. FLOOZ\n3. CELTIIS CASH\n\nTapez :\n-Le numéro correspondant à votre opérateur\n-4 pour modifier le montant\n-0 pour revenir au menu principal";
                return this.sendMessage(sock, fullId, sourceText);
            case 'source': {
                let source = '';
                if (text === '1') source = 'MTN';
                else if (text === '2') source = 'Moov';
                else if (text === '3') source = 'Celtiis';
                else if (text === '4') {
                    stateService.setState(from, 'merchant_payment', 'amount');
                    return this.sendMessage(sock, fullId, "Montant du paiement\n\nTapez :\n-Le montant à payer en FCFA\n-0 pour revenir au menu principal\n\nImportant : N’ajoutez pas d’espace ni de symbole.");
                }
                else return this.sendMessage(sock, fullId, "Choix invalide.");

                stateService.addData(from, 'source', source);

                const payer = await apiService.authenticate(from);
                if (!payer) {
                    return this.sendMessage(sock, fullId, "❌ Vous n'êtes pas encore inscrit. Veuillez m'envoyer un message privé pour créer votre compte.");
                }
                const payerPhone = source === 'MTN' ? payer.num_mtn : (source === 'Moov' ? payer.num_moov : payer.num_celtiis);

                if (!payerPhone) {
                    return this.sendMessage(sock, fullId, `Attention : Vous n'avez pas de numéro de paiement enregistré pour *${source}*. Veuillez l'ajouter dans votre profil via l'application ou demander de l'aide.`);
                }

                stateService.addData(from, 'user_phone', payerPhone);

                const currentData = stateService.getData(from);

                // NEW: If external P2P, ask for phone AFTER operator choice
                if (currentData.is_p2p && currentData.merchant_name === 'Destinataire Externe') {
                    stateService.setState(from, 'merchant_payment', 'recipient_phone');
                    const opLabel = source === 'MTN' ? 'MTN' : (source === 'Moov' ? 'FLOOZ' : 'CELTIIS CASH');
                    return this.sendMessage(sock, fullId, `Veuillez entrer le numéro *${opLabel}* du destinataire (ex: 229XXXXXXXX) :`);
                }

                stateService.setState(from, 'merchant_payment', 'confirmation');

                const data = stateService.getData(from);
                const fees = this._calculateFees(data.amount, data.service_fee || 0);
                return this._sendPaymentSummary(sock, fullId, { ...data, source, ...fees });
            }

            case 'confirmation':
                // Check if this is a reply to our summary message (for group transfers specifically)
                const quotedMsgId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
                const lastSummaryId = stateService.getData(from, 'last_summary_id');
                const isGroupReply = fullId.endsWith('@g.us');

                if (isGroupReply && lastSummaryId && (quotedMsgId !== lastSummaryId)) {
                    return; // Ignore if not replying to the correct summary in a group
                }

                if (text === '1') {
                    const finalData = stateService.getData(from);
                    try {
                        const isP2P = finalData.is_p2p;
                        const targetId = isP2P ? finalData.p2p_recipient_phone : finalData.merchant_phone;

                        if (!targetId) {
                            return this.sendMessage(sock, fullId, `Erreur: Aucun numéro de paiement associé à ce ${isP2P ? 'destinataire' : 'marchand'}.`);
                        }

                        // 1. Initiate Payment (Merchant or P2P)
                        await this.sendMessage(sock, fullId, "Initiation du paiement en cours... Veuillez patienter.");

                        let paymentResult;
                        if (finalData.is_p2p) {
                            paymentResult = await apiService.submitP2P({
                                amount: parseInt(finalData.amount),
                                recipient_phone: finalData.p2p_recipient_phone,
                                source: finalData.source || 'MTN',
                                payer_phone: finalData.user_phone || this.normalizeId(fullId),
                                object: finalData.object
                            }, from);
                        } else {
                            const paymentPayload = {
                                merchant_code: finalData.merchant_code,
                                amount: parseInt(finalData.amount),
                                object: finalData.object,
                                source: finalData.source || 'MTN',
                                payer_phone: finalData.user_phone || this.normalizeId(fullId)
                            };

                            if (finalData.payment_plan_id) {
                                paymentPayload.payment_plan_id = finalData.payment_plan_id;
                            }
                            paymentResult = await apiService.submitMerchantPayment(paymentPayload, from);
                        }

                        const reference = paymentResult.data?.reference || paymentResult.reference;

                        if (!paymentResult.success || !reference) {
                            const errorMsg = paymentResult.error?.message || "Erreur lors de l'initiation du paiement.";
                            return this.sendMessage(sock, fullId, `❌ ${errorMsg}`);
                        }

                        const userPhone = finalData.user_phone || this.normalizeId(fullId);
                        let inProgressText = `Paiement en cours…\n`;
                        inProgressText += `Une demande de paiement de ${finalData.amount} FCFA a été envoyée sur votre téléphone au numéro : ${userPhone}\n\n`;
                        inProgressText += `-Vérifier sur votre téléphone la notification Mobile Money\n`;
                        inProgressText += `-Entrez votre code secret pour valider\n\n`;
                        inProgressText += `Si la notification ne s’affiche pas :\n`;
                        inProgressText += `Ouvrez votre application Mobile Money puis vérifiez dans Demandes en attente / Validation\n\n`;
                        inProgressText += `En attente de confirmation…`;

                        await this.sendMessage(sock, fullId, inProgressText);

                        // 2. Poll for status
                        let attempts = 0;
                        const maxAttempts = 20; // 20 * 3s = 60s timeout
                        const pollInterval = 3000;

                        const checkStatus = async () => {
                            if (attempts >= maxAttempts) {
                                return; // Stop polling silently or show timeout
                            }

                            try {
                                const statusResult = await apiService.checkPaymentStatus(reference);
                                // Check deep status structure depending on API response
                                // PaymentPlanController returns { success: true, data: { status: 'SUCCESS', ... } } usually
                                // But checkPaymentStatus in Controller returns { success: true, payment: ... } or similar?
                                // Let's assume standard response structure
                                const status = statusResult.data?.status || statusResult.status; // adjust based on API

                                if (status === 'SUCCESS' || status === 'COMPLETED') {
                                    if (finalData.is_p2p) {
                                        const senderName = finalData.user_name || this.normalizeId(fullId);
                                        const recipientName = finalData.merchant_name || finalData.p2p_recipient_phone;

                                        // 1. Send notification (Private or Group)
                                        if (fullId.endsWith('@g.us')) {
                                            // 2. Detailed public group notification
                                            const publicMsg = `🔔 *Notification de Transfert*\n\n` +
                                                `✅ *${finalData.amount} FCFA* transférés avec succès !\n` +
                                                `De : @${this.normalizeId(from)}\n` +
                                                `Vers : @${finalData.p2p_recipient_jid.split('@')[0]}\n\n` +
                                                `_Frais de plateforme (2%) inclus._`;
                                            await this.sendMessage(sock, fullId, publicMsg, {
                                                mentions: [from, finalData.p2p_recipient_jid]
                                            });
                                        } else {
                                            // Private success message
                                            await this.sendMessage(sock, fullId, `✅ Transfert réussi ! *${finalData.amount} FCFA* ont été envoyés à ${recipientName}.`);
                                        }
                                    } else {
                                        // Trigger TEST Payout for merchants (as requested)
                                        await apiService.submitTestPayout({
                                            amount: parseInt(finalData.amount),
                                            phone_number: targetId,
                                            company_id: finalData.merchant_id,
                                            note: finalData.object
                                        }, from);
                                        await this.sendMessage(sock, fullId, `Paiement valide et transfere a ${finalData.merchant_name} !`);
                                    }

                                    if (finalData.payment_plan_id) {
                                        await this.sendMessage(sock, fullId, "Mise a jour de votre progression...");
                                        await new Promise(resolve => setTimeout(resolve, 5000));
                                        try {
                                            const projectsResult = await apiService.getProjects(from);
                                            const projects = Array.isArray(projectsResult) ? projectsResult : (projectsResult.data || []);
                                            const updatedProject = projects.find(p => p.id == finalData.payment_plan_id);
                                            if (updatedProject) {
                                                return this.showProjectDetails(sock, fullId, updatedProject);
                                            }
                                        } catch (err) {
                                            console.error("Error refreshing after payment:", err);
                                        }
                                    }

                                    if (fullId.endsWith('@g.us')) {
                                        stateService.clearState(from);
                                        return;
                                    }
                                    return this.showMainMenu(sock, fullId);
                                } else if (status === 'FAILED') {
                                    let failedText = `Paiement non effectué\n`;
                                    failedText += `Votre paiement de ${finalData.amount} FCFA n’a pas pu être finalisé.\n\n`;
                                    failedText += `Les causes possibles sont :\n`;
                                    failedText += `-Solde insuffisant\n`;
                                    failedText += `-Code incorrect\n`;
                                    failedText += `-Transaction annulée\n\n`;
                                    failedText += `Tapez :\n`;
                                    failedText += `-1 pour réessayer le paiement\n`;
                                    failedText += `-2 pour choisir un autre opérateur\n`;
                                    failedText += `-0 pour revenir au menu principal`;
                                    return this.sendMessage(sock, fullId, failedText);
                                } else {
                                    attempts++;
                                    setTimeout(checkStatus, pollInterval);
                                }
                            } catch (e) {
                                console.error("Polling error:", e);
                                attempts++; // Keep trying even if network blip
                                setTimeout(checkStatus, pollInterval);
                            }
                        };

                        // Start polling
                        setTimeout(checkStatus, pollInterval);

                    } catch (e) {
                        console.error("Merchant payment error:", e);
                        const errorMessage = e.message || "Erreur inconnue";
                        if (errorMessage.includes("status code 500") || errorMessage.includes("Échec initiation")) {
                            return this.sendMessage(sock, fullId, "Echec de l'initiation du paiement (Erreur API MTN/Backend).\nDetails: " + errorMessage);
                        }
                        return this.sendMessage(sock, fullId, "Échec de l'initiation du paiement. " + errorMessage);
                    }
                } else {
                    stateService.clearState(from);
                    return this.showMainMenu(sock, fullId);
                }
                break;
        }
    }

    // --- PROJECT FLOW ---
    async showProjects(sock, fullId, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        try {
            const projects = await apiService.getProjects(from);
            stateService.setState(from, 'projects_list', 'selection');
            stateService.addData(from, 'cached_projects', projects);
            return this.sendMessage(sock, fullId, navigationService.formatProjectsList(projects));
        } catch (e) {
            console.error(e);
            return this.sendMessage(sock, fullId, "Impossible de récupérer vos projets pour le moment.");
        }
    }

    async startProjectCreationFlow(sock, fullId, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        stateService.setState(from, 'create_project', 'merchant_code');
        const text = "Créer un nouveau projet de paiement\n\nPour commencer, entrez le code marchand de l’entreprise chez qui vous souhaitez souscrire.\n\nVous trouverez ce code :\n-Sur l’affiche AfrikMoney collée dans les locaux du marchand ;\n-Ou directement auprès du marchand ;\n\nTapez :\n-Le code du marchand\n-0 pour revenir au menu principal";
        return this.sendMessage(sock, fullId, text);
    }

    async handleProjectCreation(sock, fullId, step, text, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        switch (step) {
            case 'merchant_code':
                try {
                    const merchantInfo = await apiService.checkMerchant(text.trim());
                    stateService.addData(from, 'merchant_id', merchantInfo.id);
                    stateService.addData(from, 'merchant_name', merchantInfo.company_name);
                    stateService.addData(from, 'company_code', text.trim());
                    stateService.addData(from, 'service_fee', merchantInfo.service_fee || 0);

                    // Check if there are services
                    if (merchantInfo.services && merchantInfo.services.length > 0) {
                        stateService.addData(from, 'cached_services', merchantInfo.services);
                        stateService.setState(from, 'create_project', 'service');

                        let serviceList = `${merchantInfo.company_name}\n`;
                        serviceList += `Services disponibles\n`;
                        serviceList += `Choisissez le service pour lequel vous souhaitez créer un projet :\n\n`;
                        merchantInfo.services.forEach((s, i) => {
                            serviceList += `${i + 1}-${s.name}\n`;
                        });
                        serviceList += `\nTapez :\n-Le numéro du service choisi\n-0 pour revenir au menu principal`;
                        return this.sendMessage(sock, fullId, serviceList);
                    } else {
                        stateService.clearFlow(from);
                        return this.sendMessage(sock, fullId, `Ce marchand (${merchantInfo.company_name}) n'a aucun service disponible pour le moment. Vous ne pouvez pas créer de projet chez lui.`);
                    }
                } catch (e) {
                    return this.sendMessage(sock, fullId, "Code marchand invalide. Veuillez réessayer :");
                }

            case 'service':
                const selection = parseInt(text);
                const services = stateService.getData(from, 'cached_services', []);
                if (isNaN(selection) || selection < 1 || selection > services.length) {
                    return this.sendMessage(sock, fullId, "Choix invalide. Veuillez répondre avec le numéro du service.");
                }
                const selectedService = services[selection - 1];

                const sId = selectedService.id ?? selectedService._id ?? selectedService.service_id ?? selectedService.ulid;

                stateService.addData(from, 'service_id', sId);
                stateService.addData(from, 'service_name', selectedService.name);
                stateService.addData(from, 'name', selectedService.name); // Auto-set name

                stateService.setState(from, 'create_project', 'target');
                return this.sendMessage(sock, fullId, `Service sélectionné : ${selectedService.name}\n\nTapez :\n-Le montant total que vous souhaitez payer au final (en FCFA)\n-0 pour revenir au menu principal\n\nImportant : N’ajoutez pas d’espace ni de symbole.`);

            case 'name':
                stateService.addData(from, 'name', text.trim());
                stateService.setState(from, 'create_project', 'target');
                return this.sendMessage(sock, fullId, "Tapez :\n-Le montant total que vous souhaitez payer au final (en FCFA)\n-0 pour revenir au menu principal\n\nImportant : N’ajoutez pas d’espace ni de symbole.");

            case 'target':
                const totalAmount = parseInt(text.replace(/\D/g, ''));
                if (isNaN(totalAmount) || totalAmount < 1) return this.sendMessage(sock, fullId, "Veuillez entrer un montant total valide.");
                stateService.addData(from, 'target_amount', totalAmount);
                stateService.setState(from, 'create_project', 'frequency');
                const freqText = "Fréquence de paiement\n\nÀ quelle fréquence souhaitez-vous effectuer vos paiements ?\n\n1-Quotidien (paiement chaque jour)\n2-Hebdomadaire (paiement chaque semaine)\n3-Mensuel (paiement chaque mois)\n4-Annuel (paiement une fois par an)\n\nTapez :\n-Le numéro correspondant à votre choix\n-0 pour revenir au menu principal";
                return this.sendMessage(sock, fullId, freqText);

            case 'frequency':
                let freq = '';
                if (text === '1') freq = 'daily';
                else if (text === '2') freq = 'weekly';
                else if (text === '3') freq = 'monthly';
                else if (text === '4') freq = 'yearly';
                else return this.sendMessage(sock, fullId, "Choix invalide.");

                stateService.addData(from, 'frequency', freq);
                stateService.setState(from, 'create_project', 'installment');
                const instText = "Montant par versement\n\nEntrez le montant que vous souhaitez payer à chaque échéance (en FCFA).\nCe montant déterminera le nombre total de paiements nécessaires pour atteindre votre objectif.\n\nTapez :\n-Le montant de chaque versement\n-0 pour revenir au menu principal";
                return this.sendMessage(sock, fullId, instText);

            case 'installment':
                const installment = parseInt(text.replace(/\D/g, ''));
                if (isNaN(installment) || installment < 1) return this.sendMessage(sock, fullId, "Veuillez entrer un montant de versement valide.");

                stateService.addData(from, 'amount', installment);
                const recap = this._generateProjectRecap(from);

                stateService.setState(from, 'create_project', 'confirmation');
                return this.sendMessage(sock, fullId, recap);

            case 'confirmation':
                if (text === '1') {
                    const projectData = stateService.getData(from);
                    try {
                        await apiService.createProject({
                            service_id: projectData.service_id,
                            name: projectData.name,
                            target_amount: projectData.target_amount,
                            amount: projectData.amount,
                            frequency: projectData.frequency,
                            start_date: projectData.start_date,
                            end_date: projectData.end_date,
                            due_date: projectData.end_date, // Last day is the due date
                            schedule: projectData.schedule, // Full list of installments
                            is_personal: 0,
                            reminder_method: 'whatsapp',
                            company_code: projectData.company_code,
                            subject: projectData.name
                        }, from);

                        let successText = `Projet de paiement : ${projectData.name} créé avec succès !\n`;
                        successText += `Service : ${projectData.name}\n`;
                        successText += `Marchand : ${projectData.merchant_name}\n`;
                        successText += `Objectif : ${projectData.target_amount} FCFA\n`;
                        successText += `Fréquence : ${projectData.frequency === 'daily' ? 'Quotidienne' : (projectData.frequency === 'weekly' ? 'Hebdomadaire' : (projectData.frequency === 'monthly' ? 'Mensuelle' : 'Annuelle'))}\n`;
                        successText += `Versement : ${projectData.amount} FCFA\n`;
                        successText += `Prochaine échéance : ${new Date(projectData.start_date).toLocaleDateString('fr-FR')}\n\n`;
                        successText += `Tapez :\n`;
                        successText += `-1 pour payer la première échéance\n`;
                        successText += `-0 pour revenir au menu principal`;

                        await this.sendMessage(sock, fullId, successText);
                        stateService.clearFlow(from);
                        return; // Done
                    } catch (e) {
                        console.error(e);
                        return this.sendMessage(sock, fullId, `Echec de la creation du projet : ${e.message}`);
                    }
                } else if (text === '0') {
                    return this.showMainMenu(sock, fullId);
                } else {
                    return this.sendMessage(sock, fullId, "Tapez 1 pour confirmer ou 0 pour annuler.");
                }
        }
    }

    _generateProjectRecap(from) {
        const data = stateService.getData(from);
        const installments = Math.ceil(data.target_amount / data.amount);
        const startDate = new Date();
        const schedule = [];

        data.start_date = startDate.toISOString().split('T')[0];

        let freqLabel = '';
        let freqDisplay = '';

        for (let i = 0; i < installments; i++) {
            let pDate = new Date(startDate);
            if (data.frequency === 'daily') {
                pDate.setDate(startDate.getDate() + i);
                freqLabel = 'chaque jour';
                freqDisplay = 'Quotidienne';
            } else if (data.frequency === 'weekly') {
                pDate.setDate(startDate.getDate() + i * 7);
                freqLabel = 'chaque semaine';
                freqDisplay = 'Hebdomadaire';
            } else if (data.frequency === 'monthly') {
                pDate.setMonth(startDate.getMonth() + i);
                freqLabel = 'chaque mois';
                freqDisplay = 'Mensuelle';
            } else if (data.frequency === 'yearly') {
                pDate.setFullYear(startDate.getFullYear() + i);
                freqLabel = 'chaque année';
                freqDisplay = 'Annuelle';
            } else {
                freqLabel = 'une fois';
                freqDisplay = 'Unique';
            }

            schedule.push({
                date: pDate.toISOString().split('T')[0],
                amount: i === installments - 1 && (data.target_amount % data.amount) !== 0
                    ? (data.target_amount % data.amount)
                    : data.amount
            });
        }

        const lastInstallment = schedule[schedule.length - 1];
        data.end_date = lastInstallment.date;
        data.schedule = schedule;

        stateService.addData(from, 'end_date', data.end_date);
        stateService.addData(from, 'start_date', data.start_date);
        stateService.addData(from, 'schedule', data.schedule);

        let recap = `Récapitulatif du projet\n`;
        recap += `Service : ${data.name}\n`;
        recap += `Marchand : ${data.merchant_name}\n`;
        recap += `Montant total à payer : ${data.target_amount} FCFA\n`;
        recap += `Fréquence de paiement : ${freqDisplay}\n`;
        const fees = this._calculateFees(data.amount, data.service_fee || 0);
        recap += `Montant payé à chaque versement : ${fees.total} FCFA (${fees.net} + ${fees.fees} frais)\n`;
        recap += `Nombre total de versements : ${installments}\n`;
        recap += `Date de fin prévue : ${new Date(data.end_date).toLocaleDateString('fr-FR')}\n`;
        recap += `───────────────\n`;
        recap += `Plan de paiement prévisionnel\n`;

        for (let i = 0; i < schedule.length; i++) {
            if (schedule.length > 6 && i >= 3 && i < schedule.length - 3) {
                if (i === 3) recap += `... (suite des paiements) ...\n`;
                continue;
            }

            const item = schedule[i];
            recap += `• ${new Date(item.date).toLocaleDateString('fr-FR')} → ${item.amount} FCFA\n`;
        }
        recap += `───────────────\n`;
        recap += `Vérifiez attentivement les informations avant de confirmer.\n\n`;
        recap += `Tapez :\n`;
        recap += `-1 pour confirmer la création du plan de paiement\n`;
        recap += `-0 pour revenir au menu principal`;
        return recap;
    }

    async handleProjectListSelection(sock, fullId, step, text, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        const projects = stateService.getData(from, 'cached_projects', []);

        const selection = parseInt(text);
        if (isNaN(selection) || selection < 1 || selection > projects.length) {
            return this.sendMessage(sock, fullId, "Choix invalide. Veuillez taper le numéro du projet.");
        }

        const project = projects[selection - 1];
        return this.showProjectDetails(sock, fullId, project);
    }

    async showProjectDetails(sock, fullId, project) {
        const from = this.normalizeId(fullId);
        stateService.addData(from, 'selected_project', project);
        stateService.setState(from, 'project_details', 'options');

        const current = Number(project.current_amount) || 0;
        const target = Number(project.target_amount) || 0;
        const isCompleted = current >= target;
        const progress = target > 0 ? (current / target) * 100 : 0;
        const bar = navigationService._generateProgressBar(progress);

        let recap = `Détail du projet\n`;
        recap += `Client : ${project.client_name}\n`;
        recap += `Marchand : ${project.company?.name || 'N/A'}\n`;
        recap += `Objet : ${project.description || project.subject}\n`;
        recap += `Progression : ${project.current_amount} / ${project.target_amount} FCFA\n`;
        recap += `${bar} ${progress.toFixed(0)}%\n`;

        if (isCompleted) {
            recap += "\nObjectif atteint - Paiement clos\n\n";
        } else {
            recap += `Prochaine échéance : ${project.next_payment || 'N/A'}\n`;
            recap += `Montant à payer : ${project.amount} FCFA\n\n`;
            recap += "Tapez :\n-1 pour payer l’échéance maintenant\n";
        }

        recap += "-0 pour revenir au menu principal";

        return this.sendMessage(sock, fullId, recap);
    }

    async handleProjectDetails(sock, fullId, step, text, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        const project = stateService.getData(from, 'selected_project');
        const isCompleted = project && Number(project.current_amount) >= Number(project.target_amount);

        if (text === '1' && !isCompleted) {
            return this.startPlanPaymentFlow(sock, fullId);
        } else if (text === '0') {
            stateService.clearState(from);
            return this.showMainMenu(sock, fullId);
        }

        const errorMsg = isCompleted ? "Ce projet est deja termine. Tapez 0 pour revenir." : "Choix invalide. Tapez 1 pour payer ou 0 pour quitter.";
        return this.sendMessage(sock, fullId, errorMsg);
    }

    async startPlanPaymentFlow(sock, fullId, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        const project = stateService.getData(from, 'selected_project');

        stateService.addData(from, 'merchant_code', project.company?.merchant_code);
        stateService.addData(from, 'merchant_id', project.company?.id);
        stateService.addData(from, 'merchant_name', project.company?.name);
        stateService.addData(from, 'merchant_phone', project.company?.merchant_phone);
        stateService.addData(from, 'service_fee', project.company?.service_fee || 0);
        stateService.addData(from, 'amount', project.amount);
        stateService.addData(from, 'object', `Echeance Projet: ${project.name}`);
        stateService.addData(from, 'payment_plan_id', project.id);
        // Bot no longer stores due_date; backend handles it automatically

        stateService.setState(from, 'merchant_payment', 'source');
        return this.sendMessage(sock, fullId, "Choisissez l'opérateur mobile pour le paiement :\n1. MTN MOBILE MONEY\n2. FLOOZ\n3. CELTIIS CASH");
    }

    // --- SUPPORT FLOW ---
    async showSupport(sock, fullId, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        stateService.setState(from, 'support', 'menu');
        return this.sendMessage(sock, fullId, navigationService.formatSupportMenu());
    }

    async handleSupport(sock, fullId, step, text, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        if (text === '1') {
            return this.sendMessage(sock, fullId, "FAQ Afrikmoney\n\n- Q: Comment payer un marchand ?\n- R: Utilisez l'option 2 du menu principal.\n\n- Q: Puis-je retirer mon argent ?\n- R: Oui, via vos comptes liés MTN/Moov.");
        } else if (text === '2') {
            return this.sendMessage(sock, fullId, "Contact Sponsor\n\nNotre équipe est disponible au 229XXXXXXXX ou par email à support@afrikmoney.com");
        } else if (text === '3') {
            return this.sendMessage(sock, fullId, "Deposer une plainte\n\nVeuillez décrire votre problème ici. Un conseiller vous recontactera.");
        } else {
            return this.showMainMenu(sock, fullId);
        }
    }

    async showHistory(sock, fullId, fromOverride = null) {
        const from = fromOverride || this.normalizeId(fullId);
        try {
            const history = await apiService.getHistory(from);
            return this.sendMessage(sock, fullId, navigationService.formatHistoryList(history));
        } catch (e) {
            return this.sendMessage(sock, fullId, "Impossible de récupérer votre historique.");
        }
    }

    async showProfile(sock, fullId, user) {
        let text = `Mon Profil\n\n`;
        text += `Informations personnelles :\n`;
        text += `Nom : ${user.nom}\n`;
        text += `Prénom : ${user.prenom}\n`;
        text += `Numéro principal : ${user.telephone}\n\n`;
        text += `Comptes Mobile Money liés :\n`;
        text += `MTN MOBILE MONEY : ${user.num_mtn || 'Non lié'}\n`;
        text += `FLOOZ : ${user.num_moov || 'Non lié'}\n`;
        text += `CELTIIS CASH : ${user.num_celtiis || 'Non lié'}\n\n`;
        text += `Tapez :\n`;
        text += `-1 pour lier un compte Mobile Money\n`;
        text += `-2 pour modifier mes informations\n`;
        text += `-0 pour revenir au menu principal`;
        return this.sendMessage(sock, fullId, text);
    }

    async _processGroupP2P(sock, fullId, from, amount, targetJid, senderJid) {
        const targetIdShort = targetJid.split('@')[0].split(':')[0];

        try {
            const recipient = await apiService.request('POST', '/afrik/login', { whatsapp: targetIdShort });
            if (recipient.success && recipient.data.user) {
                // ... Existing registered flow ...
                stateService.setState(from, 'merchant_payment', 'source');
                stateService.addData(from, 'amount', amount);
                stateService.addData(from, 'object', `Transfert vers @${targetIdShort}`);
                stateService.addData(from, 'is_p2p', true);
                stateService.addData(from, 'p2p_recipient_phone', targetIdShort);
                stateService.addData(from, 'p2p_recipient_jid', targetJid);
                stateService.addData(from, 'p2p_recipient_numbers', {
                    'MTN': recipient.data.user.num_mtn,
                    'Moov': recipient.data.user.num_moov,
                    'Celtiis': recipient.data.user.num_celtiis
                });
                stateService.addData(from, 'merchant_code', 'P2P');
                stateService.addData(from, 'merchant_name', recipient.data.user.prenom);

                const fees = this._calculateFees(amount, 0);
                const msgText = `🎁 *Transfert d'argent*\n\n` +
                    `Destinataire: *${recipient.data.user.prenom}* (@${targetIdShort})\n` +
                    `Montant Net: *${fees.net} FCFA*\n` +
                    `Frais: *${fees.fees} FCFA*\n` +
                    `*Total à Payer: ${fees.total} FCFA*\n\n` +
                    `Choisissez l'opérateur (*Répondez à ce message en glissant ce message à droite puis choisissez le numéro*) :\n1. MTN MOBILE MONEY\n2. FLOOZ\n3. CELTIIS CASH`;

                return this.sendMessage(sock, fullId, msgText, { mentions: [targetJid, senderJid] });
            } else {
                // NEW: Handle Unregistered / External Recipient
                stateService.setState(from, 'merchant_payment', 'source');
                stateService.addData(from, 'amount', amount);
                stateService.addData(from, 'object', `Transfert vers @${targetIdShort}`);
                stateService.addData(from, 'is_p2p', true);
                stateService.addData(from, 'p2p_recipient_jid', targetJid);
                stateService.addData(from, 'merchant_code', 'P2P');
                stateService.addData(from, 'merchant_name', 'Destinataire Externe');

                const fees = this._calculateFees(amount, 0);
                const msgText = `🎁 *Transfert d'argent*\n\n` +
                    `Destinataire: @${targetIdShort} (Non inscrit)\n` +
                    `Montant Net: *${fees.net} FCFA*\n` +
                    `Frais: *${fees.fees} FCFA*\n` +
                    `*Total à Payer: ${fees.total} FCFA*\n\n` +
                    `Choisissez l'opérateur pour ce transfert :\n1. MTN MOBILE MONEY\n2. FLOOZ\n3. CELTIIS CASH`;

                return this.sendMessage(sock, fullId, msgText, { mentions: [targetJid, senderJid] });
            }
        } catch (e) {
            console.error(`[BotLogic] P2P Error:`, e);
            return this.sendMessage(sock, fullId, "Erreur lors de la recherche du destinataire.");
        }
    }

    async _sendPaymentSummary(sock, fullId, data, quoted = null) {
        const from = this.normalizeId(fullId);
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
        summary += `Paiement via : *${data.source === 'MTN' ? 'MTN MoMo' : (data.source === 'Moov' ? 'Moov Money' : 'Celtiis Cash')}*\n\n`;
        if (fullId.endsWith('@g.us')) {
            summary += `\n⚠️ *NOTE* : Vous devez *Répondez à ce message en glissant ce message à droite puis choisissez le numéro 1* pour valider.`;
        }

        summary += `\n\nTapez :\n`;
        summary += `- *1* pour confirmer le paiement\n`;
        summary += `- *0* pour revenir au menu principal`;

        const sent = await this.sendMessage(sock, fullId, summary, { quoted });

        // Store this summary message ID so we can check if the user replies to IT later
        if (sent && sent.key) {
            stateService.addData(from, 'last_summary_id', sent.key.id);
        }

        return sent;
    }

    normalizeId(id) {
        if (!id || typeof id !== 'string') return '';
        return id.split('@')[0].split(':')[0];
    }

    _mapOperator(input) {
        if (!input) return null;
        const low = input.toLowerCase().trim();
        if (['mtn', 'm', '1'].includes(low)) return 'MTN';
        if (['moov', 'mo', 'f', 'flooz', '2'].includes(low)) return 'Moov';
        if (['celtiis', 'c', '3'].includes(low)) return 'Celtiis';
        return null;
    }
    _calculateFees(amount, serviceFee = 0) {
        const feePercent = (parseFloat(serviceFee) || 0) + 2;
        const fees = Math.round(amount * feePercent / 100);
        return {
            net: Number(amount),
            fees: Number(fees),
            total: Number(amount) + Number(fees)
        };
    }
}

export default new BotLogic();
