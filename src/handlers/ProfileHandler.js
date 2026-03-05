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
     */
    async showMainMenu(sock, fullId, user, from) {
        const text = [
            'Bienvenue sur la plateforme de paiement AFRIKMONEY',
            `Bonjour ${user.prenom} ${user.nom}`,
            'Tapez un numéro pour choisir :',
            '1 - Voir mes projets',
            '2 - Faire un paiement',
            '3 - Voir mon historique',
            '4 - Mon profil',
            '5 - Créer un projet',
            "6 - Besoin d'aide"
        ].join('\n');

        this.state.clearState(from);
        this.state.setState(from, 'main_menu', 'selection');
        return this.sendMessage(sock, fullId, text);
    }

    /**
     * Display the user's profile including linked mobile money numbers.
     */
    async showProfile(sock, fullId, user) {
        const text = [
            'Mon Profil',
            '',
            'Informations personnelles :',
            `Nom : ${user.nom}`,
            `Prénom : ${user.prenom}`,
            `Numéro principal : ${user.telephone}`,
            '',
            'Comptes Mobile Money liés :',
            `MTN MOBILE MONEY : ${user.num_mtn || 'Non lié'}`,
            `FLOOZ : ${user.num_moov || 'Non lié'}`,
            `CELTIIS CASH : ${user.num_celtiis || 'Non lié'}`,
            '',
            'Tapez :',
            '-1 pour lier un compte Mobile Money',
            '-2 pour modifier mes informations',
            '-0 pour revenir au menu principal'
        ].join('\n');
        return this.sendMessage(sock, fullId, text);
    }

    /**
     * Display the payment history (last 10 transactions).
     */
    async showHistory(sock, fullId, from) {
        try {
            const history = await this.users.getHistory(from);
            const formatted = this._formatHistory(history);
            return this.sendMessage(sock, fullId, formatted);
        } catch {
            return this.sendMessage(sock, fullId, 'Impossible de récupérer votre historique.');
        }
    }

    /**
     * Display the support/help menu.
     */
    async showSupport(sock, fullId, from) {
        this.state.setState(from, 'support', 'menu');
        const text = [
            "Centre d'assistance AfrikMoney",
            'Nous sommes là pour vous aider',
            'Que souhaitez-vous faire ?',
            '',
            '1️-FAQ – Questions fréquentes',
            '2️-Contacter un conseiller',
            '3️-Signaler un problème',
            '',
            'Liens utiles :',
            "Guide d'utilisation : https://afrikmoney.com/guide",
            'Tarifs : https://afrikmoney.com/tarifs',
            '',
            'Tapez :',
            '- Le numéro de votre choix',
            '-0 pour revenir au menu principal'
        ].join('\n');
        return this.sendMessage(sock, fullId, text);
    }

    /**
     * Handle support menu selections.
     */
    async handleSupport(sock, fullId, text) {
        if (text === '1') {
            return this.sendMessage(sock, fullId, "FAQ Afrikmoney\n\n- Q: Comment payer un marchand ?\n- R: Utilisez l'option 2 du menu principal.\n\n- Q: Puis-je retirer mon argent ?\n- R: Oui, via vos comptes liés MTN/Moov.");
        }
        if (text === '2') {
            return this.sendMessage(sock, fullId, 'Contact Sponsor\n\nNotre équipe est disponible au 229XXXXXXXX ou par email à support@afrikmoney.com');
        }
        if (text === '3') {
            return this.sendMessage(sock, fullId, 'Deposer une plainte\n\nVeuillez décrire votre problème ici. Un conseiller vous recontactera.');
        }
        return null; // Signal to router to show main menu
    }

    // ===== PRIVATE =====

    _formatHistory(history) {
        if (!history || history.length === 0) {
            return 'Historique des paiements :\n\nAucune transaction trouvée.';
        }

        let text = 'Vos derniers paiements\n';
        history.slice(0, 10).forEach((t, index) => {
            const date = new Date(t.created_at).toLocaleDateString('fr-FR');
            const statusLabel = t.status === 'SUCCESS' ? 'Réussi' : (t.status === 'FAILED' ? 'Échoué' : t.status);
            text += `${index + 1} - ${date}\n`;
            text += `${t.amount} FCFA – ${t.note || 'Paiement'}\n`;
            text += `Statut : ${statusLabel}\n\n`;
        });
        text += 'Tapez :\n-0 pour revenir au menu principal';
        return text;
    }
}

export default new ProfileHandler();
