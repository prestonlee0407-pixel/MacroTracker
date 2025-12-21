const STAT_FIELDS = [
  { key: 'calories', label: 'Calories' },
  { key: 'protein', label: 'Protein' },
  { key: 'fat', label: 'Fat' },
  { key: 'fiber', label: 'Fiber' },
  { key: 'carbs', label: 'Carbs' }
];

const DEFAULT_SETTINGS = {
  id: 'current',
  body_weight: null,
  weight_unit: 'lbs',
  maintenance_calories: null,
  caloric_adjustment: 0,
  macro_ratio_unit: 'kg',
  protein_per_unit: 1.8,
  fat_per_unit: 0.6,
  fiber_goal: 25
};

let db;
let settingsState = { ...DEFAULT_SETTINGS };
let pyodideReady;
let pyodideInstance;
const pythonApi = {};
let deferredInstall;
let ocrWorker;

const settingsForm = document.getElementById('settings-form');
const statsContainer = document.getElementById('stats-cards');
const entriesList = document.getElementById('entries-list');
const itemsList = document.getElementById('items-list');
const itemDialog = document.getElementById('item-dialog');
const entryDialog = document.getElementById('entry-dialog');
const itemForm = document.getElementById('item-form');
const entryForm = document.getElementById('entry-form');
const toastEl = document.getElementById('toast');
const addChoiceDialog = document.getElementById('add-choice-dialog');

init();

async function init() {
  createStatCards();
  db = await openDatabase();
  await registerServiceWorker();
  setupInstallPrompt();
  setupSettingsListeners();
  setupDialogs();
  setupActions();
  pyodideReady = bootstrapPyodide();
  bootstrapOcr();
  await loadSettings();
  renderSettingsForm();
  await pyodideReady;
  await Promise.all([renderItems(), renderEntries()]);
  await refreshStats();
}

function createStatCards() {
  STAT_FIELDS.forEach(({ key, label }) => {
    const card = document.createElement('article');
    card.className = 'stat-card';
    card.dataset.key = key;
    card.innerHTML = `<h3>${label}</h3><p>0 / -</p>`;
    statsContainer.appendChild(card);
  });
}

function setupSettingsListeners() {
  settingsForm.addEventListener('input', (event) => {
    const target = event.target;
    const { name, value } = target;
    if (!name) return;
    const parsed = parseSettingValue(name, value);
    updateSettingsState({ [name]: parsed }, { render: false }).catch(console.error);
  });

  settingsForm.querySelectorAll('.adjuster button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.adjust || 0);
      const currentVal = Number(settingsForm.caloric_adjustment.value || 0);
      const nextVal = currentVal + delta;
      settingsForm.caloric_adjustment.value = nextVal;
      updateSettingsState({ caloric_adjustment: nextVal }, { render: false }).catch(console.error);
    });
  });
}

