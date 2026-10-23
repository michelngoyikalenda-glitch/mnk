# RoomFlow

RoomFlow est une application de réservation de salles avec authentification et autorisations vérifiées côté serveur. Le serveur utilise Node.js 24 et SQLite intégrés ; aucune dépendance npm externe n’est nécessaire.

Le logo MNK du site et son icône d’onglet se trouvent dans `assets/brand-logo.png`.

## Premier démarrage

1. Installer [Node.js 24 ou une version ultérieure](https://nodejs.org/).
2. Depuis le dossier du projet, démarrer le serveur :

   ```powershell
   npm start
   ```

3. Ouvrir <http://127.0.0.1:3000>. Si aucun compte n’existe, l’écran de configuration initiale permet de créer le premier administrateur. Cette action n’est acceptée qu’une seule fois et exige un mot de passe d’au moins 12 caractères.
4. Après création du premier compte, l’inscription initiale est désactivée. Depuis **Utilisateurs**, créer les comptes Gestionnaire et Utilisateur. Les changements de rôle et les actions sensibles sont journalisés.

Il est également possible de créer le tout premier administrateur en terminal avec `npm run create-admin` avant le démarrage. La saisie de son mot de passe est masquée.

Les comptes, les salles, les réservations, les sessions et le journal sont conservés dans `data/roomflow.sqlite`. Ce dossier est exclu du contrôle de version. Pour les sauvegardes, arrêter le serveur puis copier la base et ses fichiers SQLite associés vers un emplacement protégé.

Les notifications de demande, de modification, de confirmation, de refus et d’annulation sont conservées par compte dans l’application. Chaque utilisateur ne peut consulter et marquer comme lues que ses propres notifications. L’envoi par e-mail ou SMS et les rappels automatiques nécessitent un service de messagerie configuré et ne sont pas encore activés.

L’interface propose les rubriques **Accueil**, **À propos**, **Réservation salle** et **Nos services** dans sa navigation. La page d’accueil présente une bannière animée avec les photos locales du dossier `assets/rooms/banner/`. Les commandes permettent de parcourir les images et de mettre le diaporama en pause ; il respecte aussi la préférence de réduction des animations du système. La section **Gestion des salles** indique aux gestionnaires et administrateurs comment ajouter une salle et présente directement l’accès au formulaire de configuration. Ce formulaire permet de renseigner son nom, son code, son type (dont mariage, veillée mortuaire et anniversaire), sa capacité, ses équipements, son emplacement, ses photos, ses horaires, sa durée maximale et son statut. Les photos peuvent être choisies dans la galerie intégrée ou ajoutées depuis l’ordinateur (JPEG, PNG ou WebP, 5 Mo maximum par photo) ; les fichiers ajoutés sont conservés dans `data/room-images/`. Les cartes de salles offrent une navigation par flèches et miniatures, et le bouton de réservation préremplit le formulaire. Le formulaire de réservation distingue aussi le type d’événement (réunion, formation, conférence, entretien, mariage, veillée mortuaire, anniversaire ou autre) de son objet ; ce choix apparaît dans le calendrier, le suivi et l’export CSV. Les bases antérieures sont migrées automatiquement et leurs salles reçoivent une galerie adaptée à leur type.

Après l’envoi d’une réservation, RoomFlow attribue une référence de ticket et affiche un justificatif avec les informations de la demande. Le client peut télécharger directement le ticket en fichier PDF ou l’imprimer, puis le rouvrir avec le bouton **Ticket** dans ses réservations. Une réservation récurrente reçoit un ticket par séance dans le même PDF. Le ticket atteste la réception de la demande : la réservation reste en attente jusqu’à sa validation par un gestionnaire.

## Sécurité

- Mots de passe hachés avec `scrypt` (sel aléatoire par compte) ; aucune inscription publique.
- Sessions aléatoires stockées uniquement sous forme de hachage dans SQLite, limitées à 8 heures, cookie `HttpOnly`, `SameSite=Strict` et `Secure` en production.
- Protection CSRF par jeton lié à la session et validation de l’origine des requêtes mutantes.
- Limitation des tentatives de connexion, erreurs d’authentification génériques, requêtes SQL paramétrées, validation serveur des entrées et contrôle des rôles sur chaque action protégée.
- En-têtes de sécurité et politique CSP. L’application écoute uniquement sur `127.0.0.1` par défaut.

Pour un déploiement, utiliser HTTPS. Configurer `NODE_ENV=production` et `APP_ORIGIN=https://votre-domaine`, puis placer le serveur derrière un proxy TLS correctement configuré. Garder le processus Node non exposé directement à Internet et protéger les sauvegardes de la base. L’application n’utilise pas les en-têtes `X-Forwarded-*` comme source de confiance.

Les tentatives de connexion sont limitées en mémoire par processus ; elles ne remplacent pas une limitation au niveau du reverse proxy dans un déploiement multi-instance.

SQLite n’est pas chiffré au repos par l’application : les permissions du dossier `data/`, les sauvegardes et l’accès à la machine doivent être protégés par le système d’exploitation ou l’infrastructure.

## Vérifications

Exécuter les tests d’intégration :

```powershell
npm test
```
