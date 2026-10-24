# RoomFlow

RoomFlow est une application de réservation de salles avec authentification et autorisations vérifiées côté serveur. Le serveur utilise Node.js 24 et SQLite intégrés ; aucune dépendance npm externe n’est nécessaire.

Le logo MNK du site et son icône d’onglet se trouvent dans `assets/brand-logo.png`.

## Premier démarrage

1. Installer [Node.js 24 ou une version ultérieure](https://nodejs.org/).
2. Depuis le dossier du projet, démarrer le serveur :

   ```powershell
   npm start
   ```

3. Ouvrir <http://127.0.0.1:3000>. Si aucun compte n’existe, l’écran de configuration initiale permet de créer le premier administrateur. Cette action n’est acceptée qu’une seule fois et exige un mot de passe de 8 à 12 caractères.
4. Après création du premier compte, la configuration initiale est désactivée. La page d’authentification propose **Se connecter** et **Créer un compte** : les visiteurs peuvent s’inscrire avec un nom, une adresse e-mail et un mot de passe de 8 à 12 caractères, puis sont connectés automatiquement avec le rôle **Utilisateur** uniquement. Depuis **Utilisateurs**, l’administrateur peut également créer des comptes et attribuer les rôles Gestionnaire et Utilisateur. La même limite de 8 à 12 caractères s’applique à ces comptes et aux changements de mot de passe. Les inscriptions, les changements de rôle et les actions sensibles sont journalisés.

Il est également possible de créer le tout premier administrateur en terminal avec `npm run create-admin` avant le démarrage. La saisie de son mot de passe est masquée.

Les comptes, les salles, les réservations, les sessions et le journal sont conservés dans `data/roomflow.sqlite`. Ce dossier est exclu du contrôle de version. Pour les sauvegardes, arrêter le serveur puis copier la base et ses fichiers SQLite associés vers un emplacement protégé.

La déconnexion supprime uniquement la session courante, jamais le compte. L’utilisateur peut se reconnecter avec la même adresse e-mail et le même mot de passe, y compris après un redémarrage du serveur si le dossier de données est conservé.

Les mots de passe existants de plus de 12 caractères restent utilisables pour se connecter et changer de mot de passe ; tout nouveau mot de passe doit contenir entre 8 et 12 caractères.

### Conservation des comptes sur Render

Le disque local d’un service Render gratuit n’est pas persistant : les comptes, les réservations et les photos peuvent disparaître lors d’un redémarrage ou d’un redéploiement. Pour les conserver avec SQLite, utiliser une instance payante et ajouter un disque persistant dans **Disks**, avec le chemin de montage `/opt/render/project/src/data`. Ce chemin correspond au dossier utilisé par défaut ; aucune variable supplémentaire n’est nécessaire. Si `ROOMFLOW_DATA_DIR` ou `ROOMFLOW_DB_PATH` est configurée, vérifier que la base et les photos restent sur le disque persistant. Garder une seule instance du service et prévoir des sauvegardes.

La mise en place d’un disque ne copie pas automatiquement les données d’un ancien stockage éphémère : sauvegarder les données existantes avant de changer la configuration et les restaurer sur le disque si nécessaire. Ne pas publier la base de données sur GitHub.

Les notifications de demande, de modification, de confirmation, de refus et d’annulation sont conservées par compte dans l’application. Les rubriques **Notifications** et **Rapports & journal** sont réservées à l’Administrateur : elles sont masquées pour les Utilisateurs et Gestionnaires, leurs notifications et le journal ne sont pas transmis à ces rôles par l’API, et les actions de lecture des notifications leur sont interdites. Un administrateur consulte et marque comme lues uniquement ses propres notifications. Les utilisateurs suivent leurs demandes dans **Réservations**. L’envoi par e-mail ou SMS et les rappels automatiques nécessitent un service de messagerie configuré et ne sont pas encore activés.

L’interface propose les rubriques **Accueil**, **À propos**, **Réservation salle** et **Nos services** dans sa navigation. La page d’accueil présente une bannière animée avec les photos locales du dossier `assets/rooms/banner/`. Les commandes permettent de parcourir les images et de mettre le diaporama en pause ; il respecte aussi la préférence de réduction des animations du système. La section **Gestion des salles** indique aux gestionnaires et administrateurs comment ajouter une salle et présente directement l’accès au formulaire de configuration. Ce formulaire permet de renseigner son nom, son code, son type (dont mariage, salle mortuaire et anniversaire), sa capacité, ses équipements, son emplacement, ses photos, ses horaires, sa durée maximale et son statut. Les photos peuvent être choisies dans la galerie intégrée ou ajoutées depuis l’ordinateur (JPEG, PNG ou WebP, 5 Mo maximum par photo) ; les fichiers ajoutés sont conservés dans `data/room-images/`. Les cartes de salles offrent une navigation par flèches et miniatures, et le bouton de réservation préremplit le formulaire. Le formulaire de réservation distingue aussi le type d’événement (réunion, formation, conférence, entretien, mariage, salle mortuaire, anniversaire ou autre) de son objet ; ce choix apparaît dans le calendrier, le suivi et l’export CSV. Les bases antérieures sont migrées automatiquement et leurs salles reçoivent une galerie adaptée à leur type. Au démarrage, l’ancien type « Veillée mortuaire » est renommé « Salle mortuaire » dans les salles et réservations existantes.

Après l’envoi d’une réservation, RoomFlow attribue une référence de ticket et affiche un justificatif avec les informations de la demande. Le client peut télécharger directement le ticket en fichier PDF ou l’imprimer, puis le rouvrir avec le bouton **Ticket** dans ses réservations. Une réservation récurrente reçoit un ticket par séance dans le même PDF. Le ticket atteste la réception de la demande : la réservation reste en attente jusqu’à sa validation par un gestionnaire.

La récurrence permet de réserver **toutes les X heures**, **tous les X jours**, chaque semaine ou chaque mois, avec **1 à 12 séances**, première séance comprise. L’intervalle est un entier positif, mesuré entre les débuts des séances ; leur durée reste celle des heures de début et de fin saisies, en CAT. Chaque séance doit se terminer le même jour et respecter les horaires de la salle. Si une séance est invalide ou entre en conflit avec une autre réservation (y compris dans la série), aucune séance de la série n’est enregistrée. La modification d’une réservation porte sur une seule séance et ne crée pas de nouvelle récurrence.

Cliquer sur la photo principale d’une salle ouvre une vue agrandie, sur mobile comme sur ordinateur. La photo est affichée entièrement sans recadrage ; les boutons Précédente et Suivante (ou les flèches du clavier) permettent de parcourir les photos. Les détails indiquent le code, le type, le statut, la capacité, l’emplacement, l’adresse, les horaires, la durée maximale et les équipements. Le bouton **Réserver cette salle** préremplit le formulaire pour une salle active. Fermer avec la croix, la touche Échap ou un clic à l’extérieur ; le clavier reste dans la fenêtre pendant son ouverture.

L’export CSV des réservations est réservé aux comptes **Administrateur**. Le bouton **Exporter en CSV** se trouve dans **Rapports & journal** ; il n’apparaît pas dans les espaces Utilisateur et Gestionnaire.

## Affichage adaptatif

Le footer propose des liens vers les principales rubriques et deux contacts directs au **+243 851 699 229** : **WhatsApp** ouvre directement la conversation avec ce numéro dans un nouvel onglet et **Appeler** ouvre l’application téléphonique de l’appareil. Le bouton **E-mail** ouvre la rédaction d’un message à **michelngoyikalenda@gmail.com** dans Gmail, dans un nouvel onglet. Les boutons **TikTok**, **X (Twitter)**, **LinkedIn** et **Facebook**, avec leurs icônes locales, ouvrent les profils de Michel Ngoyi Kalenda dans un nouvel onglet. Le footer passe de plusieurs colonnes à une seule sur téléphone et les boutons sociaux reviennent à la ligne selon la largeur disponible.

Les textes secondaires, indications de formulaire et textes auparavant gris sont affichés en noir sur les fonds clairs. Les textes de la navigation sur fond sombre restent blancs pour préserver leur lisibilité ; les couleurs des alertes et des statuts sont conservées.

L’interface adapte ses colonnes et ses espacements aux téléphones, tablettes et ordinateurs, y compris en orientation paysage. Les salles et le formulaire de réservation passent sur une seule colonne lorsque l’espace disponible diminue ; les champs côte à côte sont empilés sur les petits téléphones. Les boutons **Mot de passe** et **Déconnexion**, le nom et le rôle restent directement visibles dans le header sur toutes les tailles d’écran, sans menu burger.

Sur mobile et tablette, la navigation reste accessible par défilement horizontal. Les réservations sont présentées sous forme de cartes sur les petits écrans ; le calendrier, le journal et la liste des utilisateurs défilent dans leur propre zone, accessible au clavier, sans élargir la page. Les fenêtres de dialogue restent dans la hauteur de l’écran et leur contenu peut défiler. Les appareils tactiles disposent de commandes agrandies et de champs évitant le zoom automatique à la saisie.

## Langue et horaires

L’application utilise le français et le fuseau **Africa/Lubumbashi**, heure d’Afrique centrale (**CAT, UTC+2**, sans changement saisonnier). Les dates du calendrier, la date du jour, les validations de réservation côté serveur, les rapports et les horodatages affichés du journal et des notifications ne dépendent pas du fuseau du navigateur ou de l’hébergement Render. Les horaires saisis des salles et des réservations sont des heures locales CAT ; les dates et heures déjà saisies ne sont pas décalées. Les tickets indiquent le fuseau utilisé. Les horodatages techniques et les expirations de session restent stockés en UTC. Les champs horaires utilisent une saisie au format **24 heures HH:MM**, de `00:00` à `23:59` (ex. `08:00`, `14:30`), sans AM/PM quelle que soit la langue du navigateur. Le sélecteur de date natif peut conserver la présentation du navigateur ou du système ; les textes et les dates rendus par l’application sont en français.

## Sécurité

- Mots de passe hachés avec `scrypt` (sel aléatoire par compte) ; inscription publique limitée au rôle Utilisateur et disponible seulement après la configuration initiale.
- Sessions aléatoires stockées uniquement sous forme de hachage dans SQLite, limitées à 8 heures, cookie `HttpOnly`, `SameSite=Strict` et `Secure` en production.
- Protection CSRF par jeton lié à la session et validation de l’origine des requêtes mutantes.
- Limitation des tentatives de connexion, erreurs d’authentification génériques, requêtes SQL paramétrées, validation serveur des entrées et contrôle des rôles sur chaque action protégée.
- En-têtes de sécurité et politique CSP. L’application écoute uniquement sur `127.0.0.1` par défaut.

Pour un déploiement, utiliser HTTPS. Configurer `NODE_ENV=production` et `APP_ORIGIN=https://votre-domaine`, puis placer le serveur derrière un proxy TLS correctement configuré. Garder le processus Node non exposé directement à Internet et protéger les sauvegardes de la base. L’application n’utilise pas les en-têtes `X-Forwarded-*` comme source de confiance.

Les tentatives de connexion et d’inscription sont limitées en mémoire par processus ; elles ne remplacent pas une limitation au niveau du reverse proxy dans un déploiement multi-instance. Les inscriptions consomment une tentative même en cas de succès (5 par adresse e-mail et adresse réseau sur 15 minutes, avec un plafond partagé de 30 tentatives par adresse réseau). Derrière un proxy, cette adresse réseau peut être commune aux visiteurs ; les en-têtes transférés ne sont pas utilisés comme source de confiance.

SQLite n’est pas chiffré au repos par l’application : les permissions du dossier `data/`, les sauvegardes et l’accès à la machine doivent être protégés par le système d’exploitation ou l’infrastructure.

## Vérifications

Exécuter les tests d’intégration :

```powershell
npm test
```
