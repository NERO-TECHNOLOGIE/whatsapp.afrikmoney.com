import BaseHandler from '../core/BaseHandler.js';
import navigationService from '../services/NavigationService.js';

/**
 * ProjectHandler - Manages project creation and navigation.
 *
 * Responsible for:
 *  - Displaying the user's project list
 *  - Guiding through the project creation flow
 *  - Displaying detailed project view
 *  - Starting a plan installment payment
 */
class ProjectHandler extends BaseHandler {

    /**
     * Fetch and display the user's project list.
     */
    async showProjects(sock, fullId, from) {
        try {
            let projects = await this.projects.getProjects(from);

            // Filter out completed projects and sort by created_at descending
            projects = projects
                .filter(p => (Number(p.current_amount) || 0) < (Number(p.target_amount) || 0))
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            this.state.setState(from, 'projects_list', 'selection');
            this.state.addData(from, 'cached_projects', projects);
            return this.sendMessage(sock, fullId, navigationService.formatProjectsList(projects));
        } catch (e) {
            console.error('[ProjectHandler]', e);
            return this.sendMessage(sock, fullId, 'Impossible de récupérer vos projets pour le moment.');
        }
    }

    /**
     * Begin the project creation flow.
     */
    async startProjectCreationFlow(sock, fullId, from) {
        this.state.setState(from, 'create_project', 'merchant_code');
        const text = [
            '*Créer un nouveau projet de paiement*',
            '',
            "Pour commencer, entrez le *code marchand* de l'entreprise chez qui vous souhaitez souscrire.",
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
     * Handle each step of the project creation flow.
     */
    async handleProjectCreation(sock, fullId, step, text, from) {
        switch (step) {
            case 'merchant_code':
                return this._handleMerchantCodeStep(sock, fullId, text, from);

            case 'service':
                return this._handleServiceStep(sock, fullId, text, from);

            case 'name':
                this.state.addData(from, 'name', text.trim());
                this.state.setState(from, 'create_project', 'target');
                return this.sendMessage(sock, fullId, "Tapez :\n- Le *montant total* que vous souhaitez payer au final (en FCFA)\n- *0* pour revenir au menu principal\n\n⚠️ *Important* : N'ajoutez pas d'espace ni de symbole.");

            case 'target':
                return this._handleTargetStep(sock, fullId, text, from);

            case 'frequency':
                return this._handleFrequencyStep(sock, fullId, text, from);

            case 'installment':
                return this._handleInstallmentStep(sock, fullId, text, from);

            case 'confirmation':
                return this._handleConfirmationStep(sock, fullId, text, from);
        }
    }

    /**
     * Handle project selection from the list.
     */
    async handleProjectListSelection(sock, fullId, text, from) {
        const projects = this.state.getData(from, 'cached_projects', []);
        const selection = parseInt(text);
        if (isNaN(selection) || selection < 1 || selection > projects.length) {
            return this.sendMessage(sock, fullId, 'Choix invalide. Veuillez taper le numéro du projet.');
        }
        return this.showProjectDetails(sock, fullId, projects[selection - 1]);
    }

    /**
     * Display the details of a single project.
     */
    async showProjectDetails(sock, fullId, project) {
        const from = this.normalizeId(fullId);
        this.state.addData(from, 'selected_project', project);
        this.state.setState(from, 'project_details', 'options');

        const current = Number(project.current_amount) || 0;
        const target = Number(project.target_amount) || 0;
        const isCompleted = current >= target;
        const progress = target > 0 ? (current / target) * 100 : 0;
        const bar = navigationService._generateProgressBar(progress);

        let text = '*Détail du projet*\n';
        text += `Client : *${project.client_name}*\n`;
        text += `Marchand : *${project.company?.name || 'N/A'}*\n`;
        text += `Objet : *${project.description || project.subject}*\n`;
        text += `Progression : *${project.current_amount}* / *${project.target_amount} FCFA*\n`;
        text += `${bar} *${progress.toFixed(0)}%*\n`;

        if (isCompleted) {
            text += '\n*Objectif atteint - Paiement clos*\n\n';
        } else {
            text += `Prochaine échéance : *${project.next_payment || 'N/A'}*\n`;
            text += `Montant à payer : *${project.amount} FCFA*\n\n`;
            text += "Tapez :\n- *1* pour payer l'échéance maintenant\n";
        }
        text += '- *0* pour revenir au menu principal';

        return this.sendMessage(sock, fullId, text);
    }

    /**
     * Handle interactions in the project details view.
     */
    async handleProjectDetails(sock, fullId, text, from) {
        const project = this.state.getData(from, 'selected_project');
        const isCompleted = project && Number(project.current_amount) >= Number(project.target_amount);

        if (text === '1' && !isCompleted) {
            return this.startPlanPaymentFlow(sock, fullId, from);
        }
        if (text === '0') {
            this.state.clearState(from);
            return null; // Signal to router to show main menu
        }

        const msg = isCompleted
            ? 'Ce projet est deja termine. Tapez 0 pour revenir.'
            : 'Choix invalide. Tapez 1 pour payer ou 0 pour quitter.';
        return this.sendMessage(sock, fullId, msg);
    }

    /**
     * Begin the payment flow for a specific project installment.
     */
    async startPlanPaymentFlow(sock, fullId, from) {
        const project = this.state.getData(from, 'selected_project');
        this.state.addData(from, 'merchant_code', project.company?.merchant_code);
        this.state.addData(from, 'merchant_id', project.company?.id);
        this.state.addData(from, 'merchant_name', project.company?.name);
        this.state.addData(from, 'merchant_phone', project.company?.merchant_phone);
        this.state.addData(from, 'service_fee', project.company?.service_fee || 0);
        this.state.addData(from, 'amount', project.amount);
        this.state.addData(from, 'object', `Echeance Projet: ${project.name}`);
        this.state.addData(from, 'payment_plan_id', project.id);

        this.state.setState(from, 'merchant_payment', 'source');
        return this.sendMessage(sock, fullId, "*Choix de l'opérateur*\n\nChoisissez l'opérateur mobile pour le paiement :\n1. *MTN MOBILE MONEY*\n2. *FLOOZ*\n3. *CELTIIS CASH*");
    }

    // ===== PRIVATE STEP HANDLERS =====

    async _handleMerchantCodeStep(sock, fullId, text, from) {
        try {
            const merchantInfo = await this.merchants.checkMerchant(text.trim());
            this.state.addData(from, 'merchant_id', merchantInfo.id);
            this.state.addData(from, 'merchant_name', merchantInfo.company_name);
            this.state.addData(from, 'company_code', text.trim());
            this.state.addData(from, 'service_fee', merchantInfo.service_fee || 0);

            if (merchantInfo.services && merchantInfo.services.length > 0) {
                this.state.addData(from, 'cached_services', merchantInfo.services);
                this.state.setState(from, 'create_project', 'service');

                let serviceList = `*${merchantInfo.company_name}*\n`;
                serviceList += '_Services disponibles_\n';
                serviceList += 'Choisissez le service pour lequel vous souhaitez créer un projet :\n\n';
                merchantInfo.services.forEach((s, i) => {
                    serviceList += `*${i + 1}*- ${s.name}\n`;
                });
                serviceList += '\nTapez :\n- Le *numéro* du service choisi\n- *0* pour revenir au menu principal';
                return this.sendMessage(sock, fullId, serviceList);
            } else {
                this.state.clearFlow(from);
                return this.sendMessage(sock, fullId, `Ce marchand (${merchantInfo.company_name}) n'a aucun service disponible pour le moment.`);
            }
        } catch {
            return this.sendMessage(sock, fullId, 'Code marchand invalide. Veuillez réessayer :');
        }
    }

    async _handleServiceStep(sock, fullId, text, from) {
        const services = this.state.getData(from, 'cached_services', []);
        const selection = parseInt(text);
        if (isNaN(selection) || selection < 1 || selection > services.length) {
            return this.sendMessage(sock, fullId, 'Choix invalide. Veuillez répondre avec le numéro du service.');
        }
        const selectedService = services[selection - 1];
        const sId = selectedService.id ?? selectedService._id ?? selectedService.service_id ?? selectedService.ulid;
        this.state.addData(from, 'service_id', sId);
        this.state.addData(from, 'service_name', selectedService.name);
        this.state.addData(from, 'name', selectedService.name);
        this.state.setState(from, 'create_project', 'target');
        return this.sendMessage(sock, fullId, `*Service sélectionné : ${selectedService.name}*\n\nTapez :\n- Le *montant total* que vous souhaitez payer au final (en FCFA)\n- *0* pour revenir au menu principal\n\n*Important* : N'ajoutez pas d'espace ni de symbole.`);
    }

    async _handleTargetStep(sock, fullId, text, from) {
        const totalAmount = parseInt(text.replace(/\D/g, ''));
        if (isNaN(totalAmount) || totalAmount < 1) {
            return this.sendMessage(sock, fullId, 'Veuillez entrer un montant total valide.');
        }
        this.state.addData(from, 'target_amount', totalAmount);
        this.state.setState(from, 'create_project', 'frequency');
        const freqText = '*Fréquence de paiement*\n\nÀ quelle fréquence souhaitez-vous effectuer vos paiements ?\n\n1- *Quotidien* (chaque jour)\n2- *Hebdomadaire* (chaque semaine)\n3- *Mensuel* (chaque mois)\n4- *Annuel* (une fois par an)\n\nTapez :\n- Le *numéro* correspondant à votre choix\n- *0* pour revenir au menu principal';
        return this.sendMessage(sock, fullId, freqText);
    }

    async _handleFrequencyStep(sock, fullId, text, from) {
        const freqMap = { '1': 'daily', '2': 'weekly', '3': 'monthly', '4': 'yearly' };
        const freq = freqMap[text];
        if (!freq) return this.sendMessage(sock, fullId, 'Choix invalide.');
        this.state.addData(from, 'frequency', freq);
        this.state.setState(from, 'create_project', 'installment');
        return this.sendMessage(sock, fullId, '*Montant par versement*\n\nEntrez le montant que vous souhaitez payer à chaque échéance (en FCFA).\n\nTapez :\n- Le *montant* de chaque versement\n- *0* pour revenir au menu principal');
    }

    async _handleInstallmentStep(sock, fullId, text, from) {
        const installment = parseInt(text.replace(/\D/g, ''));
        if (isNaN(installment) || installment < 1) {
            return this.sendMessage(sock, fullId, 'Veuillez entrer un montant de versement valide.');
        }
        this.state.addData(from, 'amount', installment);
        const recap = this._generateProjectRecap(from);
        this.state.setState(from, 'create_project', 'confirmation');
        return this.sendMessage(sock, fullId, recap);
    }

    async _handleConfirmationStep(sock, fullId, text, from) {
        if (text === '0') return null; // Signal to router to show main menu
        if (text !== '1') return this.sendMessage(sock, fullId, 'Tapez 1 pour confirmer ou 0 pour annuler.');

        const projectData = this.state.getData(from);
        try {
            await this.projects.createProject({
                service_id: projectData.service_id,
                name: projectData.name,
                target_amount: projectData.target_amount,
                amount: projectData.amount,
                frequency: projectData.frequency,
                start_date: projectData.start_date,
                end_date: projectData.end_date,
                due_date: projectData.end_date,
                schedule: projectData.schedule,
                is_personal: 0,
                reminder_method: 'whatsapp',
                company_code: projectData.company_code,
                subject: projectData.name
            }, from);

            const freqLabels = { daily: 'Quotidienne', weekly: 'Hebdomadaire', monthly: 'Mensuelle', yearly: 'Annuelle' };
            let successText = `*Projet créé avec succès !*\n\n`;
            successText += `Projet : *${projectData.name}*\n`;
            successText += `Service : *${projectData.name}*\n`;
            successText += `Marchand : *${projectData.merchant_name}*\n`;
            successText += `Objectif : *${projectData.target_amount} FCFA*\n`;
            successText += `Fréquence : *${freqLabels[projectData.frequency] || projectData.frequency}*\n`;
            successText += `Versement : *${projectData.amount} FCFA*\n`;
            successText += `Prochaine échéance : *${new Date(projectData.start_date).toLocaleDateString('fr-FR')}*\n\n`;
            successText += 'Tapez :\n- *1* pour payer la première échéance\n- *0* pour revenir au menu principal';

            await this.sendMessage(sock, fullId, successText);
            this.state.clearFlow(from);
        } catch (e) {
            console.error('[ProjectHandler]', e);
            return this.sendMessage(sock, fullId, `Echec de la creation du projet : ${e.message}`);
        }
    }

    /**
     * Generate the payment plan recap message and compute schedule dates.
     * Also stores computed schedule/dates in state for later API submission.
     */
    _generateProjectRecap(from) {
        const data = this.state.getData(from);
        const installments = Math.ceil(data.target_amount / data.amount);
        const startDate = new Date();
        const schedule = [];

        data.start_date = startDate.toISOString().split('T')[0];

        const freqConfig = {
            daily: { label: 'chaque jour', display: 'Quotidienne', advance: (d, i) => d.setDate(startDate.getDate() + i) },
            weekly: { label: 'chaque semaine', display: 'Hebdomadaire', advance: (d, i) => d.setDate(startDate.getDate() + i * 7) },
            monthly: { label: 'chaque mois', display: 'Mensuelle', advance: (d, i) => d.setMonth(startDate.getMonth() + i) },
            yearly: { label: 'chaque année', display: 'Annuelle', advance: (d, i) => d.setFullYear(startDate.getFullYear() + i) }
        };
        const fc = freqConfig[data.frequency] || { label: 'une fois', display: 'Unique', advance: () => { } };

        for (let i = 0; i < installments; i++) {
            const pDate = new Date(startDate);
            fc.advance(pDate, i);
            const isLast = i === installments - 1;
            const remainder = data.target_amount % data.amount;
            schedule.push({
                date: pDate.toISOString().split('T')[0],
                amount: isLast && remainder !== 0 ? remainder : data.amount
            });
        }

        const lastInstallment = schedule[schedule.length - 1];
        this.state.addData(from, 'end_date', lastInstallment.date);
        this.state.addData(from, 'start_date', data.start_date);
        this.state.addData(from, 'schedule', schedule);

        const fees = this._calculateFees(data.amount, data.service_fee || 0);
        let recap = `*Récapitulatif du projet*\n\n`;
        recap += `Service : *${data.name}*\n`;
        recap += `Marchand : *${data.merchant_name}*\n`;
        recap += `Montant total : *${data.target_amount} FCFA*\n`;
        recap += `Fréquence : *${fc.display}*\n`;
        recap += `Versement : *${fees.total} FCFA* (${fees.net} + ${fees.fees} frais)\n`;
        recap += `Versements prévus : *${installments}*\n`;
        recap += `Date de fin : *${new Date(lastInstallment.date).toLocaleDateString('fr-FR')}*\n`;
        recap += `───────────────\n`;
        recap += `*Plan de paiement prévisionnel*\n`;

        schedule.forEach((item, i) => {
            if (schedule.length > 6 && i >= 3 && i < schedule.length - 3) {
                if (i === 3) recap += `... (suite des paiements) ...\n`;
                return;
            }
            recap += `• ${new Date(item.date).toLocaleDateString('fr-FR')} → ${item.amount} FCFA\n`;
        });

        recap += `───────────────\n`;
        recap += `_Vérifiez attentivement les informations avant de confirmer._\n\n`;
        recap += `Tapez :\n- *1* pour confirmer la création\n- *0* pour revenir au menu principal`;
        return recap;
    }
}

export default new ProjectHandler();
