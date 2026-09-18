# Politique de sécurité

## Signaler une vulnérabilité

Si tu découvres une faille de sécurité dans Digest, merci de **ne pas** l'ouvrir en issue publique — envoie plutôt un email directement à **techcollab@protonmail.com**, avec :

- Une description du problème et de son impact potentiel
- Les étapes pour le reproduire, si possible
- Ton navigateur/appareil si la faille semble spécifique à un environnement

Digest étant un projet personnel maintenu bénévolement par une seule personne, il n'y a pas de délai de réponse garanti — mais un signalement responsable sera pris au sérieux et traité dès que possible. Une fois corrigée, la faille sera documentée dans le [CHANGELOG](CHANGELOG.md), avec crédit au découvreur si souhaité.

## Versions prises en charge

| Version | Prise en charge |
| ------- | ---------------- |
| Dernière version (voir le bas de l'app) | ✅ |
| Versions antérieures | ❌ |

Digest n'ayant pas de mécanisme de mise à jour automatique forcée, il revient à chaque utilisateur·rice de garder son installation à jour — voir la section [Mise à jour](README.md#mise-à-jour) du README.

## Ce qui est dans le périmètre

- Faille permettant d'exécuter du code non prévu dans l'app (XSS, injection)
- Faiblesse dans l'implémentation du chiffrement (dérivation de clé, chiffrement AES-GCM)
- Contournement de la Content-Security-Policy
- Fuite de données stockées localement vers l'extérieur (qui ne devrait jamais se produire, vu l'absence de toute requête réseau)

## Ce qui est hors périmètre

- Accès physique à un appareil déverrouillé (aucune app locale ne peut s'en protéger)
- Ingénierie sociale
- Failles dans des logiciels tiers (navigateur, système d'exploitation) non liées au code de Digest

## Pourquoi cette politique existe

Digest ne collecte, ne transmet et ne stocke aucune donnée en dehors de l'appareil de la personne qui l'utilise (voir la [politique de confidentialité](privacy-policy.html)) — le principal risque de sécurité concerne donc l'intégrité des données stockées localement, pas leur exfiltration vers un tiers.
