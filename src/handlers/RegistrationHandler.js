import BaseHandler from '../core/BaseHandler.js';
import companyRegistrationHandler from './CompanyRegistrationHandler.js';

const AFRIK_DISCLAIMER = `*INFORMATION IMPORTANTE* ⚠️

🔒 *Confidentialité* : Vos données sont traitées de manière sécurisée et confidentielle conformément aux lois en vigueur.

📋 *Conditions* : En utilisant ce bot, vous acceptez nos *Conditions Générales d'Utilisation (CGU)* et notre politique de confidentialité.`;

/**
 * RegistrationHandler - Manages the complete user onboarding flow.
 *
 * Responsible for:
 *  - Displaying the welcome/disclaimer screen
 *  - Guiding the user through step-by-step registration
 *  - Registering the user via the API
 *  - Showing the main menu after successful registration
 */
class RegistrationHandler extends BaseHandler {

    /**
     * Show the welcome or disclaimer screen.
     * If the user hasn't accepted yet, show the disclaimer first.
     */
    async showWelcome(sock, fullId, userId, sessionId) {
        const hasAccepted = this.state.getUserData(userId, 'disclaimer_accepted', false);

        if (!hasAccepted) {
            this.state.setState(sessionId, 'welcome', 'disclaimer');
            return this.sendNativeFlowMessage(
                sock, fullId,
                AFRIK_DISCLAIMER,
                'Votre réponse est requise pour continuer',
                [
                    { label: '✅ Accepter et continuer', id: '1' },
                    { label: '❌ Quitter', id: '0' },
                ]
            );
        }

        this.state.setState(sessionId, 'main_menu', 'init');
        return this.sendNativeFlowMessage(
            sock, fullId,
            '*Bienvenue sur Afrikmoney Bot !* 🎉\n\nVotre assistant WhatsApp pour gérer vos projets de paiement et payer vos marchands en toute simplicité.',
            'Commencez dès maintenant',
            [
                { label: "➕ M'inscrire", id: '1' },
            ]
        );
    }

    /**
     * Handle user input during the disclaimer step.
     */
    async handleDisclaimer(sock, fullId, text, userId, sessionId) {
        if (text === '1') {
            this.state.setUserData(userId, 'disclaimer_accepted', true);
            return this.showAccountTypeChoice(sock, fullId, sessionId);
        }
        if (text === '0') {
            this.state.clearState(sessionId);
            return this.sendMessage(sock, fullId, 'Session terminée. Merci.');
        }
        return this.sendNativeFlowMessage(
            sock, fullId,
            'Veuillez choisir une option pour continuer.',
            '',
            [
                { label: '✅ Accepter et continuer', id: '1' },
                { label: '❌ Quitter', id: '0' },
            ]
        );
    }

    /**
     * Ask whether the user wants a client account or a company/merchant account.
     * The client path below is entirely unchanged; this is the only fork point.
     */
    async showAccountTypeChoice(sock, fullId, sessionId) {
        this.state.setState(sessionId, 'welcome', 'account_type');
        return this.sendNativeFlowMessage(
            sock, fullId,
            'Très bien ! Pour commencer, dites-nous qui vous êtes :',
            '',
            [
                { label: '👤 Je suis un client', id: '1' },
                { label: '🏢 Je suis une entreprise', id: '2' },
            ]
        );
    }

    async handleAccountTypeChoice(sock, fullId, text, userId, sessionId) {
        if (text === '1') {
            return this.startRegistrationFlow(sock, fullId, sessionId);
        }
        if (text === '2') {
            return companyRegistrationHandler.startRegistrationFlow(sock, fullId, sessionId);
        }
        return this.sendNativeFlowMessage(
            sock, fullId,
            'Choix invalide. Êtes-vous un client ou une entreprise ?',
            '',
            [
                { label: '👤 Je suis un client', id: '1' },
                { label: '🏢 Je suis une entreprise', id: '2' },
            ]
        );
    }

    /**
     * Begin the multi-step registration flow.
     */
    async startRegistrationFlow(sock, fullId, sessionId) {
        this.state.setState(sessionId, 'registration', 'nom');
        return this.sendMessage(sock, fullId, '*Inscription Afrikmoney*\n\nQuel est votre *NOM* ? (ou *0* pour annuler)');
    }

