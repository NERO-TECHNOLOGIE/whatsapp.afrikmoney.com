import BaseHandler from '../core/BaseHandler.js';

const AFRIK_DISCLAIMER = `INFORMATION IMPORTANTE

Confidentialite : Vos donnees sont traitees de maniere securisee et confidentielle conformement aux lois en vigueur.

Conditions : En utilisant ce bot, vous acceptez nos Conditions Generales d'Utilisation (CGU) et notre politique de confidentialite.

Tapez 1 pour accepter et continuer, ou 0 pour quitter.`;

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
    async showWelcome(sock, fullId) {
        const from = this.normalizeId(fullId);
        const hasAccepted = this.state.getData(from, 'disclaimer_accepted', false);

        if (!hasAccepted) {
            this.state.setState(from, 'welcome', 'disclaimer');
            return this.sendMessage(sock, fullId, AFRIK_DISCLAIMER);
        }

        const text = [
            'Bienvenue sur Afrikmoney Bot !',
            '',
            "Votre assistant whatsapp pour gérer vos projets de paiement et payer vos marchands en toute simplicité.",
            '',
            "1- M'inscrire",
            '',
            'Tapez 1 pour commencer.'
        ].join('\n');

        this.state.setState(from, 'main_menu', 'init');
        return this.sendMessage(sock, fullId, text);
    }

    /**
     * Handle user input during the disclaimer step.
     */
    async handleDisclaimer(sock, fullId, text) {
        const from = this.normalizeId(fullId);
        if (text === '1') {
            this.state.addData(from, 'disclaimer_accepted', true);
            return this.showWelcome(sock, fullId);
        }
        if (text === '0') {
            this.state.clearState(from);
            return this.sendMessage(sock, fullId, 'Session terminée. Merci.');
        }
        return this.sendMessage(sock, fullId, 'Veuillez taper 1 pour accepter ou 0 pour quitter.');
    }

    /**
     * Begin the multi-step registration flow.
     */
    async startRegistrationFlow(sock, fullId) {
        const from = this.normalizeId(fullId);
        this.state.setState(from, 'registration', 'nom');
        return this.sendMessage(sock, fullId, 'Inscription Afrikmoney\n\nQuel est votre NOM ? (ou 0 pour annuler)');
    }

    /**
     * Handle each step of the registration flow.
     * @param {string} step - Current step: nom|prenom|telephone|whatsapp|mtn|moov|celtiis
     * @param {string} text - User input
     */
    async handleRegistration(sock, fullId, step, text, from) {
        switch (step) {
            case 'nom':
                this.state.addData(from, 'nom', text.trim());
                this.state.setState(from, 'registration', 'prenom');
                return this.sendMessage(sock, fullId, 'Quel est votre PRENOM ?');

            case 'prenom':
                this.state.addData(from, 'prenom', text.trim());
                this.state.setState(from, 'registration', 'telephone');
                return this.sendMessage(sock, fullId, 'Entrez votre NUMERO DE TELEPHONE (Commencez par 229, ex: 2290197XXXXXX) :');

            case 'telephone': {
                const tel = text.replace(/[^0-9]/g, '');
                if (!tel.startsWith('229') || tel.length < 11) {
                    return this.sendMessage(sock, fullId, 'Numéro invalide. Il doit commencer par 229 et avoir au moins 11 chiffres. Réessayez :');
                }
                const phoneExists = await this.auth.checkPhoneExists(tel);
                if (phoneExists) {
                    return this.sendMessage(sock, fullId, 'Ce numéro est déjà enregistré.');
                }
                this.state.addData(from, 'telephone', tel);
                this.state.setState(from, 'registration', 'whatsapp');
                return this.sendMessage(sock, fullId, 'Entrez votre NUMERO WHATSAPP (Commencez par 229, ex: 2290197XXXXXX) :');
            }

            case 'whatsapp': {
                const wa = text.replace(/[^0-9]/g, '');
                if (!wa.startsWith('229') || wa.length < 11) {
                    return this.sendMessage(sock, fullId, 'Numéro WhatsApp invalide. Réessayez :');
                }
                this.state.addData(from, 'whatsapp_num', wa);
                this.state.setState(from, 'registration', 'mtn');
                return this.sendMessage(sock, fullId, 'Entrez votre numéro de paiement MTN (ou 0 si aucun) :');
            }

            case 'mtn':
                this.state.addData(from, 'num_mtn', text === '0' ? null : text.trim());
                this.state.setState(from, 'registration', 'moov');
                return this.sendMessage(sock, fullId, 'Entrez votre numéro de paiement MOOV (ou 0 si aucun) :');

            case 'moov':
                this.state.addData(from, 'num_moov', text === '0' ? null : text.trim());
                this.state.setState(from, 'registration', 'celtiis');
                return this.sendMessage(sock, fullId, 'Entrez votre numéro de paiement CELTIIS (ou 0 si aucun) :');

            case 'celtiis':
                this.state.addData(from, 'num_celtiis', text === '0' ? null : text.trim());
                return this._completeRegistration(sock, fullId, from);

            default:
                return this.showWelcome(sock, fullId);
        }
    }

    /**
     * Finalize registration by calling the API and transitioning to the main menu.
     */
    async _completeRegistration(sock, fullId, from) {
        const data = this.state.getData(from);
        try {
            const user = await this.auth.registerUser({
                ...data,
                whatsapp: from,
                whatsapp_number: data.whatsapp_num
            });

            this.state.clearFlow(from);
            await this.sendMessage(sock, fullId, `Inscription réussie, ${user.prenom} !`);

            // Delegate displaying the menu back to the router (via returning the user object)
            return user;
        } catch (e) {
            console.error('[RegistrationHandler]', e);
            const errorMsg = e.response?.data?.message || 'Erreur inconnue';
            return this.sendMessage(sock, fullId, `Erreur lors de l'inscription: ${errorMsg}. Réessayez.`);
        }
    }
}

export default new RegistrationHandler();
