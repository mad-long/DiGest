#!/usr/bin/env python3
"""
Génère un fichier HTML unique combinant index.html + style.css + app.js,
UNIQUEMENT pour prévisualisation rapide (dans Claude, ou en ouvrant le
fichier directement dans un navigateur).

⚠️ Ce fichier de sortie n'est PAS ce qu'il faut déployer/committer.
Pour ça, utilise les fichiers séparés (index.html, style.css, app.js)
avec la Content-Security-Policy stricte d'origine.

Ce script existe parce que les 3 fichiers séparés ne peuvent pas être
prévisualisés ensemble dans certains contextes (ex. un artefact Claude) :
- CSS et JS sont inlinés dans un seul <style>/<script>
- La CSP est assouplie (script-src/style-src 'unsafe-inline') pour que
  l'inlining fonctionne — c'est le seul rôle de cet assouplissement
- Le manifest et l'enregistrement du service worker sont retirés
  (inutiles hors déploiement réel)

Usage :
    python3 build-preview.py
    → génère preview-digest.html dans le même dossier

    python3 build-preview.py --output autre-nom.html
    → change le nom du fichier de sortie
"""

import re
import sys
import argparse
from pathlib import Path

def build_preview(repo_dir: Path, output_path: Path):
    html = (repo_dir / 'index.html').read_text(encoding='utf-8')
    css = (repo_dir / 'style.css').read_text(encoding='utf-8')
    js = (repo_dir / 'app.js').read_text(encoding='utf-8')

    html = html.replace(
        '<link rel="stylesheet" href="style.css">',
        f'<style>\n{css}\n</style>'
    )
    html = html.replace(
        '<script src="app.js"></script>',
        f'<script>\n{js}\n</script>'
    )

    # CSP assouplie uniquement pour permettre le CSS/JS inline de cet aperçu
    html = re.sub(
        r'<meta http-equiv="Content-Security-Policy"[^>]*>',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
        'script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: \'self\'; '
        'connect-src \'none\'; base-uri \'none\'; form-action \'none\';">',
        html
    )

    # Manifest et service worker n'ont pas de sens pour un fichier de prévisualisation ponctuel
    html = re.sub(r'<link rel="manifest"[^>]*>\n?', '', html)
    html = re.sub(r"// Service worker.*?\}\)\;\n?}\n?", '', html, flags=re.DOTALL)

    output_path.write_text(html, encoding='utf-8')
    print(f"✅ Aperçu généré : {output_path} ({len(html)} octets)")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output', '-o', default='preview-digest.html', help='Nom du fichier de sortie')
    args = parser.parse_args()

    repo_dir = Path(__file__).parent
    for required in ('index.html', 'style.css', 'app.js'):
        if not (repo_dir / required).exists():
            print(f"❌ Fichier manquant : {required} (ce script doit rester à la racine du dépôt)")
            sys.exit(1)

    build_preview(repo_dir, repo_dir / args.output)
