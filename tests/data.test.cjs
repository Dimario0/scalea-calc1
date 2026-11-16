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

test('old bookings without an advance field stay unknown without changing the record', () => {
    const booking = legacy();
    const before = clone(booking);
    assert.deepEqual(D.getAdvancePayment(booking), { status: 'unknown', amountCents: null, receivedOn: null, remainingCents: null });
    assert.deepEqual(booking, before);
    assert.ok(!Object.hasOwn(D.normalizeData({ bookings: [booking] }).bookings[0], 'advancePayment'));
});

test('not received means zero advance and the full agreed total remains', () => {
    const booking = fresh();
    const payment = D.buildAdvancePayment({ status: 'not_received', amount: '', receivedOn: '' }, booking);
    assert.deepEqual(payment, { status: 'not_received' });
    assert.deepEqual(D.getAdvancePayment({ ...booking, advancePayment: payment }), { status: 'not_received', amountCents: 0, receivedOn: null, remainingCents: 30500 });
});

test('received with an unknown amount keeps the remainder unknown, even when a receipt date is known', () => {
    const booking = fresh();
    const payment = D.buildAdvancePayment({ status: 'received', amount: ' ', receivedOn: '2026-11-16' }, booking);
    assert.deepEqual(payment, { status: 'received', receivedOn: '2026-11-16' });
    assert.deepEqual(D.getAdvancePayment({ ...booking, advancePayment: payment }), { status: 'received', amountCents: null, receivedOn: '2026-11-16', remainingCents: null });
    assert.deepEqual(D.buildAdvancePayment({ status: 'received' }, booking), { status: 'received' });
});

test('a received advance reduces the stay total rather than adding a charge', () => {
    const booking = fresh();
    const payment = D.buildAdvancePayment({ status: 'received', amount: '100.25', receivedOn: '2026-11-16' }, booking);
    assert.deepEqual(payment, { status: 'received', amountCents: 10025, receivedOn: '2026-11-16' });
    const paidBooking = { ...booking, advancePayment: payment };
    assert.equal(D.getBookingTotalCents(paidBooking), 30500);
    assert.deepEqual(D.getAdvancePayment(paidBooking), { status: 'received', amountCents: 10025, receivedOn: '2026-11-16', remainingCents: 20475 });
    assert.deepEqual(paidBooking.nightlyRates, booking.nightlyRates);
});

test('advance euro inputs become exact integer cents without binary rounding or silent fractions of cents', () => {
    const booking = fresh();
    assert.equal(D.buildAdvancePayment({ status: 'received', amount: '0.29' }, booking).amountCents, 29);
    assert.equal(D.buildAdvancePayment({ status: 'received', amount: '010,10' }, booking).amountCents, 1010);
    assert.equal(D.buildAdvancePayment({ status: 'received', amount: '1.05' }, booking).amountCents, 105);
    for (const amount of ['1.005', '0.001', '1e2', '-1', '0', '0.00', 'bad', '9007199254740992', 100]) {
        assert.throws(() => D.buildAdvancePayment({ status: 'received', amount }, booking), hasCode('INVALID_ADVANCE_PAYMENT'));
    }
});

test('advance cannot exceed the exact quoted total, including the one-cent averaged-price difference', () => {
    const booking = fresh();
    const full = D.buildAdvancePayment({ status: 'received', amount: '305.00' }, booking);
    assert.equal(D.getAdvancePayment({ ...booking, advancePayment: full }).remainingCents, 0);
    assert.throws(() => D.buildAdvancePayment({ status: 'received', amount: '305.01' }, booking), hasCode('ADVANCE_EXCEEDS_TOTAL'));
});

test('legacy remainder uses the historical displayed total without repricing the booking', () => {
    const booking = legacy('OLD', '2026-06-30', '2026-07-03', 101.67);
    const payment = D.buildAdvancePayment({ status: 'received', amount: '100.01' }, booking);
    assert.equal(D.getAdvancePayment({ ...booking, advancePayment: payment }).remainingCents, 20499);
    assert.equal(booking.price, 101.67);
    assert.equal(D.getAdvancePayment({ ...booking, advancePayment: { status: 'not_received' } }).remainingCents, 30500);
    assert.throws(() => D.buildAdvancePayment({ status: 'received', amount: '305.01' }, booking), hasCode('ADVANCE_EXCEEDS_TOTAL'));
});

