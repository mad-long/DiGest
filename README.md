# Digest

**Version actuelle : 1.0.0**

Une petite app web pour suivre des intolérances/sensibilités alimentaires : aliments et recettes, symptômes personnalisables, agenda quotidien, classement par symptôme, carnet de recettes séparé, export médecin prêt à imprimer. Le tout **100 % local, sans compte, sans serveur, sans réseau**.

Conçue à l'origine pour un usage personnel, publiée ici au cas où elle serait utile à quelqu'un d'autre. Chaque personne qui l'utilise a sa propre copie locale, avec ses propres données. Rien n'est jamais partagé ni envoyé nulle part.

## Avertissement santé et éthique

Cette app est un **outil de suivi personnel**, pas un dispositif médical. Elle ne diagnostique rien, n'établit aucun lien de cause à effet certain, et ne recommande aucun traitement, régime ou conduite à tenir.

Si tu penses avoir une intolérance, une allergie ou tout autre souci de santé, **consulte un médecin ou un professionnel de santé qualifié**. Les données notées ici sont un repère personnel, pas une base suffisante pour une décision de santé.

Je (l'auteur·rice de cette app) ne suis pas médecin et ne formule aucune recommandation médicale, alimentaire ou thérapeutique à travers cet outil.

## Fonctionnalités

- **Aliments** : symptômes associés (avec couleur personnalisable), mode de cuisson, associations, compteur de réactions, favoris
- **Carnet de Recettes** : ingrédients, tags repas/régime, notes rapidité/facilité/prix
- **Suivi** : vue groupée par symptôme, triée par nombre de réactions
- **Agenda** : vue mensuelle, notes libres, jauges personnalisables (0 à 10)
- **Export Médecin** : génère un document prêt à imprimer avant un rendez-vous, pour arriver avec tout en main plutôt que de tout reconstituer de mémoire sur place. Diagnostics et traitement en cours, sujets à aborder, historique des rendez-vous depuis une date choisie, aliments les plus inflammatoires et les plus récents. Chaque section est facultative : la personne choisit ce qu'elle veut réellement montrer.
- **Paramètres** : mode sombre, protection par mot de passe (chiffrement AES-GCM), export/import de sauvegarde, gestion des symptômes

## Confidentialité et sécurité

- **Aucune requête vers un serveur tiers** : la [Content-Security-Policy](index.html) n'autorise que l'app elle-même (`connect-src 'self'`, `script-src 'self'`, `style-src 'self'`). Nécessaire pour que le service worker puisse mettre l'app en cache hors-ligne, mais aucun domaine externe n'est ni autorisé ni contacté.
- Toutes les données restent dans le `localStorage` du navigateur, sur l'appareil de la personne qui utilise l'app
- Chiffrement optionnel (mot de passe, AES-GCM, dérivation PBKDF2) pour protéger les données stockées sur l'appareil
- Export en fichier `.json`, avec une variante chiffrée ; import avec résumé avant confirmation
- L'export standard (non chiffré) retire automatiquement le nom, le lieu et les notes de tes rendez-vous médicaux. Seuls la date, l'heure et le type de médecin sont inclus. L'export chiffré, lui, conserve tout.
- Aucun tracker, aucun analytics, aucune police ou ressource chargée depuis un service externe

## Installation

Deux façons d'utiliser l'app :

**Raccourci d'écran d'accueil** (le plus simple)
1. Télécharge tous les fichiers du dépôt **dans un même dossier**
2. Ouvre `index.html` avec ton navigateur (Chrome, Firefox...)
3. Menu du navigateur → **Ajouter à l'écran d'accueil**

**Vrai fichier .apk** (pour l'installer comme une app à part entière)
1. Active GitHub Pages sur ce dépôt (Settings → Pages)
2. Va sur [pwabuilder.com](https://www.pwabuilder.com), colle l'URL de la Page générée
3. Génère le package Android, télécharge le `.apk`
4. Transfère-le sur ton téléphone et installe-le (autorisation "sources inconnues" nécessaire)

L'app inclut un `manifest.json` et un `sw.js` (service worker) qui la rendent installable et utilisable **hors-ligne** une fois le premier chargement effectué. Aucune connexion requise ensuite, y compris pour la version `.apk`.

## Mise à jour

En cas de nouvelle version : remplace tous les fichiers **en gardant les mêmes noms, dans le même dossier**. Les données stockées dans le navigateur restent liées au chemin du fichier `index.html`. Un changement de nom ou d'emplacement ferait repartir de zéro (sans rien supprimer, mais sans y accéder non plus). Pense à exporter une sauvegarde avant toute mise à jour importante.

La version actuelle s'affiche en bas de l'app (Digest v1.0.0). À chaque changement notable, penser à incrémenter **les deux endroits suivants ensemble** :
- `APP_VERSION` en haut de `app.js`
- `CACHE_NAME` en haut de `sw.js` (sinon la version installée ne se met pas à jour toute seule)

Si le dépôt est un jour construit par F-Droid : penser aussi à **poser un tag Git** à chaque version (`git tag v1.0.0` puis `git push --tags`). C'est la méthode principale que F-Droid utilise pour détecter automatiquement une nouvelle version publiée. Sans tag, une mise à jour du code seul peut passer inaperçue de leur côté.

## Développement : tests et aperçu

Le dossier `tests/` contient une suite de tests automatisés (Node.js, sans dépendance externe) qui vérifie les scénarios critiques de l'app : création/suppression d'aliments, Agenda, chiffrement, export médecin, import/export. À lancer avant toute modification importante :

```
node tests/run-all.js
```

Le script `build-preview.py` génère un fichier HTML unique (CSS et JS inlinés) pour prévisualiser rapidement l'app dans un contexte qui ne peut pas charger les 3 fichiers séparément (ex. un artefact Claude). **Ce fichier généré n'est pas à déployer** : les fichiers séparés avec la CSP stricte restent la version de référence.

```
python3 build-preview.py
```

## Contribuer

Les contributions sont bienvenues. Voir [CONTRIBUTING.md](CONTRIBUTING.md) pour signaler un bug, proposer un changement, et les conventions du projet à respecter.

Pour signaler une **faille de sécurité** spécifiquement, voir [SECURITY.md](SECURITY.md) plutôt qu'une issue publique.

## Soumission F-Droid

Le dossier `fastlane/metadata/android/` contient les textes de présentation (titre, résumés, description, notes de version) au format que F-Droid sait détecter automatiquement, en français et en anglais. Le fichier `changelogs/1.txt` correspond au `versionCode` Android `1`, à renommer si le `versionCode` réel choisi au moment de la génération de l'APK est différent.

## Licence

Voir [LICENSE](LICENSE) (MIT).
