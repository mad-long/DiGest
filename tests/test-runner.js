// Mini-framework de test maison — pas de dépendance externe (l'app
// n'en utilise aucune, les tests n'en ont pas besoin non plus).
// Chaque fichier tests/test-*.js exporte une fonction qui reçoit `T`
// et enregistre ses cas ; ce fichier collecte et affiche le résultat.

function makeRunner(){
  const results = [];
  function T(label, fn){
    try {
      const ok = !!fn();
      results.push([label, ok, null]);
    } catch(e){
      results.push([label, false, e.message]);
    }
  }
  function report(suiteName){
    let pass = 0, fail = 0;
    for(const [label, ok, err] of results){
      if(ok) pass++;
      else { fail++; console.log(`❌ [${suiteName}] ${label}` + (err ? ` → ${err}` : '')); }
    }
    console.log(`${suiteName} : ${pass}/${results.length} tests réussis`);
    return { pass, total: results.length };
  }
  return { T, report };
}

module.exports = { makeRunner };