test('unknown and not-received advances cannot carry a sum or a receipt date', () => {
    const booking = fresh();
    for (const status of ['unknown', 'not_received']) {
        assert.deepEqual(D.buildAdvancePayment({ status, amount: '', receivedOn: '' }, booking), { status });
        assert.throws(() => D.buildAdvancePayment({ status, amount: '1' }, booking), hasCode('INVALID_ADVANCE_PAYMENT'));
        assert.throws(() => D.buildAdvancePayment({ status, receivedOn: '2026-11-16' }, booking), hasCode('INVALID_ADVANCE_PAYMENT'));
    }
});

test('receipt date is optional and validated without inventing a due date or percentage', () => {
    const booking = fresh();
    assert.deepEqual(D.buildAdvancePayment({ status: 'received', amount: '50', receivedOn: '' }, booking), { status: 'received', amountCents: 5000 });
    assert.throws(() => D.buildAdvancePayment({ status: 'received', amount: '50', receivedOn: '2027-02-29' }, booking), hasCode('INVALID_ADVANCE_PAYMENT'));
    assert.deepEqual(D.buildAdvancePayment({ status: 'received', receivedOn: '2028-02-29' }, booking), { status: 'received', receivedOn: '2028-02-29' });
});

test('new booking accepts canonical advance data and keeps the same price and nightly breakdown', () => {
    const base = fresh();
    const payment = D.buildAdvancePayment({ status: 'received', amount: '100' }, base);
    const booking = fresh('A', base.checkIn, base.checkOut, { advancePayment: payment });
    assert.deepEqual(booking.advancePayment, payment);
    const withoutPayment = clone(booking);
    delete withoutPayment.advancePayment;
    assert.deepEqual(withoutPayment, base);
    payment.amountCents = 1;
    assert.equal(booking.advancePayment.amountCents, 10000);
});

test('malformed canonical advance data aborts import instead of being dropped or interpreted as unpaid', () => {
    const booking = fresh();
    for (const advancePayment of [
        null, {}, { status: 'paid' }, { status: 'unknown', amountCents: 0 }, { status: 'not_received', amountCents: 0 },
        { status: 'unknown', receivedOn: '2026-11-16' }, { status: 'received', amountCents: 0 },
        { status: 'received', amountCents: -1 }, { status: 'received', amountCents: 1.5 },
        { status: 'received', amountCents: '10000' }, { status: 'received', receivedOn: '' },
        { status: 'received', receivedOn: '2027-02-30' }, { status: 'received', amount: 100 }
    ]) {
        assert.throws(() => D.prepareImport({ bookings: [{ ...booking, advancePayment }] }), hasCode('INVALID_ADVANCE_PAYMENT'));
    }
    assert.throws(() => D.prepareImport({ bookings: [{ ...booking, advancePayment: { status: 'received', amountCents: 30501 } }] }), hasCode('ADVANCE_EXCEEDS_TOTAL'));
});

test('updating an advance changes only its field on the latest root snapshot', () => {
    const initial = root();
    const current = clone(initial);
    current.bookings[0].notes = 'new note on another phone';
    current.bookings[0].price = 70.15;
    current.futureMetadata.revision++;
    current.bookings.push(fresh('NEW'));
    const before = clone(current);
    const advancePayment = D.buildAdvancePayment({ status: 'received', amount: '100', receivedOn: '2026-11-16' }, current.bookings[0]);
    const result = D.reduceOperation(current, { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: null, advancePayment });
    assert.deepEqual(result.bookings[0].advancePayment, advancePayment);
    delete result.bookings[0].advancePayment;
    assert.deepEqual(result, before);
    assert.deepEqual(current, before);
});

test('two phones cannot overwrite different advance updates from the same old snapshot', () => {
    const initial = root();
    const first = { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: null, advancePayment: { status: 'received', amountCents: 10000 } };
    const second = { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: null, advancePayment: { status: 'not_received' } };
    const committed = D.reduceOperation(initial, first);
    assert.throws(() => D.reduceOperation(committed, second), hasCode('RECORD_CHANGED'));
    assert.deepEqual(D.reduceOperation(committed, first), committed);
    assert.equal(committed.bookings[0].advancePayment.amountCents, 10000);
});

