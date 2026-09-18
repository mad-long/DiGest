# Changelog

Format basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).

## [Non publié]

## [1.0.0] — 2026-08-12

### Ajouté
- **Aliments** : symptômes associés avec couleur personnalisable, mode de cuisson, associations, compteur de réactions, favoris
- **Carnet de Recettes** : espace séparé avec ingrédients, tags repas/régime, notes rapidité/facilité/prix
- **Suivi** : vue groupée par symptôme, triée par nombre de réactions
- **Agenda** : vue mensuelle, notes libres, rendez-vous médicaux, jauges personnalisables (0 à 10), pastilles par catégorie (aliment/recette/symptôme/rdv)
- **Export Médecin** : résumé visuel imprimable à destination d'un professionnel de santé, avec sélection des sections à inclure
- **Accès rapide "pansement"** : bouton flottant pour noter un symptôme en deux taps depuis n'importe quel onglet
- **Pack d'aliments optionnel** : plus de 300 aliments courants installables en un clic, pour gagner du temps
- **Protection par mot de passe** : chiffrement AES-GCM, dérivation de clé PBKDF2 (600 000 itérations)
- **5 thèmes de couleurs** : Brume marine (par défaut), Nuit douce, Blé et lavande, Coquille et corail, Lin et miel — au choix dans Paramètres
- **Export/import de sauvegarde** : fichier `.json`, avec variante chiffrée, résumé avant confirmation d'import
- **Bilan périodique** : statistiques positives et rappel doux de rendez-vous à venir, au maximum une fois toutes les 3 semaines
- Application 100 % locale : aucun compte, aucun serveur, fonctionne hors-ligne après le premier chargement

### Accessibilité
- Navigation complète au clavier sur tous les éléments interactifs
- Contrastes de couleurs conformes WCAG AA
- Résumés vocaux (aria-label) sur le calendrier pour les lecteurs d'écran
