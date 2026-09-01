import BaseHandler from '../core/BaseHandler.js';
import companyHandler from './CompanyHandler.js';

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'https://afrikmoney.com';

/**
 * CompanyRegistrationHandler - Onboarding flow for a business/merchant that
 * wants to receive payments through AfrikMoney, run entirely from the chat.
 *
 * Mirrors RegistrationHandler.js's shape (client onboarding) but collects
 * company-specific fields and ends by handing off to CompanyHandler for the
 * mandatory first-service creation step.
 */
class CompanyRegistrationHandler extends BaseHandler {

    /**
     * Entry point — CGU link + accept/cancel buttons.
     */
    async startRegistrationFlow(sock, fullId, sessionId) {
        this.state.setState(sessionId, 'company_registration', 'terms');
        return this.sendNativeFlowMessage(
            sock, fullId,
            "*Créer un compte Entreprise* 🏢\n\nAvec ce compte, vous pourrez recevoir des paiements de vos clients — en une fois ou en plusieurs versements — directement via AfrikMoney.\n\nAvant de continuer, merci de lire nos Conditions Générales d'Utilisation.",
            'Votre acceptation est requise pour continuer',
            [
                { label: '📄 Lire les CGU', url: `${FRONTEND_URL()}/cgu` },
                { label: "✅ J'accepte", id: '1' },
                { label: '❌ Annuler', id: '0' },
            ]
        );
    }

    /**
     * Dispatch for every step of this flow, called by MessageRouter for
     * flow === 'company_registration'.
     * @param {string} step - terms|nom_entreprise|email|ifu|mtn|moov|celtiis
     */
    async handleStep(sock, fullId, step, text, sessionId) {
        if (step === 'terms') {
            return this._handleTerms(sock, fullId, text, sessionId);
        }
        return this._handleRegistration(sock, fullId, step, text, sessionId);
    }

    async _handleTerms(sock, fullId, text, sessionId) {
        if (text === '1') {
            this.state.addData(sessionId, 'terms_accepted', true);
            this.state.setState(sessionId, 'company_registration', 'nom_entreprise');
            return this.sendMessage(sock, fullId, 'Quel est le *nom de votre entreprise* ?');
        }
        if (text === '0') {
            this.state.clearState(sessionId);
            return this.sendMessage(sock, fullId, 'Inscription annulée.');
        }
        return this.sendNativeFlowMessage(
            sock, fullId,
            "Merci d'accepter les CGU pour continuer, ou d'annuler.",
            '',
            [
                { label: '📄 Lire les CGU', url: `${FRONTEND_URL()}/cgu` },
                { label: "✅ J'accepte", id: '1' },
                { label: '❌ Annuler', id: '0' },
            ]
        );
    }