test('advance conflict checking distinguishes an absent raw field from an explicitly unknown status', () => {
    const initial = root();
    const unknown = D.reduceOperation(initial, { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: null, advancePayment: { status: 'unknown' } });
    assert.throws(() => D.reduceOperation(unknown, { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: null, advancePayment: { status: 'received' } }), hasCode('RECORD_CHANGED'));
    const result = D.reduceOperation(unknown, { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: { status: 'unknown' }, advancePayment: { status: 'received' } });
    assert.equal(result.bookings[0].advancePayment.status, 'received');
});

test('advance editing rechecks the amount against the latest agreed total', () => {
    const initial = root();
    const operation = { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: null, advancePayment: { status: 'received', amountCents: 10000 } };
    const repriced = clone(initial);
    repriced.bookings[0].price = 20;
    assert.throws(() => D.reduceOperation(repriced, operation), hasCode('ADVANCE_EXCEEDS_TOTAL'));
    assert.equal(repriced.bookings[0].price, 20);
    assert.ok(!Object.hasOwn(repriced.bookings[0], 'advancePayment'));
});

test('advance update and an unrelated addition preserve both changes in either commit order', () => {
    const initial = root();
    const advance = { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: null, advancePayment: { status: 'received', amountCents: 10000 } };
    const add = { type: 'add', booking: fresh('NEW') };
    assert.deepEqual(D.reduceOperation(D.reduceOperation(initial, advance), add), D.reduceOperation(D.reduceOperation(initial, add), advance));
});

test('advance updates cannot recreate a removed or missing booking', () => {
    const initial = root();
    const deleted = D.reduceOperation(initial, { type: 'delete', id: 'OLD', expectedBooking: initial.bookings[0] });
    const operation = { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: null, advancePayment: { status: 'received', amountCents: 10000 } };
    assert.throws(() => D.reduceOperation(deleted, operation), hasCode('DELETED_BOOKING'));
    assert.throws(() => D.reduceOperation({ bookings: [] }, operation), hasCode('BOOKING_NOT_FOUND'));
    assert.equal(deleted.bookings.length, 0);
});

test('a stale delete cannot silently remove a newly recorded advance', () => {
    const initial = root();
    const updated = D.reduceOperation(initial, { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: null, advancePayment: { status: 'received', amountCents: 10000 } });
    assert.throws(() => D.reduceOperation(updated, { type: 'delete', id: 'OLD', expectedBooking: initial.bookings[0] }), hasCode('RECORD_CHANGED'));
});

test('advance fields survive export/import, while a stale imported record cannot reset a recorded payment', () => {
    const initial = root();
    const updated = D.reduceOperation(initial, { type: 'advancePayment', id: 'OLD', expectedAdvancePayment: null, advancePayment: { status: 'received', amountCents: 10000, receivedOn: '2026-11-16' } });
    const exported = D.exportData(updated);
    const restored = D.reduceOperation({ bookings: [] }, { type: 'import', bookings: D.prepareImport(exported).bookings });
    assert.deepEqual(restored.bookings, updated.bookings);
    assert.throws(() => D.reduceOperation(updated, { type: 'import', bookings: initial.bookings }), hasCode('ID_CONFLICT'));
    const deleted = D.reduceOperation(updated, { type: 'delete', id: 'OLD', expectedBooking: updated.bookings[0] });
    assert.throws(() => D.reduceOperation(deleted, { type: 'import', bookings: exported.bookings }), hasCode('DELETED_BOOKING'));
});

const knownBooking = (overrides = {}) => fresh('A', '2027-06-30', '2027-07-03', { advancePayment: { status: 'not_received' }, ...overrides });
const bookingRoot = booking => ({ ...root(), bookings: [booking] });
const payment = (id, amountCents, extra = {}) => ({ id, amountCents, ...extra });

test('optional guest, arrival, departure, cleaning and source fields are saved without writing defaults to old bookings', () => {
    const booking = knownBooking({ guestCount: 4, arrivalTime: '15:30', departureTime: '10:00', cleaningStatus: 'scheduled', inquirySource: 'website' });
    assert.equal(booking.guestCount, 4);
    assert.equal(booking.arrivalTime, '15:30');
    assert.equal(booking.departureTime, '10:00');
    assert.equal(booking.cleaningStatus, 'scheduled');
    assert.equal(booking.inquirySource, 'website');
    const old = D.normalizeData({ bookings: [legacy()] }).bookings[0];
    for (const key of ['guestCount', 'arrivalTime', 'departureTime', 'cleaningStatus', 'inquirySource']) assert.ok(!Object.hasOwn(old, key));
});

