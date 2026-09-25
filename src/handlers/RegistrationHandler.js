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
            return this.sendClientSignupLink(sock, fullId, sessionId);
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
     * Inscription client : plus de Q&R dans le chat (source de confusion — des
     * gens ne réalisaient pas qu'ils parlaient à un bot et tapaient n'importe
     * quoi). L'inscription se fait sur une page web ; le bot confirme ensuite
     * la création du compte par un message, une fois le formulaire soumis.
     *
     * clients.whatsapp stocke le LID WhatsApp (pas un numéro de téléphone) pour
     * les comptes récents — un numéro tapé par l'utilisateur ne pourra jamais
     * correspondre (personne ne connaît/tape son propre LID). On embarque donc
     * l'identité exacte de CETTE session (fullId, déjà sous la bonne forme —
     * @lid ou @s.whatsapp.net selon ce que WhatsApp utilise ici) dans le lien,
     * pour que le formulaire n'ait rien à demander à ce sujet.
     */
    async sendClientSignupLink(sock, fullId, sessionId) {
        this.state.clearState(sessionId);
        const isLid = fullId.endsWith('@lid');
        const waId = this.normalizeId(fullId);
        const baseUrl = process.env.FRONTEND_URL || 'https://afrikmoney.com';
        const signupUrl = `${baseUrl}/inscription-client?wa=${encodeURIComponent(waId)}&lid=${isLid ? '1' : '0'}`;
        return this.sendNativeFlowMessage(
            sock, fullId,
            "*Créer mon compte AfrikMoney* 👤\n\nL'inscription se fait sur une page simple, en dehors de WhatsApp — remplissez vos informations, et je vous confirmerai ici même la création de votre compte.",
            '',
            [{ label: '📝 Créer mon compte', url: signupUrl }]
        );
    }

    /**
     * Passwordless web login/link: the site shows a "LOGIN-<token>" message for
     * the user to send here themselves (never the other way around — the bot
     * never messages a stranger first, that's what risks a ban on an unofficial
     * client like this one). Confirming identity is all this does; the backend
     * decides login vs. link and returns the message to relay, success or not.
     * Deliberately stateless: doesn't touch/require any conversation flow, so it
     * works no matter what the user was doing when they sent it.
     */
    async handleLoginToken(sock, fullId, token) {
        const isLid = fullId.endsWith('@lid');
        const waId = this.normalizeId(fullId);
        const message = await this.auth.confirmWhatsAppLogin(token, waId, isLid);
        return this.sendMessage(sock, fullId, message);
    }
}

export default new RegistrationHandler();
