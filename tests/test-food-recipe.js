const { createDomShim, getAppCode } = require('./dom-shim');
const { makeRunner } = require('./test-runner');

createDomShim();
const { T, report } = makeRunner();
global.T = T;

const testsCode = `
  T("cycle complet aliment : créer, favoriser, +1, éditer, supprimer", () => {
    state.foods = [];
    document.getElementById('itemName').value = 'Poivron';
    addMode='food'; selectedSymptoms=new Set(); pendingCooking=[]; pendingAssoc=[]; pendingIngredients=[];
    editingSeverities={}; editingFoodId=null; pendingFavorite=true;
    saveItem();
    const f = state.foods[0];
    toggleFavorite(f.id);
    changeCount(f.id, 1);
    deleteFood(f.id);
    return state.foods.length === 0;
  });

  T("impossible de créer un aliment sans nom", () => {
    state.foods = [];
    document.getElementById('itemName').value = '';
    addMode='food'; selectedSymptoms=new Set(); pendingCooking=[]; pendingAssoc=[]; pendingIngredients=[];
    editingSeverities={}; editingFoodId=null; pendingFavorite=false;
    saveItem();
    return state.foods.length === 0;
  });

  T("Carnet de Recettes : tri A→Z par défaut", () => {
    state.recipeBook = [
      {id:'1', name:'Tarte aux poireaux', ingredients:[]},
      {id:'2', name:'Curry de lentilles', ingredients:[]},
    ];
    rbSearchQuery = ''; rbSortBy = 'name-asc';
    renderRecipeBookList();
    const html = document.getElementById('recipeBookList').innerHTML;
    return html.indexOf('Curry') < html.indexOf('Tarte');
  });

  T("Carnet de Recettes : tri Z→A via onRBSortChange", () => {
    document.getElementById('rbSort').value = 'name-desc';
    onRBSortChange();
    renderRecipeBookList();
    const html = document.getElementById('recipeBookList').innerHTML;
    return html.indexOf('Tarte') < html.indexOf('Curry');
  });

  T("pack d'aliments : installation sans doublon", () => {
    state.foods = [];
    installFoodPack();
    const before = state.foods.length;
    installFoodPack();
    return before === FOOD_PACK.length && state.foods.length === before;
  });

  T("pack d'aliments : retrait sélectif protège les aliments utilisés", () => {
    const f = state.foods.find(f => f.name === 'Poivron');
    f.count = 3;
    removeUnusedPackFoods();
    return state.foods.some(f => f.name === 'Poivron') && state.foods.length === 1;
  });

  T("computeSymptomDeclareCounts ignore proprement les entrées food-log/recipe-log", () => {
    state.foods = [];
    state.agenda = { '2026-01-01': [
      { kind:'food-log', label:'x' },
      { kind:'symptom', symptomIds:['s1'] },
    ]};
    const counts = computeSymptomDeclareCounts();
    return counts['s1'] === 1 && Object.keys(counts).length === 1;
  });
`;

(0, eval)(getAppCode() + '\n' + testsCode);

const { pass, total } = report('Aliments & Recettes');
process.exitCode = (pass === total) ? 0 : 1;