test('booking details accept every declared enum and reject impossible counts, times and sources', () => {
    for (const cleaningStatus of ['unknown', 'needed', 'scheduled', 'ready']) assert.equal(knownBooking({ cleaningStatus }).cleaningStatus, cleaningStatus);
    for (const inquirySource of ['unknown', 'website', 'social', 'referral', 'repeat']) assert.equal(knownBooking({ inquirySource }).inquirySource, inquirySource);
    assert.equal(knownBooking({ guestCount: '2' }).guestCount, 2);
    for (const invalid of [{ guestCount: 0 }, { guestCount: 5 }, { guestCount: 1.5 }, { arrivalTime: '24:00' }, { departureTime: '09:60' }, { arrivalTime: '9:00' }, { cleaningStatus: 'done' }, { inquirySource: 'booking' }]) {
        assert.throws(() => knownBooking(invalid), hasCode('INVALID_BOOKING_DETAILS'));
    }
    assert.throws(() => D.prepareImport({ bookings: [{ ...legacy(), guestCount: '2' }] }), hasCode('INVALID_BOOKING_DETAILS'));
});

test('editing clears optional blank inputs and preserves exact entered text and unrelated fields', () => {
    const original = { ...knownBooking({ guestCount: 2, arrivalTime: '15:00', departureTime: '10:00', cleaningStatus: 'needed', inquirySource: 'social' }), extra: { keep: true } };
    const edited = D.buildBookingEdit({ guest: ' Новое имя ', phone: '', notes: '', guestCount: '', arrivalTime: '', departureTime: '', cleaningStatus: 'ready', inquirySource: 'repeat' }, original);
    assert.equal(edited.guest, ' Новое имя ');
    assert.equal(edited.phone, '');
    assert.equal(edited.notes, '');
    for (const key of ['guestCount', 'arrivalTime', 'departureTime']) assert.ok(!Object.hasOwn(edited, key));
    assert.equal(edited.cleaningStatus, 'ready');
    assert.equal(edited.inquirySource, 'repeat');
    assert.deepEqual(edited.extra, original.extra);
    assert.equal(original.arrivalTime, '15:00');
});

test('editing details or entering the same agreed total does not reprice historical precision', () => {
    const original = legacy('OLD', '2026-05-01', '2026-05-04', 1.005, { extra: { keep: true }, paidCents: 100 });
    for (const total of [undefined, '', '3.00']) {
        const edited = D.buildBookingEdit({ notes: 'updated', total }, original);
        assert.equal(edited.price, 1.005);
        assert.ok(!Object.hasOwn(edited, 'totalCents'));
        assert.ok(!Object.hasOwn(edited, 'nightlyRates'));
        assert.equal(D.getBookingTotalCents(edited), 300);
        assert.equal(edited.paidCents, 100);
        assert.deepEqual(edited.extra, original.extra);
    }
});

test('moving dates preserves the agreed total and distributes exact cents without loading default tariffs', () => {
    const original = legacy('OLD', '2026-06-30', '2026-07-03', 101.67);
    const edited = D.buildBookingEdit({ checkIn: '2027-08-01', checkOut: '2027-08-05', total: '' }, original);
    assert.equal(edited.totalCents, 30500);
    assert.equal(edited.price, 76.25);
    assert.deepEqual(edited.nightlyRates.map(rate => rate.cents), [7625, 7625, 7625, 7625]);
    assert.equal(original.price, 101.67);
    const nextYear = D.buildBookingEdit({ checkIn: '2028-08-01', checkOut: '2028-08-05' }, edited);
    assert.equal(nextYear.totalCents, 30500);
});

test('an explicitly changed agreed total is allocated in integer cents with a deterministic remainder', () => {
    const edited = D.buildBookingEdit({ total: '100.00' }, knownBooking());
    assert.equal(edited.totalCents, 10000);
    assert.equal(edited.price, 33.33);
    assert.deepEqual(edited.nightlyRates.map(rate => rate.cents), [3334, 3333, 3333]);
    const tiny = D.buildBookingEdit({ total: '0.01' }, knownBooking());
    assert.equal(tiny.price, 0);
    assert.deepEqual(tiny.nightlyRates.map(rate => rate.cents), [1, 0, 0]);
    assert.equal(D.getBookingTotalCents(tiny), 1);
    for (const total of ['0', '-1', '1.005', 'bad', null]) assert.throws(() => D.buildBookingEdit({ total }, knownBooking()), hasCode('INVALID_TOTAL'));
});

