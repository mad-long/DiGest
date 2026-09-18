// Environnement DOM minimal simulé pour exécuter app.js sous Node,
// sans navigateur. Utilisé par tous les fichiers de tests/.
// Ne prétend pas être un DOM complet — juste assez pour que les
// fonctions de rendu de l'app s'exécutent sans planter.

function fakeElement(){
  return {
    value: '', textContent: '', innerHTML: '', dataset: {}, files: [], checked: false,
    classList: {
      _set: new Set(),
      add(c){ this._set.add(c); },
      remove(c){ this._set.delete(c); },
      toggle(c, f){
        if(f === undefined){
          if(this._set.has(c)){ this._set.delete(c); return false; }
          this._set.add(c); return true;
        }
        f ? this._set.add(c) : this._set.delete(c);
        return f;
      },
      contains(c){ return this._set.has(c); }
    },
    children: [],
    addEventListener(){}, removeEventListener(){},
    appendChild(c){ this.children.push(c); return c; },
    remove(){}, click(){}, focus(){}, blur(){}, scrollIntoView(){}, closest(){ return null; },
    querySelector(){ return fakeElement(); }, querySelectorAll(){ return []; },
    setAttribute(){}, getAttribute(){ return null; },
    parentElement: null
  };
}

function createDomShim(){
  const elCache = {};
  const storage = {};

  global.document = {
    getElementById: (id) => { if(!elCache[id]) elCache[id] = fakeElement(); return elCache[id]; },
    createElement: () => fakeElement(),
    addEventListener: () => {},
    querySelectorAll: () => [],
    body: fakeElement(),
  };
  global.addEventListener = () => {};
  global.window = global;
  global.localStorage = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; }
  };
  global.alert = () => {};
  global.confirm = () => true;
  global.prompt = () => null;
  global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  global.Blob = function(){};
  global.FileReader = function(){ this.readAsText = () => {}; };

  return { elCache, storage };
}

// Retourne le code source de app.js (à concaténer avec le code de test
// avant un eval indirect commun — voir les fichiers tests/test-*.js
// pour le pattern exact). On ne fait PAS l'eval ici : app.js et le
// code de test doivent partager le même scope global pour que les
// fonctions/variables de l'app soient visibles depuis les tests.
function getAppCode(){
  const fs = require('fs');
  const path = require('path');
  return fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf-8');
}

module.exports = { fakeElement, createDomShim, getAppCode };
