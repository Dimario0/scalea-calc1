/* Isolated browser demo. It never loads or calls Firebase. */
window.createScaleaPreviewStore = (D, handlers) => {
    'use strict';
    const key = 'scaleastay-calc-preview-v3-mobile';
    let connected = true;
    let cache = null;
    function seed() {
        const example = (id, guest, checkIn, checkOut, extra) => {
            const quote = D.quoteStay(checkIn, checkOut);
            return D.buildBooking({ id, guest, phone: '', notes: 'Вымышленная запись для проверки калькулятора.', checkIn, checkOut, price: quote.averagePrice, quote, createdAt: '2026-11-16T00:00:00Z', ...extra });
        };
        const anna = example('demo-anna', 'Анна · пример', '2027-06-28', '2027-07-03', { guestCount: 2, inquirySource: 'referral', arrivalTime: '14:00', departureTime: '10:00', cleaningStatus: 'needed', advancePayment: { status: 'received', amountCents: 15000, receivedOn: '2026-11-10' } });
        anna.paymentEntries = { 'demo-partial': D.buildPayment({ id: 'demo-partial', amount: '100', receivedOn: '2026-11-15', note: 'Часть доплаты — пример' }, anna) };
        const boris = example('demo-boris', 'Борис · пример', '2027-07-10', '2027-07-15', { guestCount: 4, inquirySource: 'website', arrivalTime: '17:00', departureTime: '11:00', cleaningStatus: 'ready', advancePayment: { status: 'received', amountCents: 20000, receivedOn: '2026-11-01' } });
        boris.paymentEntries = { 'demo-final': D.buildPayment({ id: 'demo-final', amount: '350', receivedOn: '2026-11-12', note: 'Окончательная оплата — пример' }, boris) };
        return {
            bookings: [
                example('demo-elena', 'Елена · пример', '2027-06-05', '2027-06-10', { guestCount: 2, inquirySource: 'website', arrivalTime: '16:30', departureTime: '10:30', cleaningStatus: 'scheduled', advancePayment: { status: 'not_received' } }),
                anna,
                boris,
                example('demo-victor', 'Виктор · пример', '2027-08-06', '2027-08-11', { guestCount: 3, inquirySource: 'social', cleaningStatus: 'unknown', advancePayment: { status: 'not_received' } }),
                example('demo-legacy', 'Старая запись · пример', '2027-09-05', '2027-09-09', { inquirySource: 'repeat', notes: 'Оплата и число гостей не отмечены. Пустые сведения не считаются долгом.' })
            ], prices: [50, 50, 50, 55, 60, 65, 75, 120, 65, 60, 50, 50]
        };
    }
    function read() { return JSON.parse(localStorage.getItem(key) || 'null') || seed(); }
    function emit() { if (connected) { cache = read(); handlers.data(cache); } }
    async function withLock(callback) {
        if (!navigator.locks) throw new Error('Для демонстрации синхронизации нужен современный браузер.');
        return navigator.locks.request(key, callback);
    }
    withLock(() => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed())); })
        .then(() => { handlers.connected(true); emit(); })
        .catch(handlers.error);
    const onStorage = event => { if (event.key === key) emit(); };
    window.addEventListener('storage', onStorage);
    return {
        async mutate(operation) {
            if (!connected) throw new Error('Demo offline');
            await withLock(() => {
                if (!connected) throw new Error('Demo offline');
                const result = D.reduceOperation(read(), operation);
                localStorage.setItem(key, JSON.stringify(result));
                emit();
            });
        },
        toggleConnection() { connected = !connected; handlers.connected(connected); if (connected) emit(); return connected; },
        dispose() { window.removeEventListener('storage', onStorage); cache = null; }
    };
};