function setupDialogs() {
  document.querySelectorAll('dialog [data-close]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      const dialog = event.target.closest('dialog');
      dialog?.close();
    });
  });

  if (addChoiceDialog) {
    addChoiceDialog.addEventListener('click', (event) => {
      const modeBtn = event.target.closest('button[data-mode]');
      if (!modeBtn) return;
      const mode = modeBtn.dataset.mode;
      addChoiceDialog.close();
      if (mode === 'label') {
        openItemDialog(undefined, { mode: 'label' });
      } else {
        openItemDialog();
      }
    });
  }

  itemForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(itemForm);
    const baseGrams = parseFloat(formData.get('base_grams'));
    if (!formData.get('name')) {
      showToast('Name is required');
      return;
    }
    if (!baseGrams || baseGrams <= 0) {
      showToast('Serving mass must be greater than zero');
      return;
    }

    const macros = ['calories', 'protein', 'fat', 'carbs', 'fiber'].reduce((acc, key) => {
      acc[key] = toNumber(formData.get(key));
      return acc;
    }, {});

    let imageData = itemForm.dataset.imageData || null;
    const imageFile = formData.get('image');
    if (imageFile && imageFile.size > 0) {
      imageData = await fileToDataUrl(imageFile);
    }

    const itemPayload = {
      name: formData.get('name').trim(),
      base_grams: baseGrams,
      macros,
      per_gram: perGram(macros, baseGrams),
      imageData,
      createdAt: itemForm.dataset.editingId ? Number(itemForm.dataset.createdAt) : Date.now()
    };

    if (itemForm.dataset.editingId) {
      itemPayload.id = Number(itemForm.dataset.editingId);
      await updateItem(itemPayload);
      showToast('Item updated');
    } else {
      await addItem(itemPayload);
      showToast('Item saved');
    }

    itemDialog.close();
    resetItemForm();
    await renderItems();
  });

  const imageInput = itemForm.querySelector('input[name="image"]');
  imageInput.addEventListener('change', async () => {
    if (imageInput.files?.length) {
      const dataUrl = await fileToDataUrl(imageInput.files[0]);
      itemForm.dataset.imageData = dataUrl;
      updateImagePreview(dataUrl);
      if (itemForm.dataset.mode === 'label') {
        await runLabelOcr(imageInput.files[0]);
      }
    }
  });

  entryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(entryForm);
    const itemId = Number(formData.get('item_id'));
    const grams = Number(formData.get('grams'));
    if (!itemId || !grams || grams <= 0) {
      showToast('Item and grams are required');
      return;
    }
    await addEntry({ itemId, grams });
    entryDialog.close();
    entryForm.reset();
    await renderEntries();
    await refreshStats();
  });
}

function setupActions() {
  const addItemBtn = document.getElementById('add-item-btn');
  if (addChoiceDialog) {
    addItemBtn.addEventListener('click', () => addChoiceDialog.showModal());
  } else {
    addItemBtn.addEventListener('click', () => openItemDialog());
  }
  document.getElementById('add-entry-btn').addEventListener('click', openEntryDialog);

  document.getElementById('toggle-settings').addEventListener('click', () => {
    const panel = document.getElementById('settings-panel');
    const isHidden = panel.toggleAttribute('hidden');
    document.getElementById('toggle-settings').textContent = isHidden
      ? 'Show settings'
      : 'Hide settings';
  });

  itemsList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const itemId = Number(button.closest('[data-id]')?.dataset.id);
    if (!itemId) return;
    const action = button.dataset.action;
    if (action === 'delete') {
      if (!confirm('Delete this item?')) return;
      await deleteItem(itemId);
      await renderItems();
      await renderEntries();
      await refreshStats();
    }
    if (action === 'log') {
      openEntryDialog(itemId);
    }
    if (action === 'edit') {
      const item = await getItem(itemId);
      openItemDialog(item);
    }
  });

  entriesList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action="delete-entry"]');
    if (!button) return;
    const entryId = Number(button.closest('[data-entry-id]')?.dataset.entryId);
    if (!entryId) return;
    await deleteEntry(entryId);
    await renderEntries();
    await refreshStats();
  });

  entriesList.addEventListener('change', async (event) => {
    const input = event.target.closest('input[data-entry-grams]');
    if (!input) return;
    const entryId = Number(input.dataset.entryId);
    const grams = Number(input.value);
    if (!entryId || grams < 0) return;
    await updateEntry({ id: entryId, grams });
    await renderEntries();
    await refreshStats();
  });
}

function setupInstallPrompt() {
  const installBtn = document.getElementById('install-btn');
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstall = event;
    installBtn.hidden = false;
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    deferredInstall = null;
    installBtn.hidden = true;
  });
}

async function openEntryDialog(prefillItemId) {
  const items = await getAllItems();
  if (!items.length) {
    showToast('Create an item first');
    return;
  }
  const select = entryForm.querySelector('select[name="item_id"]');
  select.innerHTML = items
    .map((item) => `<option value="${item.id}">${item.name}</option>`)
    .join('');
  if (prefillItemId) {
    select.value = String(prefillItemId);
  }
  entryForm.grams.value = '';
  entryDialog.showModal();
}

