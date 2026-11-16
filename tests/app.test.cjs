'use strict';

// The real app runs against an in-memory DOM and a retrying Firebase substitute.
// No SDK, browser, network, accounts or persisted calendar are used by these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../data.js');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const dataSource = fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const snapshot = value => ({ val: () => clone(value) });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function booking(id, start, end, extra = {}) {
    return { id, guest: 'SYNTHETIC', phone: '', notes: '', source: 'Прямая бронь', checkIn: start, checkOut: end, price: 60, ...extra };
}

function dom() {
    const elements = new Map();
    const documentListeners = new Map();
    const controls = ['bookingFields', 'confirmDeleteBtn', 'importDesktop', 'importMobile', 'depositEditor', 'paymentEditor'];
    const exports = ['exportDesktop', 'exportMobile'];
    const defaults = {
        depositStatus: 'unknown', modalDepositStatus: 'unknown',
        bookingFilter: 'all', bookingSourceFilter: 'all', bookingSort: 'arrival',
        cleaningStatus: 'unknown', inquirySource: 'unknown'
    };
    const get = id => {
        if (elements.has(id)) return elements.get(id);
        let classes = new Set(['actionError', 'deleteModalError', 'deleteModal', 'deleteModalChanged', 'dataModalStatus', 'deleteModalStatus', 'loginError', 'appContainer', 'previewBanner'].includes(id) ? ['hidden'] : []);
        let html = '';
        const listeners = new Map();
        const element = {
            id, value: defaults[id] ?? '', textContent: '', min: '', max: '', disabled: false,
            style: {}, dataset: {}, children: [], tagName: 'DIV', resetCount: 0,
            classList: {
                add: (...names) => names.forEach(name => classes.add(name)),
                remove: (...names) => names.forEach(name => classes.delete(name)),
                contains: name => classes.has(name),
                toggle(name, force) {
                    const on = force === undefined ? !classes.has(name) : Boolean(force);
                    if (on) classes.add(name); else classes.delete(name);
                    return on;
                }
            },
            addEventListener: (name, listener) => listeners.set(name, listener),
            dispatch: (name, event = {}) => listeners.get(name)?.(event),
            querySelectorAll() { return []; },
            setAttribute(name, value) { this[name] = String(value); },
            getAttribute(name) { return this[name] ?? null; },
            focus() { this.focused = true; }, scrollIntoView() {},
            appendChild(child) { this.children.push(child); },
            click() { this.clicked = true; }, remove() { this.removed = true; },
            reset() {
                this.resetCount++;
                const fields = id === 'advancePaymentForm' ? ['modalDepositStatus', 'modalDepositAmount', 'modalDepositDate']
                    : id === 'paymentForm' ? ['paymentAmount', 'paymentDate', 'paymentNote']
                    : ['guestName', 'guestPhone', 'guestNotes', 'checkIn', 'checkOut', 'price', 'depositStatus', 'depositAmount', 'depositDate',
                        'guestCount', 'arrivalTime', 'departureTime', 'cleaningStatus', 'inquirySource', 'agreedTotal'];
                fields.forEach(name => { get(name).value = defaults[name] ?? ''; });
            }
        };
        Object.defineProperty(element, 'className', { get: () => [...classes].join(' '), set: value => { classes = new Set(value.split(/\s+/).filter(Boolean)); } });
        Object.defineProperty(element, 'innerHTML', { get: () => html, set: value => { html = value; element.children = []; } });
        elements.set(id, element);
        return element;
    };
    let created = 0;
    const document = {
        body: { dataset: {}, appendChild() {} },
        getElementById: get,
        createElement: type => { const element = get(`created-${type}-${++created}`); element.tagName = type.toUpperCase(); return element; },
        querySelectorAll: selector => (selector === '[data-write]' ? controls : selector === '[data-export]' ? exports : []).map(get),
        addEventListener: (name, listener) => documentListeners.set(name, listener)
    };
    return { document, get, controls, exports, documentListeners };
}

class World {
    constructor(data = { bookings: [] }) {
        this.data = clone(data);
        this.clients = [];
        this.pending = [];
        this.heldAcknowledgments = [];
    }

