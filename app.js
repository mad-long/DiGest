const APP_VERSION = '1.0.0';
const STORE_KEY = 'intolerances_v1';
const SALT_KEY = 'intolerances_salt';
const SECURE_KEY = 'intolerances_secure';

let state = { symptoms: [], foods: [], recipeBook: [], gaugeTypes: [], agenda: {}, medications: [], pathologies: [] };
let sessionCryptoKey = null;

function migrateSeverity(){
  state.foods.forEach(f => {
    if(!f.symptoms){
      f.symptoms = (f.symptomIds || []).map(id => ({ id, severity: 2 }));
    }
  });
}
function migrateCooking(){
  state.foods.forEach(f => {
    if(Array.isArray(f.cooking)){
      f.cooking = f.cooking.map(c => typeof c === 'string' ? { name: c, count: 0 } : c);
    }
  });
}
function incrementCookingCount(foodId, name){
  const f = state.foods.find(f => f.id === foodId);
  if(!f || !Array.isArray(f.cooking)) return;
  const entry = f.cooking.find(c => (typeof c === 'string' ? c : c.name) === name);
  if(!entry) return;
  if(typeof entry === 'string') return;
  entry.count = (entry.count || 0) + 1;
  persist();
  renderFoodList();
}
let pendingCooking = [];
let pendingAssoc = [];
let pendingIngredients = [];
let pendingFavorite = false;
let selectedSymptoms = new Set();
let editingSeverities = {}; // id -> ancienne sévérité conservée lors d'une modification

// ---- Palette de couleurs pour les symptômes (16 teintes fixes) ----
const SYMPTOM_PALETTE = ['#C0392B','#D98A46','#D4AC0D','#4C7A52','#16A085','#6FA69D','#2980B9','#34495E','#8E44AD','#C2185B','#A65B3B','#7F8C8D','#27AE60','#E67E22','#5D6D7E','#B03A2E'];
function hexToRgb(hex){
  const h = hex.replace('#','');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function paletteIndexForColor(hex){
  if(!hex) return 0;
  const exact = SYMPTOM_PALETTE.findIndex(c => c.toLowerCase() === hex.toLowerCase());
  if(exact !== -1) return exact;
  const target = hexToRgb(hex);
  let best = 0, bestDist = Infinity;
  SYMPTOM_PALETTE.forEach((c, i) => {
    const rgb = hexToRgb(c);
    const d = (rgb.r-target.r)**2 + (rgb.g-target.g)**2 + (rgb.b-target.b)**2;
    if(d < bestDist){ bestDist = d; best = i; }
  });
  return best;
}
let pendingCreateColorIndex = 0;
function renderPaletteSwatches(activeIndex, dataActAttr){
  return SYMPTOM_PALETTE.map((hex, i) =>
    `<button type="button" class="swatch c${i} ${i === activeIndex ? 'active' : ''}" ${dataActAttr(i)} title="${hex}"></button>`
  ).join('');
}
let addMode = 'food';
let mainTab = 'aliments';
let activeFilters = { symptoms: new Set(), cooking: new Set(), assoc: new Set() };
let editingFoodId = null;
let editingCookingCounts = {};
let editingRBId = null;
let foodSearchQuery = '';
let foodSortBy = 'name-asc';
let rbSortBy = 'name-asc';
let rbSearchQuery = '';

let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let selectedDate = null;
let pendingAgendaSymptoms = new Set();
let pendingAgendaGauges = {};

const MEAL_TAGS = ['Petit-déj', 'Déjeuner', 'Goûter', 'Dîner', 'Snack'];
let pendingRBIngredients = [];
let pendingRBMeal = new Set();
let pendingRBDiet = [];
let pendingRBSpeed = 0;
let pendingRBEasy = 0;
let pendingRBPrice = 0;

/* ---------- Chiffrement (Web Crypto API) ---------- */
function hasCrypto(){
  return !!(window.crypto && window.crypto.subtle);
}
function b64encode(buf){
  const bytes = new Uint8Array(buf);
  let bin = '';
  for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(str){
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function deriveKey(passphrase, saltBytes){
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt:saltBytes, iterations:600000, hash:'SHA-256' },
    baseKey,
    { name:'AES-GCM', length:256 },
    false,
    ['encrypt','decrypt']
  );
}
async function aesEncryptJSON(key, obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64encode(iv), data: b64encode(ciphertext) };
}
async function aesDecryptJSON(key, ivB64, dataB64){
  const iv = new Uint8Array(b64decode(ivB64));
  const ciphertext = b64decode(dataB64);
  const plainBuf = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, ciphertext);
  const dec = new TextDecoder();
  return JSON.parse(dec.decode(plainBuf));
}
function isProtectionEnabled(){
  return !!localStorage.getItem(SALT_KEY);
}

function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
let persistQueue = Promise.resolve();
function persist(){
  // Capture immédiate et synchrone de l'état au moment de l'appel — garantit que
  // chaque sauvegarde écrit exactement ce qui était vrai à cet instant, même si
  // l'état change à nouveau avant que l'écriture (asynchrone en mode chiffré) ne se termine.
  const snapshot = JSON.stringify(state);
  const useCrypto = !!sessionCryptoKey;
  const key = sessionCryptoKey;
  // Chaînage sur la file d'attente précédente : les écritures se font une par une,
  // dans l'ordre où elles ont été demandées — jamais deux en parallèle qui pourraient
  // se terminer dans le désordre et faire gagner une version périmée.
  persistQueue = persistQueue.then(async () => {
    if(useCrypto){
      try{
        const payload = await aesEncryptJSON(key, JSON.parse(snapshot));
        try{
          localStorage.setItem(SECURE_KEY, JSON.stringify(payload));
          localStorage.removeItem(STORE_KEY);
        }catch(e){
          alert("Attention : l'enregistrement chiffré a échoué (stockage plein ou navigation privée). Pense à exporter tes données pour ne rien perdre.");
        }
      }catch(e){
        alert("Erreur de chiffrement lors de l'enregistrement. Tes données affichées sont à jour mais n'ont peut-être pas été sauvegardées — pense à exporter.");
      }
    } else {
      try{
        localStorage.setItem(STORE_KEY, snapshot);
      }catch(e){
        alert("Attention : l'enregistrement a échoué (stockage plein ou navigation privée). Pense à exporter tes données pour ne rien perdre.");
      }
    }
  }).catch(() => {}); // ne jamais laisser une erreur casser la chaîne pour les prochains appels
  return persistQueue;
}