test('only explicit recalculation with a matching quote applies seasonal nightly prices during editing', () => {
    const original = legacy('OLD', '2027-06-30', '2027-07-03', 100);
    const quote = D.quoteStay(original.checkIn, original.checkOut);
    assert.equal(D.buildBookingEdit({ quote }, original).price, 100);
    const recalculated = D.buildBookingEdit({ total: '305', quote }, original);
    assert.equal(recalculated.totalCents, 30500);
    assert.deepEqual(recalculated.nightlyRates.map(rate => rate.cents), [8500, 11000, 11000]);
    assert.equal(recalculated.price, 101.67);
});

test('payment summary counts the deposit once and adds only subsequent ledger entries', () => {
    const booking = { ...knownBooking({ advancePayment: { status: 'received', amountCents: 10000 } }), paymentEntries: { P1: payment('P1', 5000), P2: payment('P2', 2500) } };
    const summary = D.getPaymentSummary(booking);
    assert.equal(summary.known, true);
    assert.equal(summary.receivedCents, 17500);
    assert.equal(summary.recordedCents, 17500);
    assert.equal(summary.remainingCents, 13000);
    assert.equal(summary.fullyPaid, false);
    assert.deepEqual(summary.entries.map(entry => entry.id), ['P1', 'P2']);
    assert.equal(D.getBookingTotalCents(booking), 30500);
});

test('unknown deposit bases remain unknown and cannot acquire new payments as assumed debt', () => {
    for (const advancePayment of [undefined, { status: 'unknown' }, { status: 'received' }]) {
        const booking = knownBooking();
        if (advancePayment) booking.advancePayment = advancePayment;
        else delete booking.advancePayment;
        const summary = D.getPaymentSummary(booking);
        assert.equal(summary.known, false);
        assert.equal(summary.receivedCents, null);
        assert.equal(summary.remainingCents, null);
        assert.equal(summary.fullyPaid, false);
        assert.throws(() => D.buildPayment({ id: 'P1', amount: '50' }, booking), hasCode('PAYMENT_BASE_UNKNOWN'));
        assert.throws(() => D.reduceOperation(bookingRoot(booking), { type: 'addPayment', id: booking.id, payment: payment('P1', 5000) }), hasCode('PAYMENT_BASE_UNKNOWN'));
    }
});

test('an unknown deposit with an existing ledger preserves known receipts without fabricating a balance', () => {
    const booking = { ...knownBooking({ advancePayment: { status: 'received' } }), paymentEntries: { P1: payment('P1', 5000) } };
    assert.deepEqual(D.getPaymentSummary(booking), { known: false, receivedCents: null, remainingCents: null, recordedCents: 5000, fullyPaid: false, entries: [payment('P1', 5000)] });
    assert.equal(D.normalizeData(bookingRoot(booking)).bookings[0].paymentEntries.P1.amountCents, 5000);
});

test('payment builder uses exact cents and optional real receipt date and note', () => {
    const booking = knownBooking();
    assert.deepEqual(D.buildPayment({ id: 'P1', amount: '0,29', receivedOn: '2026-11-16', note: 'перевод' }, booking), { id: 'P1', amountCents: 29, receivedOn: '2026-11-16', note: 'перевод' });
    assert.deepEqual(D.buildPayment({ id: 'P2', amount: '100.00', receivedOn: '', note: '' }, booking), { id: 'P2', amountCents: 10000 });
    for (const amount of ['0', '-1', '1.005', 'NaN', '1e2']) assert.throws(() => D.buildPayment({ id: 'BAD', amount }, booking), hasCode('INVALID_PAYMENT'));
    assert.throws(() => D.buildPayment({ id: 'BAD', amount: '1', receivedOn: '2027-02-29' }, booking), hasCode('INVALID_PAYMENT'));
    assert.throws(() => D.buildPayment({ id: 'BAD', amount: '1', note: {} }, booking), hasCode('INVALID_PAYMENT'));
});

test('payment summary sorts receipt dates then ids and does not expose mutable ledger objects', () => {
    const booking = { ...knownBooking(), paymentEntries: { Z: payment('Z', 100, { receivedOn: '2027-01-02' }), B: payment('B', 100), A: payment('A', 100, { receivedOn: '2027-01-01' }) } };
    const summary = D.getPaymentSummary(booking);
    assert.deepEqual(summary.entries.map(entry => entry.id), ['A', 'Z', 'B']);
    summary.entries[0].amountCents = 1;
    assert.equal(booking.paymentEntries.A.amountCents, 100);
});