    /**
     * Handle each step of the registration flow.
     * @param {string} step - Current step: nom|prenom|telephone|whatsapp|mtn|moov|celtiis
     * @param {string} text - User input
     */
    async handleRegistration(sock, fullId, step, text, sessionId) {
        switch (step) {
            case 'nom':
                if (!this._isValidPersonName(text)) {
                    return this.sendMessage(sock, fullId, 'Nom invalide. Utilisez uniquement des lettres (2 à 50 caractères). Réessayez :');
                }
                this.state.addData(sessionId, 'nom', text.trim());
                this.state.setState(sessionId, 'registration', 'prenom');
                return this.sendMessage(sock, fullId, 'Quel est votre PRENOM ?');

            case 'prenom':
                if (!this._isValidPersonName(text)) {
                    return this.sendMessage(sock, fullId, 'Prénom invalide. Utilisez uniquement des lettres (2 à 50 caractères). Réessayez :');
                }
                this.state.addData(sessionId, 'prenom', text.trim());
                this.state.setState(sessionId, 'registration', 'telephone');
                return this.sendMessage(sock, fullId, 'Entrez votre NUMERO DE TELEPHONE (Commencez par 229, ex: 2290197XXXXXX) :');

            case 'telephone': {
                if (!this._isValidBeninPhone(text)) {
                    return this.sendMessage(sock, fullId, 'Numéro invalide. Il doit commencer par 229 et avoir au moins 11 chiffres. Réessayez :');
                }
                const tel = this._normalizePhone(text);
                const phoneExists = await this.auth.checkPhoneExists(tel);
                if (phoneExists) {
                    return this.sendMessage(sock, fullId, 'Ce numéro est déjà enregistré.\n\nVeuillez entrer un autre numéro ou tapez *0* pour annuler.');
                }
                this.state.addData(sessionId, 'telephone', tel);
                this.state.setState(sessionId, 'registration', 'whatsapp');
                return this.sendMessage(sock, fullId, 'Entrez votre NUMERO WHATSAPP (Commencez par 229, ex: 2290197XXXXXX) :');
            }

            case 'whatsapp': {
                if (!this._isValidBeninPhone(text)) {
                    return this.sendMessage(sock, fullId, 'Numéro WhatsApp invalide. Réessayez :');
                }
                this.state.addData(sessionId, 'whatsapp_num', this._normalizePhone(text));
                this.state.setState(sessionId, 'registration', 'mtn');
                return this.sendMessage(sock, fullId, 'Entrez votre numéro de paiement MTN (ou 0 si aucun) :');
            }

            case 'mtn':
                if (text !== '0' && !this._isValidBeninPhone(text)) {
                    return this.sendMessage(sock, fullId, 'Numéro MTN invalide. Entrez un numéro valide, ou *0* si aucun :');
                }
                this.state.addData(sessionId, 'num_mtn', text === '0' ? null : this._normalizePhone(text));
                this.state.setState(sessionId, 'registration', 'moov');
                return this.sendMessage(sock, fullId, 'Entrez votre numéro de paiement MOOV (ou 0 si aucun) :');

            case 'moov':
                if (text !== '0' && !this._isValidBeninPhone(text)) {
                    return this.sendMessage(sock, fullId, 'Numéro MOOV invalide. Entrez un numéro valide, ou *0* si aucun :');
                }
                this.state.addData(sessionId, 'num_moov', text === '0' ? null : this._normalizePhone(text));
                this.state.setState(sessionId, 'registration', 'celtiis');
                return this.sendMessage(sock, fullId, 'Entrez votre numéro de paiement CELTIIS (ou 0 si aucun) :');

            case 'celtiis':
                if (text !== '0' && !this._isValidBeninPhone(text)) {
                    return this.sendMessage(sock, fullId, 'Numéro CELTIIS invalide. Entrez un numéro valide, ou *0* si aucun :');
                }
                this.state.addData(sessionId, 'num_celtiis', text === '0' ? null : this._normalizePhone(text));
                return this._completeRegistration(sock, fullId, sessionId);

            default: {
                const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;
                return this.showWelcome(sock, fullId, userId, sessionId);
            }
        }
    }

    /**
     * Finalize registration by calling the API and transitioning to the main menu.
     */
    async _completeRegistration(sock, fullId, sessionId) {
        const data = this.state.getData(sessionId);
        try {
            const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;
            const user = await this.auth.registerUser({
                ...data,
                whatsapp: userId,
                whatsapp_number: data.whatsapp_num
            });

            this.state.clearState(sessionId);
            this.state.setState(sessionId, 'main_menu', 'selection');
            await this.sendMessage(sock, fullId, `✅ *Bienvenue ${user.prenom} !* Votre compte AfrikMoney est prêt.`);

            return this.sendListMessage(
                sock, fullId,
                `*Bienvenue sur AFRIKMONEY* 👋\n\nBonjour *${user.prenom} ${user.nom}*\n\nQue souhaitez-vous faire ?`,
                'AfrikMoney – Paiement Mobile',
                'Voir les options',
                [
                    { label: '📁 Mes projets', id: '1', description: 'Gérer et payer vos projets' },
                    { label: '💳 Faire un paiement', id: '2', description: 'Payer un marchand ou transférer' },
                    { label: '📋 Mon historique', id: '3', description: 'Voir vos dernières transactions' },
                    { label: '👤 Mon profil', id: '4', description: 'Vos informations personnelles' },
                    { label: '➕ Créer un projet', id: '5', description: 'Nouveau projet de collecte' },
                    { label: '❓ Besoin d\'aide', id: '6', description: 'Support et assistance' },
                ]
            );
        } catch (e) {
            console.error('[RegistrationHandler]', e);
            return this.sendMessage(sock, fullId, `Erreur lors de l'inscription: ${e.message}. Réessayez.`);
        }
    }
}

export default new RegistrationHandler();
