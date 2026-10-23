# Cahier des charges - Système de réservation de salles

## 1. Contexte et objectif
Le système permet de gérer la réservation de salles dans un établissement (entreprise, école, centre de formation, campus, hôtel, bureau partagé, etc.). Il doit permettre aux utilisateurs de consulter la disponibilité des salles, de réserver une salle, de modifier ou annuler une réservation, et aux gestionnaires d’avoir une vue globale sur l’utilisation des ressources.

L’objectif est d’automatiser la planification, de limiter les conflits de réservation, de sécuriser les droits d’accès et de rendre l’utilisation des salles plus transparente.

## 2. Problèmes actuels
- Les réservations sont souvent gérées manuellement (papier, calendrier, messagerie, Excel).
- Il y a des risques de double réservation.
- Les salles ne sont pas toujours visibles selon leur disponibilité réelle.
- Les délais d’annulation ou les restrictions d’usage ne sont pas appliqués de façon uniforme.
- Les responsables ne disposent pas d’un suivi clair de l’usage et des statistiques.

## 3. Objectifs du projet
- Centraliser la gestion des salles et des réservations.
- Automatiser la vérification de disponibilité.
- Sécuriser l’accès selon les rôles.
- Simplifier la communication entre utilisateurs et gestionnaires.
- Fournir une traçabilité de chaque réservation.
- Permettre un suivi statistique et des rapports.

## 4. Public cible
### 4.1 Utilisateurs
- Administrateur système
- Gestionnaire de salles
- Employé / enseignant / étudiant / client
- Responsable de configuration ou de maintenance

## 5. Acteurs et rôles
### 5.1 Administrateur
- Gère les utilisateurs, les salles, les rôles et les paramètres système.
- Valide ou annule les réservations selon les règles.
- Consulte les statistiques et les logs.

### 5.2 Gestionnaire de salles
- Ajoute/modifie/supprime les salles.
- Valide certaines demandes de réservation.
- Surveille les conflits et les anomalies.

### 5.3 Utilisateur standard
- Consulte les salles disponibles.
- Réserve une salle.
- Modifie ou annule sa réservation.
- Reçoit des notifications de confirmation ou de rappel.

## 6. Fonctionnalités attendues
### 6.1 Gestion des salles
- Ajout d’une salle avec les informations suivantes : nom, code, type, capacité, équipements, localisation, statut (active/inactive).
- Modification des caractéristiques d’une salle.
- Suppression d’une salle si elle n’est plus utilisée.
- Association d’une salle à un bâtiment ou un étage.
- Définition des plages horaires autorisées.

### 6.2 Gestion des réservations
- Création d’une réservation avec : salle, date, heure de début, heure de fin, objet, participant(s), utilisateur demandeur.
- Vérification automatique de la disponibilité.
- Blocage de la réservation en cas de conflit.
- Consultation de l’historique des réservations.
- Modification des détails d’une réservation.
- Annulation avec motif optionnel.
- Possibilité de réservation récurrente (quotidienne, hebdomadaire, mensuelle).

### 6.3 Gestion des disponibilités
- Affichage du calendrier mensuel, hebdomadaire et quotidien.
- Vue par salle ou par jour.
- Indication des salles libres / occupées / en attente / refusées.
- Visualisation des conflits et dépendances.

### 6.4 Authentification et autorisation
- Connexion sécurisée.
- Rôle attribué par utilisateur.
- Gestion des permissions : créer une réservation, modifier une réservation, annuler, gérer les salles, administrer le système.
- Journalisation des actions importantes.

### 6.5 Notifications
- Confirmation de réservation par e-mail ou SMS.
- Rappel avant l’événement.
- Notification d’annulation ou de refus.
- Alertes sur les conflits ou délais dépassés.

### 6.6 Statistiques et reporting
- Nombre de réservations par salle, par période.
- Taux d’occupation.
- Salles les plus demandées.
- Réservations annulées ou refusées.
- Export des données au format CSV/PDF.

## 7. Règles fonctionnelles
- Une salle ne peut pas être réservée deux fois pour la même période.
- Une réservation ne peut pas dépasser la durée maximale autorisée.
- Une salle inactiva ou bloquée ne peut pas recevoir de réservation.
- Le créateur d’une réservation peut la modifier ou l’annuler tant qu’elle n’est pas clôturée.
- Un gestionnaire peut modifier ou annuler toute réservation dans le cadre de la politique de l’établissement.
- Une réservation peut être refusée si l’utilisateur n’a pas les droits requis.
- Les réservations passées peuvent être consultées en lecture seule.
- Les conflits doivent être signalés visuellement.

