import BaseHandler from '../core/BaseHandler.js';

/**
 * ProfileHandler - Manages user profile and transaction history.
 *
 * Responsible for:
 *  - Displaying the user profile (name, linked phone numbers)
 *  - Displaying payment history
 *  - Displaying and handling the support menu
 *  - Displaying the authenticated main menu
 */
class ProfileHandler extends BaseHandler {

    /**
     * Display the main menu for an authenticated user.
     * @param {Object} user - Authenticated user object from the API
     * @param {string} sessionId - Normalized session ID
     */
    async showMainMenu(sock, fullId, user, sessionId) {
        this.state.clearState(sessionId);
        this.state.setState(sessionId, 'main_menu', 'selection');
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
                { label: '🪪 Vérifier mon identité', id: '7', description: 'Vérification KYC de votre compte' },
                { label: '🌐 Mon espace web', id: '8', description: 'Accéder à votre tableau de bord' },
            ]
        );
    }

    /**
     * Display the user's profile including linked mobile money numbers.
     * @param {Object} user - Authenticated user object
     * @param {string} sessionId - Normalized session ID
     */
    async showProfile(sock, fullId, user, sessionId) {
        this.state.setState(sessionId, 'profile', 'selection');

        const text = [
            '*Mon Profil*',
            '',
            '*Informations personnelles* :',
            `Nom : *${user.nom}*`,
            `Prénom : *${user.prenom}*`,
            `Numéro principal : *${user.telephone}*`,
            '',
            '*Comptes Mobile Money liés* :',
            `MTN MOBILE MONEY : *${user.num_mtn || 'Non lié'}*`,
            `FLOOZ : *${user.num_moov || 'Non lié'}*`,
            `CELTIIS CASH : *${user.num_celtiis || 'Non lié'}*`,
            '',
            'Tapez :',
            '- *1* pour modifier mes informations',
            '- *0* pour revenir au menu principal'
        ].join('\n');
        return this.sendMessage(sock, fullId, text);
    }

    /**
     * Handle selections in the profile menu.
     */
    async handleProfile(sock, fullId, text, sessionId) {
        if (text === '1') {
            return this.sendMessage(sock, fullId, "La modification de votre profil est uniquement disponible sur la plateforme web.\n\nTapez *0* pour revenir au menu principal.");
        }
        if (text === '0') {
            this.state.clearState(sessionId);
            return null; // Show main menu
        }
        return this.sendMessage(sock, fullId, "Choix invalide. Tapez *1* pour modifier ou *0* pour revenir.");
    }

    /**
     * Display the payment history (last 10 transactions).
     */
    async showHistory(sock, fullId, sessionId) {
        const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;
        try {
            const history = await this.users.getHistory(userId);
            this.state.setState(sessionId, 'history', 'viewing');
            const formatted = this._formatHistory(history);
            return this.sendMessage(sock, fullId, formatted);
        } catch {
            this.state.clearState(sessionId);
            return this.sendMessage(sock, fullId, '⚠️ Impossible de récupérer votre historique. Tapez *0* pour revenir au menu.');
        }
    }

    /**
     * Display the support/help menu.
     */
    async showSupport(sock, fullId, sessionId) {
        this.state.setState(sessionId, 'support', 'menu');
        return this.sendListMessage(
            sock, fullId,
            "*Centre d'assistance AfrikMoney* 🛟\n\nNous sommes là pour vous aider.\nQue souhaitez-vous faire ?",
            'AfrikMoney – Support',
            'Voir les options',
            [
                { label: '❓ FAQ', id: '1', description: 'Questions fréquentes' },
                { label: '📞 Contacter un conseiller', id: '2', description: 'Parler à notre équipe' },
                { label: '⚠️ Signaler un problème', id: '3', description: 'Déposer une réclamation' },
                { label: '🏠 Menu principal', id: '0', description: 'Retour au menu' },
            ]
        );
    }

    /**
     * Handle support menu selections.
     */
    async handleSupport(sock, fullId, text, sessionId) {
        if (text === '1') {
            await this.sendMessage(sock, fullId, "*FAQ Afrikmoney*\n\n- Q: Comment payer un marchand ?\n  R: Utilisez l'option *Faire un paiement* du menu.\n\n- Q: Puis-je retirer mon argent ?\n  R: Oui, via vos comptes liés MTN/Moov.");
            return this.showSupport(sock, fullId, sessionId);
        }
        if (text === '2') {
            await this.sendMessage(sock, fullId, '*Contacter notre équipe*\n\nNotre équipe est disponible :\n📞 229 XX XX XX XX\n📧 support@afrikmoney.com');
            return this.showSupport(sock, fullId, sessionId);
        }
        if (text === '3') {
            await this.sendMessage(sock, fullId, '*Signaler un problème*\n\nVeuillez décrire votre problème ici. Un conseiller vous recontactera dans les plus brefs délais.');
            return this.showSupport(sock, fullId, sessionId);
        }
        if (text === '0') {
            this.state.clearState(sessionId);
            return null; // Show main menu
        }
        return this.showSupport(sock, fullId, sessionId);
    }

    /**
     * Generate a personalized KYC link and send it to the user.
     */
    async sendKycLink(sock, fullId, sessionId) {
        const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;

        try {
            const result = await this.payments.getKycLink(userId);
            const data   = result?.data;

            if (!result.success || !data?.url) {
                if (data?.kyc_level === 2) {
                    return this.sendMessage(sock, fullId,
                        'Votre identité est deja verifiee. Votre compte beneficie de limites de paiement etendues.'
                    );
                }
                return this.sendMessage(sock, fullId,
                    'Impossible de generer votre lien KYC pour le moment. Tapez *0* pour revenir au menu.'
                );
            }

            const kycLevel = data.kyc_level ?? 0;
            const statusLine = kycLevel === 1
                ? 'Votre dossier est en cours de verification.'
                : kycLevel === 0
                    ? 'Votre compte n\'est pas encore verifie.'
                    : '';

            return this.sendNativeFlowMessage(
                sock, fullId,
                `*Verification d\'identite (KYC)*\n\n${statusLine ? statusLine + '\n\n' : ''}Cliquez sur le bouton ci-dessous pour soumettre vos documents. Le lien expire dans 1 heure.\n\n_Vos documents seront traites dans les 24 a 48 heures suivant la soumission._`,
                'AfrikMoney — KYC',
                [
                    { label: 'Verifier mon identite', url: data.url },
                    { label: 'Retour au menu', id: '0' },
                ]
            );
        } catch (err) {
            console.error('[ProfileHandler] KYC link error:', err.message);
            return this.sendMessage(sock, fullId,
                'Une erreur est survenue. Tapez *0* pour revenir au menu.'
            );
        }
    }

    /**
     * Generate a personalized magic link to the web dashboard and send it.
     */
    async sendDashboardLink(sock, fullId, sessionId) {
        const userId = sessionId.includes(':') ? sessionId.split(':').pop() : sessionId;

        try {
            const result = await this.payments.getDashboardLink(userId);
            const data   = result?.data;

            if (!result.success || !data?.url) {
                return this.sendMessage(sock, fullId,
                    'Impossible de generer votre lien pour le moment. Tapez *0* pour revenir au menu.'
                );
            }

            return this.sendNativeFlowMessage(
                sock, fullId,
                `*Mon espace web*\n\nCliquez sur le bouton ci-dessous pour acceder directement a votre tableau de bord. Le lien expire dans 1 heure.`,
                'AfrikMoney — Dashboard',
                [
                    { label: 'Acceder a mon dashboard', url: data.url },
                    { label: 'Retour au menu', id: '0' },
                ]
            );
        } catch (err) {
            console.error('[ProfileHandler] Dashboard link error:', err.message);
            return this.sendMessage(sock, fullId,
                'Une erreur est survenue. Tapez *0* pour revenir au menu.'
            );
        }
    }

    // ===== PRIVATE =====

    _formatHistory(history) {
        if (!history || history.length === 0) {
            return 'Historique des paiements :\n\nAucune transaction trouvée.';
        }

        let text = '*Vos derniers paiements*\n\n';
        history.slice(0, 10).forEach((t, index) => {
            const date = new Date(t.created_at).toLocaleDateString('fr-FR');
            const statusLabel = t.status === 'SUCCESS' ? 'Réussi' : (t.status === 'FAILED' ? 'Échoué' : t.status);
            text += `${index + 1}. *${date}*\n`;
            text += `   *${t.amount} FCFA* – ${t.note || 'Paiement'}\n`;
            text += `   Statut : *${statusLabel}*\n\n`;
        });
        text += 'Tapez :\n- *0* pour revenir au menu principal';
        return text;
    }
}

export default new ProfileHandler();
