'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const D = require('../data.js');

const clone = value => JSON.parse(JSON.stringify(value));
const legacy = (id = 'OLD', checkIn = '2026-07-10', checkOut = '2026-07-13', price = 63.25, extra = {}) => ({
    id, guest: 'Синтетическая запись', phone: '', notes: '', source: 'Прямая бронь', checkIn, checkOut, price, ...extra
});
const root = () => ({
    bookings: [legacy('OLD', '2026-07-10', '2026-07-13', 63.25, { status: 'confirmed', paidCents: 10000, extra: { keep: true } })],
    prices: [50, 50, 50, 55, 60, 65, 75, 120, 65, 60, 50, 50],
    futureMetadata: { ownerLabel: 'SYNTHETIC', revision: 3 }
});
const fresh = (id = 'A', checkIn = '2027-06-30', checkOut = '2027-07-03', overrides = {}) => {
    const quote = D.quoteStay(checkIn, checkOut);
    return D.buildBooking({ id, guest: ' Синтетическая запись ', phone: ' ', notes: ' тест ', checkIn, checkOut,
        price: quote.averagePrice, quote, createdAt: '2026-11-16T12:00:00.000Z', ...overrides });
};
const hasCode = code => error => error instanceof D.DataError && error.code === code;

test('one agreed direct schedule covers all 365 nights of 2027', () => {
    const expected = [60, 60, 60, 60, 70, 85, 110, 140, 95, 65, 60, 60];
    assert.deepEqual(D.DIRECT_RATES_2027, expected);
    assert.ok(Object.isFrozen(D.DIRECT_RATES_2027));
    const quote = D.quoteStay('2027-01-01', '2028-01-01');
    assert.equal(quote.nights, 365);
    assert.equal(quote.nightlyRates.length, 365);
    let expectedTotal = 0;
    for (const rate of quote.nightlyRates) {
        const month = Number(rate.date.slice(5, 7)) - 1;
        assert.equal(rate.cents, expected[month] * 100, rate.date);
        expectedTotal += rate.cents;
    }
    assert.equal(quote.totalCents, expectedTotal);
});

test('June/July quote saves exact nightly prices instead of an averaged total', () => {
    const quote = D.quoteStay('2027-06-30', '2027-07-03');
    assert.deepEqual(quote.nightlyRates, [
        { date: '2027-06-30', cents: 8500 }, { date: '2027-07-01', cents: 11000 }, { date: '2027-07-02', cents: 11000 }
    ]);
    assert.equal(quote.totalCents, 30500);
    assert.equal(quote.averagePrice, 101.67);
    const booking = fresh();
    assert.equal(booking.price, 101.67);
    assert.equal(D.getBookingTotalCents(booking), 30500);
    assert.equal(D.getNightCents(booking, '2027-06-30'), 8500);
    assert.equal(D.getNightCents(booking, '2027-07-01') + D.getNightCents(booking, '2027-07-02'), 22000);
    assert.equal(D.getNightCents(booking, '2027-07-03'), 0);
});

test('July/August and August/September boundaries use each paid night', () => {
    assert.equal(D.quoteStay('2027-07-30', '2027-08-03').totalCents, 50000);
    assert.equal(D.quoteStay('2027-08-31', '2027-09-02').totalCents, 23500);
});

test('January checkout after the last 2027 night is allowed, other years do not borrow the 2027 tariff', () => {
    assert.equal(D.quoteStay('2027-12-31', '2028-01-01').totalCents, 6000);
    assert.throws(() => D.quoteStay('2027-12-31', '2028-01-02'), hasCode('UNSUPPORTED_YEAR'));
    assert.throws(() => D.quoteStay('2026-12-31', '2027-01-02'), hasCode('UNSUPPORTED_YEAR'));
    assert.throws(() => D.quoteStay('2028-01-01', '2028-01-02'), hasCode('UNSUPPORTED_YEAR'));
});

test('calendar arithmetic is unaffected by daylight saving transitions', () => {
    assert.equal(D.getNights('2027-03-27', '2027-03-29'), 2);
    assert.equal(D.getNights('2027-10-30', '2027-11-01'), 2);
    assert.equal(D.addDays('2027-03-28', -1), '2027-03-27');
    assert.equal(D.addDays('2027-12-31', 1), '2028-01-01');
    assert.equal(D.addDays('2028-02-28', 1), '2028-02-29');
    assert.match(D.todayStr(), /^\d{4}-\d{2}-\d{2}$/);
});