## 8. Contraintes techniques
- L’application doit être accessible via navigateur web.
- Le système doit supporter plusieurs utilisateurs simultanément.
- Les données doivent être stockées de façon sécurisée.
- Le système doit être compatible avec les navigateurs modernes.
- Le système doit être évolutif pour accueillir davantage de salles et d’utilisateurs.
- Le backend doit exposer une API claire pour une future intégration avec d’autres outils.

## 9. Exigences non fonctionnelles
### 9.1 Performance
- Le chargement des pages doit être rapide.
- La recherche et les filtres doivent répondre en moins de 2 secondes sous un volume standard.

### 9.2 Sécurité
- Authentification avec mot de passe sécurisé.
- Protection contre les injections SQL et les vulnérabilités web classiques.
- Autorisation au niveau des rôles.
- Chiffrement des données sensibles.

### 9.3 Fiabilité
- Les réservations doivent être cohérentes et sans doublons.
- Le système doit gérer les erreurs et afficher des messages explicites.
- Le système doit conserver un historique des actions importantes.

### 9.4 Maintenabilité
- Code structuré et documenté.
- Séparation claire entre frontend, backend et base de données.
- Possibilité de mise à jour sans interruption majeure du service.

## 10. Modèle de données (exemple)
### 10.1 Entités principales
- Utilisateur
  - id
  - nom
  - prénom
  - email
  - mot_de_passe
  - rôle
  - statut

- Salle
  - id
  - nom
  - code
  - type
  - capacité
  - equipements
  - localisation
  - statut

- Réservation
  - id
  - utilisateur_id
  - salle_id
  - date_debut
  - heure_debut
  - date_fin
  - heure_fin
  - objet
  - statut
  - commentaire

- Notification
  - id
  - utilisateur_id
  - type
  - message
  - date_envoi
  - lu

## 11. Cas d’utilisation principaux
### 11.1 Cas d’usage fonctionnels
- Se connecter
- Consulter les salles disponibles
- Créer une réservation
- Modifier une réservation
- Annuler une réservation
- Valider une réservation
- Refuser une réservation
- Gérer les salles
- Consulter l’historique
- Recevoir une notification
- Générer un rapport

## 12. Interface utilisateur (exigences minimales)
- Page d’accueil affichant les salles disponibles.
- Page de détail d’une salle avec ses caractéristiques et son calendrier.
- Formulaire de réservation.
- Tableau des réservations avec filtres.
- Espace de gestion pour les administrateurs.
- Page de profil utilisateur.
- Tableau de bord avec statistiques globales.

## 13. Critères d’acceptation
1. Un utilisateur connecté peut réserver une salle disponible.
2. Un utilisateur ne peut pas réserver une salle déjà prise pour la même plage horaire.
3. Un gestionnaire peut modifier ou annuler une réservation sans validation complémentaire.
4. Une réservation refusée ne doit pas apparaître comme active.
5. Un utilisateur reçoit une confirmation après sa demande de réservation.
6. Le système affiche un calendrier clair avec les salles occupées et libres.
7. Un administrateur peut configurer les salles et leurs paramètres.
8. Les actions sensibles sont journalisées.

## 14. Périmètre hors scope
- Paiement ou facturation.
- Gestion de ressources complexes comme le matériel audio/vidéo non intégré.
- Intégration avec des outils tiers hors plan de base.
- Réservation multi-site complexe avec logique avancée d’optimisation.

## 15. Livrables attendus
- Prototype fonctionnel ou MVP.
- Base de données.
- API backend.
- Interface utilisateur accessible.
- Documentation utilisateur et technique.
- Plan de test et validation.

## 16. Plan de réalisation proposé
### Phase 1 - Analyse et cadrage
- Recueil des besoins.
- Validation du périmètre.
- Définition des règles métiers.

### Phase 2 - Conception
- Modélisation des données.
- Conception de l’architecture.
- Prototypage des écrans essentiels.

### Phase 3 - Développement
- Authentification et gestion des utilisateurs.
- Gestion des salles.
- Gestion des réservations.
- Notifications.

### Phase 4 - Tests et validation
- Tests unitaires et fonctionnels.
- Vérification des cas limites.
- Validation avec les utilisateurs.

### Phase 5 - Mise en production
- Déploiement.
- Paramétrage initial.
- Formation des utilisateurs.

## 17. Conclusion
Le système de réservation de salles doit offrir une solution simple, fiable et sécurisée pour gérer la planification des espaces. Il permettra de réduire les conflits, améliorer l’expérience utilisateur et centraliser l’information pour les gestionnaires.

## 18. Synthèse fonctionnelle rapide
- Objectif : gérer les réservations de salles de manière centralisée.
- Utilisateurs : gestionnaire, administrateur, utilisateur standard.
- Fonctionnalités clés : gestion des salles, réservation, validation, calendrier, notifications, reporting.
- Contraintes : sécurité, disponibilité, fiabilité, évolutivité.
