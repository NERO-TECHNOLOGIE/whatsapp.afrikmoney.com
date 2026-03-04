# Documentation Afrikmoney Bot & Backend

Ce document récapitule les fonctionnalités, les commandes et les changements récents apportés au bot WhatsApp et à l'API Backend.

## 🚀 Fonctionnalités du Bot

### 1. Inscription (Registration)
Le bot gère l'inscription complète des nouveaux utilisateurs. 
- **Nouveauté** : Le numéro WhatsApp saisi est maintenant stocké dans un champ `whatsapp_number` dédié, distinct de l'ID technique WhatsApp (JID).
- **Sécurité** : Les numéros de paiement (MTN, Moov, Celtiis) sont enregistrés proprement dans la table `client_payment_numbers`.

### 2. Paiements Marchands (Merchant Payments)
- **Commande** : `payer [CODE_MARCHAND] [MONTANT]`
- **Raccourci** : `#montant#code_marchand#operateur` (opérateur optionnel : mtn, moov, celtiis)
- **Sécurité** : Le bot vérifie que le marchand existe et récupère ses services.

### 3. Transferts Groupes/P2P (Group Transfers)
Vous pouvez envoyer de l'argent à un ami directement dans un groupe ou en privé.
- **Le plus simple (Réponse)** : Répondez au message d'un ami avec simplement `@Bot [MONTANT]` (ex: `@Afrikmoney 2000`).
- **Commande par mention** : `@Bot merci @Utilisateur [MONTANT]`
- **Commande par réponse** : Répondez au message d'un ami avec `@Bot merci [MONTANT]`.
- **Contrainte** : Le destinataire doit être inscrit au bot pour recevoir les fonds.

### 4. Projets de Paiement (E-Tontine / Plans)
Permet de créer un plan d'épargne ou de paiement pour un service spécifique.
- **Contrainte** : Un projet doit impérativement être lié à un **service** du marchand. Si le marchand n'a pas de service, la création est bloquée.
- **Simplification** : Après la création, l'utilisateur peut soit payer la première échéance (1), soit revenir au menu (0).

---

## 🛠 Commandes Groupes (Trigger : Mention @Bot)

| Commande | Description | Format |
| :--- | :--- | :--- |
| **Aide** | Affiche les commandes disponibles | `@Bot aide` |
| **Solde** | Affiche votre profil et numéros | `@Bot solde` |
| **Payer** | Payer un marchand | `@Bot payer [CODE] [MONTANT]` |
| **Merci** | Envoyer à un utilisateur | `@Bot merci @Ami [MONTANT]` |
| **Rapide** | Paiement ultra-rapide | `@Bot #montant#code#op` |
| **Format Pro** | Format technique | `@Bot *pay*code*montant*op#` |

---

## 🔧 Maintenance Backend (Laravel)

### Migrations
Assurez-vous que votre base de données est à jour.
```bash
php artisan migrate
```
Changements récents en base :
- Ajout de `whatsapp_number` dans la table `clients`.
- Utilisation de ULID pour toutes les relations dans `client_payment_numbers`.

### Sécurité des Paiements
Le bot applique désormais une règle de **non-fallback** :
- Si un utilisateur choisit **MTN** comme source de paiement, le bot utilisera **uniquement** son numéro MTN enregistré.
- Si aucun numéro n'est trouvé pour l'opérateur choisi, la transaction est bloquée avec une invitation à l'ajouter.

---

## 📁 Structure des Fichiers Clés
- `src/services/BotLogic.js` : Cœur de l'intelligence du bot et gestion des flows.
- `src/services/ApiService.js` : Communication avec le backend Laravel.
- `app/Http/Controllers/API/AfrikBotController.php` : Endpoints API pour le bot.
- `app/Models/Client.php` : Modèle client avec le nouveau champ `whatsapp_number`.