    client(name, { load = true, online = true, signedIn = true } = {}) {
        const ui = dom();
        const c = {
            name, ui, connected: false, cache: null, subscriptions: { data: [], connection: [] },
            paths: [], transactions: [], authCallback: null, blob: null, timers: [], windows: [], signOutCalls: 0, uuid: 0
        };
        const kindForPath = pathName => pathName === '.info/connected' ? 'connection' : 'data';
        const refs = new Map();
        const ref = pathName => {
            c.paths.push(pathName);
            if (refs.has(pathName)) return refs.get(pathName);
            const kind = kindForPath(pathName);
            const result = {
                on: (event, callback, error) => { assert.equal(event, 'value'); c.subscriptions[kind].push({ callback, error }); },
                off: (event, callback) => { assert.equal(event, 'value'); c.subscriptions[kind] = c.subscriptions[kind].filter(item => item.callback !== callback); },
                set: () => { throw new Error('Whole-state set is forbidden'); },
                transaction: (update, completion, applyLocally) => {
                    assert.equal(applyLocally, false, 'No local success events before server confirmation');
                    assert.equal(completion, undefined);
                    let resolve, reject;
                    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
                    const op = { client: c, update, resolve, reject, retries: 1, initial: update(clone(c.cache)) };
                    c.transactions.push(op);
                    if (op.initial === undefined) resolve({ committed: false, snapshot: snapshot(c.cache) });
                    else this.pending.push(op);
                    return promise;
                }
            };
            refs.set(pathName, result);
            return result;
        };
        const auth = {
            onAuthStateChanged: callback => { c.authCallback = callback; },
            signInWithEmailAndPassword: async () => ({}),
            signOut: async () => { c.signOutCalls++; c.authenticate(null); }
        };
        const windowListeners = new Map();
        const context = {
            document: ui.document, innerWidth: 1280, Blob,
            URL: { createObjectURL: blob => { c.blob = blob; return 'blob:synthetic'; }, revokeObjectURL() {} },
            crypto: { randomUUID: () => `synthetic-${name}-${++c.uuid}` },
            confirm: () => true,
            setTimeout: callback => { c.timers.push(callback); return c.timers.length; },
            addEventListener: (event, callback) => windowListeners.set(event, callback),
            navigator: { clipboard: { writeText: async () => {} } },
            open: (...args) => c.windows.push(args),
            firebase: { initializeApp: config => assert.equal(Object.keys(config).length, 0), auth: () => auth, database: () => ({ ref }) }
        };
        context.window = context;
        c.context = vm.createContext(context);
        c.run = code => vm.runInContext(code, c.context, { timeout: 1000 });
        c.get = ui.get;
        c.authenticate = user => c.authCallback(user);
        c.connect = connected => {
            c.connected = connected;
            c.subscriptions.connection.forEach(item => item.callback(snapshot(connected)));
        };
        c.receive = value => {
            c.cache = clone(value);
            c.subscriptions.data.forEach(item => item.callback(snapshot(value)));
        };
        c.failRead = () => c.subscriptions.data.forEach(item => item.error(Object.assign(new Error('synthetic denied'), { code: 'PERMISSION_DENIED' })));
        c.fill = (start, end, price = 60, guest = 'SYNTHETIC') => {
            c.get('checkIn').value = start; c.get('checkOut').value = end;
            c.get('price').value = String(price); c.get('guestName').value = guest;
        };
        c.submit = () => c.get('bookingForm').onsubmit({ preventDefault() {} });
        c.remove = id => { c.context.openDeleteModal(id); return c.get('confirmDeleteBtn').onclick(); };
        c.setAdvance = (prefix, status, amount = '', receivedOn = '') => {
            const ids = prefix === 'modal'
                ? ['modalDepositStatus', 'modalDepositAmount', 'modalDepositDate']
                : ['depositStatus', 'depositAmount', 'depositDate'];
            [status, amount, receivedOn].forEach((value, index) => { c.get(ids[index]).value = value; });
            c.get(ids[0]).dispatch('change');
            c.get(ids[1]).dispatch('input');
            c.get(ids[2]).dispatch('input');
        };
        c.saveAdvance = () => c.get('advancePaymentForm').onsubmit({ preventDefault() {} });
        c.setPayment = (amount, receivedOn = '', note = '') => {
            c.get('paymentAmount').value = amount;
            c.get('paymentDate').value = receivedOn;
            c.get('paymentNote').value = note;
            ['paymentAmount', 'paymentDate', 'paymentNote'].forEach(id => c.get(id).dispatch('input'));
        };
        c.savePayment = () => c.get('paymentForm').onsubmit({ preventDefault() {} });
        c.edit = id => { c.context.openDeleteModal(id); c.context.editSelectedBooking(); };
        c.filter = (id, value) => { c.get(id).value = value; c.get(id).dispatch(id === 'bookingSearch' ? 'input' : 'change'); };
        c.listHTML = () => c.get('bookingList').innerHTML;
        c.currentAdvance = () => {
            const match = c.get('deleteModalInfo').innerHTML.match(/<div id="modalCurrentAdvance" class="([^"]*)">([^<]*)<\/div>/);
            assert.ok(match, 'The rendered booking card must contain its saved advance status');
            return { className: match[1], textContent: match[2] };
        };
        c.import = value => {
            const input = { value: 'selected', files: [{ size: 100, text: async () => JSON.stringify(value) }] };
            return c.context.uploadBackup(input);
        };
        c.export = async () => { c.context.downloadBackup(); return c.blob ? JSON.parse(await c.blob.text()) : null; };
        c.beforeUnload = () => {
            const event = { prevented: false, preventDefault() { this.prevented = true; } };
            windowListeners.get('beforeunload')?.(event);
            return event;
        };
        c.run(dataSource);
        c.run('const firebaseConfig = {};\n' + appSource);
        this.clients.push(c);
        if (signedIn) c.authenticate({ uid: `synthetic-user-${name}` });
        if (online) c.connect(true);
        if (load && signedIn) c.receive(this.data);
        return c;
    }

    commit(client, { holdAck = false } = {}) {
        const op = this.pending.find(item => item.client === client);
        assert.ok(op, `Expected a pending write for ${client.name}`);
        assert.equal(client.connected, true, 'A disconnected transaction waits for reconnection');
        this.pending.splice(this.pending.indexOf(op), 1);
        op.retries++;
        const next = op.update(clone(this.data));
        const result = { committed: next !== undefined, snapshot: snapshot(next === undefined ? this.data : next) };
        if (next !== undefined) {
            this.data = clone(next);
            this.clients.filter(item => item.connected).forEach(item => item.receive(this.data));
        }
        if (holdAck) this.heldAcknowledgments.push(() => op.resolve(result));
        else op.resolve(result);
        return op;
    }

    acknowledge() { assert.ok(this.heldAcknowledgments.length); this.heldAcknowledgments.shift()(); }

    reject(client) {
        const op = this.pending.find(item => item.client === client);
        assert.ok(op);
        this.pending.splice(this.pending.indexOf(op), 1);
        op.reject(Object.assign(new Error('SYNTHETIC_PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' }));
    }
}

test('initial loading blocks writes even if the connection is ready', async () => {
    const w = new World(), c = w.client('A', { load: false });
    c.fill('2027-02-01', '2027-02-03');
    await c.submit();
    assert.equal(c.transactions.length, 0);
    assert.equal(c.get('bookingFields').disabled, true);
    assert.equal(c.get('syncBanner').dataset.kind, 'loading');
    assert.equal(await c.export(), null);
});

test('read error blocks all writes and never initializes defaults', async () => {
    const w = new World(), c = w.client('A', { load: false });
    c.failRead(); c.fill('2027-02-01', '2027-02-03'); await c.submit();
    assert.equal(c.transactions.length, 0);
    assert.equal(c.get('syncBanner').dataset.kind, 'error');
    assert.deepEqual(w.data, { bookings: [] });
});

test('offline editing is blocked while the last loaded copy remains exportable', async () => {
    const record = booking('old', '2026-01-01', '2026-01-03');
    const w = new World({ bookings: [record], custom: { retained: true } }), c = w.client('A');
    c.connect(false); c.fill('2027-02-01', '2027-02-03'); await c.submit();
    assert.equal(c.transactions.length, 0);
    assert.equal(c.get('syncBanner').dataset.kind, 'offline');
    const copy = await c.export();
    assert.deepEqual(copy.bookings, [record]); assert.equal(copy.custom.retained, true);
    assert.equal(copy._scaleaExport.connected, false);
});

test('two concurrent nonoverlapping app submissions survive transaction retries', async () => {
    const w = new World(), a = w.client('A'), b = w.client('B');
    a.fill('2027-02-01', '2027-02-03'); b.fill('2027-03-01', '2027-03-03');
    const pa = a.submit(), pb = b.submit();
    assert.equal(w.pending.length, 2); assert.equal(w.data.bookings.length, 0);
    w.commit(a); w.commit(b); await Promise.all([pa, pb]);
    assert.equal(w.data.bookings.length, 2);
    assert.equal((await a.export()).bookings.length, 2);
    assert.equal((await b.export()).bookings.length, 2);
    assert.equal(a.get('checkIn').value, ''); assert.equal(b.get('checkIn').value, '');
});

test('concurrent overlapping submissions reject the second without clearing its form', async () => {
    const w = new World(), a = w.client('A'), b = w.client('B');
    a.fill('2027-02-01', '2027-02-05'); b.fill('2027-02-03', '2027-02-06');
    const pa = a.submit(), pb = b.submit();
    w.commit(a); w.commit(b); await Promise.all([pa, pb]);
    assert.equal(w.data.bookings.length, 1);
    assert.equal(b.get('checkIn').value, '2027-02-03');
    assert.match(b.get('actionError').textContent, /даты уже заняты/);
});

test('a concurrent addition and deletion modify only their intended records', async () => {
    const old = booking('old', '2026-01-01', '2026-01-03', { price: 63.25, status: 'synthetic-confirmed' });
    const keep = booking('keep', '2026-02-01', '2026-02-03');
    const w = new World({ bookings: [old, keep], prices: [50], ownerMetadata: { unchanged: true } });
    const a = w.client('A'), b = w.client('B');
    a.fill('2027-03-01', '2027-03-03'); const pa = a.submit(), pb = b.remove('old');
    w.commit(a); w.commit(b); await Promise.all([pa, pb]);
    assert.equal(w.data.bookings.length, 2);
    assert.ok(w.data.bookings.find(item => item.id === 'keep'));
    assert.ok(w.data.bookings.find(item => item.id === 'synthetic-A-1'));
    assert.deepEqual(w.data.prices, [50]); assert.deepEqual(w.data.ownerMetadata, { unchanged: true });
    assert.equal(w.data.deletedBookingIds.old, true);
});

