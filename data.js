(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ScaleaData = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DAY_MS = 86400000;
    const DIRECT_RATES_2027 = Object.freeze([60, 60, 60, 60, 70, 85, 110, 140, 95, 65, 60, 60]);
    const monthNames = Object.freeze(['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']);

    class DataError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'DataError';
            this.code = code;
        }
    }

    function fail(code, message) { throw new DataError(code, message); }
    function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }

    // Firebase snapshots and backup files are JSON values. Copy them without silently
    // stripping unknown fields, coercing non-finite numbers, or mutating the caller.
    function copy(value) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (Array.isArray(value)) return Array.from(value, copy);
        if (isObject(value)) {
            return Object.fromEntries(Object.keys(value).map(key => [key, copy(value[key])]));
        }
        fail('INVALID_DATA', 'Данные содержат неподдерживаемое значение.');
    }

    function dateMillis(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_DATE', 'Неверный формат даты.');
        const [year, month, day] = value.split('-').map(Number);
        const date = new Date(0);
        date.setUTCHours(0, 0, 0, 0);
        date.setUTCFullYear(year, month - 1, day);
        if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
            fail('INVALID_DATE', 'Такой даты нет в календаре.');
        }
        return date.getTime();
    }

    function dateString(date) {
        const year = date.getUTCFullYear();
        if (year < 1 || year > 9999) fail('INVALID_DATE', 'Дата находится вне поддерживаемого календаря.');
        return `${String(year).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    }

    function getNights(start, end) {
        const nights = (dateMillis(end) - dateMillis(start)) / DAY_MS;
        if (!Number.isSafeInteger(nights) || nights <= 0) fail('INVALID_DATES', 'Выезд должен быть позже заезда.');
        return nights;
    }

    function addDays(value, days) {
        if (!Number.isSafeInteger(days)) fail('INVALID_DATE', 'Количество дней должно быть целым.');
        return dateString(new Date(dateMillis(value) + days * DAY_MS));
    }

    function todayStr() {
        const date = new Date();
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function priceToCents(price) {
        const [mantissa, exponent = '0'] = String(price).split('e');
        return Math.round(Number(`${mantissa}e${Number(exponent) + 2}`));
    }

    function readPrice(value) {
        if (typeof value !== 'number' && typeof value !== 'string') fail('INVALID_PRICE', 'Укажите корректную цену за ночь.');
        if (typeof value === 'string' && (value.trim() === '' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) fail('INVALID_PRICE', 'Укажите корректную цену за ночь.');
        const price = Number(value);
        if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(priceToCents(price))) fail('INVALID_PRICE', 'Укажите корректную цену за ночь.');
        return price;
    }

    function isCents(value) { return Number.isSafeInteger(value) && value >= 0; }

    function quoteStay(start, end) {
        const nights = getNights(start, end);
        // Checkout on 1 January is allowed: every paid night must belong to 2027.
        if (start < '2027-01-01' || end > '2028-01-01') fail('UNSUPPORTED_YEAR', 'Согласованные тарифы действуют на ночи 2027 года.');
        const nightlyRates = [];
        let totalCents = 0;
        for (let day = dateMillis(start); day < dateMillis(end); day += DAY_MS) {
            const date = new Date(day);
            const cents = DIRECT_RATES_2027[date.getUTCMonth()] * 100;
            nightlyRates.push({ date: dateString(date), cents });
            totalCents += cents;
        }
        return { nights, totalCents, nightlyRates, averagePrice: Math.round(totalCents / nights) / 100 };
    }

    function canonical(value) {
        if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
        if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
        return JSON.stringify(value);
    }

    function equal(a, b) { return canonical(a) === canonical(b); }

    function buildBooking(input) {
        if (!isObject(input)) fail('INVALID_BOOKING', 'Неверные данные бронирования.');
        const nights = getNights(input.checkIn, input.checkOut);
        const price = readPrice(input.price);
        let matchingQuote = null;
        if (isObject(input.quote)) {
            try {
                const expected = quoteStay(input.checkIn, input.checkOut);
                if (price === expected.averagePrice && input.quote.nights === expected.nights &&
                    input.quote.totalCents === expected.totalCents && input.quote.averagePrice === expected.averagePrice &&
                    equal(input.quote.nightlyRates, expected.nightlyRates)) matchingQuote = expected;
            } catch (error) {
                if (!(error instanceof DataError) || error.code !== 'UNSUPPORTED_YEAR') throw error;
            }
        }
        const cents = priceToCents(price);
        if (!matchingQuote && price !== cents / 100) fail('INVALID_PRICE', 'Укажите цену за ночь не более чем с двумя знаками после запятой.');
        if (cents <= 0) fail('INVALID_PRICE', 'Минимальная цена за ночь — один цент.');
        const nightlyRates = matchingQuote ? matchingQuote.nightlyRates : Array.from({ length: nights }, (_, i) => ({ date: addDays(input.checkIn, i), cents }));
        const totalCents = matchingQuote ? matchingQuote.totalCents : cents * nights;
        if (!isCents(totalCents)) fail('INVALID_PRICE', 'Сумма бронирования слишком велика.');
        const booking = {
            id: input.id,
            guest: typeof input.guest === 'string' && input.guest.trim() ? input.guest.trim() : 'Гость',
            phone: typeof input.phone === 'string' ? input.phone.trim() : '',
            source: 'Прямая бронь',
            notes: typeof input.notes === 'string' ? input.notes.trim() : '',
            checkIn: input.checkIn,
            checkOut: input.checkOut,
            price: matchingQuote ? matchingQuote.averagePrice : cents / 100,
            totalCents,
            nightlyRates,
            createdAt: input.createdAt === undefined ? new Date().toISOString() : input.createdAt
        };
        if (input.advancePayment !== undefined) booking.advancePayment = copy(input.advancePayment);
        validateBooking(booking);
        return booking;
    }

    function validateId(id) {
        if (typeof id !== 'string' || !id.trim() || /[.#$\[\]\/\u0000-\u001f\u007f]/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) {
            fail('INVALID_BOOKING', 'У бронирования неверный идентификатор.');
        }
    }

    function validateBooking(booking) {
        if (!isObject(booking)) fail('INVALID_BOOKING', 'В списке найдено повреждённое бронирование.');
        validateId(booking.id);
        const nights = getNights(booking.checkIn, booking.checkOut);
        readPrice(booking.price);
        if (hasOwn(booking, 'totalCents') && !isCents(booking.totalCents)) fail('INVALID_BOOKING', 'У бронирования неверная итоговая сумма.');
        if (hasOwn(booking, 'nightlyRates')) {
            if (!Array.isArray(booking.nightlyRates) || booking.nightlyRates.length !== nights) fail('INVALID_BOOKING', 'У бронирования повреждён список ночных цен.');
            let total = 0;
            booking.nightlyRates.forEach((rate, index) => {
                if (!isObject(rate) || rate.date !== addDays(booking.checkIn, index) || !isCents(rate.cents)) fail('INVALID_BOOKING', 'У бронирования повреждён список ночных цен.');
                total += rate.cents;
            });
            if (!isCents(total) || (hasOwn(booking, 'totalCents') && total !== booking.totalCents)) fail('INVALID_BOOKING', 'Итог бронирования не совпадает с суммой ночей.');
        }
        if (hasOwn(booking, 'advancePayment')) validateAdvancePayment(booking.advancePayment, booking);
        return booking;
    }

    function validateBookings(bookings) {
        if (!Array.isArray(bookings)) fail('INVALID_DATA', 'Список бронирований имеет неверный формат.');
        const ids = new Set();
        bookings.forEach(booking => {
            validateBooking(booking);
            if (ids.has(booking.id)) fail('DUPLICATE_ID', 'В данных повторяются идентификаторы бронирований.');
            ids.add(booking.id);
        });
    }

    function getBookingTotalCents(booking) {
        if (isCents(booking.totalCents)) return booking.totalCents;
        const total = Math.round(getNights(booking.checkIn, booking.checkOut) * readPrice(booking.price)) * 100;
        if (!isCents(total)) fail('INVALID_PRICE', 'Сумма бронирования слишком велика.');
        return total;
    }

    function validateAdvancePayment(payment, booking) {
        if (!isObject(payment) || !hasOwn(payment, 'status') || !['unknown', 'not_received', 'received'].includes(payment.status) ||
            Object.keys(payment).some(key => !['status', 'amountCents', 'receivedOn'].includes(key))) {
            fail('INVALID_ADVANCE_PAYMENT', 'Неверный формат предоплаты.');
        }
        const hasAmount = hasOwn(payment, 'amountCents');
        const hasDate = hasOwn(payment, 'receivedOn');
        if (payment.status !== 'received' && (hasAmount || hasDate)) {
            fail('INVALID_ADVANCE_PAYMENT', 'Сумму и дату можно указать только для полученной предоплаты.');
        }
        if (hasAmount) {
            if (!Number.isSafeInteger(payment.amountCents) || payment.amountCents <= 0) {
                fail('INVALID_ADVANCE_PAYMENT', 'Полученная сумма должна быть положительной и указана до центов.');
            }
            if (payment.amountCents > getBookingTotalCents(booking)) fail('ADVANCE_EXCEEDS_TOTAL', 'Предоплата не может превышать согласованную стоимость проживания.');
        }
        if (hasDate) {
            try { dateMillis(payment.receivedOn); }
            catch { fail('INVALID_ADVANCE_PAYMENT', 'Проверьте дату получения предоплаты.'); }
        }
        return payment;
    }

    function buildAdvancePayment(input, booking) {
        if (!isObject(input) || !isObject(booking)) fail('INVALID_ADVANCE_PAYMENT', 'Неверные данные предоплаты.');
        const amountInput = input.amount === undefined ? '' : input.amount;
        const dateInput = input.receivedOn === undefined ? '' : input.receivedOn;
        if (typeof amountInput !== 'string' || typeof dateInput !== 'string') fail('INVALID_ADVANCE_PAYMENT', 'Проверьте сумму и дату предоплаты.');
        const amount = amountInput.trim();
        const receivedOn = dateInput.trim();
        const payment = { status: input.status };
        if (amount) {
            if (!/^\d+(?:[.,]\d{1,2})?$/.test(amount)) fail('INVALID_ADVANCE_PAYMENT', 'Укажите сумму предоплаты не более чем с двумя знаками после запятой.');
            const [whole, fraction = ''] = amount.replace(',', '.').split('.');
            const exactCents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
            if (exactCents > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_ADVANCE_PAYMENT', 'Сумма предоплаты слишком велика.');
            payment.amountCents = Number(exactCents);
        }
        if (receivedOn) payment.receivedOn = receivedOn;
        validateAdvancePayment(payment, booking);
        return payment;
    }

    function getAdvancePayment(booking) {
        const payment = hasOwn(booking, 'advancePayment') ? validateAdvancePayment(booking.advancePayment, booking) : { status: 'unknown' };
        if (payment.status === 'not_received') {
            return { status: payment.status, amountCents: 0, receivedOn: null, remainingCents: getBookingTotalCents(booking) };
        }
        const amountCents = hasOwn(payment, 'amountCents') ? payment.amountCents : null;
        return {
            status: payment.status,
            amountCents,
            receivedOn: hasOwn(payment, 'receivedOn') ? payment.receivedOn : null,
            remainingCents: amountCents === null ? null : getBookingTotalCents(booking) - amountCents
        };
    }

    function getNightCents(booking, date) {
        dateMillis(date);
        if (date < booking.checkIn || date >= booking.checkOut) return 0;
        if (Array.isArray(booking.nightlyRates)) {
            const rate = booking.nightlyRates.find(item => item && item.date === date && isCents(item.cents));
            if (rate) return rate.cents;
        }
        return readPrice(booking.price) * 100;
    }

    function formatMoney(cents) {
        if (typeof cents !== 'number' || !Number.isFinite(cents)) fail('INVALID_PRICE', 'Неверная денежная сумма.');
        const rounded = Math.sign(cents) * Math.round(Math.abs(cents));
        return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: rounded % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(rounded / 100) + ' €';
    }

    function normalizeData(raw) {
        if (raw === null || raw === undefined) return { bookings: [] };
        if (!isObject(raw)) fail('INVALID_DATA', 'База имеет неподдерживаемый формат.');
        const data = copy(raw);
        if (!hasOwn(data, 'bookings')) data.bookings = [];
        validateBookings(data.bookings);
        if (hasOwn(data, 'deletedBookingIds')) {
            if (!isObject(data.deletedBookingIds)) fail('INVALID_DATA', 'Список удалённых бронирований повреждён.');
            Object.keys(data.deletedBookingIds).forEach(id => {
                validateId(id);
                if (data.deletedBookingIds[id] !== true) fail('INVALID_DATA', 'Список удалённых бронирований повреждён.');
                if (data.bookings.some(booking => booking.id === id)) fail('INVALID_DATA', 'В базе одновременно есть бронь и отметка об её удалении.');
            });
        }
        return data;
    }

    function overlaps(a, b) { return a.checkIn < b.checkOut && a.checkOut > b.checkIn; }

    function prepareImport(parsed) {
        if (!isObject(parsed) || !Array.isArray(parsed.bookings)) fail('INVALID_IMPORT', 'В файле нет корректного списка бронирований.');
        const bookings = copy(parsed.bookings);
        validateBookings(bookings);
        bookings.forEach((booking, i) => {
            if (bookings.slice(0, i).some(other => overlaps(booking, other))) fail('OVERLAP', 'В файле пересекаются даты бронирований.');
        });
        return { bookings };
    }

    // Apply an intention to the latest transaction snapshot. Never replace a
    // snapshot with a phone's old in-memory list; Firebase can retry this reducer.
    function reduceOperation(current, operation) {
        const data = normalizeData(current);
        if (!isObject(operation)) fail('INVALID_DATA', 'Неизвестная операция сохранения.');
        if (operation.type === 'add' || operation.type === 'import') {
            const incoming = operation.type === 'add' ? [copy(operation.booking)] : prepareImport({ bookings: operation.bookings }).bookings;
            validateBookings(incoming);
            incoming.forEach(booking => {
                if (data.deletedBookingIds && hasOwn(data.deletedBookingIds, booking.id)) fail('DELETED_BOOKING', 'Эта бронь была удалена. Старую копию нельзя восстановить автоматически.');
                const existing = data.bookings.find(item => item.id === booking.id);
                if (existing) {
                    if (!equal(existing, booking)) fail('ID_CONFLICT', 'Бронь с таким идентификатором уже содержит другие данные.');
                    return;
                }
                if (data.bookings.some(other => overlaps(booking, other))) fail('OVERLAP', 'На эти даты уже есть бронирование.');
                data.bookings.push(booking);
            });
        } else if (operation.type === 'delete') {
            validateId(operation.id);
            const index = data.bookings.findIndex(booking => booking.id === operation.id);
            if (index === -1) return data;
            if (!operation.expectedBooking || !equal(data.bookings[index], operation.expectedBooking)) fail('RECORD_CHANGED', 'Бронь изменилась на другом устройстве. Откройте карточку заново.');
            data.bookings.splice(index, 1);
            data.deletedBookingIds = Object.assign({}, data.deletedBookingIds || {}, { [operation.id]: true });
        } else if (operation.type === 'advancePayment') {
            validateId(operation.id);
            if (data.deletedBookingIds && hasOwn(data.deletedBookingIds, operation.id)) fail('DELETED_BOOKING', 'Эта бронь уже удалена. Предоплата не сохранена.');
            const booking = data.bookings.find(record => record.id === operation.id);
            if (!booking) fail('BOOKING_NOT_FOUND', 'Бронирование больше не найдено. Предоплата не сохранена.');
            const payment = copy(operation.advancePayment);
            validateAdvancePayment(payment, booking);
            const currentPayment = hasOwn(booking, 'advancePayment') ? booking.advancePayment : null;
            // A retry after an acknowledged update is harmless. Different changes
            // from a stale phone must be reviewed instead of overwriting each other.
            if (equal(currentPayment, payment)) return data;
            if (!equal(currentPayment, operation.expectedAdvancePayment)) fail('RECORD_CHANGED', 'Предоплата изменилась на другом устройстве. Откройте карточку заново.');
            booking.advancePayment = payment;
        } else {
            fail('INVALID_DATA', 'Неизвестная операция сохранения.');
        }
        return data;
    }

    return Object.freeze({
        DIRECT_RATES_2027, monthNames, DataError,
        getNights, addDays, todayStr, quoteStay, buildBooking,
        getBookingTotalCents, getNightCents, formatMoney, buildAdvancePayment, getAdvancePayment,
        normalizeData, prepareImport, reduceOperation,
        exportData: normalizeData
    });
}));