test('two independent payment ids survive transaction retries without duplicating a receipt', () => {
    const initial = bookingRoot(knownBooking({ advancePayment: { status: 'received', amountCents: 5000 } }));
    const first = { type: 'addPayment', id: 'A', payment: payment('P1', 10000) };
    const second = { type: 'addPayment', id: 'A', payment: payment('P2', 10000) };
    const both = D.reduceOperation(D.reduceOperation(initial, first), second);
    assert.deepEqual(D.reduceOperation(both, first), both);
    assert.equal(D.getPaymentSummary(both.bookings[0]).receivedCents, 25000);
    assert.equal(D.getPaymentSummary(both.bookings[0]).remainingCents, 5500);
    assert.deepEqual(both.prices, initial.prices);
    assert.deepEqual(both.futureMetadata, initial.futureMetadata);
    assert.ok(!Object.hasOwn(initial.bookings[0], 'paymentEntries'));
});

test('a competing payment is rechecked against the latest remaining balance on retry', () => {
    const initial = bookingRoot(knownBooking());
    const first = { type: 'addPayment', id: 'A', payment: payment('P1', 20000) };
    const second = { type: 'addPayment', id: 'A', payment: payment('P2', 20000) };
    assert.equal(D.getPaymentSummary(D.reduceOperation(initial, second).bookings[0]).remainingCents, 10500);
    const committed = D.reduceOperation(initial, first);
    assert.throws(() => D.reduceOperation(committed, second), hasCode('PAYMENT_EXCEEDS_TOTAL'));
    assert.deepEqual(Object.keys(committed.bookings[0].paymentEntries), ['P1']);
});

test('paying the exact remaining cents marks fully paid, without repricing the stay', () => {
    const original = knownBooking({ advancePayment: { status: 'received', amountCents: 10000 } });
    const finalPayment = D.buildPayment({ id: 'FINAL', amount: '205.00' }, original);
    const result = D.reduceOperation(bookingRoot(original), { type: 'addPayment', id: 'A', payment: finalPayment });
    assert.equal(D.getPaymentSummary(result.bookings[0]).fullyPaid, true);
    assert.equal(D.getPaymentSummary(result.bookings[0]).remainingCents, 0);
    assert.equal(result.bookings[0].totalCents, original.totalCents);
    assert.deepEqual(result.bookings[0].nightlyRates, original.nightlyRates);
    assert.throws(() => D.buildPayment({ id: 'EXTRA', amount: '0.01' }, result.bookings[0]), hasCode('PAYMENT_EXCEEDS_TOTAL'));
});

test('an existing payment id with changed content conflicts, while identical builder and operation retries are safe', () => {
    const initial = bookingRoot(knownBooking());
    const saved = D.reduceOperation(initial, { type: 'addPayment', id: 'A', payment: payment('P1', 10000) });
    assert.deepEqual(D.buildPayment({ id: 'P1', amount: '100' }, saved.bookings[0]), payment('P1', 10000));
    assert.throws(() => D.reduceOperation(saved, { type: 'addPayment', id: 'A', payment: payment('P1', 9999) }), hasCode('PAYMENT_CONFLICT'));
});

test('removing one payment retains all other receipts and leaves a tombstone that blocks resurrection', () => {
    const initial = bookingRoot({ ...knownBooking(), paymentEntries: { P1: payment('P1', 10000), P2: payment('P2', 5000) } });
    const remove = { type: 'removePayment', id: 'A', paymentId: 'P1', expectedPayment: payment('P1', 10000) };
    const result = D.reduceOperation(initial, remove);
    assert.deepEqual(result.bookings[0].paymentEntries, { P2: payment('P2', 5000) });
    assert.deepEqual(result.bookings[0].deletedPaymentIds, { P1: true });
    assert.deepEqual(D.reduceOperation(result, remove), result);
    assert.equal(D.getPaymentSummary(result.bookings[0]).remainingCents, 25500);
    assert.throws(() => D.reduceOperation(result, { type: 'addPayment', id: 'A', payment: payment('P1', 10000) }), hasCode('PAYMENT_REMOVED'));
    assert.throws(() => D.buildPayment({ id: 'P1', amount: '100' }, result.bookings[0]), hasCode('PAYMENT_REMOVED'));
    assert.throws(() => D.reduceOperation(result, { type: 'import', bookings: initial.bookings }), hasCode('ID_CONFLICT'));
});