test('import concurrent with add merges new records and preserves existing prices', async () => {
    const w = new World({ bookings: [], prices: [50] }), a = w.client('A'), b = w.client('B');
    a.fill('2027-03-01', '2027-03-03');
    const pa = a.submit(), pb = b.import({ bookings: [booking('imported', '2027-04-01', '2027-04-03')], prices: [999] });
    await flush();
    assert.equal(w.pending.length, 2);
    w.commit(a); w.commit(b); await Promise.all([pa, pb]);
    assert.equal(w.data.bookings.length, 2); assert.deepEqual(w.data.prices, [50]);
});

test('an import conflicting with a concurrent add is rejected atomically', async () => {
    const w = new World(), a = w.client('A'), b = w.client('B');
    a.fill('2027-03-01', '2027-03-04');
    const pa = a.submit(), pb = b.import({ bookings: [booking('free', '2027-04-01', '2027-04-03'), booking('conflict', '2027-03-02', '2027-03-05')] });
    await flush(); w.commit(a); w.commit(b); await Promise.all([pa, pb]);
    assert.equal(w.data.bookings.length, 1);
    assert.ok(!w.data.bookings.find(item => item.id === 'free'));
    assert.match(b.get('actionError').textContent, /даты уже заняты/);
});

test('failed save preserves all form fields and displays an error', async () => {
    const w = new World(), c = w.client('A');
    c.fill('2027-02-01', '2027-02-03', 65.25, 'SYNTHETIC RETAIN');
    c.get('guestPhone').value = 'synthetic-phone'; c.get('guestNotes').value = 'synthetic notes';
    const resetCount = c.get('bookingForm').resetCount;
    const pending = c.submit();
    assert.equal(c.get('syncBanner').dataset.kind, 'saving');
    assert.doesNotMatch(c.get('cloudStatus').className, /emerald/);
    w.reject(c); await pending;
    assert.equal(c.get('bookingForm').resetCount, resetCount);
    assert.equal(c.get('guestName').value, 'SYNTHETIC RETAIN');
    assert.equal(c.get('guestPhone').value, 'synthetic-phone');
    assert.equal(c.get('guestNotes').value, 'synthetic notes');
    assert.equal(c.get('price').value, '65.25');
    assert.equal(c.get('actionError').classList.contains('hidden'), false);
    assert.match(c.get('actionError').textContent, /не разрешил/);
    assert.equal(c.get('syncBanner').dataset.kind, 'error');
    assert.match(c.get('cloudStatus').className, /bg-rose-500/);
    assert.doesNotMatch(c.get('cloudStatus').className, /emerald/);
    assert.equal(c.get('bookingFields').disabled, false, 'A rejected save may be retried without losing the draft');
    assert.equal(w.data.bookings.length, 0);
    const retry = c.submit();
    assert.equal(c.get('syncBanner').dataset.kind, 'saving');
    w.commit(c); await retry;
    assert.equal(w.data.bookings.length, 1);
    assert.equal(w.data.bookings[0].guest, 'SYNTHETIC RETAIN');
    assert.equal(c.get('syncBanner').dataset.kind, 'ready');
    assert.match(c.get('cloudStatus').className, /bg-emerald-400/);
    assert.equal(c.get('actionError').classList.contains('hidden'), true);
    assert.equal(c.get('checkIn').value, '');
});

test('server value events alone do not turn an unacknowledged save green', async () => {
    const w = new World(), c = w.client('A');
    c.fill('2027-02-01', '2027-02-03'); const pending = c.submit();
    w.commit(c, { holdAck: true }); await flush();
    assert.equal(c.get('syncBanner').dataset.kind, 'saving');
    assert.doesNotMatch(c.get('cloudStatus').className, /emerald/);
    assert.equal(c.get('checkIn').value, '2027-02-01');
    assert.equal(c.beforeUnload().prevented, true);
    w.acknowledge(); await pending;
    assert.equal(c.get('syncBanner').dataset.kind, 'ready');
    assert.match(c.get('cloudStatus').className, /emerald/);
    assert.equal(c.get('checkIn').value, '');
    assert.equal(c.beforeUnload().prevented, false);
});

test('loss of connectivity mid-save keeps the save pending and blocks logout', async () => {
    const w = new World(), c = w.client('A');
    c.fill('2027-02-01', '2027-02-03'); const pending = c.submit();
    c.connect(false); c.context.logout(); await flush();
    assert.equal(c.signOutCalls, 0);
    assert.equal(c.get('syncBanner').dataset.kind, 'saving');
    assert.match(c.get('syncBanner').textContent, /Связь прервалась/);
    assert.equal(c.get('checkIn').value, '2027-02-01');
    c.connect(true); w.commit(c); await pending;
    assert.equal(w.data.bookings.length, 1); assert.equal(c.get('checkIn').value, '');
});

test('late acknowledgments cannot overwrite a fresher listener snapshot', async () => {
    const w = new World(), a = w.client('A'), b = w.client('B');
    a.fill('2027-02-01', '2027-02-03'); const pa = a.submit();
    w.commit(a, { holdAck: true });
    b.fill('2027-03-01', '2027-03-03'); const pb = b.submit();
    w.commit(b); await pb;
    assert.equal((await b.export()).bookings.length, 2);
    w.acknowledge(); await pa;
    assert.equal((await a.export()).bookings.length, 2);
});

test('logout detaches listeners and a previous session callback cannot restore its data', async () => {
    const w = new World({ bookings: [booking('old', '2026-01-01', '2026-01-03')] }), c = w.client('A');
    const staleCallback = c.subscriptions.data[0].callback;
    c.context.logout(); await flush();
    assert.equal(c.signOutCalls, 1); assert.equal(c.subscriptions.data.length, 0);
    assert.equal(c.get('appContainer').classList.contains('hidden'), true);
    staleCallback(snapshot(w.data));
    assert.equal(await c.export(), null);
    c.authenticate({ uid: 'synthetic-other-user' }); c.connect(true);
    assert.equal(c.get('bookingFields').disabled, true);
    c.receive({ bookings: [] });
    assert.equal((await c.export()).bookings.length, 0);
});

test('an external auth transition during save cannot reset the next session draft', async () => {
    const w = new World(), c = w.client('A');
    c.fill('2027-02-01', '2027-02-03'); const pending = c.submit();
    c.authenticate({ uid: 'synthetic-new-session' }); c.connect(true); c.receive(w.data);
    c.fill('2027-05-01', '2027-05-03', 70, 'NEW SESSION DRAFT');
    w.commit(c); await pending;
    assert.equal(c.get('guestName').value, 'NEW SESSION DRAFT');
    assert.equal(c.get('checkIn').value, '2027-05-01');
});

test('date input listeners quote exact cross-month totals in the actual form', async () => {
    const w = new World(), c = w.client('A');
    c.get('checkIn').value = '2027-06-30'; c.get('checkOut').value = '2027-07-03';
    c.get('checkIn').dispatch('change');
    assert.equal(c.get('price').value, 101.67);
    assert.equal(c.get('liveTotal').textContent, '305 €');
    const pending = c.submit(); w.commit(c); await pending;
    assert.equal(w.data.bookings[0].totalCents, 30500);
    assert.equal(w.data.bookings[0].nightlyRates[0].cents, 8500);
    assert.equal(w.data.bookings[0].nightlyRates[1].cents, 11000);
});