test('impossible dates and reversed or empty stays are refused', () => {
    for (const date of ['2027-02-29', '2027-02-30', '2027-13-01', '2027-00-01', '2027-1-01', 'not-a-date', '0000-01-01']) {
        assert.throws(() => D.getNights(date, '2028-01-01'), hasCode('INVALID_DATE'));
    }
    assert.throws(() => D.getNights('2027-01-02', '2027-01-02'), hasCode('INVALID_DATES'));
    assert.throws(() => D.getNights('2027-01-03', '2027-01-02'), hasCode('INVALID_DATES'));
});

test('manual nightly price preserves cents and ignores a stale quote', () => {
    const booking = fresh('MANUAL', '2027-06-30', '2027-07-03', { price: 90.05 });
    assert.equal(booking.totalCents, 27015);
    assert.deepEqual(booking.nightlyRates.map(rate => rate.cents), [9005, 9005, 9005]);
    assert.equal(booking.price, 90.05);
    assert.equal(booking.source, 'Прямая бронь');
    assert.equal(booking.guest, 'Синтетическая запись');
    assert.equal(booking.notes, 'тест');
});

test('a quote for different dates with the same average cannot silently apply', () => {
    const oldQuote = D.quoteStay('2027-07-10', '2027-07-12');
    const booking = D.buildBooking({ id: 'NEW', checkIn: '2027-07-15', checkOut: '2027-07-17', price: 110, quote: oldQuote });
    assert.deepEqual(booking.nightlyRates.map(rate => rate.date), ['2027-07-15', '2027-07-16']);
});

test('a modified quote is not trusted as a source of nightly prices', () => {
    const quote = D.quoteStay('2027-06-30', '2027-07-03');
    quote.nightlyRates[0].cents = 1;
    const booking = fresh('CHANGED', '2027-06-30', '2027-07-03', { quote });
    assert.equal(booking.totalCents, 30501);
    assert.deepEqual(booking.nightlyRates.map(rate => rate.cents), [10167, 10167, 10167]);
});

test('new manual prices reject fractions of a cent while historical precision is retained', () => {
    assert.throws(() => fresh('CENT', '2027-05-01', '2027-05-03', { price: 1.005 }), hasCode('INVALID_PRICE'));
    assert.throws(() => fresh('ZERO', '2027-05-01', '2027-05-03', { price: 0.001 }), hasCode('INVALID_PRICE'));
    const old = legacy('PRECISE', '2026-05-01', '2026-05-04', 1.005);
    assert.equal(D.normalizeData({ bookings: [old] }).bookings[0].price, 1.005);
    assert.equal(D.getBookingTotalCents(old), Math.round(3 * 1.005) * 100);
    assert.equal(D.getNightCents(old, '2026-05-01'), 1.005 * 100);
});

test('negative, zero, nonnumeric and infinite nightly prices are refused', () => {
    for (const price of [0, -1, NaN, Infinity, '', 'bad', null, true]) {
        assert.throws(() => fresh('PRICE', '2027-05-01', '2027-05-03', { price }), hasCode('INVALID_PRICE'));
    }
});

test('historical total follows the old displayed integer euro total', () => {
    const old = legacy('OLD', '2026-01-01', '2026-01-04', 101.67);
    assert.equal(D.getBookingTotalCents(old), 30500);
    assert.equal(D.getNightCents(old, '2026-01-01'), 10167);
    assert.equal(D.getBookingTotalCents({ ...old, totalCents: 30501 }), 30501);
    assert.equal(D.getBookingTotalCents({ ...old, totalCents: 'bad' }), 30500);
});

test('formatMoney renders exact cents and compact whole euros', () => {
    assert.equal(D.formatMoney(6000), '60 €');
    assert.equal(D.formatMoney(30501), '305,01 €');
    assert.equal(D.formatMoney(105), '1,05 €');
    assert.equal(D.formatMoney(-105), '-1,05 €');
});

test('empty data creates a local list without inventing or resetting prices', () => {
    assert.deepEqual(D.normalizeData(null), { bookings: [] });
    assert.deepEqual(D.normalizeData({ custom: 1 }), { custom: 1, bookings: [] });
    assert.deepEqual(D.normalizeData({ prices: [1, 2] }), { prices: [1, 2], bookings: [] });
});