test('stale payment deletion refuses changed expected content', () => {
    const initial = bookingRoot({ ...knownBooking(), paymentEntries: { P1: payment('P1', 10000, { note: 'latest' }) } });
    assert.throws(() => D.reduceOperation(initial, { type: 'removePayment', id: 'A', paymentId: 'P1', expectedPayment: payment('P1', 10000) }), hasCode('RECORD_CHANGED'));
    assert.equal(initial.bookings[0].paymentEntries.P1.note, 'latest');
});

test('advance changes enforce the combined deposit and ledger total, and unknown status safely preserves the ledger', () => {
    const booking = { ...knownBooking({ advancePayment: { status: 'received', amountCents: 10000 } }), paymentEntries: { P1: payment('P1', 10000) } };
    assert.throws(() => D.buildAdvancePayment({ status: 'received', amount: '250' }, booking), hasCode('PAYMENT_EXCEEDS_TOTAL'));
    assert.throws(() => D.reduceOperation(bookingRoot(booking), { type: 'advancePayment', id: 'A', expectedAdvancePayment: booking.advancePayment, advancePayment: { status: 'received', amountCents: 25000 } }), hasCode('PAYMENT_EXCEEDS_TOTAL'));
    const unknown = D.reduceOperation(bookingRoot(booking), { type: 'advancePayment', id: 'A', expectedAdvancePayment: booking.advancePayment, advancePayment: { status: 'unknown' } });
    assert.deepEqual(unknown.bookings[0].paymentEntries, booking.paymentEntries);
    assert.equal(D.getPaymentSummary(unknown.bookings[0]).recordedCents, 10000);
    assert.equal(D.getPaymentSummary(unknown.bookings[0]).remainingCents, null);
    assert.throws(() => D.buildPayment({ id: 'P2', amount: '1' }, unknown.bookings[0]), hasCode('PAYMENT_BASE_UNKNOWN'));
});

test('an editing operation preserves payments added after the edit form was opened', () => {
    const original = knownBooking();
    const edited = D.buildBookingEdit({ guest: 'Новое имя', guestCount: 3, inquirySource: 'referral' }, original);
    const latest = D.reduceOperation(bookingRoot(original), { type: 'addPayment', id: 'A', payment: payment('NEW', 10000) });
    const result = D.reduceOperation(latest, { type: 'updateBooking', id: 'A', expectedBooking: original, booking: edited });
    assert.equal(result.bookings[0].guest, 'Новое имя');
    assert.equal(result.bookings[0].guestCount, 3);
    assert.equal(result.bookings[0].inquirySource, 'referral');
    assert.deepEqual(result.bookings[0].paymentEntries, latest.bookings[0].paymentEntries);
    assert.equal(result.bookings[0].totalCents, original.totalCents);
    assert.deepEqual(D.reduceOperation(result, { type: 'updateBooking', id: 'A', expectedBooking: original, booking: edited }), result);
});

test('editing also preserves a newer deposit and payment-deletion tombstones', () => {
    const original = { ...knownBooking(), paymentEntries: { OLD: payment('OLD', 10000) } };
    const edited = D.buildBookingEdit({ notes: 'updated' }, original);
    let latest = D.reduceOperation(bookingRoot(original), { type: 'removePayment', id: 'A', paymentId: 'OLD', expectedPayment: original.paymentEntries.OLD });
    latest = D.reduceOperation(latest, { type: 'advancePayment', id: 'A', expectedAdvancePayment: original.advancePayment, advancePayment: { status: 'received', amountCents: 5000 } });
    const result = D.reduceOperation(latest, { type: 'updateBooking', id: 'A', expectedBooking: original, booking: edited });
    assert.deepEqual(result.bookings[0].advancePayment, { status: 'received', amountCents: 5000 });
    assert.deepEqual(result.bookings[0].deletedPaymentIds, { OLD: true });
    assert.deepEqual(result.bookings[0].paymentEntries, {});
});