test('manual price input invalidates the automatic quote', async () => {
    const w = new World(), c = w.client('A');
    c.get('checkIn').value = '2027-06-30'; c.get('checkOut').value = '2027-07-03'; c.get('checkIn').dispatch('change');
    c.get('price').value = '99.99'; c.get('price').dispatch('input');
    assert.equal(c.get('liveTotal').textContent, '299,97 €');
    const pending = c.submit(); w.commit(c); await pending;
    assert.equal(w.data.bookings[0].totalCents, 29997);
    assert.ok(w.data.bookings[0].nightlyRates.every(rate => rate.cents === 9999));
});

test('an unpriced year cannot accidentally reuse the 2027 table', () => {
    const w = new World(), c = w.client('A');
    c.get('checkIn').value = '2027-12-31'; c.get('checkOut').value = '2028-01-03'; c.get('checkIn').dispatch('change');
    assert.equal(c.get('price').value, '0');
    assert.match(c.get('quoteHint').textContent, /только для ночей 2027/);
    assert.equal(c.get('liveTotal').textContent, '0 €');
});

test('old bookings open with an unknown advance payment without writing or inventing debt', async () => {
    const old = booking('old', '2026-01-01', '2026-01-05', { price: 63.25 });
    const w = new World({ bookings: [old] }), c = w.client('A');
    assert.equal(c.get('depositStatus').value, 'unknown');
    assert.equal(c.get('depositAmount').value, '');
    assert.equal(c.get('depositDate').value, '');
    c.context.openDeleteModal('old');
    assert.equal(c.get('modalDepositStatus').value, 'unknown');
    assert.equal(c.get('modalDepositAmount').value, '');
    assert.equal(c.get('modalDepositDate').value, '');
    assert.match(c.get('modalDepositSummary').textContent, /остаток пока неизвестен/i);
    assert.equal(c.transactions.length, 0);
    const saved = (await c.export()).bookings[0];
    assert.deepEqual(saved, old);
    assert.equal(D.getAdvancePayment(saved).remainingCents, null);
});

test('new received advance is included in the accommodation total and resets only after acknowledgment', async () => {
    const w = new World(), c = w.client('A');
    const receivedOn = D.todayStr();
    c.fill('2027-02-01', '2027-02-06', 60);
    c.setAdvance('new', 'received', '150', receivedOn);
    assert.match(c.get('depositSummary').textContent, /Остаток[^:]*: 150 €/);
    const pending = c.submit();
    assert.equal(c.get('depositStatus').value, 'received');
    assert.equal(c.get('depositAmount').value, '150');
    w.commit(c, { holdAck: true }); await flush();
    assert.equal(c.get('depositAmount').value, '150');
    w.acknowledge(); await pending;
    const saved = w.data.bookings[0];
    assert.equal(saved.totalCents, 30000);
    assert.deepEqual(saved.advancePayment, { status: 'received', amountCents: 15000, receivedOn });
    assert.equal(D.getAdvancePayment(saved).remainingCents, 15000);
    assert.equal(c.get('depositStatus').value, 'unknown');
    assert.equal(c.get('depositAmount').value, '');
    assert.equal(c.get('depositDate').value, '');
});

test('new unknown and not-received advance statuses stay distinct', async () => {
    const w = new World(), c = w.client('A');
    c.fill('2027-02-01', '2027-02-06', 60);
    const first = c.submit(); w.commit(c); await first;
    assert.equal(D.getAdvancePayment(w.data.bookings[0]).status, 'unknown');
    assert.equal(D.getAdvancePayment(w.data.bookings[0]).remainingCents, null);
    c.fill('2027-03-01', '2027-03-06', 60);
    c.setAdvance('new', 'not_received');
    const second = c.submit(); w.commit(c); await second;
    assert.equal(D.getAdvancePayment(w.data.bookings[1]).status, 'not_received');
    assert.equal(D.getAdvancePayment(w.data.bookings[1]).remainingCents, 30000);
});

test('received without a known amount does not invent a zero amount or remaining balance', async () => {
    const w = new World(), c = w.client('A');
    c.fill('2027-02-01', '2027-02-06', 60);
    c.setAdvance('new', 'received');
    const pending = c.submit(); w.commit(c); await pending;
    assert.deepEqual(w.data.bookings[0].advancePayment, { status: 'received' });
    const value = D.getAdvancePayment(w.data.bookings[0]);
    assert.equal(value.amountCents, null); assert.equal(value.remainingCents, null);
});

test('advance editor updates a historical booking without changing its agreed price or total', async () => {
    const old = booking('old', '2026-01-01', '2026-01-05', { price: 63.25, status: 'historical-confirmed', custom: { retained: true } });
    const w = new World({ bookings: [old], ownerMetadata: { preserved: true } }), c = w.client('A');
    c.context.openDeleteModal('old');
    c.setAdvance('modal', 'received', '100', D.todayStr());
    const pending = c.saveAdvance(); w.commit(c); await pending;
    const saved = w.data.bookings[0];
    const { advancePayment, ...otherFields } = saved;
    assert.deepEqual(otherFields, old);
    assert.equal(saved.price, 63.25);
    assert.equal(D.getBookingTotalCents(saved), 25300);
    assert.equal(D.getAdvancePayment(saved).remainingCents, 15300);
    assert.deepEqual(w.data.ownerMetadata, { preserved: true });
    assert.equal(c.get('modalDepositStatus').value, 'received');
    assert.equal(Number(c.get('modalDepositAmount').value), 100);
    assert.equal(c.get('modalDepositDate').value, D.todayStr());
    assert.match(c.get('modalDepositSummary').textContent, /Остаток[^:]*: 153 €/);
});

test('two stale advance edits conflict instead of silently overwriting the first phone', async () => {
    const old = booking('old', '2027-02-01', '2027-02-06');
    const w = new World({ bookings: [old] }), a = w.client('A'), b = w.client('B');
    a.context.openDeleteModal('old'); b.context.openDeleteModal('old');
    a.setAdvance('modal', 'received', '100'); b.setAdvance('modal', 'received', '150');
    const first = a.saveAdvance(), second = b.saveAdvance();
    w.commit(a); w.commit(b); await Promise.all([first, second]);
    assert.equal(w.data.bookings[0].advancePayment.amountCents, 10000);
    assert.equal(b.get('modalDepositAmount').value, '150');
    assert.equal(b.get('syncBanner').dataset.kind, 'error');
    assert.equal(b.get('deleteModalError').classList.contains('hidden'), false);
    assert.match(b.get('deleteModalError').textContent, /другом|измен|заново/);
});

test('an untouched open card refreshes its payment fields from the other phone', async () => {
    const old = booking('old', '2027-02-01', '2027-02-06');
    const w = new World({ bookings: [old] }), a = w.client('A'), b = w.client('B');
    a.context.openDeleteModal('old'); b.context.openDeleteModal('old');
    assert.equal(b.get('modalDepositStatus').value, 'unknown');
    a.setAdvance('modal', 'received', '100', D.todayStr());
    const first = a.saveAdvance(); w.commit(a); await first;
    assert.equal(b.get('modalDepositStatus').value, 'received');
    assert.equal(Number(b.get('modalDepositAmount').value), 100);
    assert.equal(b.get('modalDepositDate').value, D.todayStr());
    assert.match(b.get('modalDepositSummary').textContent, /Остаток[^:]*: 200 €/);
    assert.equal(b.get('deleteModalChanged').classList.contains('hidden'), true);
    assert.equal(b.transactions.length, 0, 'Refreshing an open card must remain read-only');
    // A subsequent edit must compare against the refreshed payment, not the old
    // unknown status that the card had when it first opened.
    b.setAdvance('modal', 'received', '150');
    const second = b.saveAdvance(); w.commit(b); await second;
    assert.equal(w.data.bookings[0].advancePayment.amountCents, 15000);
    assert.equal(b.get('syncBanner').dataset.kind, 'ready');
});

