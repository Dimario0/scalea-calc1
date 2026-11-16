/* Isolated browser demo. It never loads or calls Firebase. */
window.createScaleaPreviewStore = (D, handlers) => {
    'use strict';
    const key = 'scaleastay-calc-preview-v2';
    let connected = true;
    let cache = null;
    const seed = () => ({
        bookings: [
            D.buildBooking({ id: 'demo-january', guest: 'Пример брони', phone: '', notes: 'Демонстрационная запись — только для просмотра.', checkIn: '2027-01-07', checkOut: '2027-01-11', price: 60, quote: D.quoteStay('2027-01-07', '2027-01-11'), createdAt: '2026-11-16T00:00:00Z' }),
            D.buildBooking({ id: 'demo-summer', guest: 'Летний пример', phone: '', notes: 'Две ночи июля и две ночи августа по разным тарифам.', checkIn: '2027-07-30', checkOut: '2027-08-03', price: 125, quote: D.quoteStay('2027-07-30', '2027-08-03'), createdAt: '2026-11-16T00:00:00Z' })
        ], prices: [50, 50, 50, 55, 60, 65, 75, 120, 65, 60, 50, 50]
    });
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
