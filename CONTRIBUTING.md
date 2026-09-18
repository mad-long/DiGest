# Contribuer à Digest

Merci de l'intérêt porté à ce projet ! Digest reste un projet personnel maintenu par une seule personne bénévolement — les contributions sont bienvenues, mais le temps de relecture peut varier.

## Signaler un bug

Ouvre une issue sur le dépôt en décrivant :
- Ce que tu attendais, et ce qui s'est passé à la place
- Les étapes pour reproduire le problème
- Ton navigateur/appareil si le bug semble spécifique à un environnement

## Proposer un changement

1. Ouvre une issue avant de commencer un gros changement, pour discuter de l'approche — évite les mauvaises surprises des deux côtés
2. Fork le dépôt, crée une branche dédiée
3. Ouvre une pull request en expliquant ce qui change et pourquoi

## Conventions du projet

Digest est volontairement construit sans framework ni étape de build — HTML/CSS/JS natifs, trois fichiers (`index.html`, `app.js`, `style.css`). Quelques règles à respecter pour rester cohérent :

- **Aucune dépendance externe** — pas de CDN, pas de librairie tierce, pas de police externe. C'est un choix délibéré (confidentialité, simplicité, poids de l'app).
- **Content-Security-Policy stricte** — pas de script/style inline. Toute interaction passe par le moteur de délégation d'événements existant (attributs `data-act` sur les éléments, gérés par les registres `clickActions`/`inputActions`/`changeActions` dans `app.js`).
- **Zéro appel réseau** — l'app doit continuer à fonctionner 100 % hors-ligne. N'introduis rien qui contacterait un serveur externe.
- **Toutes les données restent locales** — pas de compte, pas de synchronisation cloud, pas de télémétrie ni d'analytics, même optionnels.
- **Interface en français** — les textes visibles restent en français, cohérents avec le reste de l'app.
- **Échappement systématique** — toute donnée saisie par l'utilisateur affichée dans le DOM doit passer par `escapeHtml()`/`escapeAttr()`.

## Tests

Avant d'ouvrir une pull request, lance la suite de tests :

```
node tests/run-all.js
```

Si ton changement touche un comportement déjà couvert par un test existant, vérifie qu'il passe toujours. Si tu ajoutes une fonctionnalité, un test dans `tests/` (même minimal) est apprécié — voir les fichiers existants pour le format utilisé.

## Ce que je préfère éviter

- Ajout d'un framework ou d'une étape de build
- Fonctionnalités qui nécessiteraient un serveur, un compte, ou une connexion réseau
- Tout ce qui s'écarterait de la philosophie de l'app : un outil de suivi personnel, pas un dispositif médical — voir la note légale dans l'app et le README pour le détail.

En cas de doute sur si une idée correspond à l'esprit du projet, ouvrir une issue pour en discuter avant de coder reste le plus sûr.