    async _handleRegistration(sock, fullId, step, text, sessionId) {
        switch (step) {
            case 'nom_entreprise':
                if (!this._isValidCompanyName(text)) {
                    return this.sendMessage(sock, fullId, "Nom invalide. Utilisez 2 à 100 caractères (lettres, chiffres, espaces, - & '). Réessayez :");
                }
                this.state.addData(sessionId, 'company_name', text.trim());
                this.state.setState(sessionId, 'company_registration', 'email');
                return this.sendMessage(sock, fullId, 'Quel est votre *email professionnel* ?');

            case 'email': {
                const email = text.trim();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    return this.sendMessage(sock, fullId, 'Email invalide. Réessayez :');
                }
                this.state.addData(sessionId, 'company_email', email);
                this.state.setState(sessionId, 'company_registration', 'ifu');
                return this.sendMessage(sock, fullId, "Quel est le numéro *IFU* de votre entreprise ? (ou *0* si vous ne l'avez pas encore)");
            }

            case 'ifu':
                if (text !== '0' && !this._isValidIfu(text)) {
                    return this.sendMessage(sock, fullId, "IFU invalide (12 à 14 chiffres attendus). Réessayez, ou *0* si vous ne l'avez pas encore :");
                }
                this.state.addData(sessionId, 'ifu', text === '0' ? null : text.replace(/\D/g, ''));
                this.state.setState(sessionId, 'company_registration', 'mtn');
                return this.sendMessage(sock, fullId, 'Numéro de réception *MTN Money* de votre entreprise ? (ou *0* si aucun)');

            case 'mtn':
                if (text !== '0' && !this._isValidBeninPhone(text)) {
                    return this.sendMessage(sock, fullId, 'Numéro MTN invalide. Entrez un numéro valide, ou *0* si aucun :');
                }
                this.state.addData(sessionId, 'num_mtn', text === '0' ? null : this._normalizePhone(text));
                this.state.setState(sessionId, 'company_registration', 'moov');
                return this.sendMessage(sock, fullId, 'Numéro de réception *Moov Money* ? (ou *0* si aucun)');

            case 'moov':
                if (text !== '0' && !this._isValidBeninPhone(text)) {
                    return this.sendMessage(sock, fullId, 'Numéro Moov invalide. Entrez un numéro valide, ou *0* si aucun :');
                }
                this.state.addData(sessionId, 'num_moov', text === '0' ? null : this._normalizePhone(text));
                this.state.setState(sessionId, 'company_registration', 'celtiis');
                return this.sendMessage(sock, fullId, 'Numéro de réception *Celtiis Cash* ? (ou *0* si aucun)');

            case 'celtiis':
                if (text !== '0' && !this._isValidBeninPhone(text)) {
                    return this.sendMessage(sock, fullId, 'Numéro Celtiis invalide. Entrez un numéro valide, ou *0* si aucun :');
                }
                this.state.addData(sessionId, 'num_celtiis', text === '0' ? null : this._normalizePhone(text));
                return this._completeRegistration(sock, fullId, sessionId);

            default:
                return this.startRegistrationFlow(sock, fullId, sessionId);
        }
    }

    async _completeRegistration(sock, fullId, sessionId) {
        const data = this.state.getData(sessionId);
        try {
            const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;
            // whatsapp is forced to the real sender identity (not asked as free text) —
            // it's the lookup key authenticateCompany() uses on every future message from
            // this chat, so it must never diverge from what the user could type here
            // (same reasoning as the client flow's registerUser({ whatsapp: userId, ... })).
            const result = await this.auth.registerCompany({
                company_name: data.company_name,
                whatsapp: userId,
                email: data.company_email,
                ifu: data.ifu,
                num_mtn: data.num_mtn,
                num_moov: data.num_moov,
                num_celtiis: data.num_celtiis,
                terms_accepted: true,
            });

            this.state.clearState(sessionId);

            // Credentials (email + generated password) are sent by email — never echoed
            // in WhatsApp, which isn't a secure channel for a password (backend already
            // emails them via CompanyCredentialsNotification on every registration).
            await this.sendMessage(sock, fullId,
                `✅ *Compte entreprise créé pour ${result.company.name} !*\n\n` +
                `🔢 Votre *code marchand* : *${result.company.merchant_code}*\n` +
                `C'est ce code que vos clients utiliseront pour vous payer ou créer un plan de paiement avec vous — communiquez-le-leur.\n\n` +
                `📧 Vos identifiants de connexion (email + mot de passe) viennent de vous être envoyés par email à *${data.company_email}*.\n\n` +
                `⏳ *Statut : en attente de vérification.* Un administrateur AfrikMoney doit valider votre compte avant que vous puissiez recevoir de vrais paiements. Vous pouvez déjà configurer votre profil en attendant.`
            );

            // Un premier service est obligatoire avant de pouvoir accéder au menu entreprise.
            return companyHandler.startServiceSetup(sock, fullId, sessionId, { isFirstService: true });
        } catch (e) {
            console.error('[CompanyRegistrationHandler]', e);
            return this.sendMessage(sock, fullId, `Erreur lors de l'inscription : ${e.message}. Tapez *0* pour recommencer.`);
        }
    }
}

export default new CompanyRegistrationHandler();