async function openItemDialog(item, options = {}) {
  resetItemForm();
  if (item) {
    itemForm.dataset.editingId = item.id;
    itemForm.dataset.createdAt = item.createdAt;
    itemForm.name.value = item.name;
    itemForm.base_grams.value = item.base_grams;
    itemForm.calories.value = item.macros.calories;
    itemForm.protein.value = item.macros.protein;
    itemForm.fat.value = item.macros.fat;
    itemForm.carbs.value = item.macros.carbs;
    itemForm.fiber.value = item.macros.fiber;
    if (item.imageData) {
      itemForm.dataset.imageData = item.imageData;
      updateImagePreview(item.imageData);
    }
    document.getElementById('item-dialog-title').textContent = 'Edit food item';
  } else {
    document.getElementById('item-dialog-title').textContent = 'Add food item';
  }
  if (options.mode === 'label') {
    document.getElementById('item-dialog-title').textContent = 'Add from nutrition label';
    itemForm.dataset.mode = 'label';
    const imageInput = itemForm.querySelector('input[name="image"]');
    imageInput?.focus();
  }
  itemDialog.showModal();
}

function resetItemForm() {
  itemForm.reset();
  delete itemForm.dataset.editingId;
  delete itemForm.dataset.createdAt;
  delete itemForm.dataset.imageData;
  delete itemForm.dataset.mode;
  updateImagePreview(null);
}

function updateImagePreview(dataUrl) {
  const figure = itemForm.querySelector('.image-preview');
  if (!dataUrl) {
    figure.hidden = true;
    figure.querySelector('img').src = '';
    return;
  }
  figure.hidden = false;
  figure.querySelector('img').src = dataUrl;
}

function parseSettingValue(name, value) {
  const numericFields = [
    'body_weight',
    'maintenance_calories',
    'caloric_adjustment',
    'protein_per_unit',
    'fat_per_unit',
    'fiber_goal'
  ];
  if (numericFields.includes(name)) {
    return value === '' ? null : Number(value);
  }
  return value;
}

async function updateSettingsState(patch, { render = false } = {}) {
  settingsState = { ...settingsState, ...patch, id: 'current' };
  await saveSettingsState();
  if (render) {
    renderSettingsForm();
  }
  await refreshStats();
}

function renderSettingsForm() {
  settingsForm.body_weight.value = valueOrEmpty(settingsState.body_weight);
  settingsForm.weight_unit.value = settingsState.weight_unit;
  settingsForm.maintenance_calories.value = valueOrEmpty(settingsState.maintenance_calories);
  settingsForm.caloric_adjustment.value = valueOrEmpty(settingsState.caloric_adjustment ?? 0);
  settingsForm.macro_ratio_unit.value = settingsState.macro_ratio_unit;
  settingsForm.protein_per_unit.value = valueOrEmpty(settingsState.protein_per_unit);
  settingsForm.fat_per_unit.value = valueOrEmpty(settingsState.fat_per_unit);
  settingsForm.fiber_goal.value = valueOrEmpty(settingsState.fiber_goal);
}

function valueOrEmpty(value) {
  return value === null || value === undefined ? '' : value;
}

function toNumber(value) {
  if (value === '' || value === null || value === undefined) return 0;
  return Number(value);
}

function perGram(macros, baseGrams) {
  const base = baseGrams || 1;
  return Object.fromEntries(
    Object.entries(macros).map(([key, val]) => [key, base ? val / base : 0])
  );
}

async function loadSettings() {
  const tx = db.transaction('settings', 'readonly');
  const request = tx.objectStore('settings').get('current');
  const stored = await requestToPromise(request);
  if (stored) {
    settingsState = { ...DEFAULT_SETTINGS, ...stored };
  } else {
    await saveSettingsState();
  }
}

