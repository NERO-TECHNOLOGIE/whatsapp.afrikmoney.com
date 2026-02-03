import stateService from './StateService.js';
import apiService from './ApiService.js';
import navigationService from './NavigationService.js';

const AFRIK_DISCLAIMER = `⚠️ *INFORMATION IMPORTANTE* ⚠️

🔒 *Confidentialité :* Vos données sont traitées de manière sécurisée et confidentielle conformément aux lois en vigueur.

⚖️ *Conditions :* En utilisant ce bot, vous acceptez nos *Conditions Générales d'Utilisation (CGU)* et notre politique de confidentialité.

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
                await this.sendMessage(sock, fullId, "Enregistrez mon contact pour ne rien manquer ! 📲");
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Disclaimer Acceptance
            if (currentFlow === 'welcome' && currentStep === 'disclaimer') {
                if (text === '1') {
                    stateService.addData(from, 'disclaimer_accepted', true);
                    return this.showWelcome(sock, fullId);
                } else if (text === '0') {
                    stateService.clearState(from);
                    return this.sendMessage(sock, fullId, "❌ Session terminée. Merci.");
                }
                return this.sendMessage(sock, fullId, "⚠️ Veuillez taper *1* pour accepter ou *0* pour quitter.");
            }

            // Cancel operation
            if (text === '0' && currentFlow !== 'main_menu') {
                stateService.clearState(from);
                return this.showMainMenu(sock, fullId);
            }

            if (!currentFlow || currentFlow === 'main_menu') {
                let user = null;
                try {
                    user = await apiService.authenticate(from);
                } catch (error) {
                    console.log(`[BotLogic] Auth check failed for ${from}`);
                }

                if (!user) {
                    const hasAccepted = stateService.getData(from, 'disclaimer_accepted', false);
                    if (!hasAccepted) return this.showWelcome(sock, fullId);

                    if (text === '1') return this.startRegistrationFlow(sock, fullId);
                    return this.showWelcome(sock, fullId);
                } else {
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
                case 'support':
                    return this.handleSupport(sock, fullId, currentStep, text);
                default:
                    return this.showMainMenu(sock, fullId);
            }
        } catch (error) {
            console.error(`[BotLogic] Error:`, error);
            await this.sendMessage(sock, fullId, "❌ Une erreur est survenue. Réessayez plus tard.");
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

        const text = "👋 *Bienvenue sur Afrikmoney Bot !*\n\n" +
            "Votre assistant pour gérer vos projets de paiement et payer vos marchands en toute simplicité.\n\n" +
            "1- M'inscrire\n\n" +
            "👉 Tapez *1* pour commencer.";
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

        let text = `🌟 *Menu Afrikmoney*\n\nBonjour *${user.nom} ${user.prenom}* !\n\n`;
        text += "1. 📁 Mes Projets & Stats\n";
        text += "2. 💸 Payer un Marchand\n";
        text += "3. 📜 Mon Historique\n";
        text += "4. 👤 Mon Profil\n";
        text += "5. 🆕 Créer un Projet\n";
        text += "6. 🆘 Aide & Support\n\n";
        text += "👉 Tapez le numéro de votre choix.";

        stateService.clearState(from);
        stateService.setState(from, 'main_menu', 'selection');
        return this.sendMessage(sock, fullId, text);
    }

    // --- REGISTRATION FLOW ---
    async startRegistrationFlow(sock, fullId) {
        const from = this.normalizeId(fullId);
        stateService.setState(from, 'registration', 'nom');
        return this.sendMessage(sock, fullId, "📝 *Inscription Afrikmoney*\n\nQuel est votre *NOM* ? (ou 0 pour annuler)");
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
                    return this.sendMessage(sock, fullId, "❌ Numéro invalide. Il doit commencer par 229 et avoir au moins 11 chiffres. Réessayez :");
                }
                const phoneExists = await apiService.checkPhoneExists(tel);
                if (phoneExists) {
                    return this.sendMessage(sock, fullId, "❌ Ce numéro est déjà enregistré.");
                }
                stateService.addData(from, 'telephone', tel);
                stateService.setState(from, 'registration', 'mtn');
                return this.sendMessage(sock, fullId, "Entrez votre numéro de paiement *MTN* (ou 'non' si aucun) :");

            case 'mtn':
                stateService.addData(from, 'num_mtn', text.toLowerCase() === 'non' ? null : text.trim());
                stateService.setState(from, 'registration', 'moov');
                return this.sendMessage(sock, fullId, "Entrez votre numéro de paiement *MOOV* (ou 'non' si aucun) :");

            case 'moov':
                stateService.addData(from, 'num_moov', text.toLowerCase() === 'non' ? null : text.trim());
                stateService.setState(from, 'registration', 'celtiis');
                return this.sendMessage(sock, fullId, "Entrez votre numéro de paiement *CELTIIS* (ou 'non' si aucun) :");

            case 'celtiis':
                stateService.addData(from, 'num_celtiis', text.toLowerCase() === 'non' ? null : text.trim());
                return this.completeRegistration(sock, fullId);
        }
    }

    async completeRegistration(sock, fullId) {
        const from = this.normalizeId(fullId);
        const data = stateService.getData(from);
        try {
            const user = await apiService.registerUser({
                ...data,
                whatsapp: from
            });
            await this.sendMessage(sock, fullId, `✅ Inscription réussie, ${user.prenom} !`);
            return this.showMainMenu(sock, fullId, user);
        } catch (e) {
            console.error(e);
            return this.sendMessage(sock, fullId, "❌ Erreur lors de l'inscription. Réessayez.");
        }
    }

    // --- MERCHANT PAYMENT FLOW ---
    async startMerchantPaymentFlow(sock, fullId) {
        const from = this.normalizeId(fullId);
        stateService.setState(from, 'merchant_payment', 'code');
        return this.sendMessage(sock, fullId, "💸 *Paiement Marchand*\n\nEntrez le CODE du marchand :");
    }

    async handleMerchantPayment(sock, fullId, step, text) {
        const from = this.normalizeId(fullId);
        switch (step) {
            case 'code':
                stateService.addData(from, 'merchant_code', text);
                stateService.setState(from, 'merchant_payment', 'object');
                return this.sendMessage(sock, fullId, "Quel est l'OBJET du paiement ?");
            case 'object':
                stateService.addData(from, 'object', text);
                stateService.setState(from, 'merchant_payment', 'amount');
                return this.sendMessage(sock, fullId, "Quel est le MONTANT à payer (FCFA) ?");
            case 'amount':
                stateService.addData(from, 'amount', text);
                stateService.setState(from, 'merchant_payment', 'source');
                return this.sendMessage(sock, fullId, "Choisissez la source de paiement :\n1. MTN\n2. Moov\n3. Celtiis");
            case 'source':
                let source = '';
                if (text === '1') source = 'MTN';
                else if (text === '2') source = 'Moov';
                else if (text === '3') source = 'Celtiis';
                else return this.sendMessage(sock, fullId, "❌ Choix invalide.");

                stateService.addData(from, 'source', source);
                stateService.setState(from, 'merchant_payment', 'confirmation');

                const data = stateService.getData(from);
                let summary = `📝 *Récapitulatif du Paiement*\n\n`;
                summary += `🔹 Marchand : ${data.merchant_code}\n`;
                summary += `🔹 Objet : ${data.object}\n`;
                summary += `🔹 Montant : ${data.amount} FCFA\n`;
                summary += `🔹 Source : ${source}\n\n`;
                summary += `✅ Tapez *1* pour CONFIRMER\n`;
                summary += `❌ Tapez *0* pour ANNULER`;
                return this.sendMessage(sock, fullId, summary);

            case 'confirmation':
                if (text === '1') {
                    const finalData = stateService.getData(from);
                    try {
                        await apiService.submitMerchantPayment(finalData, from);
                        await this.sendMessage(sock, fullId, `✅ Paiement de ${finalData.amount} FCFA effectué avec succès !`);
                        return this.showMainMenu(sock, fullId);
                    } catch (e) {
                        return this.sendMessage(sock, fullId, "❌ Échec du paiement. Vérifiez votre solde.");
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
            return this.sendMessage(sock, fullId, navigationService.formatProjectsList(projects));
        } catch (e) {
            console.error(e);
            return this.sendMessage(sock, fullId, "❌ Impossible de récupérer vos projets pour le moment.");
        }
    }

    async startProjectCreationFlow(sock, fullId) {
        const from = this.normalizeId(fullId);
        stateService.setState(from, 'create_project', 'name');
        return this.sendMessage(sock, fullId, "🆕 *Nouveau Projet*\n\nQuel nom souhaitez-vous donner à ce projet ? (ex: Scolarité, Épargne Auto)");
    }

    async handleProjectCreation(sock, fullId, step, text) {
        const from = this.normalizeId(fullId);
        switch (step) {
            case 'name':
                stateService.addData(from, 'name', text.trim());
                stateService.setState(from, 'create_project', 'target');
                return this.sendMessage(sock, fullId, "Quel est le *MONTANT CIBLE* (FCFA) ?");
            case 'target':
                if (isNaN(parseInt(text))) return this.sendMessage(sock, fullId, "❌ Veuillez entrer un montant valide.");
                stateService.addData(from, 'target_amount', parseInt(text));
                stateService.setState(from, 'create_project', 'frequency');
                return this.sendMessage(sock, fullId, "Choisissez la fréquence de rappel :\n1. Hebdomadaire\n2. Mensuel\n3. Ponctuel");
            case 'frequency':
                let freq = '';
                if (text === '1') freq = 'weekly';
                else if (text === '2') freq = 'monthly';
                else if (text === '3') freq = 'one-time';
                else return this.sendMessage(sock, fullId, "❌ Choix invalide.");

                const projectData = stateService.getData(from);
                try {
                    await apiService.createProject({ ...projectData, frequency: freq }, from);
                    await this.sendMessage(sock, fullId, `✅ Projet *${projectData.name}* créé avec succès !`);
                    return this.showMainMenu(sock, fullId);
                } catch (e) {
                    console.error(e);
                    return this.sendMessage(sock, fullId, "❌ Échec de la création du projet.");
                }
        }
    }

    // --- SUPPORT FLOW ---
    async showSupport(sock, fullId) {
        const from = this.normalizeId(fullId);
        stateService.setState(from, 'support', 'menu');
        return this.sendMessage(sock, fullId, navigationService.formatSupportMenu());
    }

    async handleSupport(sock, fullId, step, text) {
        if (text === '1') {
            return this.sendMessage(sock, fullId, "❓ *FAQ Afrikmoney*\n\n- Q: Comment payer un marchand ?\n- R: Utilisez l'option 2 du menu principal.\n\n- Q: Puis-je retirer mon argent ?\n- R: Oui, via vos comptes liés MTN/Moov.");
        } else if (text === '2') {
            return this.sendMessage(sock, fullId, "📞 *Contact Sponsor*\n\nNotre équipe est disponible au 229XXXXXXXX ou par email à support@afrikmoney.com");
        } else if (text === '3') {
            return this.sendMessage(sock, fullId, "📝 *Déposer une plainte*\n\nVeuillez décrire votre problème ici. Un conseiller vous recontactera.");
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
            return this.sendMessage(sock, fullId, "❌ Impossible de récupérer votre historique.");
        }
    }

    async showProfile(sock, fullId, user) {
        let text = `👤 *Votre Profil*\n\n`;
        text += `Nom: ${user.nom}\n`;
        text += `Prénom: ${user.prenom}\n`;
        text += `Tel: ${user.telephone}\n`;
        text += `MTN: ${user.num_mtn || 'Non lié'}\n`;
        text += `Moov: ${user.num_moov || 'Non lié'}\n`;
        text += `Celtiis: ${user.num_celtiis || 'Non lié'}\n\n`;
        text += `👉 Tapez 0 pour revenir.`;
        return this.sendMessage(sock, fullId, text);
    }

    normalizeId(id) {
        return id.split('@')[0].split(':')[0];
    }
}

export default new BotLogic();