test('an edited open card keeps its draft, shows the new server payment and rejects a stale save', async () => {
    const old = booking('old', '2027-02-01', '2027-02-06');
    const w = new World({ bookings: [old] }), a = w.client('A'), b = w.client('B');
    a.context.openDeleteModal('old'); b.context.openDeleteModal('old');
    b.setAdvance('modal', 'received', '150', D.todayStr());
    a.setAdvance('modal', 'received', '100');
    const first = a.saveAdvance(); w.commit(a); await first;
    assert.equal(b.get('modalDepositStatus').value, 'received');
    assert.equal(b.get('modalDepositAmount').value, '150');
    assert.equal(b.get('modalDepositDate').value, D.todayStr());
    assert.match(b.get('modalDepositSummary').textContent, /Остаток[^:]*: 150 €/);
    assert.match(b.currentAdvance().textContent, /Залог получен · 100 €/);
    assert.equal(b.get('deleteModalChanged').classList.contains('hidden'), false);
    await b.saveAdvance();
    assert.equal(w.data.bookings[0].advancePayment.amountCents, 10000);
    assert.equal(b.get('modalDepositAmount').value, '150');
    assert.equal(b.get('syncBanner').dataset.kind, 'error');
    assert.equal(b.get('deleteModalError').classList.contains('hidden'), false);
    assert.match(b.get('deleteModalError').textContent, /другом|измен|заново/);
    assert.equal(w.pending.length, 0);
});

test('a dirty card follows a remote payment change back to its original unknown status', async () => {
    const old = booking('old', '2027-02-01', '2027-02-06', { advancePayment: { status: 'unknown' } });
    const w = new World({ bookings: [old] }), a = w.client('A'), b = w.client('B');
    a.context.openDeleteModal('old'); b.context.openDeleteModal('old');
    b.setAdvance('modal', 'received', '150', D.todayStr());
    a.setAdvance('modal', 'received', '100');
    const received = a.saveAdvance(); w.commit(a); await received;
    assert.match(b.currentAdvance().textContent, /Залог получен · 100 €/);
    assert.match(b.currentAdvance().className, /bg-emerald-50/);
    assert.equal(b.get('deleteModalChanged').classList.contains('hidden'), false);
    a.setAdvance('modal', 'unknown');
    const unknown = a.saveAdvance(); w.commit(a); await unknown;
    assert.equal(b.currentAdvance().textContent, 'Залог: не отмечено');
    assert.match(b.currentAdvance().className, /bg-slate-50/);
    assert.doesNotMatch(b.currentAdvance().className, /emerald/);
    assert.equal(b.get('deleteModalChanged').classList.contains('hidden'), true);
    assert.equal(b.get('modalDepositStatus').value, 'received');
    assert.equal(b.get('modalDepositAmount').value, '150');
    assert.equal(b.get('modalDepositDate').value, D.todayStr());
    assert.match(b.get('modalDepositSummary').textContent, /Остаток[^:]*: 150 €/);
    assert.equal(b.transactions.length, 0);
});

test('a rejected pending advance edit refreshes the saved badge from the latest listener without losing the draft', async () => {
    const old = booking('old', '2027-02-01', '2027-02-06', { advancePayment: { status: 'unknown' } });
    const w = new World({ bookings: [old] }), a = w.client('A'), b = w.client('B');
    a.context.openDeleteModal('old'); b.context.openDeleteModal('old');
    b.setAdvance('modal', 'received', '150', D.todayStr());
    const pendingB = b.saveAdvance();
    a.setAdvance('modal', 'received', '100');
    const pendingA = a.saveAdvance(); w.commit(a); await pendingA;
    assert.equal(b.get('syncBanner').dataset.kind, 'saving');
    assert.equal(b.get('modalDepositAmount').value, '150');
    w.reject(b); await pendingB;
    assert.equal(w.data.bookings[0].advancePayment.amountCents, 10000);
    assert.match(b.currentAdvance().textContent, /Залог получен · 100 €/);
    assert.match(b.currentAdvance().className, /bg-emerald-50/);
    assert.equal(b.get('deleteModalChanged').classList.contains('hidden'), false);
    assert.equal(b.get('modalDepositStatus').value, 'received');
    assert.equal(b.get('modalDepositAmount').value, '150');
    assert.equal(b.get('modalDepositDate').value, D.todayStr());
    assert.equal(b.get('syncBanner').dataset.kind, 'error');
    assert.equal(b.get('deleteModalError').classList.contains('hidden'), false);
});

test('deletion on the other phone closes an untouched card and reports the missing booking', async () => {
    const old = booking('old', '2027-02-01', '2027-02-06');
    const w = new World({ bookings: [old] }), a = w.client('A'), b = w.client('B');
    b.context.openDeleteModal('old');
    assert.equal(b.get('deleteModal').classList.contains('hidden'), false);
    const deletion = a.remove('old'); w.commit(a); await deletion;
    assert.equal(b.get('deleteModal').classList.contains('hidden'), true);
    assert.equal(b.get('actionError').classList.contains('hidden'), false);
    assert.match(b.get('actionError').textContent, /брони уже нет|удалили с другого телефона/i);
    assert.equal(w.data.bookings.length, 0);
    const writesBefore = b.transactions.length;
    await b.saveAdvance();
    assert.equal(b.transactions.length, writesBefore, 'A closed deleted record cannot be edited by a stale handler');
});

test('a rejected advance edit keeps the modal fields and permits a successful retry', async () => {
    const old = booking('old', '2027-02-01', '2027-02-06');
    const w = new World({ bookings: [old] }), c = w.client('A');
    c.context.openDeleteModal('old'); c.setAdvance('modal', 'received', '150', D.todayStr());
    const pending = c.saveAdvance(); w.reject(c); await pending;
    assert.equal(c.get('modalDepositStatus').value, 'received');
    assert.equal(c.get('modalDepositAmount').value, '150');
    assert.equal(c.get('modalDepositDate').value, D.todayStr());
    assert.equal(c.get('depositEditor').disabled, false);
    assert.equal(c.get('syncBanner').dataset.kind, 'error');
    assert.equal(c.get('deleteModalError').classList.contains('hidden'), false);
    assert.deepEqual(w.data.bookings[0], old);
    const retry = c.saveAdvance(); w.commit(c); await retry;
    assert.equal(w.data.bookings[0].advancePayment.amountCents, 15000);
    assert.equal(c.get('syncBanner').dataset.kind, 'ready');
    assert.equal(c.get('deleteModalError').classList.contains('hidden'), true);
});

test('offline advance editor cannot submit a change', async () => {
    const old = booking('old', '2027-02-01', '2027-02-06');
    const w = new World({ bookings: [old] }), c = w.client('A');
    c.context.openDeleteModal('old'); c.connect(false);
    assert.equal(c.get('depositEditor').disabled, true);
    c.setAdvance('modal', 'received', '100'); await c.saveAdvance();
    assert.equal(c.transactions.length, 0);
    assert.deepEqual(w.data.bookings[0], old);
});