async function saveSettingsState() {
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put(settingsState);
  return transactionComplete(tx);
}

async function renderItems() {
  const items = await getAllItems();
  itemsList.innerHTML = '';
  if (!items.length) {
    itemsList.innerHTML = '<p class="placeholder">No items yet.</p>';
    return;
  }
  items.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'item-card';
    card.dataset.id = item.id;
    card.innerHTML = `
      <header>
        <h3>${item.name}</h3>
        <div class="section-actions">
          <button class="ghost-btn" data-action="edit">Edit</button>
          <button class="ghost-btn" data-action="log">Log</button>
          <button class="ghost-btn" data-action="delete">Delete</button>
        </div>
      </header>
      <p>${item.macros.calories.toFixed(0)} kcal per ${item.base_grams.toFixed(0)} g</p>
      ${item.imageData ? `<img src="${item.imageData}" alt="${item.name} label" />` : ''}
      <footer>
        <span>Protein ${item.macros.protein.toFixed(1)} g</span>
        <span>Fat ${item.macros.fat.toFixed(1)} g</span>
        <span>Carbs ${item.macros.carbs.toFixed(1)} g</span>
        <span>Fiber ${item.macros.fiber.toFixed(1)} g</span>
      </footer>
    `;
    itemsList.appendChild(card);
  });
}

async function renderEntries() {
  const entries = await getEntriesWithItems();
  entriesList.innerHTML = '';
  if (!entries.length) {
    entriesList.innerHTML = '<p class="placeholder">No food items yet. Create or select an item.</p>';
    return;
  }
  entries.forEach(({ entry, item }) => {
    const totals = Object.fromEntries(
      Object.entries(item.per_gram).map(([key, per]) => [key, per * entry.grams])
    );
    const card = document.createElement('article');
    card.className = 'entry-card';
    card.dataset.entryId = entry.id;
    card.innerHTML = `
      <header>
        <h3>${item.name}</h3>
        <button class="ghost-btn" data-action="delete-entry">Remove</button>
      </header>
      <label>Grams consumed
        <input type="number" min="0" data-entry-grams data-entry-id="${entry.id}" value="${entry.grams}" />
      </label>
      <footer>
        <span>${totals.calories.toFixed(0)} kcal</span>
        <span>${totals.protein.toFixed(1)} g protein</span>
        <span>${totals.fat.toFixed(1)} g fat</span>
        <span>${totals.carbs.toFixed(1)} g carbs</span>
        <span>${totals.fiber.toFixed(1)} g fiber</span>
      </footer>
    `;
    entriesList.appendChild(card);
  });
}

async function refreshStats() {
  await pyodideReady;
  const entries = await getEntriesWithItems();
  const entryPayload = entries.map(({ entry, item }) => ({
    grams: entry.grams,
    per_gram: item.per_gram
  }));

  const settingsPayload = { ...settingsState };
  let goalsResult = pythonCall('calculate_goals', settingsPayload);
  let totalsResult = pythonCall('calculate_consumed_totals', entryPayload);
  if (!goalsResult || Object.keys(goalsResult).length === 0) {
    goalsResult = calculateGoalsFallback(settingsPayload);
  }
  if (!totalsResult || Object.keys(totalsResult).length === 0) {
    totalsResult = calculateConsumedTotalsFallback(entryPayload);
  }

  STAT_FIELDS.forEach(({ key }) => {
    const consumed = totalsResult[key] || 0;
    const goal = goalsResult[key];
    const goalText = goal && goal > 0 ? goal.toFixed(0) : '-';
    const consumedText = consumed.toFixed(goal ? 0 : 1);
    const card = statsContainer.querySelector(`[data-key="${key}"] p`);
    card.textContent = `${consumedText} / ${goalText}`;
  });
}

