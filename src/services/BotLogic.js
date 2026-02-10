import stateService from './StateService.js';
import apiService from './ApiService.js';
import navigationService from './NavigationService.js';

const AFRIK_DISCLAIMER = `*INFORMATION IMPORTANTE*

*Confidentialité :* Vos données sont traitées de manière sécurisée et confidentielle conformément aux lois en vigueur.

*Conditions :* En utilisant ce bot, vous acceptez nos *Conditions Générales d'Utilisation (CGU)* et notre politique de confidentialité.

Tapez *1* pour accepter et continuer, ou *0* pour quitter.`;

class BotLogic {
    async handleMessage(sock, msg) {
        const fullId = msg.key.remoteJid;
        if (!fullId || fullId === 'status@broadcast') return;

        const from = this.normalizeId(fullId);

        // Extract text from message
        const text = (msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            '').trim();

        if (!text && !msg.message?.buttonsResponseMessage && !msg.message?.templateButtonReplyMessage) return;

        try {
            await sock.sendPresenceUpdate('composing', fullId);
            await new Promise(resolve => setTimeout(resolve, 1000));
            await sock.sendPresenceUpdate('paused', fullId);
        } catch (e) {
            console.warn(`[BotLogic] Presence update error:`, e.message);
        }

        try {
            const currentFlow = stateService.getCurrentFlow(from);
            const currentStep = stateService.getCurrentStep(from);

            // Send vCard if new discussion
            if (!currentFlow && !stateService.getData(from, 'vcard_sent', false)) {
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
                return this.sendMessage(sock, fullId, "Veuillez taper *1* pour accepter ou *0* pour quitter.");
            }

            // Cancel operation
            const isSkippingRegistrationPayment = currentFlow === 'registration' && ['mtn', 'moov', 'celtiis'].includes(currentStep);
            if (text === '0' && currentFlow !== 'main_menu' && !isSkippingRegistrationPayment) {
                stateService.clearState(from);
                return this.showMainMenu(sock, fullId);
            }

            if (!currentFlow || currentFlow === 'main_menu') {
                let user = null;
                try {
                    user = await apiService.authenticate(from);
                } catch (error) {
                    console.log(`[BotLogic] Auth check failed for ${from}:`, error.message);
                    if (error.message.includes('404')) {
                        // It's expected for new users, so we don't spam them, 
                        // but for debugging let's show the ID
                        console.log(`[Debug] ID used for auth: ${from}`);
                    }
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
                        case '1': return this.showProjects(sock, fullId);
                        case '2': return this.startMerchantPaymentFlow(sock, fullId);
                        case '3': return this.showHistory(sock, fullId);
                        case '4': return this.showProfile(sock, fullId, user);
                        case '5': return this.startProjectCreationFlow(sock, fullId);
                        case '6': return this.showSupport(sock, fullId);
                        default: return this.showMainMenu(sock, fullId, user);
                    }
                }
            }

            switch (currentFlow) {
                case 'registration':
                    return this.handleRegistration(sock, fullId, currentStep, text);
                case 'merchant_payment':
                    return this.handleMerchantPayment(sock, fullId, currentStep, text);
                case 'create_project':
                    return this.handleProjectCreation(sock, fullId, currentStep, text);
                case 'projects_list':
                    return this.handleProjectListSelection(sock, fullId, currentStep, text);
                case 'project_details':
                    return this.handleProjectDetails(sock, fullId, currentStep, text);
                case 'support':
                    return this.handleSupport(sock, fullId, currentStep, text);
                default:
                    return this.showMainMenu(sock, fullId);
            }
        } catch (error) {
            console.error(`[BotLogic] Error:`, error);
            await this.sendMessage(sock, fullId, "Une erreur est survenue. Réessayez plus tard.");
        }
    }

    async sendMessage(sock, jid, text) {
        return sock.sendMessage(jid, { text });
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

    async showWelcome(sock, fullId) {
        const from = this.normalizeId(fullId);
        const hasAccepted = stateService.getData(from, 'disclaimer_accepted', false);

        if (!hasAccepted) {
            stateService.setState(from, 'welcome', 'disclaimer');
            return this.sendMessage(sock, fullId, AFRIK_DISCLAIMER);
        }

        const text = "*Bienvenue sur Afrikmoney Bot !*\n\n" +
            "Votre assistant whatsapp pour gérer vos projets de paiement et payer vos marchands en toute simplicité.\n\n" +
            "1- M'inscrire\n\n" +
            "Tapez *1* pour commencer.";
        stateService.setState(from, 'main_menu', 'init');
        return this.sendMessage(sock, fullId, text);
    }

    async showMainMenu(sock, fullId, user = null) {
        const from = this.normalizeId(fullId);
        if (!user) user = await apiService.authenticate(from);

        if (!user) {
            const hasAccepted = stateService.getData(from, 'disclaimer_accepted', false);
            if (!hasAccepted) return this.showWelcome(sock, fullId);
            return this.showWelcome(sock, fullId);
        }

        let text = `*Menu Afrikmoney*\n\nBonjour *${user.nom} ${user.prenom}* !\n\n`;
        text += "1. Mes Projets & Stats\n";
        text += "2. Payer un Marchand\n";
        text += "3. Mon Historique\n";
        text += "4. Mon Profil\n";
        text += "5. Créer un Projet\n";
        text += "6. Aide & Support\n\n";
        text += "Tapez le numéro de votre choix.";

        stateService.clearState(from);
        stateService.setState(from, 'main_menu', 'selection');
        return this.sendMessage(sock, fullId, text);
    }

    // --- REGISTRATION FLOW ---
    async startRegistrationFlow(sock, fullId) {
        const from = this.normalizeId(fullId);
        stateService.setState(from, 'registration', 'nom');
        return this.sendMessage(sock, fullId, "*Inscription Afrikmoney*\n\nQuel est votre *NOM* ? (ou 0 pour annuler)");
    }

    async handleRegistration(sock, fullId, step, text) {
        const from = this.normalizeId(fullId);
        switch (step) {
            case 'nom':
                stateService.addData(from, 'nom', text.trim());
                stateService.setState(from, 'registration', 'prenom');
                return this.sendMessage(sock, fullId, "Quel est votre *PRÉNOM* ?");

            case 'prenom':
                stateService.addData(from, 'prenom', text.trim());
                stateService.setState(from, 'registration', 'telephone');
                return this.sendMessage(sock, fullId, "Entrez votre *NUMÉRO DE TÉLÉPHONE* (Commencez par 229, ex: 2290197XXXXXX) :");

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
                return this.sendMessage(sock, fullId, "Entrez votre *NUMÉRO WHATSAPP* (Commencez par 229, ex: 2290197XXXXXX) :");

            case 'whatsapp':
                let wa = text.replace(/[^0-9]/g, '');
                if (!wa.startsWith('229') || wa.length < 11) {
                    return this.sendMessage(sock, fullId, "Numéro WhatsApp invalide. Réessayez :");
                }
                stateService.addData(from, 'whatsapp_num', wa);
                stateService.setState(from, 'registration', 'mtn');
                return this.sendMessage(sock, fullId, "Entrez votre numéro de paiement *MTN* (ou 0 si aucun) :");

            case 'mtn':
                stateService.addData(from, 'num_mtn', text === '0' ? null : text.trim());
                stateService.setState(from, 'registration', 'moov');
                return this.sendMessage(sock, fullId, "Entrez votre numéro de paiement *MOOV* (ou 0 si aucun) :");

            case 'moov':
                stateService.addData(from, 'num_moov', text === '0' ? null : text.trim());
                stateService.setState(from, 'registration', 'celtiis');
                return this.sendMessage(sock, fullId, "Entrez votre numéro de paiement *CELTIIS* (ou 0 si aucun) :");

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
                // We could send data.whatsapp_num as a separate field if needed, 
                // but the prompt emphasized "donner son numero" which we did.
                // Ensuring consistency is key for the bot.
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
    async startMerchantPaymentFlow(sock, fullId) {
        const from = this.normalizeId(fullId);
        stateService.setState(from, 'merchant_payment', 'code');
        return this.sendMessage(sock, fullId, "*Paiement Marchand*\n\nEntrez le CODE du marchand :");
    }

    async handleMerchantPayment(sock, fullId, step, text) {
        const from = this.normalizeId(fullId);
        switch (step) {
            case 'code':
                try {
                    const merchantInfo = await apiService.checkMerchant(text.trim());
                    stateService.addData(from, 'merchant_code', text.trim());
                    stateService.addData(from, 'merchant_id', merchantInfo.id);
                    stateService.addData(from, 'merchant_name', merchantInfo.company_name);
                    stateService.addData(from, 'merchant_phone', merchantInfo.merchant_phone);

                    stateService.setState(from, 'merchant_payment', 'object');
                    return this.sendMessage(sock, fullId, `Code valide : *${merchantInfo.company_name}*.\n\nQuel est l'OBJET du paiement ?`);
                } catch (e) {
                    return this.sendMessage(sock, fullId, "Code marchand invalide. Veuillez réessayer :");
                }
            case 'object':
                stateService.addData(from, 'object', text);
                stateService.setState(from, 'merchant_payment', 'amount');
                return this.sendMessage(sock, fullId, "Quel est le MONTANT à payer (FCFA) ?");
            case 'amount':
                const amount = parseInt(text.replace(/\D/g, '')); // Remove non-digits
                if (isNaN(amount) || amount < 1) {
                    return this.sendMessage(sock, fullId, "Montant invalide. Veuillez entrer un montant minimum de 1 FCFA.");
                }
                stateService.addData(from, 'amount', amount);
                stateService.setState(from, 'merchant_payment', 'source');
                return this.sendMessage(sock, fullId, "Choisissez l'opérateur mobile pour le paiement :\n1. MTN\n2. Moov\n3. Celtiis");
            case 'source':
                let source = '';
                if (text === '1') source = 'MTN';
                else if (text === '2') source = 'Moov';
                else if (text === '3') source = 'Celtiis';
                else return this.sendMessage(sock, fullId, "Choix invalide.");

                stateService.addData(from, 'source', source);
                stateService.setState(from, 'merchant_payment', 'confirmation');

                const data = stateService.getData(from);
                let summary = `*Récapitulatif du Paiement*\n\n`;
                summary += `Marchand : ${data.merchant_name} (${data.merchant_code})\n`;
                summary += `Objet : ${data.object}\n`;
                summary += `Montant : ${data.amount} FCFA\n`;
                summary += `Source : ${source}\n\n`;
                summary += `Tapez *1* pour CONFIRMER\n`;
                summary += `Tapez *0* pour ANNULER`;
                return this.sendMessage(sock, fullId, summary);

            case 'confirmation':
                if (text === '1') {
                    const finalData = stateService.getData(from);
                    try {
                        const targetPhone = finalData.merchant_phone;
                        if (!targetPhone) {
                            return this.sendMessage(sock, fullId, "Erreur: Aucun numéro de paiement associé à ce marchand.");
                        }

                        // 1. Initiate Merchant Payment
                        await this.sendMessage(sock, fullId, "⏳ Initiation du paiement en cours... Veuillez patienter.");

                        const paymentResult = await apiService.submitMerchantPayment({
                            merchant_code: finalData.merchant_code,
                            amount: parseInt(finalData.amount),
                            object: finalData.object,
                            source: finalData.source || 'MTN',
                            payer_phone: finalData.user_phone || this.normalizeId(fullId) // Use registered phone
                        }, from);

                        const reference = paymentResult.data?.reference || paymentResult.reference;

                        await this.sendMessage(sock, fullId, `Veuillez valider le paiement de ${finalData.amount} FCFA sur votre téléphone (${finalData.user_phone || this.normalizeId(fullId)}).\n\nEn attente de validation...`);

                        // 2. Poll for status
                        let attempts = 0;
                        const maxAttempts = 20; // 20 * 3s = 60s timeout
                        const pollInterval = 3000;

                        const checkStatus = async () => {
                            if (attempts >= maxAttempts) {
                                return this.sendMessage(sock, fullId, "❌ Délai d'attente dépassé. Le paiement n'a pas été confirmé.");
                            }

                            try {
                                const statusResult = await apiService.checkPaymentStatus(reference);
                                // Check deep status structure depending on API response
                                // PaymentPlanController returns { success: true, data: { status: 'SUCCESS', ... } } usually
                                // But checkPaymentStatus in Controller returns { success: true, payment: ... } or similar?
                                // Let's assume standard response structure
                                const status = statusResult.data?.status || statusResult.status; // adjust based on API

                                if (status === 'SUCCESS' || status === 'COMPLETED') {
                                    // 3. Trigger TEST Payout (as requested)
                                    await apiService.submitTestPayout({
                                        amount: parseInt(finalData.amount),
                                        phone_number: targetPhone,
                                        company_id: finalData.merchant_id,
                                        note: finalData.object
                                    }, from);

                                    await this.sendMessage(sock, fullId, `✅ Paiement validé et transféré à ${finalData.merchant_name} !`);
                                    return this.showMainMenu(sock, fullId);
                                } else if (status === 'FAILED') {
                                    return this.sendMessage(sock, fullId, "❌ Le paiement a échoué via MoMo.");
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
                            return this.sendMessage(sock, fullId, "❌ Échec de l'initiation du paiement (Erreur API MTN/Backend).\nDétails: " + errorMessage);
                        }
                        return this.sendMessage(sock, fullId, "Échec de l'initiation du paiement. " + errorMessage);
                    }
                } else {
                    stateService.clearState(from);
                    return this.showMainMenu(sock, fullId);
                }
        }
    }

    // --- PROJECT FLOW ---
    async showProjects(sock, fullId) {
        const from = this.normalizeId(fullId);
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

    async startProjectCreationFlow(sock, fullId) {
        const from = this.normalizeId(fullId);
        stateService.setState(from, 'create_project', 'merchant_code');
        return this.sendMessage(sock, fullId, "*Nouveau Projet*\n\nVeuillez entrer le *Code Marchand* de l'entreprise où vous souhaitez souscrire :");
    }

    async handleProjectCreation(sock, fullId, step, text) {
        const from = this.normalizeId(fullId);
        switch (step) {
            case 'merchant_code':
                try {
                    const merchantInfo = await apiService.checkMerchant(text.trim());
                    stateService.addData(from, 'merchant_id', merchantInfo.id);
                    stateService.addData(from, 'merchant_name', merchantInfo.company_name);
                    stateService.addData(from, 'company_code', text.trim());

                    // Check if there are services
                    if (merchantInfo.services && merchantInfo.services.length > 0) {
                        stateService.addData(from, 'cached_services', merchantInfo.services);
                        stateService.setState(from, 'create_project', 'service');

                        let serviceList = `*Services chez ${merchantInfo.company_name}*\n\nVeuillez choisir un service :\n\n`;
                        merchantInfo.services.forEach((s, i) => {
                            serviceList += `${i + 1}. ${s.name}\n`;
                        });
                        return this.sendMessage(sock, fullId, serviceList);
                    } else {
                        stateService.setState(from, 'create_project', 'name');
                        return this.sendMessage(sock, fullId, `Code valide : *${merchantInfo.company_name}*.\n\nQuel est le *NOM* de votre projet ?`);
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
                return this.sendMessage(sock, fullId, `Service sélectionné : *${selectedService.name}*.\n\nQuel est le *MONTANT TOTAL CIBLE* (FCFA) ?`);

            case 'name':
                stateService.addData(from, 'name', text.trim());
                stateService.setState(from, 'create_project', 'target');
                return this.sendMessage(sock, fullId, "Quel est le *MONTANT TOTAL CIBLE* (FCFA) ?");

            case 'target':
                const totalAmount = parseInt(text.replace(/\D/g, ''));
                if (isNaN(totalAmount) || totalAmount < 1) return this.sendMessage(sock, fullId, "Veuillez entrer un montant total valide.");
                stateService.addData(from, 'target_amount', totalAmount);
                stateService.setState(from, 'create_project', 'frequency');
                return this.sendMessage(sock, fullId, "Choisissez la fréquence de rappel :\n1. Quotidien\n2. Hebdomadaire\n3. Mensuel\n4. Annuel");

            case 'frequency':
                let freq = '';
                if (text === '1') freq = 'daily';
                else if (text === '2') freq = 'weekly';
                else if (text === '3') freq = 'monthly';
                else if (text === '4') freq = 'yearly';
                else return this.sendMessage(sock, fullId, "Choix invalide.");

                stateService.addData(from, 'frequency', freq);
                stateService.setState(from, 'create_project', 'installment');
                return this.sendMessage(sock, fullId, "Quel est le *MONTANT DE CHAQUE VERSEMENT* (FCFA) ?");

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

                        await this.sendMessage(sock, fullId, `✅ Projet *${projectData.name}* créé avec succès !`);
                        return this.showMainMenu(sock, fullId);
                    } catch (e) {
                        console.error(e);
                        return this.sendMessage(sock, fullId, `❌ Échec de la création du projet : ${e.message}`);
                    }
                } else if (text === '0') {
                    return this.showMainMenu(sock, fullId);
                } else {
                    return this.sendMessage(sock, fullId, "Tapez *1* pour confirmer ou *0* pour annuler.");
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

        for (let i = 0; i < installments; i++) {
            let pDate = new Date(startDate);
            if (data.frequency === 'daily') {
                pDate.setDate(startDate.getDate() + i);
                freqLabel = 'chaque jour';
            } else if (data.frequency === 'weekly') {
                pDate.setDate(startDate.getDate() + i * 7);
                freqLabel = 'chaque semaine';
            } else if (data.frequency === 'monthly') {
                pDate.setMonth(startDate.getMonth() + i);
                freqLabel = 'chaque mois';
            } else if (data.frequency === 'yearly') {
                pDate.setFullYear(startDate.getFullYear() + i);
                freqLabel = 'chaque année';
            } else {
                freqLabel = 'une fois';
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

        let recap = `*RECAPITULATIF DU PROJET*\n\n`;
        recap += `📌 *Nom :* ${data.name}\n`;
        recap += `🏢 *Marchand :* ${data.merchant_name}\n`;
        recap += `💰 *Cible :* ${data.target_amount} FCFA\n`;
        recap += `📅 *Fréquence :* ${freqLabel}\n`;
        recap += `💵 *Versement :* ${data.amount} FCFA\n`;
        recap += `🔢 *Nombre de versements :* ${installments}\n`;
        recap += `🏁 *Date de fin prévue :* ${new Date(data.end_date).toLocaleDateString('fr-FR')}\n\n`;

        recap += `*PLAN DE PAIEMENT PRÉVISIONNEL :*\n`;

        for (let i = 0; i < schedule.length; i++) {
            if (schedule.length > 6 && i >= 3 && i < schedule.length - 3) {
                if (i === 3) recap += `... (suite des paiements) ...\n`;
                continue;
            }

            const item = schedule[i];
            recap += `- ${new Date(item.date).toLocaleDateString('fr-FR')} : ${item.amount} FCFA\n`;
        }

        recap += `\nTapez *1* pour confirmer la création ou *0* pour annuler.`;
        return recap;
    }

    async handleProjectListSelection(sock, fullId, step, text) {
        const from = this.normalizeId(fullId);
        const projects = stateService.getData(from, 'cached_projects', []);

        const selection = parseInt(text);
        if (isNaN(selection) || selection < 1 || selection > projects.length) {
            return this.sendMessage(sock, fullId, "Choix invalide. Veuillez taper le numéro du projet.");
        }

        const project = projects[selection - 1];
        stateService.addData(from, 'selected_project', project);
        stateService.setState(from, 'project_details', 'options');

        const progress = project.target_amount > 0 ? (project.current_amount / project.target_amount) * 100 : 0;
        const bar = navigationService._generateProgressBar(progress);

        let recap = `📂 *Détails du Projet : ${project.name}*\n\n`;
        recap += `👤 Client : ${project.client_name}\n`;
        recap += `🏢 Marchand : ${project.company?.name || 'N/A'}\n`;
        recap += `📖 Objet : ${project.description || project.subject}\n\n`;
        recap += `💰 Progression : ${project.current_amount} / ${project.target_amount} FCFA\n`;
        recap += `📊 ${bar} ${progress.toFixed(0)}%\n`;
        recap += `📅 Prochaine échéance : ${project.next_payment || 'N/A'}\n`;
        recap += `💳 Montant échéance : ${project.amount} FCFA\n\n`;
        recap += "1️⃣ *Payer l'échéance maintenant*\n";
        recap += "0️⃣ *Retour au menu principal*";

        return this.sendMessage(sock, fullId, recap);
    }

    async handleProjectDetails(sock, fullId, step, text) {
        const from = this.normalizeId(fullId);
        if (text === '1') {
            return this.startPlanPaymentFlow(sock, fullId);
        } else if (text === '0') {
            stateService.clearState(from);
            return this.showMainMenu(sock, fullId);
        }
        return this.sendMessage(sock, fullId, "Choix invalide. Tapez 1 pour payer ou 0 pour quitter.");
    }

    async startPlanPaymentFlow(sock, fullId) {
        const from = this.normalizeId(fullId);
        const project = stateService.getData(from, 'selected_project');

        stateService.addData(from, 'merchant_code', project.company?.merchant_code);
        stateService.addData(from, 'merchant_id', project.company?.id);
        stateService.addData(from, 'merchant_name', project.company?.name);
        stateService.addData(from, 'merchant_phone', project.company?.merchant_phone);
        stateService.addData(from, 'amount', project.amount);
        stateService.addData(from, 'object', `Échéance Projet: ${project.name}`);
        stateService.addData(from, 'payment_plan_id', project.id);

        stateService.setState(from, 'merchant_payment', 'source');
        return this.sendMessage(sock, fullId, "Choisissez l'opérateur mobile pour le paiement :\n1. MTN\n2. Moov\n3. Celtiis");
    }

    // --- SUPPORT FLOW ---
    async showSupport(sock, fullId) {
        const from = this.normalizeId(fullId);
        stateService.setState(from, 'support', 'menu');
        return this.sendMessage(sock, fullId, navigationService.formatSupportMenu());
    }

    async handleSupport(sock, fullId, step, text) {
        if (text === '1') {
            return this.sendMessage(sock, fullId, "*FAQ Afrikmoney*\n\n- Q: Comment payer un marchand ?\n- R: Utilisez l'option 2 du menu principal.\n\n- Q: Puis-je retirer mon argent ?\n- R: Oui, via vos comptes liés MTN/Moov.");
        } else if (text === '2') {
            return this.sendMessage(sock, fullId, "*Contact Sponsor*\n\nNotre équipe est disponible au 229XXXXXXXX ou par email à support@afrikmoney.com");
        } else if (text === '3') {
            return this.sendMessage(sock, fullId, "*Déposer une plainte*\n\nVeuillez décrire votre problème ici. Un conseiller vous recontactera.");
        } else {
            return this.showMainMenu(sock, fullId);
        }
    }

    async showHistory(sock, fullId) {
        const from = this.normalizeId(fullId);
        try {
            const history = await apiService.getHistory(from);
            return this.sendMessage(sock, fullId, navigationService.formatHistoryList(history));
        } catch (e) {
            return this.sendMessage(sock, fullId, "Impossible de récupérer votre historique.");
        }
    }

    async showProfile(sock, fullId, user) {
        let text = `*Votre Profil*\n\n`;
        text += `Nom: ${user.nom}\n`;
        text += `Prénom: ${user.prenom}\n`;
        text += `Tel: ${user.telephone}\n`;
        text += `MTN: ${user.num_mtn || 'Non lié'}\n`;
        text += `Moov: ${user.num_moov || 'Non lié'}\n`;
        text += `Celtiis: ${user.num_celtiis || 'Non lié'}\n\n`;
        text += `Tapez 0 pour revenir.`;
        return this.sendMessage(sock, fullId, text);
    }

    normalizeId(id) {
        return id.split('@')[0].split(':')[0];
    }
}

export default new BotLogic();