test('imported historical advance is unknown and is not interpreted as unpaid accommodation', async () => {
    const old = booking('imported', '2026-01-01', '2026-01-05', { price: 63.25 });
    const w = new World(), c = w.client('A');
    const pending = c.import({ bookings: [old] }); await flush(); w.commit(c); await pending;
    const saved = (await c.export()).bookings[0];
    assert.deepEqual(saved, old);
    assert.equal(D.getAdvancePayment(saved).status, 'unknown');
    assert.equal(D.getAdvancePayment(saved).remainingCents, null);
    c.context.openDeleteModal('imported');
    assert.equal(c.get('modalDepositStatus').value, 'unknown');
    assert.equal(c.get('modalDepositAmount').value, '');
});

test('invalid advance amount is rejected by the form before a transaction is requested', async () => {
    const old = booking('old', '2027-02-01', '2027-02-06');
    const w = new World({ bookings: [old] }), c = w.client('A');
    c.context.openDeleteModal('old'); c.setAdvance('modal', 'received', '301');
    await c.saveAdvance();
    assert.equal(c.transactions.length, 0);
    assert.equal(c.get('deleteModalError').classList.contains('hidden'), false);
    assert.equal(c.get('modalDepositAmount').value, '301');
    assert.deepEqual(w.data.bookings[0], old);
});

test('a booking continuing into the first day of a month keeps its name and a separate visible payment marker', () => {
    const continuing = booking('continuing', '2027-01-30', '2027-02-03', {
        guest: 'SYNTHETIC CONTINUING', advancePayment: { status: 'received', amountCents: 10000 }
    });
    const w = new World({ bookings: [continuing] }), c = w.client('A');
    c.get('checkIn').value = '2027-02-01'; c.get('checkOut').value = '2027-02-02';
    c.get('checkIn').dispatch('change');
    assert.equal(c.get('displayMonth').textContent, 'Февраль');
    const firstDay = c.get('calendarGrid').children.find(cell => />1<\/div>/.test(cell.innerHTML));
    assert.ok(firstDay, 'The first day of the displayed month must exist');
    const bar = firstDay.children.find(child => child.classList.contains('booking-visible-continuation'));
    assert.ok(bar, 'A stay which began in the previous month must have a labelled continuation');
    assert.match(bar.innerHTML, /SYNTHETIC CONTINUING/);
    assert.match(bar.innerHTML, /<span class="shrink-0 pl-1"[^>]*>✓<\/span><span class="truncate px-1">/);
    assert.match(bar.title, /Залог получен · 100 €/);
    assert.equal(c.transactions.length, 0);
});

test('booking list search, payment filters, sources and ordering are read-only', () => {
    const records = [
        booking('first', '2027-01-04', '2027-01-06', { guest: 'Zulu guest', inquirySource: 'website', advancePayment: { status: 'not_received' } }),
        booking('second', '2027-01-07', '2027-01-12', { guest: 'Alpha guest', inquirySource: 'social', advancePayment: { status: 'received', amountCents: 6000 } }),
        booking('third', '2027-01-13', '2027-01-16', { guest: 'Mike guest', inquirySource: 'referral', advancePayment: { status: 'received', amountCents: 18000 } }),
        booking('legacy', '2027-01-17', '2027-01-21', { guest: 'Unknown guest' })
    ];
    const w = new World({ bookings: records }), c = w.client('A');
    const contains = name => assert.match(c.listHTML(), new RegExp(name));
    const excludes = name => assert.doesNotMatch(c.listHTML(), new RegExp(name));
    const ordered = names => {
        const positions = names.map(name => c.listHTML().indexOf(name));
        positions.forEach(position => assert.ok(position >= 0));
        positions.slice(1).forEach((position, index) => assert.ok(position > positions[index], `${names.join(' → ')} must be ordered`));
    };
    ordered(['Zulu guest', 'Alpha guest', 'Mike guest', 'Unknown guest']);
    c.filter('bookingSearch', 'aLpHa'); contains('Alpha guest'); excludes('Zulu guest'); excludes('Mike guest');
    c.filter('bookingSearch', '');
    c.filter('bookingFilter', 'deposit'); contains('Zulu guest'); excludes('Alpha guest'); excludes('Unknown guest');
    c.filter('bookingFilter', 'balance'); contains('Zulu guest'); contains('Alpha guest'); excludes('Mike guest'); excludes('Unknown guest');
    c.filter('bookingFilter', 'paid'); contains('Mike guest'); excludes('Zulu guest'); excludes('Unknown guest');
    c.filter('bookingFilter', 'unknown'); contains('Unknown guest'); excludes('Zulu guest'); excludes('Alpha guest');
    c.filter('bookingFilter', 'all'); c.filter('bookingSourceFilter', 'website'); contains('Zulu guest'); excludes('Alpha guest');
    c.filter('bookingSourceFilter', 'unknown'); contains('Unknown guest'); excludes('Zulu guest');
    c.filter('bookingSourceFilter', 'all'); c.filter('bookingSort', 'balance'); ordered(['Alpha guest', 'Zulu guest']);
    c.filter('bookingSort', 'total'); ordered(['Alpha guest', 'Unknown guest', 'Mike guest', 'Zulu guest']);
    c.filter('bookingSort', 'guest'); ordered(['Alpha guest', 'Mike guest', 'Unknown guest', 'Zulu guest']);
    assert.equal(c.transactions.length, 0);
    assert.deepEqual(w.data.bookings, records);
});

test('upcoming filter separates future arrivals from past stays using calendar dates', () => {
    const today = D.todayStr();
    const records = [
        booking('past', D.addDays(today, -5), D.addDays(today, -3), { guest: 'PAST GUEST' }),
        booking('soon', D.addDays(today, 2), D.addDays(today, 4), { guest: 'SOON GUEST' }),
        booking('later', D.addDays(today, 8), D.addDays(today, 10), { guest: 'LATER GUEST' })
    ];
    const w = new World({ bookings: records }), c = w.client('A');
    c.filter('bookingFilter', 'upcoming');
    assert.doesNotMatch(c.listHTML(), /PAST GUEST/);
    assert.match(c.listHTML(), /SOON GUEST/); assert.match(c.listHTML(), /LATER GUEST/);
    assert.ok(c.listHTML().indexOf('SOON GUEST') < c.listHTML().indexOf('LATER GUEST'));
    assert.equal(c.transactions.length, 0);
});

test('editing dates preserves the agreed total until the explicit recalculation action', async () => {
    const old = booking('edit', '2027-02-01', '2027-02-06', { advancePayment: { status: 'not_received' }, custom: { retained: true } });
    const w = new World({ bookings: [old] }), c = w.client('A');
    c.edit('edit');
    assert.equal(Number(c.get('agreedTotal').value), 300);
    c.get('checkOut').value = '2027-02-07'; c.get('checkOut').dispatch('change');
    c.get('guestName').value = 'EDITED GUEST'; c.get('guestNotes').value = 'EDITED NOTE';
    assert.equal(Number(c.get('agreedTotal').value), 300);
    const first = c.submit(); w.commit(c); await first;
    assert.equal(w.data.bookings.length, 1);
    assert.equal(w.data.bookings[0].checkOut, '2027-02-07');
    assert.equal(D.getBookingTotalCents(w.data.bookings[0]), 30000);
    assert.equal(w.data.bookings[0].guest, 'EDITED GUEST');
    assert.deepEqual(w.data.bookings[0].custom, { retained: true });
    c.edit('edit'); c.get('recalculateBooking').onclick();
    assert.equal(Number(c.get('agreedTotal').value), 360);
    const second = c.submit(); w.commit(c); await second;
    assert.equal(D.getBookingTotalCents(w.data.bookings[0]), 36000);
});