test('normalization and export preserve every historical field without mutation', () => {
    const input = root();
    const before = clone(input);
    const result = D.normalizeData(input);
    assert.deepEqual(result, before);
    result.bookings[0].extra.keep = false;
    assert.deepEqual(input, before);
    assert.deepEqual(D.exportData(input), before);
});

test('malformed lists, dates, prices and duplicate identifiers are refused instead of filtered', () => {
    for (const raw of ['wrong', [], { bookings: {} }, { bookings: null }, { bookings: [null] }]) {
        assert.throws(() => D.normalizeData(raw), error => error instanceof D.DataError);
    }
    assert.throws(() => D.normalizeData({ bookings: [legacy(), legacy()] }), hasCode('DUPLICATE_ID'));
    assert.throws(() => D.normalizeData({ bookings: [legacy('BAD', '2026-02-30', '2026-03-02')] }), hasCode('INVALID_DATE'));
    assert.throws(() => D.normalizeData({ bookings: [legacy('BAD', '2026-03-01', '2026-03-02', 'bad')] }), hasCode('INVALID_PRICE'));
    assert.throws(() => D.normalizeData({ bookings: [legacy('unsafe/id')] }), hasCode('INVALID_BOOKING'));
});

test('corrupt per-night totals are rejected during import', () => {
    const booking = fresh();
    booking.totalCents += 1;
    assert.throws(() => D.prepareImport({ bookings: [booking] }), hasCode('INVALID_BOOKING'));
    const duplicateDate = fresh();
    duplicateDate.nightlyRates[1].date = duplicateDate.nightlyRates[0].date;
    assert.throws(() => D.prepareImport({ bookings: [duplicateDate] }), hasCode('INVALID_BOOKING'));
});

test('concurrent adds reduced on the latest snapshot both survive, and retries are idempotent', () => {
    const initial = root();
    const before = clone(initial);
    const opA = { type: 'add', booking: fresh('A', '2027-05-01', '2027-05-03') };
    const opB = { type: 'add', booking: fresh('B', '2027-07-01', '2027-07-03') };
    const first = D.reduceOperation(initial, opA);
    const committed = D.reduceOperation(first, opB);
    assert.deepEqual(committed.bookings.map(booking => booking.id), ['OLD', 'A', 'B']);
    assert.deepEqual(D.reduceOperation(committed, opA), committed);
    assert.deepEqual(committed.prices, initial.prices);
    assert.deepEqual(committed.futureMetadata, initial.futureMetadata);
    assert.deepEqual(initial, before);
});

test('a transaction retry rechecks overlap against a competing committed booking', () => {
    const initial = root();
    const opA = { type: 'add', booking: fresh('A', '2027-07-01', '2027-07-05') };
    const opB = { type: 'add', booking: fresh('B', '2027-07-03', '2027-07-07') };
    assert.equal(D.reduceOperation(initial, opB).bookings.length, 2);
    const latest = D.reduceOperation(initial, opA);
    assert.throws(() => D.reduceOperation(latest, opB), hasCode('OVERLAP'));
    assert.deepEqual(latest.bookings.map(booking => booking.id), ['OLD', 'A']);
});

test('checkout and checkin on the same date do not conflict', () => {
    let state = D.reduceOperation(root(), { type: 'add', booking: fresh('A', '2027-07-01', '2027-07-05') });
    state = D.reduceOperation(state, { type: 'add', booking: fresh('B', '2027-07-05', '2027-07-07') });
    assert.equal(state.bookings.length, 3);
});

test('a retry cannot reuse an existing identifier for different content', () => {
    const state = D.reduceOperation(root(), { type: 'add', booking: fresh() });
    const changed = { ...state.bookings[1], notes: 'changed on another phone' };
    assert.throws(() => D.reduceOperation(state, { type: 'add', booking: changed }), hasCode('ID_CONFLICT'));
});

test('adding and deleting concurrently preserves unrelated records in either commit order', () => {
    const initial = root();
    const add = { type: 'add', booking: fresh() };
    const remove = { type: 'delete', id: 'OLD', expectedBooking: clone(initial.bookings[0]) };
    const firstOrder = D.reduceOperation(D.reduceOperation(initial, add), remove);
    const secondOrder = D.reduceOperation(D.reduceOperation(initial, remove), add);
    assert.deepEqual(firstOrder, secondOrder);
    assert.deepEqual(firstOrder.bookings.map(booking => booking.id), ['A']);
    assert.deepEqual(firstOrder.deletedBookingIds, { OLD: true });
    assert.deepEqual(firstOrder.prices, initial.prices);
});