test('two concurrent detail edits conflict rather than silently overwriting each other', () => {
    const original = knownBooking();
    const first = D.buildBookingEdit({ guest: 'First' }, original);
    const second = D.buildBookingEdit({ notes: 'Second' }, original);
    const committed = D.reduceOperation(bookingRoot(original), { type: 'updateBooking', id: 'A', expectedBooking: original, booking: first });
    assert.throws(() => D.reduceOperation(committed, { type: 'updateBooking', id: 'A', expectedBooking: original, booking: second }), hasCode('RECORD_CHANGED'));
    assert.equal(committed.bookings[0].guest, 'First');
});

test('an edit retry rechecks overlap against bookings created after the form opened', () => {
    const original = knownBooking();
    const edited = D.buildBookingEdit({ checkIn: '2027-08-01', checkOut: '2027-08-05' }, original);
    const latest = D.reduceOperation(bookingRoot(original), { type: 'add', booking: fresh('OTHER', '2027-08-03', '2027-08-06') });
    assert.throws(() => D.reduceOperation(latest, { type: 'updateBooking', id: 'A', expectedBooking: original, booking: edited }), hasCode('OVERLAP'));
    assert.equal(latest.bookings[0].checkIn, original.checkIn);
});

test('lowering agreed total rechecks receipts added after the edit started', () => {
    const original = knownBooking();
    const edited = D.buildBookingEdit({ total: '50' }, original);
    const latest = D.reduceOperation(bookingRoot(original), { type: 'addPayment', id: 'A', payment: payment('NEW', 10000) });
    assert.throws(() => D.reduceOperation(latest, { type: 'updateBooking', id: 'A', expectedBooking: original, booking: edited }), hasCode('PAYMENT_EXCEEDS_TOTAL'));
    assert.throws(() => D.buildBookingEdit({ total: '50' }, latest.bookings[0]), hasCode('PAYMENT_EXCEEDS_TOTAL'));
    assert.equal(latest.bookings[0].totalCents, 30500);
});

test('editing and payment operations cannot recreate a deleted booking', () => {
    const original = knownBooking();
    const deleted = D.reduceOperation(bookingRoot(original), { type: 'delete', id: 'A', expectedBooking: original });
    for (const operation of [
        { type: 'updateBooking', id: 'A', expectedBooking: original, booking: D.buildBookingEdit({ notes: 'new' }, original) },
        { type: 'addPayment', id: 'A', payment: payment('P1', 100) },
        { type: 'removePayment', id: 'A', paymentId: 'P1', expectedPayment: payment('P1', 100) }
    ]) assert.throws(() => D.reduceOperation(deleted, operation), hasCode('DELETED_BOOKING'));
});

test('imports reject malformed ledger shapes, identifiers, values, dates and tombstones in full', () => {
    const booking = knownBooking();
    for (const invalid of [
        { paymentEntries: [] }, { paymentEntries: null }, { paymentEntries: { P1: payment('P2', 100) } },
        { paymentEntries: { P1: payment('P1', 0) } }, { paymentEntries: { P1: payment('P1', 1.5) } },
        { paymentEntries: { P1: payment('P1', '100') } }, { paymentEntries: { P1: payment('P1', 100, { receivedOn: '2027-02-30' }) } },
        { paymentEntries: { P1: payment('P1', 100, { note: {} }) } }, { deletedPaymentIds: [] },
        { deletedPaymentIds: { P1: false } }, { paymentEntries: { P1: payment('P1', 100) }, deletedPaymentIds: { P1: true } }
    ]) assert.throws(() => D.prepareImport({ bookings: [{ ...booking, ...invalid }] }), hasCode('INVALID_PAYMENT'));
    assert.throws(() => D.prepareImport({ bookings: [{ ...booking, paymentEntries: { P1: payment('P1', 30501) } }] }), hasCode('PAYMENT_EXCEEDS_TOTAL'));
});

test('all detail, ledger, deletion and unknown metadata fields survive export and fresh import unchanged', () => {
    const booking = { ...knownBooking({ guestCount: 4, arrivalTime: '16:00', departureTime: '10:00', cleaningStatus: 'scheduled', inquirySource: 'repeat' }),
        paymentEntries: { P1: payment('P1', 10000, { receivedOn: '2026-11-16', note: 'test' }) }, deletedPaymentIds: { REMOVED: true }, extra: { keep: true } };
    const exported = D.exportData(bookingRoot(booking));
    const imported = D.reduceOperation({ bookings: [] }, { type: 'import', bookings: D.prepareImport(exported).bookings });
    assert.deepEqual(imported.bookings[0], booking);
    assert.equal(D.getPaymentSummary(imported.bookings[0]).remainingCents, 20500);
});