test('a conflicting date edit is rejected without clearing the draft and can be cancelled', async () => {
    const old = booking('edit', '2027-02-01', '2027-02-03', { advancePayment: { status: 'not_received' } });
    const occupied = booking('occupied', '2027-02-05', '2027-02-07');
    const w = new World({ bookings: [old, occupied] }), c = w.client('A');
    c.edit('edit'); c.get('checkOut').value = '2027-02-06'; c.get('checkOut').dispatch('change');
    c.get('guestName').value = 'PRESERVED EDIT'; c.get('guestNotes').value = 'PRESERVED NOTE';
    await c.submit();
    assert.deepEqual(w.data.bookings, [old, occupied]);
    assert.equal(c.get('checkOut').value, '2027-02-06');
    assert.equal(c.get('guestName').value, 'PRESERVED EDIT');
    assert.equal(c.get('guestNotes').value, 'PRESERVED NOTE');
    assert.equal(c.get('actionError').classList.contains('hidden'), false);
    assert.match(c.get('actionError').textContent, /занят/);
    const attempts = c.transactions.length;
    c.context.cancelBookingEdit();
    assert.equal(c.get('guestName').value, ''); assert.equal(c.get('checkIn').value, '');
    assert.equal(c.transactions.length, attempts);
});

test('optional stay details survive creation, editing and export', async () => {
    const w = new World(), c = w.client('A');
    c.fill('2027-03-01', '2027-03-05', 60, 'DETAIL GUEST');
    const fields = { guestCount: '4', arrivalTime: '15:30', departureTime: '10:00', cleaningStatus: 'scheduled', inquirySource: 'social' };
    for (const [id, value] of Object.entries(fields)) c.get(id).value = value;
    const first = c.submit(); w.commit(c); await first;
    const record = w.data.bookings[0];
    assert.equal(record.guestCount, 4);
    for (const id of ['arrivalTime', 'departureTime', 'cleaningStatus', 'inquirySource']) assert.equal(record[id], fields[id]);
    c.edit(record.id);
    assert.equal(Number(c.get('guestCount').value), 4);
    for (const id of ['arrivalTime', 'departureTime', 'cleaningStatus', 'inquirySource']) assert.equal(c.get(id).value, fields[id]);
    c.get('cleaningStatus').value = 'ready';
    const second = c.submit(); w.commit(c); await second;
    const exported = (await c.export()).bookings[0];
    assert.equal(exported.cleaningStatus, 'ready'); assert.equal(exported.inquirySource, 'social');
    assert.equal(exported.guestCount, 4); assert.equal(exported.arrivalTime, '15:30'); assert.equal(exported.departureTime, '10:00');
});

test('a detail edit and a payment on two phones preserve both changes in either commit order', async () => {
    for (const order of ['edit-first', 'payment-first']) {
        const old = booking('edit', '2027-02-01', '2027-02-06', { advancePayment: { status: 'not_received' }, custom: { retained: true } });
        const w = new World({ bookings: [old] }), a = w.client('A'), b = w.client('B');
        a.edit('edit'); a.get('guestName').value = 'EDITED CONCURRENT'; a.get('guestNotes').value = 'DETAILS RETAINED';
        b.context.openDeleteModal('edit'); b.setPayment('100', D.todayStr(), 'SYNTHETIC PAYMENT');
        const edit = a.submit(), payment = b.savePayment();
        assert.equal(w.pending.length, 2);
        if (order === 'edit-first') { w.commit(a); w.commit(b); } else { w.commit(b); w.commit(a); }
        await Promise.all([edit, payment]);
        const saved = w.data.bookings[0], summary = D.getPaymentSummary(saved);
        assert.equal(saved.guest, 'EDITED CONCURRENT'); assert.equal(saved.notes, 'DETAILS RETAINED');
        assert.equal(D.getBookingTotalCents(saved), 30000);
        assert.equal(summary.receivedCents, 10000); assert.equal(summary.remainingCents, 20000);
        assert.equal(summary.entries.length, 1); assert.equal(summary.entries[0].note, 'SYNTHETIC PAYMENT');
        assert.deepEqual(saved.custom, { retained: true });
    }
});

test('an open edit can lower the total after another phone removes a payment without restoring it', async () => {
    const old = booking('edit', '2027-02-01', '2027-02-06', {
        advancePayment: { status: 'received', amountCents: 10000 },
        paymentEntries: { removed: { id: 'removed', amountCents: 10000, note: 'CORRECTION' } },
        custom: { retained: true }
    });
    const w = new World({ bookings: [old] }), a = w.client('A'), b = w.client('B');
    b.edit('edit'); b.get('guestName').value = 'PRESERVED EDIT DRAFT';
    a.context.openDeleteModal('edit');
    const removal = a.context.removeBookingPayment('removed'); w.commit(a); await removal;
    assert.equal(b.get('guestName').value, 'PRESERVED EDIT DRAFT');
    assert.equal(D.getPaymentSummary(w.data.bookings[0]).receivedCents, 10000);
    b.get('agreedTotal').value = '150'; b.get('agreedTotal').dispatch('input');
    assert.equal(b.get('liveTotal').textContent, D.formatMoney(15000));
    const edit = b.submit();
    assert.equal(w.pending.length, 1, 'The latest smaller received total permits the edit');
    w.commit(b); await edit;
    const saved = w.data.bookings[0], summary = D.getPaymentSummary(saved);
    assert.equal(saved.guest, 'PRESERVED EDIT DRAFT');
    assert.equal(D.getBookingTotalCents(saved), 15000);
    assert.deepEqual(saved.advancePayment, old.advancePayment);
    assert.deepEqual(saved.paymentEntries, {});
    assert.equal(saved.deletedPaymentIds.removed, true);
    assert.equal(summary.receivedCents, 10000); assert.equal(summary.remainingCents, 5000);
    assert.deepEqual(saved.custom, old.custom);
});

test('lowering the total respects a new payment before submission and during transaction retry', async () => {
    for (const order of ['payment-before-submit', 'payment-during-save']) {
        const old = booking('edit', '2027-02-01', '2027-02-06', { advancePayment: { status: 'received', amountCents: 10000 } });
        const w = new World({ bookings: [old] }), a = w.client('A'), b = w.client('B');
        b.edit('edit'); b.get('guestName').value = 'KEEP LOWER-TOTAL DRAFT';
        b.get('agreedTotal').value = '150'; b.get('agreedTotal').dispatch('input');
        a.context.openDeleteModal('edit'); a.setPayment('100', '', 'NEW PAYMENT');
        const payment = a.savePayment();
        let edit;
        if (order === 'payment-during-save') edit = b.submit();
        w.commit(a); await payment;
        if (order === 'payment-before-submit') {
            await b.submit();
            assert.equal(b.transactions.length, 0, 'A known excessive decrease is blocked before writing');
        } else {
            w.commit(b); await edit;
            assert.equal(b.transactions.length, 1, 'The transaction retry rechecks newer receipts');
        }
        assert.equal(D.getBookingTotalCents(w.data.bookings[0]), 30000);
        assert.equal(D.getPaymentSummary(w.data.bookings[0]).receivedCents, 20000);
        assert.equal(w.data.bookings[0].guest, old.guest);
        assert.equal(b.get('agreedTotal').value, '150');
        assert.equal(b.get('guestName').value, 'KEEP LOWER-TOTAL DRAFT');
        assert.equal(b.get('actionError').classList.contains('hidden'), false);
        assert.match(b.get('actionError').textContent, /оплаты.*превышать/i);
        b.get('agreedTotal').value = '250'; b.get('agreedTotal').dispatch('input');
        const retry = b.submit(); w.commit(b); await retry;
        const saved = w.data.bookings[0], summary = D.getPaymentSummary(saved);
        assert.equal(saved.guest, 'KEEP LOWER-TOTAL DRAFT');
        assert.equal(D.getBookingTotalCents(saved), 25000);
        assert.equal(summary.receivedCents, 20000); assert.equal(summary.remainingCents, 5000);
        assert.equal(summary.entries.length, 1); assert.equal(summary.entries[0].note, 'NEW PAYMENT');
    }
});