test('delete is idempotent and refuses a stale record expectation', () => {
    const initial = root();
    const remove = { type: 'delete', id: 'OLD', expectedBooking: clone(initial.bookings[0]) };
    const deleted = D.reduceOperation(initial, remove);
    assert.deepEqual(D.reduceOperation(deleted, remove), deleted);
    const changed = clone(initial);
    changed.bookings[0].notes = 'new note';
    assert.throws(() => D.reduceOperation(changed, remove), hasCode('RECORD_CHANGED'));
    assert.equal(changed.bookings.length, 1);
});

test('deletion expectation is independent of JSON property order', () => {
    const initial = root();
    const expectedBooking = Object.fromEntries(Object.entries(initial.bookings[0]).reverse());
    assert.equal(D.reduceOperation(initial, { type: 'delete', id: 'OLD', expectedBooking }).bookings.length, 0);
});

test('tombstones stop an old add or import from resurrecting a deleted booking', () => {
    const initial = root();
    const deleted = D.reduceOperation(initial, { type: 'delete', id: 'OLD', expectedBooking: initial.bookings[0] });
    assert.throws(() => D.reduceOperation(deleted, { type: 'add', booking: initial.bookings[0] }), hasCode('DELETED_BOOKING'));
    assert.throws(() => D.reduceOperation(deleted, { type: 'import', bookings: initial.bookings }), hasCode('DELETED_BOOKING'));
    assert.equal(deleted.bookings.length, 0);
});

test('import merges into the latest state and does not import old tariff settings', () => {
    const initial = root();
    const imported = fresh('IMPORTED', '2027-09-01', '2027-09-04');
    const prepared = D.prepareImport({ bookings: [imported], prices: Array(12).fill(1), unknown: 'ignored backup metadata' });
    assert.deepEqual(Object.keys(prepared), ['bookings']);
    const latest = D.reduceOperation(initial, { type: 'add', booking: fresh('NEW', '2027-08-01', '2027-08-03') });
    const result = D.reduceOperation(latest, { type: 'import', bookings: prepared.bookings });
    assert.deepEqual(result.bookings.map(booking => booking.id), ['OLD', 'NEW', 'IMPORTED']);
    assert.deepEqual(result.prices, initial.prices);
    assert.deepEqual(result.futureMetadata, initial.futureMetadata);
    assert.deepEqual(D.reduceOperation(result, { type: 'import', bookings: prepared.bookings }), result);
});

test('an empty import is a no-op and never clears bookings', () => {
    const initial = root();
    assert.deepEqual(D.reduceOperation(initial, { type: 'import', bookings: [] }), initial);
});

test('one conflict aborts a whole import without changing the input snapshot', () => {
    const initial = root();
    const before = clone(initial);
    const records = [fresh('SAFE', '2027-07-01', '2027-07-03'), { ...initial.bookings[0], notes: 'conflict' }];
    assert.throws(() => D.reduceOperation(initial, { type: 'import', bookings: records }), hasCode('ID_CONFLICT'));
    assert.deepEqual(initial, before);
});

test('malformed and internally overlapping imports are refused in full', () => {
    assert.throws(() => D.prepareImport({}), hasCode('INVALID_IMPORT'));
    assert.throws(() => D.prepareImport({ bookings: [legacy(), { id: 'PARTIAL' }] }), error => error instanceof D.DataError);
    assert.throws(() => D.prepareImport({ bookings: [fresh('A', '2027-07-01', '2027-07-04'), fresh('B', '2027-07-03', '2027-07-06')] }), hasCode('OVERLAP'));
});

test('non-finite unknown fields and inconsistent deletion metadata are not silently discarded', () => {
    assert.throws(() => D.normalizeData({ bookings: [], unknown: Infinity }), hasCode('INVALID_DATA'));
    assert.throws(() => D.normalizeData({ bookings: [legacy()], deletedBookingIds: { OLD: true } }), hasCode('INVALID_DATA'));
    assert.throws(() => D.normalizeData({ bookings: [], deletedBookingIds: [] }), hasCode('INVALID_DATA'));
});

test('browser UMD entry exposes the same fixed direct schedule without Firebase', () => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../data.js'), 'utf8'), context);
    assert.deepEqual(Array.from(context.ScaleaData.DIRECT_RATES_2027), Array.from(D.DIRECT_RATES_2027));
    assert.equal(context.ScaleaData.quoteStay('2027-08-01', '2027-08-06').totalCents, 70000);
});