// Retire les champs potentiellement identifiants d'un rendez-vous (nom, lieu, notes)
// pour l'export standard non chiffré — le type de médecin et l'heure restent, utiles
// pour préparer une prochaine consultation sans exposer de détail qui remonte à quelqu'un.
function redactRdvFieldsForExport(agenda){
  const clone = {};
  for(const [date, entries] of Object.entries(agenda || {})){
    clone[date] = (entries || []).map(e =>
      e.kind === 'appointment' ? { ...e, name: '', location: '', notes: '' } : e
    );
  }
  return clone;
}
function exportData(){
  const { medications, pathologies, ...exportable } = state;
  exportable.agenda = redactRdvFieldsForExport(exportable.agenda);
  const blob = new Blob([JSON.stringify(exportable, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `carnet-intolerances-${date}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  localStorage.setItem('intolerances_last_export', date);
  renderLastExportInfo();
  const hasRdv = Object.values(state.agenda || {}).some(entries => (entries||[]).some(e => e.kind === 'appointment'));
  if(hasRdv){
    alert("Pour rappel : le nom, le lieu et les notes de tes rendez-vous ne sont pas inclus dans cet export standard (seuls la date, l'heure et le type de médecin le sont) — utilise l'export protégé pour tout conserver.");
  }
  if((state.medications||[]).length > 0 || (state.pathologies||[]).length > 0){
    alert("Pour rappel : les sections pathologies/traitements ne sont jamais incluses dans les exports (ni standard, ni protégé) — elles restent uniquement sur cet appareil.");
  }
}
async function exportDataEncrypted(){
  if(!hasCrypto()){
    alert("Ce navigateur ne permet pas le chiffrement ici. Utilise l'export simple, ou réessaie depuis une version hébergée en HTTPS.");
    return;
  }
  const pass = prompt("Choisis un mot de passe pour protéger ce fichier exporté.\nNote-le bien : sans lui, ce fichier ne pourra jamais être ouvert.");
  if(!pass) return;
  const confirmPass = prompt("Confirme le mot de passe :");
  if(pass !== confirmPass){ alert('Les deux mots de passe ne correspondent pas. Export annulé.'); return; }
  try{
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(pass, salt);
    const { medications, pathologies, ...exportable } = state;
    const payload = await aesEncryptJSON(key, exportable);
    const out = { encrypted: true, salt: b64encode(salt), iv: payload.iv, data: payload.data };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0,10);
    a.href = url;
    a.download = `carnet-intolerances-protege-${date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    localStorage.setItem('intolerances_last_export', date + ' (protégé)');
    renderLastExportInfo();
    if((state.medications||[]).length > 0 || (state.pathologies||[]).length > 0){
      alert("Pour rappel : les sections pathologies/traitements ne sont jamais incluses dans les exports (ni standard, ni protégé) — elles restent uniquement sur cet appareil.");
    }
  }catch(e){
    alert("Erreur lors du chiffrement de l'export.");
  }
}
function renderLastExportInfo(){
  const el = document.getElementById('lastExportInfo');
  if(!el) return;
  const last = localStorage.getItem('intolerances_last_export');
  el.textContent = last ? `Dernière sauvegarde exportée : ${last}` : 'Aucune sauvegarde exportée — pense-y avant une mise à jour.';
}
function renderAppVersionInfo(){
  const el = document.getElementById('appVersionInfo');
  if(!el) return;
  el.textContent = `Digest v${APP_VERSION}`;
}

function isValidSymptom(s){
  return s && typeof s === 'object'
    && typeof s.id === 'string'
    && typeof s.name === 'string'
    && typeof s.color === 'string';
}
function isValidFood(f){
  if(!f || typeof f !== 'object') return false;
  if(typeof f.id !== 'string' || typeof f.name !== 'string') return false;
  if(f.type !== undefined && f.type !== 'food' && f.type !== 'recipe') return false;
  if(f.symptoms !== undefined){
    if(!Array.isArray(f.symptoms)) return false;
    for(const s of f.symptoms){
      if(!s || typeof s.id !== 'string') return false;
      if(s.severity !== undefined && ![1,2,3].includes(s.severity)) return false;
    }
  }
  if(f.symptomIds !== undefined && !Array.isArray(f.symptomIds)) return false;
  if(f.cooking !== undefined && !Array.isArray(f.cooking)) return false;
  if(f.assoc !== undefined && !Array.isArray(f.assoc)) return false;
  if(f.ingredients !== undefined && !Array.isArray(f.ingredients)) return false;
  if(f.count !== undefined && typeof f.count !== 'number') return false;
  return true;
}
function isValidRBEntry(r){
  return r && typeof r === 'object' && typeof r.id === 'string' && typeof r.name === 'string';
}
function isValidGaugeType(g){
  return g && typeof g === 'object' && typeof g.id === 'string' && typeof g.name === 'string';
}
function isValidAgendaEntry(e){
  return e && typeof e === 'object' && typeof e.id === 'string';
}
function sanitizeImportedState(imported){
  const symptoms = (imported.symptoms || []).filter(isValidSymptom);
  const foods = (imported.foods || []).filter(isValidFood).map(f => ({
    id: f.id, type: f.type === 'recipe' ? 'recipe' : 'food', name: String(f.name).slice(0,200),
    symptoms: Array.isArray(f.symptoms) ? f.symptoms.filter(s=>s&&typeof s.id==='string').map(s=>({id:s.id, severity:[1,2,3].includes(s.severity)?s.severity:2})) : [],
    symptomIds: Array.isArray(f.symptomIds) ? f.symptomIds : undefined,
    cooking: Array.isArray(f.cooking) ? f.cooking.map(c => typeof c === 'string' ? { name: String(c).slice(0,60), count:0 } : { name: String((c&&c.name)||'').slice(0,60), count: (typeof c.count==='number'&&c.count>=0) ? c.count : 0 }).filter(c => c.name) : [],
    assoc: Array.isArray(f.assoc) ? f.assoc : [],
    ingredients: Array.isArray(f.ingredients) ? f.ingredients : undefined,
    favorite: !!f.favorite,
    fromPack: !!f.fromPack,
    count: typeof f.count === 'number' && f.count >= 0 ? f.count : 0
  }));
  const recipeBook = (imported.recipeBook || []).filter(isValidRBEntry).map(r => ({
    id: r.id, name: String(r.name).slice(0,200),
    ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
    mealTags: Array.isArray(r.mealTags) ? r.mealTags : [],
    dietTags: Array.isArray(r.dietTags) ? r.dietTags : [],
    speed: [0,1,2,3].includes(r.speed) ? r.speed : 0,
    easy: [0,1,2,3].includes(r.easy) ? r.easy : 0,
    price: [0,1,2,3].includes(r.price) ? r.price : 0
  }));
  const gaugeTypes = (imported.gaugeTypes || []).filter(isValidGaugeType).map(g => ({ id: g.id, name: String(g.name).slice(0,60) }));
  const agenda = {};
  if(imported.agenda && typeof imported.agenda === 'object'){
    Object.keys(imported.agenda).forEach(key => {
      if(!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
      const entries = Array.isArray(imported.agenda[key]) ? imported.agenda[key].filter(isValidAgendaEntry) : [];
      if(entries.length){
        agenda[key] = entries.map(e => ({
          id: e.id,
          kind: ['appointment', 'food-log', 'recipe-log'].includes(e.kind) ? e.kind : 'symptom',
          symptomIds: Array.isArray(e.symptomIds) ? e.symptomIds : [],
          note: typeof e.note === 'string' ? e.note.slice(0,2000) : '',
          gauges: (e.gauges && typeof e.gauges === 'object') ? e.gauges : {},
          name: typeof e.name === 'string' ? e.name.slice(0,120) : '',
          time: typeof e.time === 'string' ? e.time.slice(0,10) : '',
          doctorType: typeof e.doctorType === 'string' ? e.doctorType.slice(0,120) : '',
          location: typeof e.location === 'string' ? e.location.slice(0,200) : '',
          label: typeof e.label === 'string' ? e.label.slice(0,200) : '',
          quickLog: !!e.quickLog
        }));
      }
    });
  }
  const medications = Array.isArray(imported.medications) ? imported.medications
    .filter(m => m && typeof m === 'object' && typeof m.id === 'string' && typeof m.name === 'string')
    .map(m => ({
      id: m.id,
      name: String(m.name).slice(0,120),
      dosage: typeof m.dosage === 'string' ? m.dosage.slice(0,120) : '',
      notes: typeof m.notes === 'string' ? m.notes.slice(0,1000) : ''
    })) : [];
  return { symptoms, foods, recipeBook, gaugeTypes, agenda, medications };
}
function importData(event){
  const file = event.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async function(e){
    try{
      const imported = JSON.parse(e.target.result);
      let toApply;
      if(imported && imported.encrypted === true && imported.salt && imported.iv && imported.data){
        if(!hasCrypto()){
          alert("Ce navigateur ne permet pas de déchiffrer ce fichier ici.");
          event.target.value = '';
          return;
        }
        const pass = prompt('Ce fichier est protégé. Entre le mot de passe utilisé lors de son export :');
        if(!pass){ event.target.value = ''; return; }
        const salt = new Uint8Array(b64decode(imported.salt));
        const key = await deriveKey(pass, salt);
        try{
          toApply = await aesDecryptJSON(key, imported.iv, imported.data);
        }catch(decErr){
          alert('Mot de passe incorrect, import annulé.');
          event.target.value = '';
          return;
        }
      } else {
        toApply = imported;
      }
      const structurallyValid = toApply && typeof toApply === 'object'
        && Array.isArray(toApply.symptoms)
        && Array.isArray(toApply.foods);
      if(!structurallyValid){ throw new Error('format invalide'); }
      const clean = sanitizeImportedState(toApply);

      const currentCounts = {
        aliments: state.foods.filter(f => f.type !== 'recipe').length,
        recettes: state.foods.filter(f => f.type === 'recipe').length,
        carnet: state.recipeBook.length,
        agenda: Object.values(state.agenda || {}).reduce((s, arr) => s + arr.length, 0),
        symptomes: state.symptoms.length
      };
      const newCounts = {
        aliments: clean.foods.filter(f => f.type !== 'recipe').length,
        recettes: clean.foods.filter(f => f.type === 'recipe').length,
        carnet: clean.recipeBook.length,
        agenda: Object.values(clean.agenda || {}).reduce((s, arr) => s + arr.length, 0),
        symptomes: clean.symptoms.length
      };
      const summaryMsg =
        `Le fichier contient : ${newCounts.aliments} aliment(s), ${newCounts.recettes} recette(s), ${newCounts.carnet} entrée(s) de carnet de recettes, ${newCounts.agenda} entrée(s) d'agenda, ${newCounts.symptomes} symptôme(s).\n\n` +
        `Ça remplacera ce qui est actuellement dans l'app : ${currentCounts.aliments} aliment(s), ${currentCounts.recettes} recette(s), ${currentCounts.carnet} entrée(s) de carnet, ${currentCounts.agenda} entrée(s) d'agenda, ${currentCounts.symptomes} symptôme(s).\n\n` +
        `Continuer ?`;
      if(!confirm(summaryMsg)) { event.target.value = ''; return; }

      const hasExistingData = currentCounts.aliments + currentCounts.recettes + currentCounts.carnet + currentCounts.agenda + currentCounts.symptomes > 0;
      if(hasExistingData && confirm("Veux-tu d'abord sauvegarder tes données actuelles (avant remplacement), au cas où ?")){
        exportData();
      }

      if(!confirm("Dernière confirmation : remplacer définitivement les données actuelles par celles du fichier importé ?")) { event.target.value = ''; return; }

      const keepMedications = state.medications || [];
      const keepPathologies = state.pathologies || [];
      state = clean;
      state.medications = keepMedications;
      state.pathologies = keepPathologies;
      migrateSeverity();
      migrateCooking();
      if(!state.gaugeTypes) state.gaugeTypes = [];
      if(!state.agenda) state.agenda = {};
      persist();
      renderAll();
      if(typeof renderRecipeBookList === 'function') renderRecipeBookList();
      if(typeof renderRankingList === 'function') renderRankingList();
      if(typeof renderCalendar === 'function') renderCalendar();
      if(typeof renderMedsSection === 'function') renderMedsSection();
      alert('Import réussi.');
    }catch(err){
      alert('Fichier invalide, import annulé.');
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
// Le suffixe aléatoire de uid() fait toujours exactement 5 caractères — on peut donc
// retrouver l'horodatage de création de n'importe quel élément à partir de son id,
// sans avoir besoin d'un champ de date dédié ni de migration de données existantes.
function decodeUidTimestamp(id){
  if(typeof id !== 'string' || id.length <= 5) return 0;
  const ms = parseInt(id.slice(0, -5), 36);
  return isNaN(ms) ? 0 : ms;
}

// ---- Onglet principal ----
function addFormIsDirty(){
  const nameInput = document.getElementById('itemName');
  const nameVal = nameInput ? nameInput.value.trim() : '';
  return !!nameVal || selectedSymptoms.size > 0 || pendingCooking.length > 0 || pendingAssoc.length > 0 || pendingIngredients.length > 0;
}
function rbFormIsDirty(){
  const nameInput = document.getElementById('rbName');
  const nameVal = nameInput ? nameInput.value.trim() : '';
  return !!nameVal || pendingRBIngredients.length > 0 || pendingRBMeal.size > 0 || pendingRBDiet.length > 0 || pendingRBSpeed > 0 || pendingRBEasy > 0 || pendingRBPrice > 0;
}
function setMainTab(tab){
  if(tab !== mainTab){
    if(mainTab === 'aliments' && !document.getElementById('addForm').classList.contains('u-hidden-mt16') && addFormIsDirty()){
      if(!confirm("Tu as un aliment ou une recette en cours de saisie, non enregistré.\n\nOK = abandonner et changer d'onglet\nAnnuler = rester ici pour l'enregistrer")) return;
      closeAddForm();
    }
    if(mainTab === 'recipebook' && !document.getElementById('rbForm').classList.contains('u-hidden-mt16') && rbFormIsDirty()){
      if(!confirm("Tu as une recette en cours de saisie dans le carnet, non enregistrée.\n\nOK = abandonner et changer d'onglet\nAnnuler = rester ici pour l'enregistrer")) return;
      closeRBForm();
    }
  }
  mainTab = tab;
  document.getElementById('viewAliments').classList.toggle('u-hidden', tab !== 'aliments');
  document.getElementById('viewRecipeBook').classList.toggle('u-hidden', tab !== 'recipebook');
  document.getElementById('viewRanking').classList.toggle('u-hidden', tab !== 'ranking');
  document.getElementById('viewAgenda').classList.toggle('u-hidden', tab !== 'agenda');
  document.getElementById('viewDoctorExport').classList.toggle('u-hidden', tab !== 'doctor');
  document.getElementById('viewParams').classList.toggle('u-hidden', tab !== 'params');
  document.getElementById('mainTabAliments').classList.toggle('active-tab', tab === 'aliments');
  document.getElementById('mainTabRecipeBook').classList.toggle('active-tab', tab === 'recipebook');
  document.getElementById('mainTabRanking').classList.toggle('active-tab', tab === 'ranking');
  document.getElementById('mainTabAgenda').classList.toggle('active-tab', tab === 'agenda');
  document.getElementById('mainTabDoctorExport').classList.toggle('active-tab', tab === 'doctor');
  document.getElementById('mainTabParams').classList.toggle('active-tab', tab === 'params');
  if(tab === 'recipebook') renderRecipeBookList();
  if(tab === 'ranking') renderRankingList();
  if(tab === 'agenda') renderCalendar();
  if(tab === 'doctor') renderDoctorExportForm();
  if(tab === 'params'){ renderSymptomManageList(); renderMedsSection(); }
}

// ---- Gestion des symptômes (nom, couleur, suppression) ----
// ---- Médicaments / traitements (uniquement si protection activée) ----
function renderMedsSection(){
  const gate = document.getElementById('medsGate');
  if(!gate) return;
  if(!isProtectionEnabled()){
    gate.innerHTML = `<p class="u-soft-85-m0">Pour ta confidentialité, cette section n'est utilisable qu'avec la protection par mot de passe activée (section Sécurité ci-dessus).</p>`;
    return;
  }
  const pathologies = state.pathologies || [];
  const meds = state.medications || [];

  let html = `<h3 class="u-m0">Pathologies</h3>`;
  html += pathologies.length ? pathologies.map(p => `
    <div class="u-row-item">
      <div class="u-minw0">
        <div class="u-bold-90">${escapeHtml(p.name)}</div>
        ${p.notes ? `<div class="u-note-80-pre">${escapeHtml(p.notes)}</div>` : ''}
      </div>
      <button class="text-action danger" data-act="deletePathology" data-a="${p.id}">Supprimer</button>
    </div>`).join('') : '<p class="u-soft-85-m0">Aucune pathologie enregistrée.</p>';
  html += `
    <div class="u-section-14">
      <label for="pathoName">Nom</label>
      <input type="text" id="pathoName" placeholder="ex. Maladie cœliaque">
      <label for="pathoNotes">Notes (facultatif)</label>
      <textarea id="pathoNotes" rows="2" placeholder="ex. diagnostiquée en…"></textarea>
      <button class="btn secondary small u-mt8" data-act="addPathology">Ajouter</button>
    </div>`;

  html += `<h3 class="u-mt18-76">Traitements</h3>`;
  html += meds.length ? meds.map(m => `
    <div class="u-row-item">
      <div class="u-minw0">
        <div class="u-bold-90">${escapeHtml(m.name)}</div>
        ${m.dosage ? `<div class="u-note-80">${escapeHtml(m.dosage)}</div>` : ''}
        ${m.notes ? `<div class="u-note-80-pre">${escapeHtml(m.notes)}</div>` : ''}
      </div>
      <button class="text-action danger" data-act="deleteMedication" data-a="${m.id}">Supprimer</button>
    </div>`).join('') : '<p class="u-soft-85-m0">Aucun traitement enregistré.</p>';
  html += `
    <div class="u-section-14">
      <label for="medName">Nom</label>
      <input type="text" id="medName" placeholder="ex. Levothyrox">
      <label for="medDosage">Posologie (facultatif)</label>
      <input type="text" id="medDosage" placeholder="ex. 50 µg, 1x/jour le matin">
      <label for="medNotes">Notes (facultatif)</label>
      <textarea id="medNotes" rows="2" placeholder="ex. à jeun, ne pas associer à…"></textarea>
      <button class="btn secondary small u-mt8" data-act="addMedication">Ajouter</button>
    </div>
    <p class="u-note-72">Ces sections ne sont jamais incluses dans un export, protégé ou non — elles restent uniquement sur cet appareil.</p>`;
  gate.innerHTML = html;
}
function addPathology(){
  const nameInput = document.getElementById('pathoName');
  const name = nameInput.value.trim();
  if(!name){ nameInput.focus(); return; }
  const notes = document.getElementById('pathoNotes').value.trim();
  if(!state.pathologies) state.pathologies = [];
  state.pathologies.push({ id: uid(), name, notes });
  persist();
  renderMedsSection();
}
function deletePathology(id){
  state.pathologies = (state.pathologies || []).filter(p => p.id !== id);
  persist();
  renderMedsSection();
}
function addMedication(){
  const nameInput = document.getElementById('medName');
  const name = nameInput.value.trim();
  if(!name){ nameInput.focus(); return; }
  const dosage = document.getElementById('medDosage').value.trim();
  const notes = document.getElementById('medNotes').value.trim();
  if(!state.medications) state.medications = [];
  state.medications.push({ id: uid(), name, dosage, notes });
  persist();
  renderMedsSection();
}
function deleteMedication(id){
  state.medications = (state.medications || []).filter(m => m.id !== id);
  persist();
  renderMedsSection();
}

function renderSymptomManageList(){
  const el = document.getElementById('symptomManageList');
  if(!el) return;
  if(state.symptoms.length === 0){
    el.innerHTML = '<p class="u-soft-85-m0">Aucun symptôme créé pour l\'instant.</p>';
    return;
  }
  const active = activeSymptoms();
  const archived = state.symptoms.filter(s => s.archived);
  let html = active.map(symptomManageRow).join('');
  if(archived.length){
    html += `<p class="u-section-label">Archivés (historique conservé, plus proposés pour de nouvelles entrées)</p>`;
    html += archived.map(symptomManageRow).join('');
  }
  el.innerHTML = html;
}
function symptomManageRow(s){
  const idx = paletteIndexForColor(s.color);
  const swatches = renderPaletteSwatches(idx, i => `data-act="pickSymptomColor" data-a="${s.id}" data-b="${i}"`);
  return `
    <div class="symptom-row ${s.archived ? 'is-archived' : ''}">
      <span class="dot c${idx}"></span>
      <input type="text" value="${escapeAttr(s.name)}" data-act="updateSymptomName" data-a="${s.id}" class="symptom-name-input">
      <button type="button" class="swatch-toggle c${idx}" data-act="toggleColorPalette" data-a="${s.id}" title="Changer la couleur"></button>
      ${s.archived
        ? `<button class="btn secondary small" data-act="reactivateSymptom" data-a="${s.id}">Réactiver</button>`
        : `<button class="icon-btn" title="Supprimer" data-act="deleteSymptom" data-a="${s.id}">🗑</button>`}
    </div>
    <div class="palette-row" id="palette-${s.id}">${swatches}</div>`;
}
function toggleColorPalette(id){
  const el = document.getElementById('palette-' + id);
  if(!el) return;
  el.classList.toggle('is-open');
}
function pickSymptomColor(id, idxStr){
  updateSymptomColor(id, SYMPTOM_PALETTE[parseInt(idxStr, 10)] || SYMPTOM_PALETTE[0]);
  const el = document.getElementById('palette-' + id);
  if(el) el.classList.remove('is-open');
}
function updateSymptomColor(id, color){
  const s = state.symptoms.find(s => s.id === id);
  if(!s) return;
  s.color = color;
  persist();
  renderSymptomManageList();
  renderFoodList();
  renderFilters();
  if(typeof renderRankingList === 'function') renderRankingList();
  if(selectedDate && typeof renderAgendaEntries === 'function') renderAgendaEntries();
}
function updateSymptomName(id, name){
  const trimmed = name.trim();
  const s = state.symptoms.find(s => s.id === id);
  if(!s) return;
  if(!trimmed){ renderSymptomManageList(); return; }
  s.name = trimmed;
  persist();
  renderSymptomManageList();
  renderFoodList();
  renderFilters();
  if(typeof renderRankingList === 'function') renderRankingList();
  if(selectedDate && typeof renderAgendaEntries === 'function') renderAgendaEntries();
}
function countSymptomUsage(id){
  const foodCount = state.foods.filter(f => (f.symptoms || []).some(fs => fs.id === id)).length;
  const agendaCount = Object.values(state.agenda || {}).reduce((sum, entries) =>
    sum + entries.filter(e => (e.symptomIds || []).includes(id)).length, 0);
  return { foodCount, agendaCount, total: foodCount + agendaCount };
}
function activeSymptoms(){
  return state.symptoms.filter(s => !s.archived);
}
function deleteSymptom(id){
  const s = state.symptoms.find(s => s.id === id);
  if(!s) return;
  const { foodCount, agendaCount, total } = countSymptomUsage(id);
  if(total === 0){
    if(confirm(`Supprimer le symptôme « ${s.name} » ? Il n'est utilisé nulle part pour l'instant.`)){
      state.symptoms = state.symptoms.filter(sym => sym.id !== id);
      persist();
      refreshAfterSymptomChange();
    }
    return;
  }
  const purgeAll = confirm(
    `Le symptôme « ${s.name} » est utilisé dans ${foodCount} aliment(s)/recette(s) et ${agendaCount} entrée(s) d'agenda.\n\n` +
    `OK = supprimer aussi tout l'historique associé (irréversible)\n` +
    `Annuler = ne plus proposer ce symptôme pour de nouvelles entrées, mais garder l'historique existant tel quel`
  );
  if(purgeAll){
    if(!confirm(`Confirme : supprimer définitivement « ${s.name} » et le retirer de tous les aliments, recettes et entrées d'agenda concernés ?`)) return;
    state.symptoms = state.symptoms.filter(sym => sym.id !== id);
    state.foods.forEach(f => {
      if(Array.isArray(f.symptoms)) f.symptoms = f.symptoms.filter(fs => fs.id !== id);
      if(Array.isArray(f.symptomIds)) f.symptomIds = f.symptomIds.filter(x => x !== id);
    });
    Object.keys(state.agenda || {}).forEach(key => {
      state.agenda[key] = (state.agenda[key] || []).map(e => ({ ...e, symptomIds: (e.symptomIds || []).filter(x => x !== id) }));
    });
  } else {
    s.archived = true;
  }
  persist();
  refreshAfterSymptomChange();
}
function reactivateSymptom(id){
  const s = state.symptoms.find(s => s.id === id);
  if(!s) return;
  s.archived = false;
  persist();
  renderSymptomManageList();
  renderFilters();
}
function refreshAfterSymptomChange(){
  renderSymptomManageList();
  renderFoodList();
  renderFilters();
  if(typeof renderRankingList === 'function') renderRankingList();
  if(typeof renderCalendar === 'function') renderCalendar();
  if(selectedDate && typeof renderAgendaEntries === 'function') renderAgendaEntries();
}

// ---- Add mode (aliment / recette) ----
function setAddMode(mode){
  addMode = mode;
  document.getElementById('addForm').classList.remove('u-hidden-mt16');
  document.getElementById('addFormTitle').textContent = mode === 'recipe' ? 'Ajouter une recette' : 'Ajouter un aliment';
  document.getElementById('nameLabel').textContent = mode === 'recipe' ? 'Nom de la recette' : "Nom de l'aliment";
  document.getElementById('ingredientsSection').classList.toggle('u-hidden', mode !== 'recipe');
  document.getElementById('tabFoodBtn').classList.toggle('active-tab', mode === 'food');
  document.getElementById('tabRecipeBtn').classList.toggle('active-tab', mode === 'recipe');
  renderMiciQuickPicks();
  addFormGoToStep(1);
  document.getElementById('itemName').focus();
}
function resetAddForm(){
  document.getElementById('itemName').value = '';
  document.getElementById('symptomSearch').value = '';
  document.getElementById('symptomResults').innerHTML = '';
  selectedSymptoms = new Set();
  editingSeverities = {};
  pendingCooking = []; pendingAssoc = []; pendingIngredients = [];
  editingCookingCounts = {};
  pendingFavorite = false;
  editingFoodId = null;
  const favBtn = document.getElementById('favToggleBtn');
  favBtn.textContent = '☆ Marquer en favori';
  favBtn.classList.remove('active');
  const saveBtn = document.getElementById('saveItemBtn');
  if(saveBtn) saveBtn.textContent = 'Ajouter à la liste';
  renderSymptomSelected();
  renderPendingTags();
  addFormGoToStep(1);
}
const ADD_FORM_STEP_COUNT = 4;
// ⚠️ Le nombre d'étapes (4) est câblé en dur dans les classes CSS .wizard-progress-fill.step-1
// à .step-4 (style.css) — CSP interdit de calculer une largeur via un style en ligne.
let addFormStep = 1;
function addFormGoToStep(n){
  addFormStep = Math.max(1, Math.min(ADD_FORM_STEP_COUNT, n));
  for(let i = 1; i <= ADD_FORM_STEP_COUNT; i++){
    const el = document.getElementById('addStep' + i);
    if(el) el.classList.toggle('u-hidden', i !== addFormStep);
  }
  document.getElementById('addFormProgressFill').className = 'wizard-progress-fill step-' + addFormStep;
  document.getElementById('addFormStepLabel').textContent = `Étape ${addFormStep} sur ${ADD_FORM_STEP_COUNT}`;
  document.getElementById('addFormBackBtn').disabled = addFormStep === 1;
  const nextBtn = document.getElementById('addFormNextBtn');
  // À la dernière étape, "Suivant" s'efface : le bouton "Ajouter à la liste" (déjà visible dans l'étape) devient l'action finale.
  nextBtn.classList.toggle('u-hidden', addFormStep === ADD_FORM_STEP_COUNT);
}
function addFormNextStep(){ addFormGoToStep(addFormStep + 1); }
function addFormPrevStep(){ addFormGoToStep(addFormStep - 1); }

const MICI_QUICK_SYMPTOMS = [
  'Douleurs abdominales', 'Diarrhée', 'Sang dans les selles', 'Urgence défécatoire',
  'Ballonnements', 'Fatigue intense', 'Perte d\'appétit', 'Nausées'
];
function renderMiciQuickPicks(){
  const el = document.getElementById('miciQuickPicks');
  if(!el) return;
  el.innerHTML = MICI_QUICK_SYMPTOMS.map(name => {
    const existing = state.symptoms.find(s => !s.archived && s.name.toLowerCase() === name.toLowerCase());
    const active = existing && selectedSymptoms.has(existing.id);
    return `<button type="button" class="chip ${active ? 'active' : 'suggestion'}" data-act="quickPickMiciSymptom" data-a="${escapeAttr(name)}">${escapeHtml(name)}</button>`;
  }).join('');
}
function quickPickMiciSymptom(name){
  let s = state.symptoms.find(sym => !sym.archived && sym.name.toLowerCase() === name.toLowerCase());
  if(s){
    if(selectedSymptoms.has(s.id)){ selectedSymptoms.delete(s.id); }
    else { selectedSymptoms.add(s.id); }
  } else {
    // Couleur choisie automatiquement (index basé sur la position dans la liste MICI, pour une répartition stable)
    const idx = MICI_QUICK_SYMPTOMS.indexOf(name) % SYMPTOM_PALETTE.length;
    s = { id: uid(), name, color: SYMPTOM_PALETTE[idx] };
    state.symptoms.push(s);
    persist();
    selectedSymptoms.add(s.id);
    if(typeof renderFilters === 'function') renderFilters();
    if(typeof renderSymptomManageList === 'function') renderSymptomManageList();
  }
  renderSymptomSelected();
  renderMiciQuickPicks();
}
function requestCloseAddForm(){
  if(addFormIsDirty() && !confirm("Abandonner cette saisie non enregistrée ?")) return;
  closeAddForm();
}
function closeAddForm(){
  document.getElementById('addForm').classList.add('u-hidden-mt16');
  document.getElementById('tabFoodBtn').classList.remove('active-tab');
  document.getElementById('tabRecipeBtn').classList.remove('active-tab');
  resetAddForm();
}
function toggleAddFavorite(){
  pendingFavorite = !pendingFavorite;
  const favBtn = document.getElementById('favToggleBtn');
  favBtn.textContent = pendingFavorite ? '★ En favori' : '☆ Marquer en favori';
  favBtn.classList.toggle('active', pendingFavorite);
}

// ---- Symptoms (recherche en direct) ----
const symptomPickers = {
  main:   { getSelected: () => selectedSymptoms,        searchInput:'symptomSearch',       results:'symptomResults',       selectedEl:'symptomSelected' },
  agenda: { getSelected: () => pendingAgendaSymptoms,    searchInput:'agendaSymptomSearch', results:'agendaSymptomResults', selectedEl:'agendaSymptomSelected' }
};
function renderSymptomPicker(key){
  const cfg = symptomPickers[key];
  const sel = cfg.getSelected();
  const el = document.getElementById(cfg.selectedEl);
  if(sel.size === 0){
    el.innerHTML = '<span class="u-soft-85">Aucun symptôme sélectionné.</span>';
    return;
  }
  el.innerHTML = Array.from(sel).map(id => {
    const s = state.symptoms.find(s => s.id === id);
    if(!s) return '';
    return `<button type="button" class="chip active" data-act="removeSymptomFromPicker" data-a="${key}" data-b="${id}"><span class="dot c${paletteIndexForColor(s.color)}"></span>${escapeHtml(s.name)} ✕</button>`;
  }).join('');
}
function removeSymptomFromPicker(key, id){
  symptomPickers[key].getSelected().delete(id);
  renderSymptomPicker(key);
}
function selectSymptomForPicker(key, id){
  const cfg = symptomPickers[key];
  cfg.getSelected().add(id);
  document.getElementById(cfg.searchInput).value = '';
  document.getElementById(cfg.results).innerHTML = '';
  renderSymptomPicker(key);
  document.getElementById(cfg.searchInput).focus();
}
function onSymptomPickerSearch(key){
  const cfg = symptomPickers[key];
  const input = document.getElementById(cfg.searchInput);
  const q = input.value.trim().toLowerCase();
  const resultsEl = document.getElementById(cfg.results);
  if(!q){ resultsEl.innerHTML = ''; return; }
  const sel = cfg.getSelected();
  const matches = state.symptoms.filter(s => !s.archived && s.name.toLowerCase().includes(q));
  let html = '';
  if(matches.length){
    html += '<div class="chip-row u-mt8">' + matches.map(s => `
      <button type="button" class="chip ${sel.has(s.id) ? 'active' : 'suggestion'}" data-act="selectSymptomForPicker" data-a="${key}" data-b="${s.id}">
        <span class="dot c${paletteIndexForColor(s.color)}"></span>${escapeHtml(s.name)}
      </button>`).join('') + '</div>';
  }
  const exact = state.symptoms.some(s => !s.archived && s.name.toLowerCase() === q);
  if(!exact){
    pendingCreateColorIndex = 0;
    html += `<div class="u-mt8">
      <div class="palette-row is-open">${renderPaletteSwatches(pendingCreateColorIndex, i => `data-act="selectCreateColor" data-a="${i}"`)}</div>
      <button class="btn secondary small" data-act="createSymptomForPicker" data-a="${key}">Créer « ${escapeHtml(input.value.trim())} »</button>
    </div>`;
  }
  resultsEl.innerHTML = html;
}
function selectCreateColor(idxStr){
  pendingCreateColorIndex = parseInt(idxStr, 10) || 0;
  document.querySelectorAll('.palette-row.is-open .swatch').forEach((btn, i) => {
    btn.classList.toggle('active', i === pendingCreateColorIndex);
  });
}
function createSymptomForPicker(key){
  const cfg = symptomPickers[key];
  const input = document.getElementById(cfg.searchInput);
  const name = input.value.trim();
  if(!name) return;
  if(state.symptoms.some(s => s.name.toLowerCase() === name.toLowerCase())) return;
  const color = SYMPTOM_PALETTE[pendingCreateColorIndex] || SYMPTOM_PALETTE[0];
  const s = { id: uid(), name, color };
  state.symptoms.push(s);
  persist();
  cfg.getSelected().add(s.id);
  input.value = '';
  document.getElementById(cfg.results).innerHTML = '';
  renderSymptomPicker(key);
  if(typeof renderFilters === 'function') renderFilters();
  if(typeof renderSymptomManageList === 'function') renderSymptomManageList();
  input.focus();
}

// Formulaire principal (aliment/recette) — délègue au moteur partagé ci-dessus
function renderSymptomSelected(){ renderSymptomPicker('main'); }
function onSymptomSearch(){ onSymptomPickerSearch('main'); }

// ---- Pending tags for the add-form (cuisson / association / ingrédients) ----
function addPendingTag(kind){
  const inputId = kind === 'cooking' ? 'cookingInput' : kind === 'assoc' ? 'assocInput' : 'ingredientInput';
  const input = document.getElementById(inputId);
  const val = input.value.trim();
  if(!val) return;
  const arr = kind === 'cooking' ? pendingCooking : kind === 'assoc' ? pendingAssoc : pendingIngredients;
  if(!arr.includes(val)) arr.push(val);
  if(kind === 'ingredient') ensureFoodExists(val);
  input.value = '';
  if(kind === 'ingredient'){
    const resEl = document.getElementById('ingredientSearchResults');
    if(resEl) resEl.innerHTML = '';
  }
  renderPendingTags();
}
const ingredientPickers = {
  main: { getList: () => pendingIngredients, searchInput:'ingredientInput', results:'ingredientSearchResults', selectAction:'selectIngredientSuggestion', onChange: () => renderPendingTags() },
  rb:   { getList: () => pendingRBIngredients, searchInput:'rbIngredientInput', results:'rbIngredientSearchResults', selectAction:'selectRBIngredientSuggestion', onChange: () => renderRBPending() }
};
function onIngredientPickerSearch(key){
  const cfg = ingredientPickers[key];
  const input = document.getElementById(cfg.searchInput);
  const q = input.value.trim().toLowerCase();
  const el = document.getElementById(cfg.results);
  if(!q){ el.innerHTML = ''; return; }
  const list = cfg.getList();
  const matches = allFoodNames().filter(n => n.toLowerCase().includes(q) && !list.includes(n));
  el.innerHTML = matches.length
    ? '<div class="chip-row u-mt6">' + matches.map(n => `<button type="button" class="chip suggestion" data-act="${cfg.selectAction}" data-a="${escapeAttr(n)}">${escapeHtml(n)}</button>`).join('') + '</div>'
    : '';
}
function selectIngredientForPicker(key, name){
  const cfg = ingredientPickers[key];
  const list = cfg.getList();
  if(!list.includes(name)) list.push(name);
  document.getElementById(cfg.searchInput).value = '';
  document.getElementById(cfg.results).innerHTML = '';
  cfg.onChange();
}
function onIngredientSearch(){ onIngredientPickerSearch('main'); }
function selectIngredientSuggestion(name){ selectIngredientForPicker('main', name); }
function showToast(msg){
  let el = document.getElementById('toast');
  if(!el){
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { el.classList.remove('show'); }, 2600);
}
// ---- Pack d'aliments optionnel (installable depuis Paramètres) ----
const FOOD_PACK = [
  'Pomme', 'Poire', 'Banane', 'Orange', 'Mandarine', 'Clémentine', 'Citron', 'Citron vert',
  'Pamplemousse', 'Fraise', 'Framboise', 'Myrtille', 'Mûre', 'Groseille', 'Cassis', 'Cerise',
  'Abricot', 'Pêche', 'Nectarine', 'Prune', 'Raisin', 'Kiwi', 'Ananas', 'Mangue',
  'Papaye', 'Fruit de la passion', 'Litchi', 'Grenade', 'Figue', 'Datte', 'Pastèque', 'Melon',
  'Rhubarbe', 'Coing', 'Nèfle', 'Kaki', 'Avocat', 'Noix de coco', 'Banane plantain', 'Goyave',
  'Tomate', 'Concombre', 'Carotte', 'Pomme de terre', 'Patate douce', 'Oignon', 'Échalote', 'Ail',
  'Poireau', 'Céleri', 'Céleri-rave', 'Poivron', 'Aubergine', 'Courgette', 'Potiron', 'Butternut',
  'Citrouille', 'Brocoli', 'Chou-fleur', 'Chou vert', 'Chou rouge', 'Chou de Bruxelles', 'Chou frisé (kale)', 'Épinard',
  'Salade (laitue)', 'Roquette', 'Mâche', 'Endive', 'Radis', 'Betterave', 'Navet', 'Fenouil',
  'Artichaut', 'Asperge', 'Haricot vert', 'Petit pois', 'Maïs', 'Champignon de Paris', 'Cèpe', 'Girolle',
  'Pleurote', 'Cornichon', 'Blette', 'Cresson', 'Salsifis', 'Panais', 'Topinambour', 'Igname',
  'Manioc', 'Riz blanc', 'Riz complet', 'Riz basmati', 'Pâtes', 'Blé', 'Semoule', 'Couscous',
  'Quinoa', 'Boulgour', 'Avoine', 'Orge', 'Sarrasin', 'Millet', 'Épeautre', 'Seigle',
  'Polenta', 'Pain blanc', 'Pain complet', 'Pain de mie', 'Pain aux céréales', 'Baguette', 'Biscotte', 'Céréales du petit-déjeuner',
  'Flocons d\'avoine', 'Lentilles vertes', 'Lentilles corail', 'Pois chiches', 'Haricots rouges', 'Haricots blancs', 'Haricots noirs', 'Fèves',
  'Soja', 'Edamame', 'Tofu', 'Poulet', 'Dinde', 'Canard', 'Bœuf', 'Veau',
  'Porc', 'Agneau', 'Mouton', 'Lapin', 'Jambon', 'Saucisse', 'Saucisson', 'Chorizo',
  'Bacon', 'Lardons', 'Steak haché', 'Foie', 'Rognons', 'Merguez', 'Pâté', 'Saumon',
  'Thon', 'Cabillaud', 'Sole', 'Truite', 'Sardine', 'Maquereau', 'Anchois', 'Bar',
  'Dorade', 'Colin', 'Lieu', 'Merlan', 'Hareng', 'Crevette', 'Moule', 'Huître',
  'Coquille Saint-Jacques', 'Calamar', 'Poulpe', 'Crabe', 'Homard', 'Langoustine', 'Tourteau', 'Surimi',
  'Lait de vache', 'Lait entier', 'Lait demi-écrémé', 'Lait écrémé', 'Lait d\'amande', 'Lait de soja', 'Lait d\'avoine', 'Lait de coco',
  'Yaourt nature', 'Yaourt grec', 'Fromage blanc', 'Beurre', 'Crème fraîche', 'Crème liquide', 'Œuf', 'Œuf de caille',
  'Petit-suisse', 'Skyr', 'Kéfir', 'Babeurre', 'Camembert', 'Brie', 'Comté', 'Emmental',
  'Gruyère', 'Roquefort', 'Chèvre', 'Mozzarella', 'Parmesan', 'Feta', 'Cheddar', 'Reblochon',
  'Mimolette', 'Fromage frais', 'Ricotta', 'Amande', 'Noix', 'Noisette', 'Cacahuète', 'Pistache',
  'Noix de cajou', 'Noix de pécan', 'Graine de tournesol', 'Graine de courge', 'Graine de lin', 'Graine de chia', 'Graine de sésame', 'Pignon de pin',
  'Noix du Brésil', 'Noix de macadamia', 'Sel', 'Poivre', 'Paprika', 'Curry', 'Curcuma', 'Cumin',
  'Cannelle', 'Gingembre', 'Muscade', 'Piment', 'Piment d\'Espelette', 'Origan', 'Basilic', 'Thym',
  'Romarin', 'Persil', 'Ciboulette', 'Coriandre', 'Menthe', 'Laurier', 'Moutarde', 'Mayonnaise',
  'Ketchup', 'Vinaigre', 'Huile d\'olive', 'Huile de tournesol', 'Huile de colza', 'Sauce soja', 'Miel', 'Sucre',
  'Eau', 'Café', 'Thé', 'Tisane', 'Jus d\'orange', 'Jus de pomme', 'Jus de raisin', 'Soda',
  'Coca', 'Limonade', 'Bière', 'Vin rouge', 'Vin blanc', 'Champagne', 'Cidre', 'Lait chocolaté',
  'Chocolat chaud', 'Smoothie', 'Eau gazeuse', 'Kombucha', 'Chocolat', 'Chocolat noir', 'Chocolat au lait', 'Biscuit',
  'Gâteau', 'Tarte', 'Croissant', 'Pain au chocolat', 'Brioche', 'Crêpe', 'Gaufre', 'Confiture',
  'Pâte à tartiner', 'Glace', 'Sorbet', 'Bonbon', 'Chewing-gum', 'Céréales sucrées', 'Compote', 'Pizza',
  'Burger', 'Sandwich', 'Quiche', 'Lasagnes', 'Soupe', 'Bouillon', 'Sauce tomate', 'Chips',
  'Frites', 'Nuggets', 'Cordon bleu', 'Plat surgelé', 'Conserve de thon', 'Conserve de maïs', 'Houmous', 'Tapenade',
  'Guacamole', 'Falafel', 'Sushi'
];
function installFoodPack(){
  let added = 0;
  FOOD_PACK.forEach(name => {
    const exists = state.foods.some(f => f.type !== 'recipe' && f.name.toLowerCase() === name.toLowerCase());
    if(!exists){
      state.foods.push({ id: uid(), type:'food', name, symptoms:[], cooking:[], assoc:[], favorite:false, count:0, fromPack:true });
      added++;
    }
  });
  persist();
  renderFoodList();
  renderFilters();
  alert(added > 0 ? `${added} aliment(s) ajouté(s) depuis le pack.` : "Tous les aliments du pack sont déjà dans ta liste.");
}
function removeUnusedPackFoods(){
  const toRemove = state.foods.filter(f =>
    f.fromPack && (f.count||0) === 0 && !f.favorite &&
    (f.symptoms||[]).length === 0 && (f.cooking||[]).length === 0 && (f.assoc||[]).length === 0
  );
  if(toRemove.length === 0){ alert("Aucun aliment du pack à retirer — soit tu n'as pas installé le pack, soit tu utilises déjà tout ce qui en reste."); return; }
  if(!confirm(`Retirer ${toRemove.length} aliment(s) du pack jamais utilisé(s) ? Les aliments du pack que tu as déjà commencé à utiliser (favori, symptôme, réaction...) resteront intacts.`)) return;
  const removeIds = new Set(toRemove.map(f => f.id));
  state.foods = state.foods.filter(f => !removeIds.has(f.id));
  persist();
  renderFoodList();
  renderFilters();
  alert(`${toRemove.length} aliment(s) du pack retiré(s).`);
}

function ensureFoodExists(name){
  const exists = state.foods.some(f => f.type !== 'recipe' && f.name.toLowerCase() === name.toLowerCase());
  if(exists) return;
  state.foods.push({ id: uid(), type: 'food', name, symptoms: [], cooking: [], assoc: [], favorite: false, count: 0 });
  persist();
  if(typeof renderFoodList === 'function') renderFoodList();
  if(typeof renderFilters === 'function') renderFilters();
  showToast(`"${name}" ajouté aux Aliments`);
}
function removePendingTag(kind, val){
  if(kind === 'cooking') pendingCooking = pendingCooking.filter(v => v !== val);
  else if(kind === 'assoc') pendingAssoc = pendingAssoc.filter(v => v !== val);
  else pendingIngredients = pendingIngredients.filter(v => v !== val);
  renderPendingTags();
}
function renderPendingTags(){
  document.getElementById('pendingCooking').innerHTML = pendingCooking.map(v =>
    `<button type="button" class="chip active" data-act="removePendingTag" data-a="cooking" data-b="${escapeAttr(v)}">${escapeHtml(v)} ✕</button>`).join('');
  document.getElementById('pendingAssoc').innerHTML = pendingAssoc.map(v =>
    `<button type="button" class="chip active" data-act="removePendingTag" data-a="assoc" data-b="${escapeAttr(v)}">${escapeHtml(v)} ✕</button>`).join('');
  const ingEl = document.getElementById('pendingIngredient');
  if(ingEl) ingEl.innerHTML = pendingIngredients.map(v =>
    `<button type="button" class="chip active" data-act="removePendingTag" data-a="ingredient" data-b="${escapeAttr(v)}">${escapeHtml(v)} ✕</button>`).join('');
}

// ---- Save item (aliment ou recette) ----
function saveItem(){
  const nameInput = document.getElementById('itemName');
  const name = nameInput.value.trim();
  if(!name){ nameInput.focus(); return; }
  const symptoms = Array.from(selectedSymptoms).map(id => ({ id, severity: editingSeverities[id] || 2 }));
  const cooking = pendingCooking.map(cName => ({ name: cName, count: editingCookingCounts[cName] || 0 }));
  if(editingFoodId){
    const existing = state.foods.find(f => f.id === editingFoodId);
    if(existing){
      existing.type = addMode === 'recipe' ? 'recipe' : 'food';
      existing.name = name;
      existing.symptoms = symptoms;
      delete existing.symptomIds;
      existing.cooking = cooking;
      existing.assoc = [...pendingAssoc];
      existing.favorite = pendingFavorite;
      if(addMode === 'recipe') existing.ingredients = [...pendingIngredients]; else delete existing.ingredients;
    }
  } else {
    const item = {
      id: uid(),
      type: addMode === 'recipe' ? 'recipe' : 'food',
      name,
      symptoms,
      cooking,
      assoc: [...pendingAssoc],
      favorite: pendingFavorite,
      count: 0
    };
    if(addMode === 'recipe') item.ingredients = [...pendingIngredients];
    state.foods.push(item);
    logDailyActivity(addMode === 'recipe' ? 'recipe-log' : 'food-log', name);
    if(Math.random() < 1/6){
      triggerFirework(addMode === 'recipe' ? 'teal' : 'orange');
    }
  }
  persist();
  closeAddForm();
  renderAll();
  renderRankingList();
  refreshAgendaDependentViews();
}

function openEditFood(id){
  const f = state.foods.find(f => f.id === id);
  if(!f) return;
  editingFoodId = id;
  addMode = f.type === 'recipe' ? 'recipe' : 'food';
  document.getElementById('addForm').classList.remove('u-hidden-mt16');
  document.getElementById('addFormTitle').textContent = addMode === 'recipe' ? 'Modifier la recette' : "Modifier l'aliment";
  document.getElementById('nameLabel').textContent = addMode === 'recipe' ? 'Nom de la recette' : "Nom de l'aliment";
  document.getElementById('ingredientsSection').classList.toggle('u-hidden', addMode !== 'recipe');
  document.getElementById('tabFoodBtn').classList.toggle('active-tab', addMode === 'food');
  document.getElementById('tabRecipeBtn').classList.toggle('active-tab', addMode === 'recipe');
  document.getElementById('itemName').value = f.name;
  editingSeverities = {};
  selectedSymptoms = new Set((f.symptoms || []).map(s => { editingSeverities[s.id] = s.severity || 2; return s.id; }));
  editingCookingCounts = {};
  pendingCooking = (f.cooking || []).map(c => {
    if(typeof c === 'string') return c;
    editingCookingCounts[c.name] = c.count || 0;
    return c.name;
  });
  pendingAssoc = [...(f.assoc || [])];
  pendingIngredients = [...(f.ingredients || [])];
  pendingFavorite = !!f.favorite;
  const favBtn = document.getElementById('favToggleBtn');
  favBtn.textContent = pendingFavorite ? '★ En favori' : '☆ Marquer en favori';
  favBtn.classList.toggle('active', pendingFavorite);
  const saveBtn = document.getElementById('saveItemBtn');
  if(saveBtn) saveBtn.textContent = 'Enregistrer les modifications';
  renderSymptomSelected();
  renderPendingTags();
  renderMiciQuickPicks();
  addFormGoToStep(1);
  document.getElementById('addCard').scrollIntoView({behavior:'smooth', block:'start'});
  document.getElementById('itemName').focus();
}

function deleteFood(id){
  const f = state.foods.find(f => f.id === id);
  if(!f) return;
  if(!confirm(`Supprimer définitivement "${f.name}" ?`)) return;
  state.foods = state.foods.filter(f => f.id !== id);
  persist();
  renderAll();
  renderRankingList();
}

function toggleFavorite(id){
  const f = state.foods.find(f => f.id === id);
  if(!f) return;
  f.favorite = !f.favorite;
  persist();
  renderFoodList();
}

// ---- Reaction counter ----
function changeCount(id, delta){
  const f = state.foods.find(f=>f.id===id);
  if(!f) return;
  f.count = Math.max(0, (f.count||0) + delta);
  persist();
  renderFoodList();
  renderRankingList();
}
function setCountFromInput(id, el){
  const f = state.foods.find(f=>f.id===id);
  if(!f) return;
  let val = parseInt(el.textContent, 10);
  if(isNaN(val) || val < 0) val = f.count || 0;
  f.count = val;
  persist();
  el.textContent = val;
  renderRankingList();
}

// ---- Filters ----
function toggleFilters(){
  document.getElementById('filterBody').classList.toggle('open');
  document.getElementById('filterToggle').classList.toggle('open');
}
function allCookingTags(){
  return [...new Set(state.foods.flatMap(f => (f.cooking||[]).map(c => typeof c === 'string' ? c : c.name)))];
}
function allAssocTags(){
  return [...new Set(state.foods.flatMap(f=>f.assoc))];
}
function renderFilters(){
  const symEl = document.getElementById('filterSymptoms');
  symEl.innerHTML = state.symptoms.length ? state.symptoms.map(s=>`
    <button type="button" class="chip ${activeFilters.symptoms.has(s.id)?'active':''}" data-act="toggleFilter" data-a="symptoms" data-b="${s.id}">
      <span class="dot c${paletteIndexForColor(s.color)}"></span>${escapeHtml(s.name)}
    </button>`).join('') : '<span class="u-soft-85">—</span>';

  const cook = allCookingTags();
  document.getElementById('filterCooking').innerHTML = cook.length ? cook.map(v=>`
    <button type="button" class="chip ${activeFilters.cooking.has(v)?'active':''}" data-act="toggleFilter" data-a="cooking" data-b="${escapeAttr(v)}">${escapeHtml(v)}</button>`).join('') : '<span class="u-soft-85">—</span>';

  const assoc = allAssocTags();
  document.getElementById('filterAssoc').innerHTML = assoc.length ? assoc.map(v=>`
    <button type="button" class="chip ${activeFilters.assoc.has(v)?'active':''}" data-act="toggleFilter" data-a="assoc" data-b="${escapeAttr(v)}">${escapeHtml(v)}</button>`).join('') : '<span class="u-soft-85">—</span>';

  updateDatalist('cookingSuggestions', cook);
  updateDatalist('assocSuggestions', assoc);
}
function allFoodNames(){
  return [...new Set(state.foods.filter(f => f.type !== 'recipe').map(f => f.name))];
}
function updateDatalist(id, values){
  const el = document.getElementById(id);
  if(!el) return;
  el.innerHTML = values.map(v=>`<option value="${escapeAttr(v)}">`).join('');
}
function toggleFilter(kind, val){
  const set = activeFilters[kind];
  if(set.has(val)) set.delete(val); else set.add(val);
  renderFilters();
  renderFoodList();
}
function clearFilters(){
  activeFilters = { symptoms: new Set(), cooking: new Set(), assoc: new Set() };
  renderFilters();
  renderFoodList();
}

// ---- Render list ----
function onFoodSearch(){
  foodSearchQuery = document.getElementById('foodSearch').value.trim().toLowerCase();
  renderFoodList();
}
function onFoodSortChange(){
  foodSortBy = document.getElementById('foodSort').value;
  renderFoodList();
}
function onRBSortChange(){
  rbSortBy = document.getElementById('rbSort').value;
  renderRecipeBookList();
}
function renderFoodList(){
  const list = document.getElementById('foodList');
  let foods = state.foods;

  if(activeFilters.symptoms.size)
    foods = foods.filter(f => (f.symptoms||[]).some(s => activeFilters.symptoms.has(s.id)));
  if(activeFilters.cooking.size)
    foods = foods.filter(f => (f.cooking||[]).some(c => activeFilters.cooking.has(typeof c === 'string' ? c : c.name)));
  if(activeFilters.assoc.size)
    foods = foods.filter(f => f.assoc.some(a => activeFilters.assoc.has(a)));
  if(foodSearchQuery)
    foods = foods.filter(f => f.name.toLowerCase().includes(foodSearchQuery) || (f.ingredients||[]).some(i=>i.toLowerCase().includes(foodSearchQuery)));

  foods = [...foods];
  if(foodSortBy === 'name-asc') foods.sort((a,b)=>a.name.localeCompare(b.name));
  else if(foodSortBy === 'name-desc') foods.sort((a,b)=>b.name.localeCompare(a.name));
  else if(foodSortBy === 'count-desc') foods.sort((a,b)=>(b.count||0)-(a.count||0));
  else if(foodSortBy === 'count-asc') foods.sort((a,b)=>(a.count||0)-(b.count||0));

  if(foods.length === 0){
    list.innerHTML = state.foods.length === 0
      ? '<div class="empty">Aucun aliment pour l\'instant. Ajoute le premier ci-dessus.</div>'
      : '<div class="empty">Aucun aliment ne correspond à ces filtres.</div>';
    return;
  }

  list.innerHTML = foods.map(f => {
    const symptomBadges = (f.symptoms||[]).map(fs => {
      const s = state.symptoms.find(s=>s.id===fs.id);
      if(!s) return '';
      return `<span class="symptom-tag"><span class="dot c${paletteIndexForColor(s.color)}"></span>${escapeHtml(s.name)}</span>`;
    }).join('');
    const firstSymptomId = (f.symptoms||[])[0] ? f.symptoms[0].id : null;
    const firstSymptomColor = firstSymptomId ? (state.symptoms.find(s=>s.id===firstSymptomId)||{}).color : null;
    const borderClass = firstSymptomColor ? `c${paletteIndexForColor(firstSymptomColor)}` : '';
    const cookingBadges = (f.cooking||[]).map(c => {
      const cName = typeof c === 'string' ? c : c.name;
      const cCount = typeof c === 'string' ? 0 : (c.count||0);
      return `<span class="tag-small cooking">${escapeHtml(cName)}${cCount > 0 ? ` · ${cCount}` : ''}<button class="cooking-inc-btn no-print" title="+1" data-act="incrementCookingCount" data-a="${f.id}" data-b="${escapeAttr(cName)}">+1</button></span>`;
    }).join('');
    const tagBadges = [
      ...(f.type === 'recipe' ? (f.ingredients||[]) : []).map(i=>`<span class="tag-small ingredient">${escapeHtml(i)}</span>`),
      cookingBadges,
      ...f.assoc.map(a=>`<span class="tag-small assoc">${escapeHtml(a)}</span>`)
    ].join('');
    const icon = '';
    return `
      <div class="food-item ${borderClass}">
        <div class="name">${icon}${escapeHtml(f.name)}</div>
        ${symptomBadges ? `<div class="symptoms">${symptomBadges}</div>` : ''}
        ${tagBadges ? `<div class="tags">${tagBadges}</div>` : ''}
        <div class="counter">
          <span class="counter-label">Réactions</span>
          <button class="counter-btn no-print" data-act="changeCount" data-a="${f.id}" data-b="-1">−</button>
          <span class="counter-value" contenteditable="true"
                data-blur-act="setCountFromInput" data-a="${f.id}"
                data-enter="blur">${f.count||0}</span>
          <button class="counter-btn no-print" data-act="changeCount" data-a="${f.id}" data-b="1">+</button>
        </div>
        <div class="item-actions no-print">
          <button class="star-btn ${f.favorite ? 'active' : ''}" title="Favori" data-act="toggleFavorite" data-a="${f.id}">${f.favorite ? '★' : '☆'}</button>
          <button class="text-action" data-act="openEditFood" data-a="${f.id}">Modifier</button>
          <button class="text-action danger" data-act="deleteFood" data-a="${f.id}">Supprimer</button>
        </div>
      </div>`;
  }).join('');
}

// ---- Carnet de Recettes ----
function openRecipeBookCreateForm(prefill){
  document.getElementById('rbForm').classList.remove('u-hidden-mt16');
  document.getElementById('rbFavPicker').classList.add('u-hidden-mt16');
  document.getElementById('rbName').value = prefill && prefill.name ? prefill.name : '';
  pendingRBIngredients = prefill && prefill.ingredients ? [...prefill.ingredients] : [];
  pendingRBMeal = new Set();
  pendingRBDiet = [];
  pendingRBSpeed = 0; pendingRBEasy = 0; pendingRBPrice = 0;
  renderRBPending();
  document.getElementById('rbName').focus();
}
function requestCloseRBForm(){
  if(rbFormIsDirty() && !confirm("Abandonner cette saisie non enregistrée ?")) return;
  closeRBForm();
}
function closeRBForm(){
  document.getElementById('rbForm').classList.add('u-hidden-mt16');
  editingRBId = null;
}
function openFavoritePicker(){
  document.getElementById('rbFavPicker').classList.remove('u-hidden-mt16');
  document.getElementById('rbForm').classList.add('u-hidden-mt16');
  document.getElementById('rbFavSearch').value = '';
  onRBFavSearch();
}
function closeFavPicker(){
  document.getElementById('rbFavPicker').classList.add('u-hidden-mt16');
}
function onRBFavSearch(){
  const q = document.getElementById('rbFavSearch').value.trim().toLowerCase();
  const favs = state.foods.filter(f => f.favorite && (!q || f.name.toLowerCase().includes(q)));
  const el = document.getElementById('rbFavResults');
  if(favs.length === 0){
    el.innerHTML = `<div class="empty u-py14">${state.foods.some(f=>f.favorite) ? 'Aucun favori correspondant.' : 'Aucun favori pour l\'instant — marque des aliments ou recettes d\'une étoile dans l\'onglet Aliments.'}</div>`;
    return;
  }
  el.innerHTML = favs.map(f => `
    <div class="fav-result-row">
      <span>${escapeHtml(f.name)}</span>
      <button class="btn secondary small" data-act="importFavoriteToRB" data-a="${f.id}">Utiliser</button>
    </div>`).join('');
}
function importFavoriteToRB(id){
  const f = state.foods.find(f => f.id === id);
  if(!f) return;
  openRecipeBookCreateForm({ name: f.name, ingredients: f.type === 'recipe' ? (f.ingredients || []) : [f.name] });
}
function addRBIngredient(){
  const input = document.getElementById('rbIngredientInput');
  const val = input.value.trim();
  if(!val) return;
  if(!pendingRBIngredients.includes(val)) pendingRBIngredients.push(val);
  ensureFoodExists(val);
  input.value = '';
  document.getElementById('rbIngredientSearchResults').innerHTML = '';
  renderRBPending();
}
function onRBIngredientSearch(){ onIngredientPickerSearch('rb'); }
function selectRBIngredientSuggestion(name){ selectIngredientForPicker('rb', name); }
function removeRBIngredient(val){
  pendingRBIngredients = pendingRBIngredients.filter(v => v !== val);
  renderRBPending();
}
function toggleRBMeal(tag){
  if(pendingRBMeal.has(tag)) pendingRBMeal.delete(tag);
  else pendingRBMeal.add(tag);
  renderRBPending();
}
function addRBDietTag(){
  const input = document.getElementById('rbDietInput');
  const val = input.value.trim();
  if(!val) return;
  if(!pendingRBDiet.includes(val)) pendingRBDiet.push(val);
  input.value = '';
  renderRBPending();
}
function removeRBDietTag(val){
  pendingRBDiet = pendingRBDiet.filter(v => v !== val);
  renderRBPending();
}
function setRBRating(field, n){
  if(field === 'speed') pendingRBSpeed = (pendingRBSpeed === n ? 0 : n);
  else if(field === 'easy') pendingRBEasy = (pendingRBEasy === n ? 0 : n);
  else pendingRBPrice = (pendingRBPrice === n ? 0 : n);
  renderRBPending();
}
function renderRatingIcons(field, value, symbol){
  let html = '';
  for(let i = 1; i <= 3; i++){
    html += `<button type="button" class="rating-btn ${i <= value ? 'filled' : ''}" data-act="setRBRating" data-a="${field}" data-b="${i}">${symbol}</button>`;
  }
  return html;
}
function allDietTags(){
  return [...new Set(state.recipeBook.flatMap(r => r.dietTags || []))];
}
function renderRBPending(){
  document.getElementById('rbMealTags').innerHTML = MEAL_TAGS.map(t => `
    <button type="button" class="chip ${pendingRBMeal.has(t) ? 'active' : ''}" data-act="toggleRBMeal" data-a="${t}">${t}</button>`).join('');
  document.getElementById('rbPendingDiet').innerHTML = pendingRBDiet.map(v =>
    `<button type="button" class="chip active" data-act="removeRBDietTag" data-a="${escapeAttr(v)}">${escapeHtml(v)} ✕</button>`).join('');
  document.getElementById('rbPendingIngredient').innerHTML = pendingRBIngredients.map(v =>
    `<button type="button" class="chip active" data-act="removeRBIngredient" data-a="${escapeAttr(v)}">${escapeHtml(v)} ✕</button>`).join('');
  document.getElementById('rbSpeedRow').innerHTML = renderRatingIcons('speed', pendingRBSpeed, '●');
  document.getElementById('rbEasyRow').innerHTML = renderRatingIcons('easy', pendingRBEasy, '●');
  document.getElementById('rbPriceRow').innerHTML = renderRatingIcons('price', pendingRBPrice, '€');
  document.getElementById('rbDietSuggestions').innerHTML = allDietTags().map(v => `<option value="${escapeAttr(v)}">`).join('');
}
function saveRecipeBookEntry(){
  const nameInput = document.getElementById('rbName');
  const name = nameInput.value.trim();
  if(!name){ nameInput.focus(); return; }
  if(editingRBId){
    const existing = state.recipeBook.find(r => r.id === editingRBId);
    if(existing){
      existing.name = name;
      existing.ingredients = [...pendingRBIngredients];
      existing.mealTags = Array.from(pendingRBMeal);
      existing.dietTags = [...pendingRBDiet];
      existing.speed = pendingRBSpeed;
      existing.easy = pendingRBEasy;
      existing.price = pendingRBPrice;
    }
  } else {
    state.recipeBook.push({
      id: uid(),
      name,
      ingredients: [...pendingRBIngredients],
      mealTags: Array.from(pendingRBMeal),
      dietTags: [...pendingRBDiet],
      speed: pendingRBSpeed,
      easy: pendingRBEasy,
      price: pendingRBPrice
    });
    logDailyActivity('recipe-log', name);
    if(Math.random() < 1/6){
      triggerFirework('teal');
    }
  }
  persist();
  closeRBForm();
  renderRecipeBookList();
  refreshAgendaDependentViews();
}
function deleteRBEntry(id){
  const r = state.recipeBook.find(r => r.id === id);
  if(!r) return;
  if(!confirm(`Supprimer définitivement la recette "${r.name}" du carnet ?`)) return;
  state.recipeBook = state.recipeBook.filter(r => r.id !== id);
  persist();
  renderRecipeBookList();
}
function onRBSearch(){
  rbSearchQuery = document.getElementById('rbSearch').value.trim().toLowerCase();
  renderRecipeBookList();
}
function openEditRBEntry(id){
  const r = state.recipeBook.find(r => r.id === id);
  if(!r) return;
  editingRBId = id;
  document.getElementById('rbForm').classList.remove('u-hidden-mt16');
  document.getElementById('rbFavPicker').classList.add('u-hidden-mt16');
  document.getElementById('rbName').value = r.name;
  pendingRBIngredients = [...(r.ingredients||[])];
  pendingRBMeal = new Set(r.mealTags||[]);
  pendingRBDiet = [...(r.dietTags||[])];
  pendingRBSpeed = r.speed||0; pendingRBEasy = r.easy||0; pendingRBPrice = r.price||0;
  renderRBPending();
  document.getElementById('rbAddCard').scrollIntoView({behavior:'smooth', block:'start'});
  document.getElementById('rbName').focus();
}
function renderRecipeBookList(){
  const list = document.getElementById('recipeBookList');
  let entries = state.recipeBook;
  if(rbSearchQuery){
    entries = entries.filter(r => r.name.toLowerCase().includes(rbSearchQuery) || (r.ingredients||[]).some(i=>i.toLowerCase().includes(rbSearchQuery)));
  }
  entries = [...entries].sort((a, b) =>
    rbSortBy === 'name-desc' ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)
  );
  if(state.recipeBook.length === 0){
    list.innerHTML = '<div class="empty">Ton carnet est vide. Ajoute une recette via création ou depuis tes favoris.</div>';
    return;
  }
  if(entries.length === 0){
    list.innerHTML = '<div class="empty">Aucune recette ne correspond à ta recherche.</div>';
    return;
  }
  list.innerHTML = entries.map(r => {
    const ingredientBadges = (r.ingredients || []).map(i => `<span class="tag-small ingredient">${escapeHtml(i)}</span>`).join('');
    const mealBadges = (r.mealTags || []).map(t => `<span class="tag-small meal">${escapeHtml(t)}</span>`).join('');
    const dietBadges = (r.dietTags || []).map(t => `<span class="tag-small diet">${escapeHtml(t)}</span>`).join('');
    const tagBadges = ingredientBadges + mealBadges + dietBadges;
    return `
      <div class="food-item rb-card">
        <div class="name">${escapeHtml(r.name)}</div>
        ${tagBadges ? `<div class="tags">${tagBadges}</div>` : ''}
        ${(r.speed || r.easy || r.price) ? `<div class="rb-ratings">
          ${r.speed ? `<span class="rb-rating-group">${'●'.repeat(r.speed)}</span>` : ''}
          ${r.easy ? `<span class="rb-rating-group">${'●'.repeat(r.easy)}</span>` : ''}
          ${r.price ? `<span class="rb-rating-group">${'€'.repeat(r.price)}</span>` : ''}
        </div>` : ''}
        <div class="item-actions no-print">
          <button class="text-action" data-act="openEditRBEntry" data-a="${r.id}">Modifier</button>
          <button class="text-action danger" data-act="deleteRBEntry" data-a="${r.id}">Supprimer</button>
        </div>
      </div>`;
  }).join('');
}

function renderAll(){
  renderSymptomSelected();
  renderPendingTags();
  renderFilters();
  renderFoodList();
}

function renderRankRow(f, i){
  const icon = f.type === 'recipe' ? '🍲 ' : '';
  const count = f.count || 0;
  const countLabel = count === 1 ? '1 réaction' : `${count} réactions`;
  return `
    <div class="food-item">
      <div class="rank-item">
        <span class="rank-badge">${i+1}</span>
        <div class="u-flex1">
          <div class="name">${icon}${escapeHtml(f.name)} <span class="rank-score">· ${countLabel}</span></div>
        </div>
      </div>
    </div>`;
}
function renderRankingList(){
  const el = document.getElementById('rankingList');
  if(!el) return;
  const groups = new Map();
  const noSymptom = [];
  state.foods.forEach(f => {
    if(!((f.count || 0) > 0)) return;
    const syms = f.symptoms || [];
    if(syms.length === 0){
      noSymptom.push(f);
    } else {
      syms.forEach(fs => {
        if(!groups.has(fs.id)) groups.set(fs.id, []);
        groups.get(fs.id).push(f);
      });
    }
  });
  if(groups.size === 0 && noSymptom.length === 0){
    el.innerHTML = '<div class="empty-tip">💡 <span class="empty-tip-text">Rien à afficher pour l\'instant — clique sur le compteur (+1) d\'un aliment ou d\'une recette dès qu\'il te cause une réaction.</span></div>';
    return;
  }
  const orderedSymptoms = state.symptoms.filter(s => groups.has(s.id));
  let html = orderedSymptoms.map(s => {
    const entries = groups.get(s.id).slice().sort((a,b) => (b.count||0) - (a.count||0));
    const rows = entries.map((f, i) => renderRankRow(f, i)).join('');
    return `
      <div class="card u-mb16">
        <div class="rank-group-header"><span class="dot c${paletteIndexForColor(s.color)}"></span>${escapeHtml(s.name)}</div>
        ${rows}
      </div>`;
  }).join('');
  if(noSymptom.length){
    const entries = noSymptom.slice().sort((a,b) => (b.count||0) - (a.count||0));
    const rows = entries.map((f, i) => renderRankRow(f, i)).join('');
    html += `
      <div class="card u-mb16">
        <div class="rank-group-header rank-group-neutral">Sans symptôme associé</div>
        ${rows}
      </div>`;
  }
  el.innerHTML = html;
}

// ---- Agenda ----
function pad2(n){ return n < 10 ? '0' + n : '' + n; }
function dateKey(y, m, d){ return `${y}-${pad2(m+1)}-${pad2(d)}`; }
function todayKey(){
  const t = new Date();
  return dateKey(t.getFullYear(), t.getMonth(), t.getDate());
}
function changeMonth(delta){
  calendarMonth += delta;
  if(calendarMonth < 0){ calendarMonth = 11; calendarYear--; }
  if(calendarMonth > 11){ calendarMonth = 0; calendarYear++; }
  renderCalendar();
}
function dayActivityCategories(entries){
  entries = entries || [];
  return {
    food: entries.some(e => e.kind === 'food-log'),
    recipe: entries.some(e => e.kind === 'recipe-log'),
    symptom: entries.some(e => e.kind === 'symptom' || !e.kind),
    rdv: entries.some(e => e.kind === 'appointment')
  };
}
const MONTH_NAMES_FULL = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
function dayAriaLabel(year, month, day, cats){
  const parts = [`${day} ${MONTH_NAMES_FULL[month]}`];
  if(cats.food) parts.push('aliment ajouté');
  if(cats.recipe) parts.push('recette ajoutée');
  if(cats.symptom) parts.push('symptôme noté');
  if(cats.rdv) parts.push('rendez-vous');
  return escapeAttr(parts.join(', '));
}
function logDailyActivity(kind, label){
  const today = todayKey();
  if(!state.agenda[today]) state.agenda[today] = [];
  state.agenda[today].push({ id: uid(), kind, label: label || '' });
}
function renderCalendar(){
  const grid = document.getElementById('calendarGrid');
  const title = document.getElementById('calendarTitle');
  if(!grid || !title) return;
  const monthNames = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  title.textContent = `${monthNames[calendarMonth]} ${calendarYear}`;
  const weekdayLabels = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
  const first = new Date(calendarYear, calendarMonth, 1);
  const startWeekday = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const tKey = todayKey();
  let html = weekdayLabels.map(w => `<div class="calendar-weekday">${w}</div>`).join('');
  for(let i = 0; i < startWeekday; i++) html += '<div class="calendar-day empty"></div>';
  for(let d = 1; d <= daysInMonth; d++){
    const key = dateKey(calendarYear, calendarMonth, d);
    const cats = dayActivityCategories(state.agenda[key]);
    const isToday = key === tKey;
    const dots = [
      cats.food ? '<span class="cd-dot cd-dot-food"></span>' : '',
      cats.recipe ? '<span class="cd-dot cd-dot-recipe"></span>' : '',
      cats.symptom ? '<span class="cd-dot cd-dot-symptom"></span>' : '',
      cats.rdv ? '<span class="cd-dot cd-dot-rdv"></span>' : ''
    ].join('');
    html += `<button type="button" class="calendar-day ${isToday ? 'today' : ''}" data-act="openAgendaDay" data-a="${key}" aria-label="${dayAriaLabel(calendarYear, calendarMonth, d, cats)}">${d}${dots ? `<span class="cd-dots">${dots}</span>` : ''}</button>`;
  }
  grid.innerHTML = html;
}
// Rafraîchit les deux vues qui dépendent de state.agenda après toute action qui le modifie
// (calendrier + compteur de jours actifs sur la bannière d'accueil) — regroupés ici pour
// éviter d'oublier l'un des deux à un futur point d'appel.
function refreshAgendaDependentViews(){
  renderCalendar();
  renderWelcomeBanner();
}
function openAgendaDay(key){
  selectedDate = key;
  document.getElementById('agendaPanel').classList.remove('u-hidden');
  const d = new Date(key + 'T00:00:00');
  document.getElementById('agendaPanelTitle').textContent = '📅 ' + d.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  renderAgendaEntries();
  renderAgendaDaySummary();
  resetAgendaSymptomForm();
  resetAgendaRdvForm();
  setAgendaSection('symptom', true);
  setAgendaSection('rdv', false);
}
function renderAgendaDaySummary(){
  const el = document.getElementById('agendaDaySummary');
  if(!el || !selectedDate) return;
  const entries = state.agenda[selectedDate] || [];
  const foods = entries.filter(e => e.kind === 'food-log').map(e => e.label).filter(Boolean);
  const recipes = entries.filter(e => e.kind === 'recipe-log').map(e => e.label).filter(Boolean);
  const symptomNames = [];
  entries.filter(e => e.kind === 'symptom' || !e.kind).forEach(e => {
    (e.symptomIds || []).forEach(id => {
      const s = state.symptoms.find(s => s.id === id);
      if(s && !symptomNames.includes(s.name)) symptomNames.push(s.name);
    });
  });
  const rdvNames = entries.filter(e => e.kind === 'appointment').map(e => e.name).filter(Boolean);

  const blocks = [];
  if(foods.length) blocks.push(`<p class="u-soft-85 u-mt6"><strong>Aliments :</strong> ${foods.map(escapeHtml).join(', ')}</p>`);
  if(recipes.length) blocks.push(`<p class="u-soft-85 u-mt6"><strong>Recettes :</strong> ${recipes.map(escapeHtml).join(', ')}</p>`);
  if(symptomNames.length) blocks.push(`<p class="u-soft-85 u-mt6"><strong>Symptômes :</strong> ${symptomNames.map(escapeHtml).join(', ')}</p>`);
  if(rdvNames.length) blocks.push(`<p class="u-soft-85 u-mt6"><strong>Rendez-vous :</strong> ${rdvNames.map(escapeHtml).join(', ')}</p>`);

  if(!blocks.length){ el.innerHTML = ''; return; }
  const isToday = selectedDate === todayKey();
  const intro = isToday ? "Aujourd'hui, tu as ajouté :" : "Ce jour-là, tu as ajouté :";
  el.innerHTML = `<div class="u-section-14"><p class="u-m0 u-bold-90">${intro}</p>${blocks.join('')}</div>`;
}
function closeAgendaPanel(){
  document.getElementById('agendaPanel').classList.add('u-hidden');
  selectedDate = null;
}
function setAgendaSection(key, open){
  const toggle = document.getElementById(key === 'symptom' ? 'agendaSymptomToggle' : 'agendaRdvToggle');
  const body = document.getElementById(key === 'symptom' ? 'agendaForm' : 'agendaRdvForm');
  if(!toggle || !body) return;
  toggle.classList.toggle('is-open', open);
  body.classList.toggle('is-open', open);
}
function toggleAgendaSection(key){
  const body = document.getElementById(key === 'symptom' ? 'agendaForm' : 'agendaRdvForm');
  const willOpen = !body.classList.contains('is-open');
  setAgendaSection(key, willOpen);
}
function renderAgendaEntries(){
  const list = document.getElementById('agendaEntriesList');
  const entries = (state.agenda[selectedDate] || []).filter(e => e.kind !== 'food-log' && e.kind !== 'recipe-log');
  if(entries.length === 0){
    list.innerHTML = '<div class="empty-tip">📅 <span class="empty-tip-text">Rien de noté pour ce jour — ajoute une note, un rendez-vous ou un symptôme ci-dessous.</span></div>';
    return;
  }
  list.innerHTML = entries.map(e => {
    if(e.kind === 'appointment'){
      return `
        <div class="agenda-entry rdv-entry">
          <div class="rdv-entry-title">🩺 ${escapeHtml(e.name || 'Rendez-vous')}${e.time ? ` · ${escapeHtml(e.time)}` : ''}</div>
          ${e.doctorType ? `<div class="u-note-80">${escapeHtml(e.doctorType)}</div>` : ''}
          ${e.location ? `<div class="u-note-80">${escapeHtml(e.location)}</div>` : ''}
          ${e.notes ? `<p class="u-m-b6-pre">${escapeHtml(e.notes)}</p>` : ''}
          <div class="item-actions"><button class="text-action danger" data-act="deleteAgendaEntry" data-a="${e.id}">Supprimer</button></div>
        </div>`;
    }
    const symptomBadges = (e.symptomIds || []).map(id => {
      const s = state.symptoms.find(s => s.id === id);
      if(!s) return '';
      return `<span class="symptom-tag"><span class="dot c${paletteIndexForColor(s.color)}"></span>${escapeHtml(s.name)}</span>`;
    }).join('');
    const gaugeLines = Object.entries(e.gauges || {}).map(([gid, val]) => {
      const g = state.gaugeTypes.find(g => g.id === gid);
      if(!g) return '';
      return `<div class="u-note-78">${escapeHtml(g.name)} : ${val}/10</div>`;
    }).join('');
    return `
      <div class="agenda-entry">
        ${symptomBadges ? `<div class="symptoms u-mb6">${symptomBadges}</div>` : ''}
        ${e.note ? `<p class="u-m-b6-pre">${escapeHtml(e.note)}</p>` : ''}
        ${gaugeLines}
        <div class="item-actions"><button class="text-action danger" data-act="deleteAgendaEntry" data-a="${e.id}">Supprimer</button></div>
      </div>`;
  }).join('');
}
function deleteAgendaEntry(id){
  if(!selectedDate) return;
  if(!confirm('Supprimer définitivement cette entrée ?')) return;
  state.agenda[selectedDate] = (state.agenda[selectedDate] || []).filter(e => e.id !== id);
  if(state.agenda[selectedDate].length === 0) delete state.agenda[selectedDate];
  persist();
  renderAgendaEntries();
  renderAgendaDaySummary();
  refreshAgendaDependentViews();
}
function resetAgendaSymptomForm(){
  pendingAgendaSymptoms = new Set();
  pendingAgendaGauges = {};
  document.getElementById('agendaNote').value = '';
  document.getElementById('agendaSymptomSearch').value = '';
  document.getElementById('agendaSymptomResults').innerHTML = '';
  renderAgendaSymptomSelected();
  renderAgendaGauges();
}
function resetAgendaRdvForm(){
  document.getElementById('rdvName').value = '';
  document.getElementById('rdvTime').value = '';
  document.getElementById('rdvDoctorType').value = '';
  document.getElementById('rdvDoctorTypeResults').innerHTML = '';
  document.getElementById('rdvLocation').value = '';
  document.getElementById('rdvNotes').value = '';
}
// Liste de base pertinente pour le suivi d'une rectocolite hémorragique / MICI —
// complétée automatiquement par les types déjà saisis, pour gagner du temps.
const DOCTOR_TYPE_PRESETS = [
  'Gastro-entérologue', 'Médecin généraliste', 'Proctologue',
  'Diététicien(ne) / Nutritionniste', 'Chirurgien digestif',
  'Infirmier(ère) MICI / stomathérapeute', 'Rhumatologue',
  'Dermatologue', 'Ophtalmologue', 'Hépatologue',
  'Psychologue', 'Pharmacien hospitalier'
];
function allDoctorTypes(){
  const used = [];
  Object.values(state.agenda || {}).forEach(entries => entries.forEach(e => {
    if(e.kind === 'appointment' && e.doctorType) used.push(e.doctorType);
  }));
  const combined = [...DOCTOR_TYPE_PRESETS, ...used];
  const seen = new Set();
  return combined.filter(v => {
    const k = v.toLowerCase();
    if(seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function onDoctorTypeSearch(){
  const input = document.getElementById('rdvDoctorType');
  const q = input.value.trim().toLowerCase();
  const el = document.getElementById('rdvDoctorTypeResults');
  if(!q){ el.innerHTML = ''; return; }
  const matches = allDoctorTypes().filter(v => v.toLowerCase().includes(q));
  el.innerHTML = matches.length
    ? '<div class="chip-row u-mt6">' + matches.map(v => `<button type="button" class="chip suggestion" data-act="selectDoctorType" data-a="${escapeAttr(v)}">${escapeHtml(v)}</button>`).join('') + '</div>'
    : '';
}
function selectDoctorType(value){
  document.getElementById('rdvDoctorType').value = value;
  document.getElementById('rdvDoctorTypeResults').innerHTML = '';
}
function saveAgendaRdv(){
  if(!selectedDate) return;
  const nameInput = document.getElementById('rdvName');
  const name = nameInput.value.trim();
  if(!name){ nameInput.focus(); return; }
  const entry = {
    id: uid(),
    kind: 'appointment',
    name,
    time: document.getElementById('rdvTime').value,
    doctorType: document.getElementById('rdvDoctorType').value.trim(),
    location: document.getElementById('rdvLocation').value.trim(),
    notes: document.getElementById('rdvNotes').value.trim()
  };
  if(!state.agenda[selectedDate]) state.agenda[selectedDate] = [];
  state.agenda[selectedDate].push(entry);
  persist();
  resetAgendaRdvForm();
  setAgendaSection('rdv', false);
  renderAgendaEntries();
  renderAgendaDaySummary();
  refreshAgendaDependentViews();
}
// Agenda — délègue au même moteur partagé
function renderAgendaSymptomSelected(){ renderSymptomPicker('agenda'); }
function onAgendaSymptomSearch(){ onSymptomPickerSearch('agenda'); }
function renderAgendaGauges(){
  const suggestEl = document.getElementById('agendaGaugeSuggestions');
  const usedIds = new Set(Object.keys(pendingAgendaGauges));
  const available = state.gaugeTypes.filter(g => !usedIds.has(g.id));
  suggestEl.innerHTML = available.map(g => `<button type="button" class="chip" data-act="addAgendaGauge" data-a="${g.id}">+ ${escapeHtml(g.name)}</button>`).join('');
  const slidersEl = document.getElementById('agendaGaugeSliders');
  slidersEl.innerHTML = Object.entries(pendingAgendaGauges).map(([gid, val]) => {
    const g = state.gaugeTypes.find(g => g.id === gid);
    if(!g) return '';
    return `
      <div class="gauge-row">
        <label>${escapeHtml(g.name)}</label>
        <input type="range" min="0" max="10" value="${val}" data-act="setAgendaGaugeValue" data-a="${gid}">
        <span class="gauge-value">${val}</span>
        <button class="icon-btn" title="Retirer" data-act="removeAgendaGauge" data-a="${gid}">✕</button>
      </div>`;
  }).join('');
}
function addAgendaGauge(id){
  pendingAgendaGauges[id] = 5;
  renderAgendaGauges();
}
function setAgendaGaugeValue(id, val){
  pendingAgendaGauges[id] = parseInt(val, 10);
  const row = document.getElementById('agendaGaugeSliders');
  if(row){
    const rangeInput = row.querySelector(`input[type="range"][data-a="${id}"]`);
    if(rangeInput){
      const valueEl = rangeInput.parentElement.querySelector('.gauge-value');
      if(valueEl) valueEl.textContent = val;
    }
  }
}
function removeAgendaGauge(id){
  delete pendingAgendaGauges[id];
  renderAgendaGauges();
}
function addNewGaugeType(){
  const input = document.getElementById('agendaNewGaugeInput');
  const name = input.value.trim();
  if(!name) return;
  let g = state.gaugeTypes.find(g => g.name.toLowerCase() === name.toLowerCase());
  if(!g){
    g = { id: uid(), name };
    state.gaugeTypes.push(g);
    persist();
  }
  pendingAgendaGauges[g.id] = pendingAgendaGauges[g.id] !== undefined ? pendingAgendaGauges[g.id] : 5;
  input.value = '';
  renderAgendaGauges();
}
function saveAgendaEntry(){
  if(!selectedDate) return;
  const note = document.getElementById('agendaNote').value.trim();
  if(pendingAgendaSymptoms.size === 0 && !note && Object.keys(pendingAgendaGauges).length === 0){
    alert("Ajoute au moins un symptôme, une note ou une jauge avant d'enregistrer.");
    return;
  }
  const entry = {
    id: uid(),
    kind: 'symptom',
    symptomIds: Array.from(pendingAgendaSymptoms),
    note,
    gauges: { ...pendingAgendaGauges }
  };
  if(!state.agenda[selectedDate]) state.agenda[selectedDate] = [];
  state.agenda[selectedDate].push(entry);
  persist();
  resetAgendaSymptomForm();
  setAgendaSection('symptom', false);
  renderAgendaEntries();
  renderAgendaDaySummary();
  refreshAgendaDependentViews();
}

// ---- Activation/désactivation des onglets optionnels (Recettes, Export médical, Agenda) ----
const FEATURE_TOGGLES = {
  recipebook: {
    storageKey: 'intolerances_recipebook_enabled', tabId: 'mainTabRecipeBook', btnId: 'recipeBookFeatureToggleBtn', label: 'Recettes',
    hasData: () => (state.recipeBook || []).length > 0
  },
  doctor: {
    storageKey: 'intolerances_doctor_enabled', tabId: 'mainTabDoctorExport', btnId: 'doctorExportFeatureToggleBtn', label: 'Export médical',
    hasData: () => false
  },
  agenda: {
    storageKey: 'intolerances_agenda_enabled', tabId: 'mainTabAgenda', btnId: 'agendaFeatureToggleBtn', label: 'Agenda',
    hasData: () => Object.values(state.agenda || {}).some(entries => Array.isArray(entries) && entries.length > 0)
  }
};
function toggleFeature(key){
  const cfg = FEATURE_TOGGLES[key];
  const enabled = localStorage.getItem(cfg.storageKey) !== '0';
  if(enabled && cfg.hasData()){
    const wantsExport = confirm(`L'onglet ${cfg.label} contient des données. Les désactiver ne les efface pas — elles restent stockées sur cet appareil — mais tu ne pourras plus les consulter tant que l'onglet est masqué.\n\nVeux-tu exporter une sauvegarde maintenant, pour pouvoir les réimporter plus tard si besoin ?`);
    if(wantsExport) exportData();
  }
  localStorage.setItem(cfg.storageKey, enabled ? '0' : '1');
  applyFeatureVisibility(key);
}
function applyFeatureVisibility(key){
  const cfg = FEATURE_TOGGLES[key];
  const enabled = localStorage.getItem(cfg.storageKey) !== '0';
  const tabBtn = document.getElementById(cfg.tabId);
  if(tabBtn) tabBtn.classList.toggle('u-hidden', !enabled);
  const toggleBtn = document.getElementById(cfg.btnId);
  if(toggleBtn) toggleBtn.textContent = `${cfg.label} : ${enabled ? 'activé' : 'désactivé'}`;
  if(!enabled && mainTab === key) setMainTab('aliments');
}
function applyAllFeatureVisibility(){
  Object.keys(FEATURE_TOGGLES).forEach(applyFeatureVisibility);
}

const THEME_NAMES = {
  'celadon-prune': 'Céladon et prune', 'ardoise-rose': 'Ardoise et rose', 'brume-marine': 'Brume marine',
  'nuit-douce': 'Nuit douce', 'ble-lavande': 'Blé et lavande', 'coquille-corail': 'Coquille et corail', 'lin-miel': 'Lin et miel',
};
function applyTheme(theme){
  const valid = Object.keys(THEME_NAMES);
  if(!valid.includes(theme)) theme = 'celadon-prune';
  if(theme === 'celadon-prune'){
    delete document.body.dataset.theme;
  } else {
    document.body.dataset.theme = theme;
  }
  // "Nuit douce" est la seule palette sombre : elle réutilise les réglages
  // déjà prévus pour les champs de saisie, puces, etc. en mode sombre,
  // plutôt que de dupliquer ces règles pour un 5e thème.
  document.body.classList.toggle('dark', theme === 'nuit-douce');
  localStorage.setItem('intolerances_theme', theme);
  const select = document.getElementById('themeSelect');
  if(select) select.value = theme;
  renderThemeSwatches(theme);
}
function renderThemeSwatches(current){
  const el = document.getElementById('themeSwatches');
  if(!el) return;
  el.innerHTML = Object.entries(THEME_NAMES).map(([key, label]) => `
    <button type="button" class="theme-swatch theme-swatch-${key} ${key === current ? 'active-tab' : ''}"
      data-act="applyTheme" data-a="${key}" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}"></button>
  `).join('');
}
function onThemeChange(){
  applyTheme(document.getElementById('themeSelect').value);
}
// ---- Export Médecin ----
function renderDoctorExportForm(){
  const el = document.getElementById('doctorExportForm');
  if(!el) return;
  const hasPathologies = (state.pathologies || []).length > 0;
  const hasMeds = (state.medications || []).length > 0;
  const hasAppointments = Object.values(state.agenda || {}).some(entries => (entries||[]).some(e => e.kind === 'appointment'));
  const jan1 = `${new Date().getFullYear()}-01-01`;
  let html = ``;
  if(hasPathologies || hasMeds){
    html += `<div class="de-field">`;
    if(hasPathologies) html += `<div class="de-check-row"><input type="checkbox" id="dePathologies" checked><label for="dePathologies">Mes diagnostics / pathologies</label></div>`;
    if(hasMeds) html += `<div class="de-check-row"><input type="checkbox" id="deMeds" checked><label for="deMeds">Mon traitement actuel</label></div>`;
    html += `</div>`;
  }
  html += `
    <div class="de-field u-section-14">
      <div class="de-check-row"><input type="checkbox" id="deTopFoods" checked><label for="deTopFoods">Les 10 aliments/recettes les plus inflammatoires</label></div>
      <div class="de-check-row"><input type="checkbox" id="deRecentFoods" checked><label for="deRecentFoods">Les 10 aliments/recettes ajoutés le plus récemment</label></div>
      <div class="de-check-row"><input type="checkbox" id="deSymptoms" checked><label for="deSymptoms">Mes symptômes (nombre de fois déclarés)</label></div>
      <div class="de-check-row"><input type="checkbox" id="deMonthSymptoms" checked><label for="deMonthSymptoms">Symptômes du mois en cours, avec les dates</label></div>
    </div>`;
  if(hasAppointments){
    html += `
    <div class="de-field u-section-14">
      <div class="de-check-row"><input type="checkbox" id="deApptHistory" checked><label for="deApptHistory">Historique des rendez-vous, depuis le</label></div>
      <div class="de-sub"><input type="date" id="deApptHistoryDate" value="${jan1}"></div>
    </div>`;
  }
  html += `
    <div class="de-field u-section-14">
      <label class="u-m0">À aborder avec le médecin (facultatif)</label>
      <div class="de-check-row u-mt8"><input type="checkbox" id="deNotesTopics"><label for="deNotesTopics">Sujets à aborder</label></div>
      <textarea id="deNotesTopicsText" rows="2" class="de-sub" placeholder="Ce dont je veux parler…"></textarea>`;
  if(hasMeds){
    html += `<div class="de-check-row u-mt8"><input type="checkbox" id="deReassessTreatment"><label for="deReassessTreatment">Je souhaite réévaluer mon traitement</label></div>
      <div class="de-check-row"><input type="checkbox" id="deSideEffects"><label for="deSideEffects">Je pense qu'il me cause des effets secondaires</label></div>
      <textarea id="deSideEffectsText" rows="2" class="de-sub" placeholder="Lesquels, si tu veux préciser…"></textarea>`;
  }
  html += `<div class="de-check-row u-mt8"><input type="checkbox" id="deImpact"><label for="deImpact">Impact sur mon quotidien (0 à 10)</label></div>
      <div class="de-sub"><input type="range" id="deImpactValue" min="0" max="10" value="5"></div>
      <button type="button" class="text-action u-mt8" data-act="toggleExtraGauges">+ Ajouter d'autres jauges (douleur, fatigue, moral, symptômes…)</button>
      <div id="deExtraGauges" class="u-hidden u-mt8">
        <div class="de-check-row"><input type="checkbox" id="dePain"><label for="dePain">Douleur physique (0 à 10)</label></div>
        <div class="de-sub"><input type="range" id="dePainValue" min="0" max="10" value="5"></div>
        <div class="de-check-row u-mt8"><input type="checkbox" id="deFatigue"><label for="deFatigue">Fatigue (0 à 10)</label></div>
        <div class="de-sub"><input type="range" id="deFatigueValue" min="0" max="10" value="5"></div>
        <div class="de-check-row u-mt8"><input type="checkbox" id="deMental"><label for="deMental">État mental / moral (0 à 10)</label></div>
        <div class="de-sub"><input type="range" id="deMentalValue" min="0" max="10" value="5"></div>
        <div class="de-check-row u-mt8"><input type="checkbox" id="deSymptomSeverity"><label for="deSymptomSeverity">Sévérité des symptômes (0 à 10)</label></div>
        <div class="de-sub"><input type="range" id="deSymptomSeverityValue" min="0" max="10" value="5"></div>
        <div class="de-check-row u-mt8"><input type="checkbox" id="deOther"><label for="deOther">Autre, à décrire</label></div>
        <textarea id="deOtherText" rows="2" class="de-sub" placeholder="Ce qui ne rentre dans aucune case…"></textarea>
      </div>
      <div class="de-check-row u-mt8"><input type="checkbox" id="deHelp"><label for="deHelp">Je veux demander une aide spécifique (ressource, documentation, RQTH, AAH…)</label></div>
      <textarea id="deHelpText" rows="2" class="de-sub" placeholder="Préciser si besoin…"></textarea>
      <div class="de-check-row u-mt8"><input type="checkbox" id="deTalk"><label for="deTalk">J'ai besoin d'en parler à quelqu'un (éviter l'isolement)</label></div>
    </div>
    <button class="btn full" data-act="generateDoctorExport">Générer le PDF (impression)</button>`;
  el.innerHTML = html;
}
function toggleExtraGauges(){
  document.getElementById('deExtraGauges').classList.toggle('u-hidden');
}
function computeSymptomDeclareCounts(){
  const counts = {};
  state.foods.forEach(f => (f.symptoms||[]).forEach(fs => { counts[fs.id] = (counts[fs.id]||0) + 1; }));
  Object.values(state.agenda || {}).forEach(entries => entries.forEach(e =>
    (e.symptomIds||[]).forEach(id => { counts[id] = (counts[id]||0) + 1; })));
  return counts;
}
function generateDoctorExport(){
  const checked = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

  const includeTop = checked('deTopFoods');
  const includeRecent = checked('deRecentFoods');
  const includeSymptoms = checked('deSymptoms');
  const includeMonth = checked('deMonthSymptoms');
  const includePathologies = checked('dePathologies');
  const includeMeds = checked('deMeds');
  const includeAppt = checked('deApptHistory');
  const apptSinceDate = val('deApptHistoryDate');
  const includeTopics = checked('deNotesTopics');
  const topicsText = val('deNotesTopicsText');
  const includeReassess = checked('deReassessTreatment');
  const includeSideEffects = checked('deSideEffects');
  const sideEffectsText = val('deSideEffectsText');
  const includeImpact = checked('deImpact');
  const impactValue = val('deImpactValue') || '5';
  const includePain = checked('dePain');
  const painValue = val('dePainValue') || '5';
  const includeFatigue = checked('deFatigue');
  const fatigueValue = val('deFatigueValue') || '5';
  const includeMental = checked('deMental');
  const mentalValue = val('deMentalValue') || '5';
  const includeSymptomSeverity = checked('deSymptomSeverity');
  const symptomSeverityValue = val('deSymptomSeverityValue') || '5';
  const includeOther = checked('deOther');
  const otherText = val('deOtherText');
  const includeHelp = checked('deHelp');
  const helpText = val('deHelpText');
  const includeTalk = checked('deTalk');

  const hasSensitive = includePathologies || includeMeds || includeSideEffects || includeReassess || includeTalk || includeMental;
  if(hasSensitive){
    const proceed = confirm("Ce document contiendra des informations de santé potentiellement sensibles (traitement, effets secondaires, besoin d'en parler…).\n\nPense à le garder et le partager en toute sécurité.\n\nContinuer ?");
    if(!proceed) return;
  }

  let html = `<header class="de-header"><div class="de-header-top"><span class="de-app">Digest — Export Médecin</span><span class="de-date-pill">Généré le ${new Date().toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' })}</span></div><h1>Résumé pour consultation</h1><p class="de-sub">Préparé pour faciliter l'échange avec un professionnel de santé</p></header>`;

  if(includePathologies && (state.pathologies||[]).length){
    html += `<section><div class="de-section-title">Diagnostics connus</div>` + state.pathologies.map(p =>
      `<div class="de-card"><b>${escapeHtml(p.name)}</b>${p.notes ? `<p>${escapeHtml(p.notes)}</p>` : ''}</div>`).join('') + `</section>`;
  }

  if(includeMeds && (state.medications||[]).length){
    html += `<section><div class="de-section-title">Traitement en cours</div>` + state.medications.map(m =>
      `<div class="de-card"><b>${escapeHtml(m.name)}</b>${m.dosage ? `<span class="de-meta">${escapeHtml(m.dosage)}</span>` : ''}</div>`).join('') + `</section>`;
  }

  const notesParts = [];
  if(includeTopics && topicsText) notesParts.push(`<div class="de-note-card">${escapeHtml(topicsText).replace(/\n/g,'<br>')}</div>`);
  if(includeReassess) notesParts.push(`<div class="de-card"><p>Je souhaite réévaluer mon traitement.</p></div>`);
  if(includeSideEffects) notesParts.push(`<div class="de-card"><p><strong>Effets secondaires suspectés :</strong><br>${sideEffectsText ? escapeHtml(sideEffectsText).replace(/\n/g,'<br>') : '(non précisé)'}</p></div>`);
  if(includeImpact) notesParts.push(`<div class="de-card"><p>Impact sur mon quotidien : ${escapeHtml(impactValue)}/10</p></div>`);
  if(includePain) notesParts.push(`<div class="de-card"><p>Douleur physique : ${escapeHtml(painValue)}/10</p></div>`);
  if(includeFatigue) notesParts.push(`<div class="de-card"><p>Fatigue : ${escapeHtml(fatigueValue)}/10</p></div>`);
  if(includeMental) notesParts.push(`<div class="de-card"><p>État mental / moral : ${escapeHtml(mentalValue)}/10</p></div>`);
  if(includeSymptomSeverity) notesParts.push(`<div class="de-card"><p>Sévérité des symptômes : ${escapeHtml(symptomSeverityValue)}/10</p></div>`);
  if(includeOther && otherText) notesParts.push(`<div class="de-card"><p><strong>Autre :</strong><br>${escapeHtml(otherText).replace(/\n/g,'<br>')}</p></div>`);
  if(includeHelp) notesParts.push(`<div class="de-card"><p><strong>Aide spécifique demandée :</strong><br>${helpText ? escapeHtml(helpText).replace(/\n/g,'<br>') : '(non précisé)'}</p></div>`);
  if(includeTalk) notesParts.push(`<div class="de-card"><p>J'ai besoin d'en parler à quelqu'un (éviter l'isolement).</p></div>`);
  if(notesParts.length) html += `<section><div class="de-section-title">Sujets à aborder</div>` + notesParts.join('') + `</section>`;

  if(includeAppt && apptSinceDate){
    const appts = [];
    Object.keys(state.agenda || {}).filter(k => k >= apptSinceDate).sort().forEach(key => {
      (state.agenda[key] || []).forEach(e => {
        if(e.kind === 'appointment') appts.push({ date: key, doctorType: e.doctorType || 'Type non précisé' });
      });
    });
    html += `<section><div class="de-section-title">Historique des rendez-vous (depuis le ${new Date(apptSinceDate).toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' })})</div><div class="de-card">`;
    html += appts.length
      ? appts.map(a => `<div class="de-timeline-item"><span class="de-timeline-date">${new Date(a.date).toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' })}</span><span class="de-timeline-type">${escapeHtml(a.doctorType)}</span></div>`).join('')
      : `<p>Aucun rendez-vous noté sur cette période.</p>`;
    html += `</div></section>`;
  }

  if(includeTop){
    const top = state.foods.filter(f => (f.count||0) > 0).slice().sort((a,b) => (b.count||0)-(a.count||0)).slice(0, 10);
    html += `<section><div class="de-section-title">Aliments les plus inflammatoires</div><div class="de-card"><div class="de-food-list">`;
    html += top.length
      ? top.map(f => `<span class="de-food-pill">${escapeHtml(f.name)} · ${f.count}</span>`).join('')
      : `<p>Aucune donnée pour l'instant.</p>`;
    html += `</div></div></section>`;
  }

  if(includeRecent){
    const recent = state.foods.slice().sort((a,b) => decodeUidTimestamp(b.id)-decodeUidTimestamp(a.id)).slice(0, 10);
    html += `<section><div class="de-section-title">Aliments ajoutés récemment</div><div class="de-card"><div class="de-food-list">`;
    html += recent.length
      ? recent.map(f => `<span class="de-food-pill de-food-pill-recent">${escapeHtml(f.name)}</span>`).join('')
      : `<p>Aucune donnée pour l'instant.</p>`;
    html += `</div></div></section>`;
  }

  if(includeSymptoms){
    const counts = computeSymptomDeclareCounts();
    const list = state.symptoms.filter(s => counts[s.id]).sort((a,b) => counts[b.id]-counts[a.id]);
    html += `<section><div class="de-section-title">Mes symptômes</div><div class="de-card">`;
    html += list.length
      ? list.map(s => `<p>${escapeHtml(s.name)} — déclaré ${counts[s.id]} fois</p>`).join('')
      : `<p>Aucune donnée pour l'instant.</p>`;
    html += `</div></section>`;
  }

  if(includeMonth){
    const now = new Date();
    const prefix = `${now.getFullYear()}-${pad2(now.getMonth()+1)}`;
    const entries = [];
    Object.keys(state.agenda || {}).filter(k => k.startsWith(prefix)).sort().forEach(key => {
      (state.agenda[key] || []).forEach(e => {
        const names = (e.symptomIds||[]).map(id => { const s = state.symptoms.find(s=>s.id===id); return s ? s.name : null; }).filter(Boolean);
        if(names.length) entries.push({ date: key, names });
      });
    });
    html += `<section><div class="de-section-title">Symptômes du mois en cours</div><div class="de-card">`;
    html += entries.length
      ? entries.map(e => `<p>${e.date} — ${e.names.map(escapeHtml).join(', ')}</p>`).join('')
      : `<p>Aucun symptôme noté ce mois-ci.</p>`;
    html += `</div></section>`;
  }

  document.getElementById('doctorExportPrintView').innerHTML = html;
  document.body.classList.add('printing-doctor-export');
  window.print();
  if(confirm("As-tu déjà un prochain rendez-vous de prévu ? Tu peux le noter dans l'Agenda dès maintenant, en quelques secondes.")){
    setMainTab('agenda');
  }
}
window.addEventListener('afterprint', () => document.body.classList.remove('printing-doctor-export'));
function closeDoctorExportPrintView(){
  document.body.classList.remove('printing-doctor-export');
}


function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function escapeAttr(str){ return escapeHtml(str); }

/* ---------- Panneau Sécurité ---------- */
// ---- Tutoriel de bienvenue (onboarding) ----
const ONBOARDING_SLIDES = [
  // ⚠️ Le nombre d'éléments ici (6) est utilisé pour le calcul de progression
  // des pastilles — pas de valeur codée en dur ailleurs à maintenir en synchronisation.
  { emoji: '👋', title: 'Bienvenue dans Digest', text: "Un carnet pour suivre tes intolérances alimentaires, entièrement local : rien n'est envoyé nulle part, tout reste sur cet appareil." },
  { emoji: '🥕', title: 'Aliments', text: "Ajoute un aliment ou une recette, associe-lui des symptômes colorés, et incrémente le compteur de réactions chaque fois que tu penses qu'il t'a causé un souci. Tu connais déjà plusieurs de tes intolérances ? Un pack de 300+ aliments courants t'attend dans Paramètres pour gagner du temps." },
  { emoji: '🍲', title: 'Recettes', text: "Un espace séparé pour organiser tes recettes : ingrédients, tags repas/régime, rapidité, facilité et prix. Rien n'y apparaît automatiquement, tu choisis ce que tu y ajoutes." },
  { emoji: '📅', title: 'Suivi & Agenda', text: "Suivi regroupe tes aliments par symptôme, triés par nombre de réactions. Agenda te permet de noter au jour le jour symptômes, notes libres et jauges personnalisées." },
  { emoji: '🔒', title: 'Paramètres', text: "Protège tes données par mot de passe, gère tes symptômes et — si besoin — un espace dédié et protégé pour tes traitements." },
  { emoji: '💾', title: 'Pense à sauvegarder', text: "Depuis Paramètres, exporte régulièrement tes données en fichier téléchargé — surtout avant une mise à jour de l'app. Une version chiffrée existe aussi si la protection par mot de passe est activée. Rien n'est automatique : c'est à toi de le déclencher." }
];
let onboardingIndex = 0;
function renderOnboardingSlide(){
  const s = ONBOARDING_SLIDES[onboardingIndex];
  document.getElementById('onboardingSlide').innerHTML =
    `<div class="onboarding-illus">${s.emoji}</div><h2>${escapeHtml(s.title)}</h2><p>${escapeHtml(s.text)}</p>`;
  document.getElementById('onboardingDots').innerHTML = ONBOARDING_SLIDES.map((_, i) =>
    `<span class="onboarding-dot ${i === onboardingIndex ? 'active' : ''}"></span>`).join('');
  document.getElementById('onboardingPrevBtn').disabled = onboardingIndex === 0;
  document.getElementById('onboardingNextBtn').textContent = onboardingIndex === ONBOARDING_SLIDES.length - 1 ? 'Commencer' : 'Suivant →';
}
function onboardingNext(){
  if(onboardingIndex < ONBOARDING_SLIDES.length - 1){ onboardingIndex++; renderOnboardingSlide(); }
  else { closeOnboarding(); }
}
function onboardingPrev(){
  if(onboardingIndex > 0){ onboardingIndex--; renderOnboardingSlide(); }
}
function onboardingSkip(){ closeOnboarding(); }
function closeOnboarding(){
  document.getElementById('onboardingOverlay').classList.remove('is-open');
  localStorage.setItem('digest_onboarding_seen', '1');
}
function maybeShowOnboarding(){
  if(!localStorage.getItem('digest_onboarding_seen')){
    onboardingIndex = 0;
    renderOnboardingSlide();
    document.getElementById('onboardingOverlay').classList.add('is-open');
  }
}
function replayOnboarding(){
  onboardingIndex = 0;
  renderOnboardingSlide();
  document.getElementById('onboardingOverlay').classList.add('is-open');
}

// ---- Bilan périodique (statistiques positives + rappel rdv) ----
function computeBilanStats(){
  return {
    aliments: state.foods.filter(f => f.type !== 'recipe').length,
    recettes: state.foods.filter(f => f.type === 'recipe').length,
    symptomes: activeSymptoms().length,
    reactions: state.foods.reduce((sum, f) => sum + (f.count || 0), 0),
    joursActifs: Object.keys(state.agenda || {}).length
  };
}
function hasUpcomingAppointment(){
  const today = todayKey();
  return Object.keys(state.agenda || {}).some(key =>
    key >= today && (state.agenda[key] || []).some(e => e.kind === 'appointment')
  );
}
function maybeShowBilan(){
  const last = localStorage.getItem('intolerances_last_bilan_shown');
  const now = Date.now();
  if(last && (now - parseInt(last, 10)) < 21 * 24 * 60 * 60 * 1000) return; // pas plus d'une fois toutes les 3 semaines
  const s = computeBilanStats();
  const hasData = s.aliments + s.recettes + s.reactions + s.joursActifs > 0;
  let html;
  if(hasData){
    html = `<h2>Ton bilan</h2><p>Tu as déjà noté <strong>${s.aliments}</strong> aliment(s), <strong>${s.recettes}</strong> recette(s)`;
    if(s.reactions) html += ` et <strong>${s.reactions}</strong> réaction(s) suivie(s)`;
    if(s.symptomes) html += `, sur <strong>${s.symptomes}</strong> symptôme(s) identifié(s)`;
    html += `. Continue comme ça — plus tu notes, plus les tendances dans Suivi deviennent claires.</p>`;
  } else {
    html = `<h2>Prêt à commencer ?</h2><p>Chaque aliment noté rend l'onglet Suivi plus utile. Prends quelques secondes pour ajouter ce que tu as mangé récemment.</p>`;
  }
  if(!hasUpcomingAppointment()){
    html += `<p class="u-mt10">As-tu un rendez-vous médical prévu prochainement ? Tu peux le noter en quelques secondes.</p>
      <button class="btn full rdv-btn" data-act="goToAgendaFromBilan">Ajouter un rendez-vous</button>`;
  }
  html += `<button class="text-action u-mt10" data-act="closeBilan">Fermer</button>`;
  document.getElementById('bilanCard').innerHTML = html;
  document.getElementById('bilanOverlay').classList.add('is-open');
  localStorage.setItem('intolerances_last_bilan_shown', String(now));
}
function closeBilan(){
  document.getElementById('bilanOverlay').classList.remove('is-open');
}
function goToAgendaFromBilan(){
  closeBilan();
  setMainTab('agenda');
}

// ---- Accès rapide "J'ai un symptôme maintenant" (2 taps max) ----
function openQuickSymptomLog(){
  document.getElementById('quickLogOverlay').classList.add('is-open');
  renderQuickLogChips();
}
function closeQuickSymptomLog(){
  document.getElementById('quickLogOverlay').classList.remove('is-open');
}
function renderQuickLogChips(){
  const el = document.getElementById('quickLogChips');
  const today = todayKey();
  const entry = (state.agenda[today] || []).find(e => e.kind === 'symptom' && e.quickLog);
  const selectedIds = new Set(entry ? entry.symptomIds : []);
  const active = activeSymptoms();
  el.innerHTML = active.length
    ? active.map(s => `<button type="button" class="chip ${selectedIds.has(s.id) ? 'active' : ''}" data-act="toggleQuickSymptom" data-a="${s.id}"><span class="dot c${paletteIndexForColor(s.color)}"></span>${escapeHtml(s.name)}</button>`).join('')
    : '<p class="u-soft-85">Crée d\'abord un symptôme depuis Aliments ou Agenda.</p>';
}
// Messages après ajout d'un symptôme via le pansement : 2 messages habituels
// (la majorité du temps), 7 messages plus chaleureux mais rares, pour éviter
// l'effet automate — jamais de langage de douleur ("mal", "ça fait mal"...).
const QUICKLOG_USUAL_MESSAGES = [
  "Noté — ça t'aide à mieux comprendre ce qui se passe, et à en parler à ton médecin.",
  "C'est noté."
];
const QUICKLOG_RARE_MESSAGES = [
  "Merci de prendre soin de toi en notant ça.",
  "Chaque note comme celle-ci t'aide à voir plus clair, doucement.",
  "C'est précieux, ce que tu fais là, pour toi-même.",
  "Merci de le noter — ton médecin appréciera d'avoir ces détails.",
  "Prendre soin de soi, ça commence par des petits gestes comme celui-ci.",
  "Merci pour cette note — elle t'aide à y voir plus clair avec le temps.",
  "Ce n'est pas simple à vivre au quotidien — heureusement, tu gardes une trace utile."
];
function pickQuickLogMessage(){
  if(Math.random() < 0.2){
    return QUICKLOG_RARE_MESSAGES[Math.floor(Math.random() * QUICKLOG_RARE_MESSAGES.length)];
  }
  return QUICKLOG_USUAL_MESSAGES[Math.floor(Math.random() * QUICKLOG_USUAL_MESSAGES.length)];
}
function toggleQuickSymptom(id){
  const today = todayKey();
  if(!state.agenda[today]) state.agenda[today] = [];
  let entry = state.agenda[today].find(e => e.kind === 'symptom' && e.quickLog);
  if(!entry){
    entry = { id: uid(), kind: 'symptom', quickLog: true, symptomIds: [], note: '', gauges: {} };
    state.agenda[today].push(entry);
  }
  const idx = entry.symptomIds.indexOf(id);
  let added = false;
  if(idx === -1){ entry.symptomIds.push(id); added = true; }
  else { entry.symptomIds.splice(idx, 1); }
  if(entry.symptomIds.length === 0){
    state.agenda[today] = state.agenda[today].filter(e => e !== entry);
    if(state.agenda[today].length === 0) delete state.agenda[today];
  }
  persist();
  renderQuickLogChips();
  refreshAgendaDependentViews();
  if(selectedDate === today){ renderAgendaEntries(); renderAgendaDaySummary(); }
  if(added){
    showToast(pickQuickLogMessage());
    const s = state.symptoms.find(s => s.id === id);
    if(s) triggerRibbon(paletteIndexForColor(s.color));
  }
}

// ---- Bannière de bienvenue (écran d'accueil) ----
function computeStreak(){
  const dates = new Set(Object.keys(state.agenda || {}).filter(k => (state.agenda[k] || []).length > 0));
  if(dates.size === 0) return 0;
  let streak = 0;
  let cursor = new Date();
  // La série compte les jours consécutifs jusqu'à aujourd'hui — si rien n'a été
  // noté aujourd'hui, on part d'hier pour ne pas casser une série en cours de journée.
  if(!dates.has(todayKey())) cursor.setDate(cursor.getDate() - 1);
  while(dates.has(dateKey(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()))){
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
function timeBasedGreeting(){
  const h = new Date().getHours();
  if(h < 5) return 'Debout tard ?';
  if(h < 12) return 'Bonjour !';
  if(h < 18) return 'Bon après-midi !';
  return 'Bonsoir !';
}
function renderWelcomeBanner(){
  const el = document.getElementById('welcomeBanner');
  if(!el) return;
  const joursActifs = computeBilanStats().joursActifs;
  const streak = computeStreak();
  const streakBadge = streak >= 2 ? ` <span class="streak-badge">🔥 ${streak} jours de suite</span>` : '';
  const regularite = joursActifs > 0
    ? `<p class="u-soft-85 u-mt6">🌱 ${joursActifs} jour${joursActifs > 1 ? 's' : ''} actif${joursActifs > 1 ? 's' : ''}${streakBadge}</p>`
    : `<p class="u-soft-85 u-mt6 welcome-empty"><span class="welcome-leaf">🌱</span><br>Ton suivi commence quand tu veux,<br>À ton rythme.</p>`;
  el.innerHTML = `<h2 class="u-m0">${escapeHtml(timeBasedGreeting())}</h2>${regularite}`;
}

function toggleLegalNotice(){
  const el = document.getElementById('legalNotice');
  if(!el) return;
  el.classList.toggle('u-hidden');
}
function toggleSecurityPanel(){
  const panel = document.getElementById('securityPanel');
  const willShow = panel.classList.contains('u-hidden-mt12');
  panel.classList.toggle('u-hidden-mt12', !willShow);
  if(willShow) renderSecurityPanel();
}
function renderSecurityPanel(){
  const panel = document.getElementById('securityPanel');
  if(!panel || panel.classList.contains('u-hidden-mt12')) return;

  if(!hasCrypto()){
    panel.innerHTML = `
      <div class="security-status">Protection indisponible</div>
      <p class="security-warning">Ce navigateur ne permet pas le chiffrement à cet endroit (fréquent pour un fichier ouvert directement, sans hébergement en HTTPS). Héberge l'app en ligne pour activer cette fonctionnalité.</p>`;
    return;
  }

  if(isProtectionEnabled()){
    panel.innerHTML = `
      <div class="security-status on">Protection activée</div>
      <p class="security-warning">Tes données sont chiffrées avant d'être enregistrées sur cet appareil. Sans ton mot de passe, personne — toi y compris — ne peut les récupérer. Note-le en lieu sûr.</p>
      <button class="btn secondary small" data-act="openChangePassphrase">Changer le mot de passe</button>
      <button class="btn secondary small" data-act="openDisableProtection">Désactiver la protection</button>
      <div id="securitySubform"></div>`;
  } else {
    panel.innerHTML = `
      <div class="security-status">Protection non activée</div>
      <p class="security-warning">Active un mot de passe pour chiffrer tes données sur cet appareil. Sans ce mot de passe, il sera impossible de les récupérer — pense à faire un export avant.</p>
      <div class="field-row">
        <input type="password" id="setupPass1" placeholder="Nouveau mot de passe" autocomplete="new-password">
      </div>
      <div class="field-row">
        <input type="password" id="setupPass2" placeholder="Confirme le mot de passe" autocomplete="new-password">
      </div>
      <button class="btn full" data-act="setupProtection">Activer la protection</button>
      <div class="lock-error" id="securityError"></div>`;
  }
}
async function setupProtection(){
  const p1 = document.getElementById('setupPass1').value;
  const p2 = document.getElementById('setupPass2').value;
  const errEl = document.getElementById('securityError');
  errEl.textContent = '';
  if(p1.length < 4){ errEl.textContent = 'Choisis un mot de passe d\'au moins 4 caractères.'; return; }
  if(p1 !== p2){ errEl.textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
  try{
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(p1, salt);
    sessionCryptoKey = key;
    localStorage.setItem(SALT_KEY, b64encode(salt));
    persist();
    alert('Protection activée. Ton carnet est maintenant chiffré sur cet appareil.');
    renderSecurityPanel();
    if(typeof renderMedsSection === 'function') renderMedsSection();
  }catch(e){
    errEl.textContent = "Erreur lors de l'activation. Réessaie.";
  }
}
function openChangePassphrase(){
  const sub = document.getElementById('securitySubform');
  sub.innerHTML = `
    <div class="field-row u-mt10">
      <input type="password" id="curPassChange" placeholder="Mot de passe actuel" autocomplete="current-password">
    </div>
    <div class="field-row">
      <input type="password" id="newPass1" placeholder="Nouveau mot de passe" autocomplete="new-password">
    </div>
    <div class="field-row">
      <input type="password" id="newPass2" placeholder="Confirme le nouveau mot de passe" autocomplete="new-password">
    </div>
    <button class="btn full" data-act="changePassphrase">Confirmer le changement</button>
    <div class="lock-error" id="securityError"></div>`;
}
async function changePassphrase(){
  const cur = document.getElementById('curPassChange').value;
  const n1 = document.getElementById('newPass1').value;
  const n2 = document.getElementById('newPass2').value;
  const errEl = document.getElementById('securityError');
  errEl.textContent = '';
  if(n1.length < 4){ errEl.textContent = 'Choisis un nouveau mot de passe d\'au moins 4 caractères.'; return; }
  if(n1 !== n2){ errEl.textContent = 'Les deux nouveaux mots de passe ne correspondent pas.'; return; }
  try{
    const saltB64 = localStorage.getItem(SALT_KEY);
    const salt = new Uint8Array(b64decode(saltB64));
    const curKey = await deriveKey(cur, salt);
    const payload = JSON.parse(localStorage.getItem(SECURE_KEY) || '{}');
    await aesDecryptJSON(curKey, payload.iv, payload.data); // vérifie le mot de passe actuel
    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    const newKey = await deriveKey(n1, newSalt);
    sessionCryptoKey = newKey;
    localStorage.setItem(SALT_KEY, b64encode(newSalt));
    persist();
    alert('Mot de passe changé avec succès.');
    renderSecurityPanel();
  }catch(e){
    errEl.textContent = 'Mot de passe actuel incorrect.';
  }
}
function openDisableProtection(){
  const sub = document.getElementById('securitySubform');
  sub.innerHTML = `
    <div class="field-row u-mt10">
      <input type="password" id="curPassDisable" placeholder="Mot de passe actuel" autocomplete="current-password">
    </div>
    <button class="btn full" data-act="disableProtection">Confirmer la désactivation</button>
    <div class="lock-error" id="securityError"></div>`;
}
async function disableProtection(){
  if((state.medications || []).length > 0 || (state.pathologies || []).length > 0){
    const proceed = confirm("Tu as des pathologies et/ou traitements enregistrés. Désactiver la protection les stockera en clair (non chiffrés) sur cet appareil.\n\nOK = continuer quand même\nAnnuler = annuler la désactivation");
    if(!proceed) return;
  }
  const cur = document.getElementById('curPassDisable').value;
  const errEl = document.getElementById('securityError');
  errEl.textContent = '';
  try{
    const saltB64 = localStorage.getItem(SALT_KEY);
    const salt = new Uint8Array(b64decode(saltB64));
    const curKey = await deriveKey(cur, salt);
    const payload = JSON.parse(localStorage.getItem(SECURE_KEY) || '{}');
    await aesDecryptJSON(curKey, payload.iv, payload.data); // vérifie le mot de passe actuel
    sessionCryptoKey = null;
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    localStorage.removeItem(SECURE_KEY);
    localStorage.removeItem(SALT_KEY);
    alert('Protection désactivée. Tes données sont de nouveau stockées sans chiffrement sur cet appareil.');
    renderSecurityPanel();
    if(typeof renderMedsSection === 'function') renderMedsSection();
  }catch(e){
    errEl.textContent = 'Mot de passe incorrect.';
  }
}
function confirmResetProtection(){
  if(!confirm("Cette action efface définitivement les données protégées de cet appareil (le mot de passe étant perdu, elles ne sont de toute façon plus récupérables). Continuer ?")) return;
  localStorage.removeItem(SECURE_KEY);
  localStorage.removeItem(SALT_KEY);
  localStorage.removeItem(STORE_KEY);
  location.reload();
}

/* ---------- Démarrage de l'app ---------- */
function applyThemePreference(){
  const saved = localStorage.getItem('intolerances_theme') || 'celadon-prune';
  applyTheme(saved);
}
function finishBoot(){
  migrateSeverity();
      migrateCooking();
  if(!state.gaugeTypes) state.gaugeTypes = [];
  if(!state.agenda) state.agenda = {};
  if(!state.medications) state.medications = [];
  if(!state.pathologies) state.pathologies = [];
  renderAll();
  renderLastExportInfo();
  renderAppVersionInfo();
  renderWelcomeBanner();
  renderRankingList();
  renderCalendar();
  applyAllFeatureVisibility();
  if(typeof renderMedsSection === 'function') renderMedsSection();
  document.body.classList.remove('app-locked');
  const isFirstLaunch = !localStorage.getItem('digest_onboarding_seen');
  maybeShowOnboarding();
  if(!isFirstLaunch) maybeShowBilan();
}
// ==================================================================
// Délégation d'événements — remplace les anciens attributs onclick=""
// (nécessaire pour une CSP sans 'unsafe-inline' sur script-src)
// ==================================================================
function parseNum(v){ return parseInt(v, 10) || 0; }

const clickActions = {
  attemptUnlock: () => attemptUnlock(),
  confirmResetProtection: () => confirmResetProtection(),
  applyTheme: (a) => applyTheme(a),
  setMainTab: (a) => setMainTab(a),
  setAddMode: (a) => setAddMode(a),
  addFormNextStep: () => addFormNextStep(),
  addFormPrevStep: () => addFormPrevStep(),
  quickPickMiciSymptom: (a) => quickPickMiciSymptom(a),
  requestCloseAddForm: () => requestCloseAddForm(),
  toggleAddFavorite: () => toggleAddFavorite(),
  addPendingTag: (a) => addPendingTag(a),
  saveItem: () => saveItem(),
  toggleFilters: () => toggleFilters(),
  clearFilters: () => clearFilters(),
  openRecipeBookCreateForm: () => openRecipeBookCreateForm(),
  openFavoritePicker: () => openFavoritePicker(),
  closeFavPicker: () => closeFavPicker(),
  requestCloseRBForm: () => requestCloseRBForm(),
  addRBIngredient: () => addRBIngredient(),
  addRBDietTag: () => addRBDietTag(),
  saveRecipeBookEntry: () => saveRecipeBookEntry(),
  changeMonth: (a) => changeMonth(parseNum(a)),
  closeAgendaPanel: () => closeAgendaPanel(),
  toggleAgendaSection: (a) => toggleAgendaSection(a),
  addNewGaugeType: () => addNewGaugeType(),
  saveAgendaEntry: () => saveAgendaEntry(),
  exportData: () => exportData(),
  exportDataEncrypted: () => exportDataEncrypted(),
  triggerImportFile: () => document.getElementById('importFile').click(),
  toggleFeature: (a) => toggleFeature(a),
  toggleSecurityPanel: () => toggleSecurityPanel(),
  toggleLegalNotice: () => toggleLegalNotice(),
  onboardingNext: () => onboardingNext(),
  onboardingPrev: () => onboardingPrev(),
  onboardingSkip: () => onboardingSkip(),
  replayOnboarding: () => replayOnboarding(),
  goToAgendaFromBilan: () => goToAgendaFromBilan(),
  openQuickSymptomLog: () => openQuickSymptomLog(),
  closeQuickSymptomLog: () => closeQuickSymptomLog(),
  toggleQuickSymptom: (a) => toggleQuickSymptom(a),
  closeBilan: () => closeBilan(),
  generateDoctorExport: () => generateDoctorExport(),
  closeDoctorExportPrintView: () => closeDoctorExportPrintView(),
  toggleExtraGauges: () => toggleExtraGauges(),
  deleteMedication: (a) => deleteMedication(a),
  addPathology: () => addPathology(),
  deletePathology: (a) => deletePathology(a),
  addMedication: () => addMedication(),
  installFoodPack: () => installFoodPack(),
  removeUnusedPackFoods: () => removeUnusedPackFoods(),
  reactivateSymptom: (a) => reactivateSymptom(a),
  toggleColorPalette: (a) => toggleColorPalette(a),
  pickSymptomColor: (a, b) => pickSymptomColor(a, b),
  selectCreateColor: (a) => selectCreateColor(a),
  deleteSymptom: (a) => deleteSymptom(a),
  removeSymptomFromPicker: (a, b) => removeSymptomFromPicker(a, b),
  selectSymptomForPicker: (a, b) => selectSymptomForPicker(a, b),
  createSymptomForPicker: (a) => createSymptomForPicker(a),
  selectIngredientSuggestion: (a) => selectIngredientSuggestion(a),
  removePendingTag: (a, b) => removePendingTag(a, b),
  toggleFilter: (a, b) => toggleFilter(a, b),
  incrementCookingCount: (a, b) => incrementCookingCount(a, b),
  changeCount: (a, b) => changeCount(a, parseNum(b)),
  toggleFavorite: (a) => toggleFavorite(a),
  openEditFood: (a) => openEditFood(a),
  deleteFood: (a) => deleteFood(a),
  importFavoriteToRB: (a) => importFavoriteToRB(a),
  selectRBIngredientSuggestion: (a) => selectRBIngredientSuggestion(a),
  setRBRating: (a, b) => setRBRating(a, parseNum(b)),
  toggleRBMeal: (a) => toggleRBMeal(a),
  removeRBDietTag: (a) => removeRBDietTag(a),
  removeRBIngredient: (a) => removeRBIngredient(a),
  openEditRBEntry: (a) => openEditRBEntry(a),
  deleteRBEntry: (a) => deleteRBEntry(a),
  openAgendaDay: (a) => openAgendaDay(a),
  saveAgendaRdv: () => saveAgendaRdv(),
  selectDoctorType: (a) => selectDoctorType(a),
  deleteAgendaEntry: (a) => deleteAgendaEntry(a),
  addAgendaGauge: (a) => addAgendaGauge(a),
  removeAgendaGauge: (a) => removeAgendaGauge(a),
  openChangePassphrase: () => openChangePassphrase(),
  openDisableProtection: () => openDisableProtection(),
  setupProtection: () => setupProtection(),
  changePassphrase: () => changePassphrase(),
  disableProtection: () => disableProtection(),
};

const inputActions = {
  onIngredientSearch, onSymptomSearch, onFoodSearch, onRBFavSearch,
  onRBIngredientSearch, onRBSearch, onAgendaSymptomSearch, onDoctorTypeSearch
};
const changeActions = { onFoodSortChange, onRBSortChange, onThemeChange };

// ---- Animation de confirmation (petites lignes qui partent vers l'extérieur) ----
// Uniquement sur les boutons qui restent visibles après l'action (sinon l'animation
// n'a pas le temps de s'afficher avant que le formulaire ne se ferme).
const BURST_ACTIONS = new Set([
  'addMedication', 'addPathology', 'addPendingTag', 'addRBIngredient', 'addRBDietTag',
  'addNewGaugeType', 'addAgendaGauge', 'toggleFavorite', 'changeCount', 'incrementCookingCount'
]);
function triggerBurst(el){
  if(!el) return;
  const burst = document.createElement('span');
  burst.className = 'click-burst';
  for(let i = 0; i < 8; i++){
    const ray = document.createElement('span');
    ray.className = 'ray ray-' + i;
    ray.appendChild(document.createElement('i'));
    burst.appendChild(ray);
  }
  el.appendChild(burst);
  setTimeout(() => burst.remove(), 600);
}
function popRankingEmoji(){
  const tab = document.getElementById('mainTabRanking');
  if(!tab) return;
  const emoji = document.createElement('span');
  emoji.className = 'tab-pop-emoji';
  emoji.textContent = '🌶️';
  tab.appendChild(emoji);
  setTimeout(() => emoji.remove(), 1050);
}

// ---- Serpentin ondulé : à chaque symptôme ajouté via le pansement ----
function triggerRibbon(colorIndex){
  const wrap = document.createElement('div');
  wrap.className = 'ribbon-pop c' + colorIndex;
  wrap.innerHTML = '<svg viewBox="0 0 120 30" class="ribbon-svg"><path d="M2,15 Q20,2 38,15 T74,15 T110,15"></path></svg>';
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 1000);
}

// ---- Feu d'artifice sobre, aléatoire : après un ajout d'aliment ou de recette ----
function triggerFirework(colorClass){
  const wrap = document.createElement('div');
  wrap.className = 'firework-pop ' + colorClass;
  for(let i = 0; i < 12; i++){
    const p = document.createElement('span');
    p.className = 'fw-particle fw-' + i;
    p.appendChild(document.createElement('i'));
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 900);
}

document.addEventListener('click', function(e){
  const el = e.target.closest('[data-act]');
  if(!el) return;
  if(el.tagName === 'A') e.preventDefault();
  const act = el.dataset.act;
  const fn = clickActions[act];
  if(fn) fn(el.dataset.a, el.dataset.b);
  if(BURST_ACTIONS.has(act) && el.dataset.b !== '-1'){
    triggerBurst(el);
  }
  if(act === 'changeCount' && el.dataset.b !== '-1'){
    popRankingEmoji();
  }
});

document.addEventListener('input', function(e){
  const el = e.target.closest('[data-act]');
  if(!el) return;
  const act = el.dataset.act;
  if(act === 'setAgendaGaugeValue'){ setAgendaGaugeValue(el.dataset.a, el.value); return; }
  const fn = inputActions[act];
  if(fn) fn();
});

document.addEventListener('change', function(e){
  const el = e.target.closest('[data-act]');
  if(!el) return;
  const act = el.dataset.act;
  if(act === 'importData'){ importData(e); return; }
  if(act === 'updateSymptomName'){ updateSymptomName(el.dataset.a, el.value); return; }
  const fn = changeActions[act];
  if(fn) fn();
});

document.addEventListener('keydown', function(e){
  if(e.key !== 'Enter') return;
  const el = e.target.closest('[data-enter]');
  if(!el) return;
  const act = el.dataset.enter;
  if(act === 'blur'){ e.preventDefault(); el.blur(); return; }
  const fn = clickActions[act];
  if(fn) fn();
});

document.addEventListener('focusout', function(e){
  const el = e.target;
  if(!el.dataset || el.dataset.blurAct !== 'setCountFromInput') return;
  setCountFromInput(el.dataset.a, el);
});

function bootPlain(){
  state = load() || { symptoms: [], foods: [], recipeBook: [] };
  if(!state.recipeBook) state.recipeBook = [];
  finishBoot();
}
async function attemptUnlock(){
  const pass = document.getElementById('lockPassphrase').value;
  const errEl = document.getElementById('lockError');
  errEl.textContent = '';
  if(!pass){ errEl.textContent = 'Entre ton mot de passe.'; return; }
  try{
    const saltB64 = localStorage.getItem(SALT_KEY);
    const salt = new Uint8Array(b64decode(saltB64));
    const key = await deriveKey(pass, salt);
    const payload = JSON.parse(localStorage.getItem(SECURE_KEY) || '{}');
    const decrypted = await aesDecryptJSON(key, payload.iv, payload.data);
    sessionCryptoKey = key;
    state = decrypted;
    if(!state.recipeBook) state.recipeBook = [];
    finishBoot();
  }catch(e){
    errEl.textContent = 'Mot de passe incorrect.';
  }
}
function initSecurity(){
  applyThemePreference();
  if(isProtectionEnabled()){
    if(!hasCrypto()){
      document.getElementById('lockScreen').innerHTML = `
        <div class="lock-card">
          <h2>Protection indisponible ici</h2>
          <p>Tes données sont chiffrées, mais ce navigateur ne permet pas de les déchiffrer à cet endroit (fréquent pour un fichier ouvert directement sans hébergement en HTTPS). Réessaie avec Chrome, Safari ou Brave à jour, ou héberge l'app en ligne.</p>
        </div>`;
      return;
    }
    document.getElementById('lockPassphrase').focus();
  } else {
    bootPlain();
  }
}
initSecurity();

// Service worker : rend l'app utilisable hors-ligne une fois installée
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