test('final payment is bounded by the balance, waits for ACK and marks the booking fully paid', async () => {
    const old = booking('payment', '2027-02-01', '2027-02-06', { guest: 'FINAL PAYMENT GUEST', advancePayment: { status: 'received', amountCents: 15000 } });
    const w = new World({ bookings: [old] }), c = w.client('A');
    c.context.openDeleteModal('payment'); c.setPayment('151'); await c.savePayment();
    assert.equal(c.transactions.length, 0);
    assert.equal(c.get('paymentAmount').value, '151');
    assert.equal(c.get('deleteModalError').classList.contains('hidden'), false);
    c.setPayment('150', D.todayStr(), 'FINAL SYNTHETIC PAYMENT');
    const pending = c.savePayment(); w.commit(c, { holdAck: true }); await flush();
    assert.equal(c.get('paymentAmount').value, '150');
    assert.equal(c.get('paymentNote').value, 'FINAL SYNTHETIC PAYMENT');
    assert.equal(c.get('syncBanner').dataset.kind, 'saving');
    w.acknowledge(); await pending;
    const summary = D.getPaymentSummary(w.data.bookings[0]);
    assert.equal(summary.receivedCents, 30000); assert.equal(summary.remainingCents, 0); assert.equal(summary.fullyPaid, true);
    assert.equal(c.get('paymentAmount').value, ''); assert.equal(c.get('paymentNote').value, '');
    c.filter('bookingFilter', 'paid'); assert.match(c.listHTML(), /FINAL PAYMENT GUEST/);
});

test('a rejected payment retains amount, date and note for a successful retry', async () => {
    const old = booking('payment', '2027-02-01', '2027-02-06', { advancePayment: { status: 'not_received' } });
    const w = new World({ bookings: [old] }), c = w.client('A');
    c.context.openDeleteModal('payment'); c.setPayment('50', D.todayStr(), 'KEEP PAYMENT NOTE');
    const first = c.savePayment(); w.reject(c); await first;
    assert.equal(c.get('paymentAmount').value, '50');
    assert.equal(c.get('paymentDate').value, D.todayStr());
    assert.equal(c.get('paymentNote').value, 'KEEP PAYMENT NOTE');
    assert.equal(c.get('syncBanner').dataset.kind, 'error');
    assert.equal(c.get('paymentEditor').disabled, false);
    assert.deepEqual(w.data.bookings[0], old);
    const retry = c.savePayment(); w.commit(c); await retry;
    const summary = D.getPaymentSummary(w.data.bookings[0]);
    assert.equal(summary.entries.length, 1); assert.equal(summary.receivedCents, 5000);
    assert.equal(c.get('paymentAmount').value, ''); assert.equal(c.get('paymentDate').value, ''); assert.equal(c.get('paymentNote').value, '');
});

test('removing one ledger payment preserves the deposit and all other payments', async () => {
    const old = booking('payment', '2027-02-01', '2027-02-06', { advancePayment: { status: 'received', amountCents: 10000 } });
    let seed = { bookings: [old] };
    seed = D.reduceOperation(seed, { type: 'addPayment', id: old.id, payment: D.buildPayment({ id: 'first-payment', amount: '50', note: 'REMOVE THIS' }, seed.bookings[0]) });
    seed = D.reduceOperation(seed, { type: 'addPayment', id: old.id, payment: D.buildPayment({ id: 'second-payment', amount: '25', note: 'KEEP THIS' }, seed.bookings[0]) });
    const w = new World(seed), c = w.client('A');
    c.context.openDeleteModal('payment');
    const removal = c.context.removeBookingPayment('first-payment'); w.commit(c); await removal;
    const saved = w.data.bookings[0], summary = D.getPaymentSummary(saved);
    assert.deepEqual(saved.advancePayment, old.advancePayment);
    assert.equal(summary.entries.length, 1); assert.equal(summary.entries[0].id, 'second-payment'); assert.equal(summary.entries[0].note, 'KEEP THIS');
    assert.equal(saved.deletedPaymentIds['first-payment'], true);
    assert.equal(summary.receivedCents, 12500); assert.equal(summary.remainingCents, 17500);
    assert.equal(D.getBookingTotalCents(saved), 30000);
});

test('payment editor blocks offline writes and preserves a pending draft across reconnection', async () => {
    const old = booking('payment', '2027-02-01', '2027-02-06', { advancePayment: { status: 'not_received' } });
    const w = new World({ bookings: [old] }), c = w.client('A');
    c.context.openDeleteModal('payment'); c.setPayment('70', '', 'OFFLINE DRAFT');
    c.connect(false); assert.equal(c.get('paymentEditor').disabled, true);
    await c.savePayment(); assert.equal(c.transactions.length, 0);
    c.connect(true); assert.equal(c.get('paymentEditor').disabled, false);
    const pending = c.savePayment(); c.connect(false); await flush();
    assert.equal(c.get('paymentAmount').value, '70'); assert.equal(c.get('paymentNote').value, 'OFFLINE DRAFT');
    assert.equal(c.get('syncBanner').dataset.kind, 'saving'); assert.equal(c.get('paymentEditor').disabled, true);
    c.connect(true); w.commit(c); await pending;
    assert.equal(D.getPaymentSummary(w.data.bookings[0]).receivedCents, 7000);
    assert.equal(c.get('paymentAmount').value, '');
});

test('unknown historical payment state is never treated as a debt or allowed to accept unexplained payments', async () => {
    const old = booking('unknown', '2026-01-01', '2026-01-05', { guest: 'UNKNOWN LEGACY GUEST', price: 63.25 });
    const w = new World({ bookings: [old] }), c = w.client('A');
    c.context.openDeleteModal('unknown');
    assert.equal(D.getPaymentSummary(old).known, false);
    assert.equal(D.getPaymentSummary(old).remainingCents, null);
    assert.equal(c.get('paymentEditor').disabled, true);
    c.setPayment('100'); await c.savePayment();
    assert.equal(c.transactions.length, 0); assert.deepEqual(w.data.bookings[0], old);
    c.filter('bookingFilter', 'balance'); assert.doesNotMatch(c.listHTML(), /UNKNOWN LEGACY GUEST/);
    c.filter('bookingFilter', 'unknown'); assert.match(c.listHTML(), /UNKNOWN LEGACY GUEST/);
});
