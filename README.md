# AFRIKMONEY BOT


## Description

Ce projet fournit une API de gestion pour des instances WhatsApp basées sur la bibliothèque `@whiskeysockets/baileys`.

Fonctionnalités principales :

- Gérer plusieurs instances/sessions WhatsApp et conserver les sessions dans le dossier `sessions/`.
- Initialiser et arrêter des instances à la demande via une API REST protégée.
- Générer et retourner un QR code pour l'authentification d'une instance (affiché sous forme d'image PNG/DataURL).
- Vérifier l'état des instances et exposer un point de santé (`/health`).
- Vérifier l'accessibilité d'un API externe via `/ping-api`.
- Protection par clé API, limites de débit (rate limiting) et validation des entrées.

Le point d'entrée HTTP est `src/index.js` et les principales logiques de gestion des instances se trouvent dans `src/services/`.

## Prérequis

- Node.js 18+ recommandé
- npm

## Installation

1. Cloner le dépôt ou télécharger les fichiers.
2. Depuis la racine du projet, installer les dépendances :

```bash
npm install
```

3. Créer un fichier `.env` si nécessaire pour vos variables d'environnement.

## Structure importante

- Le code principal se trouve dans `src/`.
- Les sessions WhatsApp sont stockées dans le dossier `sessions/` (doit être conservé entre les redémarrages).
- Point d'entrée : `src/index.js`.

## Scripts

- Démarrer en production :

```bash
npm start
```

- Démarrer en développement (avec `nodemon`) :

```bash
npm run dev
```

## Variables d'environnement

Ajoutez ici vos variables si le projet en utilise (ex : `PORT`, clés API, etc.). Utilisez un fichier `.env` et la bibliothèque `dotenv` déjà incluse.

## Notes de sécurité

- Ne commitez jamais le contenu de `sessions/` ou de vos fichiers `.env` dans un dépôt public.

## Contribution

Les contributions sont bienvenues. Ouvrez une issue ou une pull request.

## Licence

Vérifiez le champ `license` dans `package.json`.