function pythonCall(fnName, payload) {
  const fn = pythonApi[fnName];
  if (!fn) return {};
  let pyPayload;
  try {
    pyPayload = pyodideInstance.toPy(payload);
    const pyResult = fn(pyPayload);
    const result = pyResult.toJs({ create_proxies: false });
    pyResult.destroy();
    return result;
  } catch (error) {
    console.warn('Python call failed', error);
    return {};
  } finally {
    if (pyPayload) pyPayload.destroy();
  }
}

async function bootstrapPyodide() {
  pyodideInstance = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/' });
  const response = await fetch('py/calorie_logic.py');
  const code = await response.text();
  await pyodideInstance.runPythonAsync(code);
  pythonApi.calculate_goals = pyodideInstance.globals.get('calculate_goals');
  pythonApi.calculate_consumed_totals = pyodideInstance.globals.get('calculate_consumed_totals');
}

function bootstrapOcr() {
  if (window.Tesseract) {
    ocrWorker = window.Tesseract.createWorker({
      logger: (m) => {
        if (m.status === 'recognizing text') {
          toastEl.textContent = `Scanning label… ${Math.round(m.progress * 100)}%`;
          toastEl.hidden = false;
        }
      }
    });
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('calorie-tracker', 1);
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('items')) {
        const store = database.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
        store.createIndex('createdAt', 'createdAt');
      }
      if (!database.objectStoreNames.contains('entries')) {
        const store = database.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date');
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllItems() {
  const tx = db.transaction('items', 'readonly');
  const request = tx.objectStore('items').getAll();
  const result = await requestToPromise(request);
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

async function getItem(id) {
  const tx = db.transaction('items', 'readonly');
  const request = tx.objectStore('items').get(id);
  return requestToPromise(request);
}

async function addItem(item) {
  const tx = db.transaction('items', 'readwrite');
  tx.objectStore('items').add(item);
  return transactionComplete(tx);
}

async function updateItem(item) {
  const tx = db.transaction('items', 'readwrite');
  tx.objectStore('items').put(item);
  return transactionComplete(tx);
}

async function deleteItem(id) {
  const tx = db.transaction('items', 'readwrite');
  tx.objectStore('items').delete(id);
  await transactionComplete(tx);
  await deleteEntriesByItem(id);
}

async function addEntry({ itemId, grams }) {
  const entry = {
    itemId,
    grams,
    date: todayKey(),
    createdAt: Date.now()
  };
  const tx = db.transaction('entries', 'readwrite');
  tx.objectStore('entries').add(entry);
  return transactionComplete(tx);
}

async function updateEntry({ id, grams }) {
  const tx = db.transaction('entries', 'readwrite');
  const store = tx.objectStore('entries');
  const existing = await requestToPromise(store.get(id));
  if (!existing) return;
  existing.grams = grams;
  store.put(existing);
  return transactionComplete(tx);
}

async function deleteEntry(id) {
  const tx = db.transaction('entries', 'readwrite');
  tx.objectStore('entries').delete(id);
  return transactionComplete(tx);
}

async function deleteEntriesByItem(itemId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    const request = store.openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.itemId === itemId) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getEntriesByDate(date) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readonly');
    const index = tx.objectStore('entries').index('date');
    const request = index.getAll(date);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function getEntriesWithItems() {
  const [entries, items] = await Promise.all([getEntriesByDate(todayKey()), getAllItems()]);
  const itemMap = new Map(items.map((item) => [item.id, item]));
  return entries
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((entry) => ({ entry, item: itemMap.get(entry.itemId) }))
    .filter((pair) => pair.item);
}

function todayKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2500);
}

function calculateGoalsFallback(settings) {
  const data = {
    body_weight: 0,
    weight_unit: 'lbs',
    maintenance_calories: 0,
    caloric_adjustment: 0,
    macro_ratio_unit: 'kg',
    protein_per_unit: 1.8,
    fat_per_unit: 0.6,
    fiber_goal: 25,
    ...(settings || {})
  };
  const safe = (v, d = 0) => (v === null || v === undefined || Number.isNaN(Number(v)) ? d : Number(v));
  const toKg = (value, unit) => (unit === 'lbs' ? safe(value) / 2.20462 : safe(value));
  const ratioPerKg = (value, unit) => (unit === 'lbs' ? safe(value) * 2.20462 : safe(value));

  const weightKg = toKg(data.body_weight, data.weight_unit);
  const maintenance = safe(data.maintenance_calories);
  const adjustment = safe(data.caloric_adjustment);
  const calories = Math.max(0, maintenance + adjustment);
  const protein = weightKg * ratioPerKg(data.protein_per_unit, data.macro_ratio_unit);
  const fat = weightKg * ratioPerKg(data.fat_per_unit, data.macro_ratio_unit);
  const fiber = safe(data.fiber_goal, 25);

  return { calories, protein, fat, fiber, carbs: 0 };
}

function calculateConsumedTotalsFallback(entries) {
  const totals = { calories: 0, protein: 0, fat: 0, fiber: 0, carbs: 0 };
  if (!entries) return totals;
  entries.forEach((entry) => {
    const grams = Number(entry.grams) || 0;
    if (grams <= 0) return;
    const per = entry.per_gram || {};
    Object.keys(totals).forEach((key) => {
      totals[key] += (Number(per[key]) || 0) * grams;
    });
  });
  return totals;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('service-worker.js');
    } catch (error) {
      console.warn('Service worker registration failed', error);
    }
  }
}

async function runLabelOcr(file) {
  if (!ocrWorker) {
    showToast('OCR not ready. Try again in a moment.');
    return;
  }
  toastEl.textContent = 'Scanning label…';
  toastEl.hidden = false;
  try {
    await ocrWorker.load();
    await ocrWorker.loadLanguage('eng');
    await ocrWorker.initialize('eng');
    const { data } = await ocrWorker.recognize(file);
    const parsed = parseLabelText(data?.text || '');
    autoFillItemForm(parsed);
    showToast('Label scanned');
  } catch (error) {
    console.warn('OCR failed', error);
    showToast('Could not read that label');
  } finally {
    setTimeout(() => (toastEl.hidden = true), 1500);
  }
}

function parseLabelText(text) {
  const normalized = text.toLowerCase().replace(/\|/g, 'l');
  const extract = (patterns) => {
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) return Number(match[1]);
    }
    return 0;
  };
  const serving = extract([/(\d+(?:\.\d+)?)\s*(g|grams?)/]);
  const calories = extract([/calories[^\d]*(\d+)/, /(\d+)\s*kcal/]);
  const protein = extract([/protein[^\d]*(\d+(?:\.\d+)?)/]);
  const fat = extract([/total\s*fat[^\d]*(\d+(?:\.\d+)?)/, /fat[^\d]*(\d+(?:\.\d+)?)/]);
  const carbs = extract([/total\s*carb[^\d]*(\d+(?:\.\d+)?)/, /carbohydrate[^\d]*(\d+(?:\.\d+)?)/]);
  const fiber = extract([/dietary\s*fiber[^\d]*(\d+(?:\.\d+)?)/, /fiber[^\d]*(\d+(?:\.\d+)?)/]);
  return {
    serving,
    calories,
    protein,
    fat,
    carbs,
    fiber
  };
}

function autoFillItemForm(parsed) {
  if (!parsed) return;
  if (parsed.serving) itemForm.base_grams.value = parsed.serving;
  if (parsed.calories) itemForm.calories.value = parsed.calories;
  if (parsed.protein) itemForm.protein.value = parsed.protein;
  if (parsed.fat) itemForm.fat.value = parsed.fat;
  if (parsed.carbs) itemForm.carbs.value = parsed.carbs;
  if (parsed.fiber) itemForm.fiber.value = parsed.fiber;
}
