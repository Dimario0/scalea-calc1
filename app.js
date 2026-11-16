/* ScaleaStay: shared direct-booking calendar. No optimistic writes to booking state. */
(() => {
    'use strict';
    const D = window.ScaleaData;
    const preview = document.body.dataset.preview === 'true';
    const $ = id => document.getElementById(id);
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const initialDate = new Date();
    const state = { data: { bookings: [] }, currentDate: preview ? new Date(2027, 5, 1) : initialDate.getFullYear() < 2027 ? new Date(2027, 0, 1) : initialDate, selectedBooking: null, advanceBase: null, editingBooking: null, currentView: 'calendar' };
    let loaded = false, online = false, saving = false, readError = false, writeError = false;
    let adapter = null, auth = null, generation = 0, activeQuote = null, advanceDirty = false, paymentAttempt = null;
    const checkInInput = $('checkIn'), checkOutInput = $('checkOut'), priceInput = $('price');
    const errors = {
        INVALID_DATE: 'Проверьте дату: нужен настоящий день календаря.',
        INVALID_DATES: 'Дата выезда должна быть позже даты заезда.',
        INVALID_PRICE: 'Укажите положительную цену за ночь, не более двух знаков после запятой.',
        INVALID_ADVANCE_PAYMENT: 'Проверьте залог: сумму и дату получения. Если залог уже получен, уточните его сумму перед сохранением бесплатного проживания.',
        ADVANCE_EXCEEDS_TOTAL: 'Залог не может превышать согласованную стоимость проживания.',
        BOOKING_NOT_FOUND: 'Этой брони уже нет в календаре. Возможно, её удалили с другого телефона.',
        INVALID_BOOKING_DETAILS: 'Проверьте число гостей (от 1 до 4), время и сведения для подготовки квартиры.',
        INVALID_TOTAL: 'Укажите стоимость проживания от 0 €, до двух знаков после запятой.',
        INVALID_PAYMENT: 'Проверьте сумму и дату поступления. Сумма должна быть положительной, до двух знаков после запятой.',
        PAYMENT_BASE_UNKNOWN: 'Сначала уточните залог: получен ли он и в какой сумме. Тогда можно рассчитать доплату.',
        PAYMENT_EXCEEDS_TOTAL: 'Полученные оплаты не могут превышать согласованную стоимость проживания.',
        PAYMENT_CONFLICT: 'Этот платёж уже записан с другими сведениями. Откройте карточку заново.',
        PAYMENT_REMOVED: 'Этот платёж уже удалён. Повторное сохранение отменено.',
        INVALID_BOOKING: 'В записи брони есть некорректные данные. Импорт отменён.',
        INVALID_DATA: 'Данные календаря имеют неподдерживаемый формат. Изменения заблокированы.',
        INVALID_IMPORT: 'Файл не похож на резервную копию калькулятора. Данные не изменены.',
        DUPLICATE_ID: 'В календаре или файле есть повторяющиеся номера броней. Изменения отменены.',
        ID_CONFLICT: 'Бронь с таким номером уже существует с другими данными. Импорт отменён.',
        OVERLAP: 'Эти даты уже заняты. Календарь мог обновиться с другого телефона. Выберите другие даты.',
        RECORD_CHANGED: 'Эта бронь изменилась на другом устройстве. Откройте её карточку заново.',
        DELETED_BOOKING: 'Эта бронь уже удалена. Изменения отменены, чтобы не восстановить её случайно.',
        UNSUPPORTED_YEAR: 'Автоматические цены заданы только для ночей 2027 года. Укажите цену вручную.'
    };
    function messageFor(error) {
        const code = error?.code;
        if (errors[code]) return errors[code];
        if (/permission|denied/i.test(String(code || error?.message || ''))) return 'Сервер не разрешил сохранить изменения. Введённые данные оставлены в форме.';
        return 'Не удалось подтвердить сохранение. Проверьте соединение и повторите действие. Введённые данные сохранены в форме.';
    }
    function showError(error) {
        const message = typeof error === 'string' ? error : messageFor(error);
        $('actionError').textContent = message;
        $('actionError').classList.remove('hidden');
        $('deleteModalError').textContent = message;
        $('deleteModalError').classList.remove('hidden');
        $('dataModalError').textContent = message;
        $('dataModalError').classList.remove('hidden');
    }
    function clearError() { ['actionError', 'deleteModalError', 'dataModalError'].forEach(id => $(id).classList.add('hidden')); }
    function canWrite() { return loaded && online && !saving && !readError; }
    function renderSync() {
        let kind, text;
        if (saving) {
            kind = 'saving';
            text = online ? 'Сохраняем на сервере… Не закрывайте калькулятор до подтверждения.' : 'Связь прервалась во время сохранения. Ждём подключения — не закрывайте калькулятор.';
        } else if (readError) {
            kind = 'error'; text = 'Не удалось загрузить календарь. Изменения заблокированы. Повторите загрузку страницы после восстановления доступа.';
        } else if (!online) {
            kind = 'offline'; text = loaded ? 'Нет связи. Показана последняя загруженная копия. Изменения будут доступны после подключения.' : 'Ждём соединения для загрузки календаря…';
        } else if (!loaded) {
            kind = 'loading'; text = 'Загружаем календарь… Изменения пока недоступны.';
        } else if (writeError) {
            kind = 'error'; text = 'Последнее изменение не сохранено. Данные оставлены в форме — проверьте сообщение и повторите действие.';
        } else {
            kind = 'ready'; text = preview ? 'Демонстрационный календарь синхронизирован между окнами.' : 'Календарь загружен · связь с сервером есть';
        }
        $('syncBanner').dataset.kind = kind;
        $('syncBanner').textContent = text;
        ['dataModalStatus', 'deleteModalStatus'].forEach(id => {
            $(id).textContent = text;
            $(id).dataset.kind = kind;
            $(id).classList.toggle('hidden', kind === 'ready');
        });
        $('cloudStatus').className = 'w-2 h-2 rounded-full ml-2 ' + (kind === 'ready' ? 'bg-emerald-400' : kind === 'error' ? 'bg-rose-500' : 'bg-amber-400');
        $('cloudStatus').title = text;
        document.querySelectorAll('[data-write]').forEach(element => { element.disabled = !canWrite(); });
        document.querySelectorAll('[data-export]').forEach(element => { element.disabled = !loaded || saving; });
        const current = state.selectedBooking && state.data.bookings.find(record => record.id === state.selectedBooking.id);
        const payments = current && D.getPaymentSummary(current);
        $('paymentEditor').disabled = !canWrite() || !payments || !payments.known || payments.fullyPaid;
        $('editBookingBtn').disabled = !canWrite();
    }
    function receiveData(raw) {
        try {
            state.data = D.normalizeData(raw);
            loaded = true; readError = false;
            render();
            syncSelectedBooking();
        } catch (error) {
            loaded = false; readError = true;
            showError(error);
        }
        renderSync();
    }
    function receiveConnection(value) { online = value; renderSync(); }
    function receiveError(error) { readError = true; loaded = false; showError(error); renderSync(); }
    function syncSelectedBooking() {
        if (!state.selectedBooking || saving || !loaded) return;
        const current = state.data.bookings.find(record => record.id === state.selectedBooking.id);
        if (!current) { closeDeleteModal(); showError(errors.BOOKING_NOT_FOUND); return; }
        const changed = JSON.stringify(current.advancePayment || null) !== JSON.stringify(state.advanceBase);
        state.selectedBooking = JSON.parse(JSON.stringify(current));
        renderBookingDetails(current);
        if (!advanceDirty) { fillAdvanceEditor(current); }
        $('deleteModalChanged').classList.toggle('hidden', !advanceDirty || !changed);
    }

    async function runOperation(operation) {
        if (!canWrite()) {
            showError('Дождитесь загрузки календаря и соединения с сервером. Изменения пока недоступны.');
            return false;
        }
        const currentGeneration = generation;
        clearError(); writeError = false; saving = true; renderSync();
        try {
            await adapter.mutate(operation);
            if (currentGeneration !== generation) return false;
            clearError();
            return true;
        } catch (error) {
            if (currentGeneration === generation) { writeError = true; showError(error); }
            return false;
        } finally {
            if (currentGeneration === generation) { saving = false; syncSelectedBooking(); renderSync(); }
        }
    }

    function firebaseAdapter(userGeneration) {
        const ref = firebase.database().ref('scalea_app_data');
        const connectedRef = firebase.database().ref('.info/connected');
        const active = callback => value => { if (generation === userGeneration) callback(value); };
        const onValue = active(snapshot => receiveData(snapshot.val()));
        const onConnection = active(snapshot => receiveConnection(snapshot.val() === true));
        const onError = active(receiveError);
        ref.on('value', onValue, onError);
        connectedRef.on('value', onConnection, onError);
        return {
            async mutate(operation) {
                let validationError = null;
                const result = await ref.transaction(current => {
                    validationError = null;
                    try { return D.reduceOperation(current, operation); }
                    catch (error) { validationError = error; return undefined; }
                }, undefined, false);
                if (!result.committed) throw validationError || new Error('Transaction aborted');
                // The live listener owns state. A transaction result may already be
                // older than a subsequent value event from another phone.
            },
            dispose() { ref.off('value', onValue); connectedRef.off('value', onConnection); }
        };
    }

    function resetForm() {
        $('bookingForm').reset();
        state.editingBooking = null;
        $('formTitle').textContent = 'Новая бронь'; $('saveBookingBtn').textContent = 'Добавить бронь';
        $('cancelEditBtn').classList.add('hidden'); $('editTotalBlock').classList.add('hidden');
        $('newPriceBlock').classList.remove('hidden'); $('newDepositBlock').classList.remove('hidden');
        $('guestCount').value = ''; $('arrivalTime').value = ''; $('departureTime').value = '';
        $('cleaningStatus').value = 'unknown'; $('inquirySource').value = 'unknown'; $('agreedTotal').value = '';
        checkInInput.max = ''; checkOutInput.min = '';
        activeQuote = null; priceInput.value = '0'; $('liveTotal').textContent = '0 €';
        $('depositStatus').value = 'unknown';
        refreshAdvanceForm('deposit', null);
        $('quoteHint').textContent = 'Прямые цены 2027 · квартира целиком · до 4 гостей. Уборка и электричество включены.';
    }
    function quoteMatches() {
        return activeQuote && activeQuote.start === checkInInput.value && activeQuote.end === checkOutInput.value && Number(priceInput.value) === activeQuote.value.averagePrice;
    }
    function calculateTotal() {
        try {
            const quote = quoteMatches() ? activeQuote.value : null;
            const booking = state.editingBooking ? D.buildBookingEdit({ ...readBookingDetails(), total: $('agreedTotal').value, quote }, editingBase())
                : D.buildBooking({ id: 'draft', checkIn: checkInInput.value, checkOut: checkOutInput.value, price: priceInput.value, quote, createdAt: 'draft' });
            $('liveTotal').textContent = D.formatMoney(D.getBookingTotalCents(booking));
            refreshAdvanceForm('deposit', booking);
        } catch { $('liveTotal').textContent = '0 €'; refreshAdvanceForm('deposit', null); }
    }
    function readBookingDetails() {
        return {
            guest: $('guestName').value.trim() || 'Гость', phone: $('guestPhone').value.trim(), notes: $('guestNotes').value.trim(),
            checkIn: checkInInput.value, checkOut: checkOutInput.value, guestCount: $('guestCount').value,
            arrivalTime: $('arrivalTime').value, departureTime: $('departureTime').value,
            cleaningStatus: $('cleaningStatus').value || 'unknown', inquirySource: $('inquirySource').value || 'unknown'
        };
    }
    function editingBase() {
        const original = JSON.parse(JSON.stringify(state.editingBooking));
        const current = state.data.bookings.find(booking => booking.id === original.id);
        if (!current) throw new D.DataError('BOOKING_NOT_FOUND', errors.BOOKING_NOT_FOUND);
        // Validate entered totals against the latest receipts, while the saved
        // expectedBooking still guards the original nonfinancial details.
        ['advancePayment', 'paymentEntries', 'deletedPaymentIds'].forEach(key => {
            delete original[key];
            if (Object.prototype.hasOwnProperty.call(current, key)) original[key] = JSON.parse(JSON.stringify(current[key]));
        });
        return original;
    }
    function advanceIds(prefix) {
        return prefix === 'deposit' ? { status: 'depositStatus', amount: 'depositAmount', date: 'depositDate', fields: 'depositFields', summary: 'depositSummary' }
            : { status: 'modalDepositStatus', amount: 'modalDepositAmount', date: 'modalDepositDate', fields: 'modalDepositFields', summary: 'modalDepositSummary' };
    }
    function readAdvanceForm(prefix, booking) {
        const ids = advanceIds(prefix), status = $(ids.status).value || 'unknown';
        return D.buildAdvancePayment({ status, amount: status === 'received' ? $(ids.amount).value : '', receivedOn: status === 'received' ? $(ids.date).value : '' }, booking);
    }
    function refreshAdvanceForm(prefix, booking) {
        const ids = advanceIds(prefix), status = $(ids.status).value || 'unknown';
        $(ids.fields).classList.toggle('hidden', status !== 'received');
        let summary = status === 'unknown' ? 'Оплата не отмечена. Остаток пока неизвестен.' : 'Сначала укажите даты и стоимость проживания.';
        if (booking) {
            try {
                const payment = D.getPaymentSummary({ ...booking, advancePayment: readAdvanceForm(prefix, booking) });
                summary = payment.remainingCents === null ? (status === 'received' ? 'Залог получен. Укажите его сумму для расчёта остатка.' : 'Оплата не отмечена. Остаток пока неизвестен.')
                    : 'Остаток к оплате: ' + D.formatMoney(payment.remainingCents);
            } catch (error) { summary = messageFor(error); }
        }
        $(ids.summary).textContent = summary;
    }
    const isComplimentaryStay = booking => booking.totalCents === 0;
    function advanceLabel(booking) {
        if (isComplimentaryStay(booking)) return 'Залог не требуется';
        const payment = D.getAdvancePayment(booking);
        if (payment.status === 'unknown') return 'Залог: не отмечено';
        if (payment.status === 'not_received') return 'Залог не получен';
        return '✓ Залог получен' + (payment.amountCents === null ? '' : ' · ' + D.formatMoney(payment.amountCents));
    }
    function advanceClasses(booking) {
        const status = isComplimentaryStay(booking) ? 'unknown' : D.getAdvancePayment(booking).status;
        return 'font-bold rounded-xl p-3 mb-3 ' + (status === 'received' ? 'text-emerald-800 bg-emerald-50' : status === 'not_received' ? 'text-amber-900 bg-amber-50' : 'text-slate-600 bg-slate-50');
    }
    function updateDatesFromTariffs() {
        activeQuote = null;
        if (!checkInInput.value || !checkOutInput.value || checkInInput.value >= checkOutInput.value) { calculateTotal(); return; }
        try {
            const quote = D.quoteStay(checkInInput.value, checkOutInput.value);
            activeQuote = { start: checkInInput.value, end: checkOutInput.value, value: quote };
            priceInput.value = quote.averagePrice;
            $('quoteHint').textContent = 'Расчёт по нашим ценам 2027 за каждую ночь. Цена за ночь показана в среднем; итог точный. Можно указать свою цену.';
        } catch (error) {
            priceInput.value = '0';
            $('quoteHint').textContent = messageFor(error);
        }
        calculateTotal();
    }
    function handleDateLogic(field) {
        try {
            if (field === 'in' && checkInInput.value) {
                checkOutInput.min = D.addDays(checkInInput.value, 1);
                if (!checkOutInput.value || checkOutInput.value <= checkInInput.value) checkOutInput.value = checkOutInput.min;
                const [year, month] = checkInInput.value.split('-').map(Number);
                state.currentDate = new Date(year, month - 1, 1);
            }
            checkInInput.max = checkOutInput.value ? D.addDays(checkOutInput.value, -1) : '';
            render();
            if (state.editingBooking) { activeQuote = null; calculateTotal(); }
            else updateDatesFromTariffs();
        } catch (error) { showError(error); }
    }
    checkInInput.addEventListener('change', () => handleDateLogic('in'));
    checkOutInput.addEventListener('change', () => handleDateLogic('out'));
    priceInput.addEventListener('input', () => { activeQuote = null; $('quoteHint').textContent = 'Цена указана вручную и будет сохранена для этой брони.'; calculateTotal(); });
    $('agreedTotal').addEventListener('input', () => { activeQuote = null; calculateTotal(); });
    $('recalculateBooking').onclick = () => {
        try {
            const quote = D.quoteStay(checkInInput.value, checkOutInput.value);
            activeQuote = { start: checkInInput.value, end: checkOutInput.value, value: quote };
            priceInput.value = quote.averagePrice; $('agreedTotal').value = (quote.totalCents / 100).toFixed(2);
            calculateTotal(); clearError();
        } catch (error) { showError(error); }
    };
    ['depositStatus', 'depositAmount', 'depositDate'].forEach(id => $(id).addEventListener(id === 'depositStatus' ? 'change' : 'input', calculateTotal));
    ['modalDepositStatus', 'modalDepositAmount', 'modalDepositDate'].forEach(id => $(id).addEventListener(id === 'modalDepositStatus' ? 'change' : 'input', () => { advanceDirty = true; refreshAdvanceForm('modal', state.selectedBooking); }));
    $('bookingForm').onsubmit = async event => {
        event.preventDefault();
        if (!canWrite()) { showError('Сейчас нет возможности сохранить бронь. Дождитесь соединения и загрузки.'); return; }
        let booking, operation;
        try {
            if (state.editingBooking) {
                booking = D.buildBookingEdit({ ...readBookingDetails(), total: $('agreedTotal').value, quote: quoteMatches() ? activeQuote.value : null }, editingBase());
                operation = { type: 'updateBooking', id: booking.id, expectedBooking: state.editingBooking, booking };
            } else {
                booking = D.buildBooking({ id: crypto.randomUUID(), ...readBookingDetails(), price: priceInput.value, quote: quoteMatches() ? activeQuote.value : null, createdAt: new Date().toISOString() });
                booking.advancePayment = readAdvanceForm('deposit', booking);
                operation = { type: 'add', booking };
            }
        } catch (error) { showError(error); return; }
        if (await runOperation(operation)) {
            resetForm();
            toggleMobileView('bookings');
        }
    };
    window.cancelBookingEdit = () => { if (!saving) { resetForm(); clearError(); toggleMobileView('bookings'); } };
    window.editSelectedBooking = () => {
        if (!canWrite() || !state.selectedBooking) return;
        const booking = JSON.parse(JSON.stringify(state.selectedBooking));
        closeDeleteModal(); resetForm(); state.editingBooking = booking;
        $('formTitle').textContent = 'Редактирование брони'; $('saveBookingBtn').textContent = 'Сохранить изменения';
        $('cancelEditBtn').classList.remove('hidden'); $('editTotalBlock').classList.remove('hidden');
        $('newPriceBlock').classList.add('hidden'); $('newDepositBlock').classList.add('hidden');
        $('guestName').value = booking.guest || ''; $('guestPhone').value = booking.phone || ''; $('guestNotes').value = booking.notes || '';
        checkInInput.value = booking.checkIn; checkOutInput.value = booking.checkOut; priceInput.value = booking.price;
        $('agreedTotal').value = (D.getBookingTotalCents(booking) / 100).toFixed(2);
        $('guestCount').value = booking.guestCount || ''; $('arrivalTime').value = booking.arrivalTime || ''; $('departureTime').value = booking.departureTime || '';
        $('cleaningStatus').value = booking.cleaningStatus || 'unknown'; $('inquirySource').value = booking.inquirySource || 'unknown';
        $('quoteHint').textContent = 'Согласованная стоимость сохранится при изменении дат. Пересчёт по тарифам — только по отдельной кнопке.';
        clearError(); calculateTotal(); toggleMobileView('add');
    };

    window.downloadBackup = () => {
        if (!loaded || saving) { showError('Сначала дождитесь загрузки и завершения сохранения.'); return; }
        const exported = { ...state.data, _scaleaExport: { version: 2, exportedAt: new Date().toISOString(), source: preview ? 'demo' : 'calendar', connected: online, directRates2027: D.DIRECT_RATES_2027 } };
        const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = `scaleastay_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    window.uploadBackup = async input => {
        const file = input.files[0];
        if (!file) return;
        clearError();
        try {
            if (!canWrite()) throw new Error('Not connected');
            if (file.size > 10 * 1024 * 1024) { showError('Файл слишком большой. Допустимо до 10 МБ.'); return; }
            const prepared = D.prepareImport(JSON.parse(await file.text()));
            if (!confirm(`Добавить брони из копии (${prepared.bookings.length})? Существующие записи и тарифы сохранятся. При конфликте весь импорт будет отменён.`)) return;
            if (await runOperation({ type: 'import', bookings: prepared.bookings })) {
                $('syncBanner').textContent = 'Брони из копии проверены и сохранены. Существующие записи и тарифы сохранены.';
                toggleMobileView('calendar');
            }
        } catch (error) { showError(error instanceof SyntaxError ? 'Файл содержит некорректный JSON. Данные не изменены.' : error); }
        finally { input.value = ''; }
    };

    window.toggleMobileView = view => {
        ['navCal', 'navBookings', 'navAdd', 'navMore'].forEach(id => { $(id).classList.remove('is-active'); $(id).removeAttribute?.('aria-current'); });
        ['sidebarPanel', 'calendarView', 'bookingsView', 'moreView'].forEach(id => $(id).classList.add('hidden'));
        ['mobilePricesModal', 'mobileDataModal'].forEach(id => { $(id).classList.add('hidden'); $(id).classList.remove('flex'); });
        const views = { calendar: ['calendarView', 'navCal'], bookings: ['bookingsView', 'navBookings'], add: ['sidebarPanel', 'navAdd'], more: ['moreView', 'navMore'] };
        if (views[view]) {
            const [panel, nav] = views[view]; $(panel).classList.remove('hidden'); $(nav).classList.add('is-active'); $(nav).setAttribute?.('aria-current', 'page'); state.currentView = view;
        }
        else if (view === 'prices') { renderPricesList('mobilePricesList'); $('mobilePricesModal').classList.remove('hidden'); $('mobilePricesModal').classList.add('flex'); $('navMore').classList.add('is-active'); }
        else if (view === 'data') { $('mobileDataModal').classList.remove('hidden'); $('mobileDataModal').classList.add('flex'); $('navMore').classList.add('is-active'); }
        if (view === 'bookings') renderBookingsList();
    };
    window.startNewBooking = () => { if (!saving) { resetForm(); clearError(); toggleMobileView('add'); } };
    function createDiv(cls) { const div = document.createElement('div'); div.className = cls; return div; }
    const sourceLabels = { unknown: 'Не указан', website: 'Сайт', social: 'Соцсети', referral: 'Рекомендация', repeat: 'Повторный гость' };
    const cleaningLabels = { unknown: 'Не отмечено', needed: 'Нужна', scheduled: 'Назначена', ready: 'Готово' };
    const dateLabel = value => value ? value.split('-').reverse().join('.') : 'Не указано';
    function paymentLabel(booking) {
        if (isComplimentaryStay(booking)) return 'Без оплаты';
        const summary = D.getPaymentSummary(booking);
        return !summary.known ? 'Оплата не отмечена' : summary.fullyPaid ? 'Оплачено полностью' : 'Доплата ' + D.formatMoney(summary.remainingCents);
    }
    function renderBookingsList() {
        const query = $('bookingSearch').value.trim().toLocaleLowerCase('ru');
        const digits = query.replace(/\D/g, '');
        const filter = $('bookingFilter').value || 'all', source = $('bookingSourceFilter').value || 'all', sort = $('bookingSort').value || 'arrival';
        const rows = state.data.bookings.filter(booking => {
            const summary = D.getPaymentSummary(booking), advance = D.getAdvancePayment(booking);
            const searchable = `${booking.guest || ''} ${booking.phone || ''}`.toLocaleLowerCase('ru');
            if (query && !searchable.includes(query) && !(digits.length >= 3 && String(booking.phone || '').replace(/\D/g, '').includes(digits))) return false;
            if (source !== 'all' && (booking.inquirySource || 'unknown') !== source) return false;
            return filter === 'all' || (filter === 'upcoming' && booking.checkOut >= D.todayStr()) ||
                (filter === 'deposit' && !isComplimentaryStay(booking) && advance.status === 'not_received') || (filter === 'balance' && summary.known && summary.remainingCents > 0) ||
                (filter === 'paid' && !isComplimentaryStay(booking) && summary.fullyPaid) || (filter === 'unknown' && !summary.known);
        });
        rows.sort((a, b) => {
            let result = 0;
            if (sort === 'balance') {
                const left = D.getPaymentSummary(a).remainingCents, right = D.getPaymentSummary(b).remainingCents;
                result = (right === null ? -1 : right) - (left === null ? -1 : left);
            } else if (sort === 'total') result = D.getBookingTotalCents(b) - D.getBookingTotalCents(a);
            else if (sort === 'guest') result = String(a.guest || '').localeCompare(String(b.guest || ''), 'ru');
            return result || a.checkIn.localeCompare(b.checkIn) || a.id.localeCompare(b.id);
        });
        $('bookingListCount').textContent = `Найдено ${rows.length} из ${state.data.bookings.length}`;
        const unknown = rows.filter(booking => !D.getPaymentSummary(booking).known).length;
        const balance = rows.reduce((sum, booking) => sum + (D.getPaymentSummary(booking).remainingCents || 0), 0);
        $('listSummary').textContent = rows.length ? `Осталось получить по отмеченным оплатам: ${D.formatMoney(balance)}${unknown ? ` · Оплата не уточнена: ${unknown}` : ''}` : '';
        $('bookingList').innerHTML = rows.length ? rows.map(booking => {
            const summary = D.getPaymentSummary(booking), advance = D.getAdvancePayment(booking);
            return `<button type="button" class="ss-card booking-list-card" data-booking-id="${escapeHtml(booking.id)}">
                <span class="ss-row"><strong>${escapeHtml(booking.guest || 'Гость')}</strong><span class="ss-amount">${D.formatMoney(D.getBookingTotalCents(booking))}</span></span>
                <span class="ss-muted">${dateLabel(booking.checkIn)} → ${dateLabel(booking.checkOut)} · ${D.getNights(booking.checkIn, booking.checkOut)} ночей</span>
                <span class="ss-row"><span class="ss-pill ${summary.fullyPaid ? 'ss-good' : summary.known ? 'ss-warn' : ''}">${paymentLabel(booking)}</span><span class="ss-muted">${escapeHtml(sourceLabels[booking.inquirySource] || sourceLabels.unknown)}</span></span>
                <span class="ss-row"><span class="${isComplimentaryStay(booking) ? 'ss-muted' : advance.status === 'received' ? 'ss-good' : advance.status === 'not_received' ? 'ss-warn' : 'ss-muted'}">${advanceLabel(booking)}</span>${booking.guestCount ? `<span class="ss-muted">Гостей: ${booking.guestCount}</span>` : ''}</span>
                <span class="ss-muted">${summary.known ? `Получено ${D.formatMoney(summary.receivedCents)}` : summary.recordedCents ? `Отмечено поступлений ${D.formatMoney(summary.recordedCents)} · остаток неизвестен` : 'Сведения об оплате ещё не внесены'}</span>
            </button>`;
        }).join('') : '<div class="ss-empty">Брони не найдены. Измените поиск или фильтры.</div>';
    }
    window.renderBookingsList = renderBookingsList;
    ['bookingSearch', 'bookingFilter', 'bookingSort', 'bookingSourceFilter'].forEach(id => $(id).addEventListener(id === 'bookingSearch' ? 'input' : 'change', renderBookingsList));
    ['bookingList', 'upcomingBlock'].forEach(id => $(id).addEventListener('click', event => {
        const target = event.target.closest('[data-booking-id]');
        if (target) openDeleteModal(target.dataset.bookingId);
    }));
    function renderUpcoming() {
        const today = D.todayStr();
        const arrivals = state.data.bookings.filter(booking => booking.checkIn >= today).sort((a, b) => a.checkIn.localeCompare(b.checkIn));
        const departures = state.data.bookings.filter(booking => booking.checkOut >= today).sort((a, b) => a.checkOut.localeCompare(b.checkOut));
        const cleaning = departures.find(booking => booking.cleaningStatus !== 'ready');
        const items = [
            { label: 'Ближайший заезд', booking: arrivals[0], field: 'checkIn', time: 'arrivalTime' },
            { label: 'Ближайший выезд', booking: departures[0], field: 'checkOut', time: 'departureTime' },
            { label: 'Подготовка квартиры', booking: cleaning, field: 'checkOut', cleaning: true }
        ];
        $('upcomingBlock').innerHTML = items.map(item => item.booking ? `<button type="button" class="ss-card upcoming-card" data-booking-id="${escapeHtml(item.booking.id)}"><span class="ss-muted">${item.label}</span><strong>${dateLabel(item.booking[item.field])}${item.time && item.booking[item.time] ? ` · ${item.booking[item.time]}` : ''}</strong><span>${escapeHtml(item.booking.guest || 'Гость')}</span>${item.cleaning ? `<span class="ss-pill">Уборка: ${cleaningLabels[item.booking.cleaningStatus] || cleaningLabels.unknown}</span>` : ''}</button>` : `<div class="ss-card upcoming-card"><span class="ss-muted">${item.label}</span><span>Пока нет записей</span></div>`).join('');
    }
    function render() {
        const year = state.currentDate.getFullYear(), month = state.currentDate.getMonth();
        $('displayMonth').textContent = D.monthNames[month]; $('displayYear').textContent = year;
        const grid = $('calendarGrid'); grid.innerHTML = '';
        const first = new Date(year, month, 1).getDay(), days = new Date(year, month + 1, 0).getDate();
        for (let i = 0; i < (first === 0 ? 6 : first - 1); i++) grid.appendChild(createDiv('day-cell bg-slate-50/20'));
        for (let day = 1; day <= days; day++) {
            const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const cell = createDiv(`day-cell p-1 relative cursor-pointer hover:bg-slate-50 transition ${date === D.todayStr() ? 'day-today' : 'bg-transparent'}`);
            cell.innerHTML = `<div class="day-num text-slate-400">${day}</div>`;
            cell.onclick = () => { if (!canWrite()) { showError('Добавление станет доступно после загрузки и подключения.'); return; } if (state.editingBooking) resetForm(); checkInInput.value = date; handleDateLogic('in'); toggleMobileView('add'); };
            state.data.bookings.forEach(booking => {
                if (date < booking.checkIn || date > booking.checkOut) return;
                const bar = createDiv('booking-bar');
                bar.onclick = event => { event.stopPropagation(); openDeleteModal(booking.id); };
                const payment = D.getAdvancePayment(booking);
                bar.title = `${booking.guest || 'Гость'} · ${advanceLabel(booking)}`;
                const marker = isComplimentaryStay(booking) ? '' : payment.status === 'received' ? '✓' : payment.status === 'not_received' ? '⏳' : '';
                const lastNight = D.addDays(booking.checkOut, -1), label = `${marker ? `<span class="shrink-0 pl-1" aria-label="${advanceLabel(booking)}">${marker}</span>` : ''}<span class="truncate px-1">${escapeHtml(booking.guest || 'Гость')}${booking.notes ? ' 📝' : ''} (${D.formatMoney(D.getBookingTotalCents(booking))})</span>`;
                if (date === booking.checkOut) { bar.classList.add('booking-checkout'); bar.textContent = '← Выезд'; }
                else if (date === booking.checkIn) { bar.classList.add('booking-start'); if (lastNight === date) bar.style.borderRadius = '6px'; bar.innerHTML = label; }
                else if (date === lastNight) { bar.classList.add('booking-end'); bar.innerHTML = '&nbsp;'; }
                else { bar.classList.add('booking-mid'); bar.innerHTML = '&nbsp;'; }
                if (day === 1 && date > booking.checkIn && date < booking.checkOut) {
                    bar.innerHTML = label;
                    bar.classList.add('booking-visible-continuation');
                }
                cell.appendChild(bar);
            });
            grid.appendChild(cell);
        }
        updateStats(); renderPricesList('desktopPricesList'); renderBookingsList(); renderUpcoming();
    }
    function updateStats() {
        const year = state.currentDate.getFullYear(), month = state.currentDate.getMonth();
        let income = 0, yearIncome = 0, occupied = 0;
        state.data.bookings.forEach(booking => {
            const nights = D.getNights(booking.checkIn, booking.checkOut);
            for (let i = 0; i < nights; i++) {
                const date = D.addDays(booking.checkIn, i), [y, m] = date.split('-').map(Number);
                if (y === year) { const cents = D.getNightCents(booking, date); yearIncome += cents; if (m === month + 1) { occupied++; income += cents; } }
            }
        });
        $('statIncome').textContent = D.formatMoney(Math.round(income));
        $('statYearIncome').textContent = D.formatMoney(Math.round(yearIncome));
        $('statOccupancy').textContent = `${Math.round(occupied / new Date(year, month + 1, 0).getDate() * 100)}%`;
        $('statDays').textContent = `${occupied} ночей`;
        const cohort = state.data.bookings.filter(booking => booking.checkIn.slice(0, 7) === `${year}-${String(month + 1).padStart(2, '0')}`);
        let received = 0, remaining = 0, unknown = 0;
        cohort.forEach(booking => {
            const summary = D.getPaymentSummary(booking);
            received += summary.recordedCents;
            if (summary.known) remaining += summary.remainingCents; else unknown++;
        });
        $('statReceived').textContent = D.formatMoney(received);
        $('statRemaining').textContent = D.formatMoney(remaining);
        $('statUnknown').textContent = `${unknown} броней`;
        $('statsScope').textContent = 'Оплаты по броням с заездом в выбранном месяце. Неизвестные остатки в сумму не включены.';
    }
    function renderPricesList(id) {
        const container = $(id); if (!container) return;
        container.innerHTML = D.monthNames.map((month, index) => `<div class="flex justify-between items-center p-2 rounded-lg ${state.currentDate.getFullYear() === 2027 && index === state.currentDate.getMonth() ? 'bg-blue-50 border border-blue-200' : ''}"><span class="text-xs font-bold text-slate-500">${month}</span><span class="text-sm font-black text-blue-700">${D.DIRECT_RATES_2027[index]} €</span></div>`).join('');
    }
    function renderBookingDetails(booking) {
        const nights = D.getNights(booking.checkIn, booking.checkOut);
        const preparationOpen = $('bookingPrepDetails')?.open === true;
        const phone = String(booking.phone || ''), cleanPhone = phone.replace(/\D/g, '');
        $('deleteModalInfo').innerHTML = `<div class="font-black text-xl mb-2">${escapeHtml(booking.guest || 'Гость')}</div>
            <div class="text-xs text-slate-500 mb-2">${escapeHtml(booking.checkIn)} → ${escapeHtml(booking.checkOut)}</div>
            <div class="font-bold text-blue-700 mb-4">${nights} ночей · ${D.formatMoney(D.getBookingTotalCents(booking))}</div>
            <div id="modalCurrentAdvance" class="${advanceClasses(booking)}">${advanceLabel(booking)}</div>
            ${cleanPhone ? `<a href="https://wa.me/${cleanPhone}" target="_blank" rel="noopener noreferrer" class="block text-sm text-emerald-700 bg-emerald-50 p-3 rounded-lg mb-2">WhatsApp · ${escapeHtml(phone)}</a>` : ''}
            <details id="bookingPrepDetails" class="optional-details"><summary><span>Гости, подготовка и заметки</span></summary><div class="optional-fields">
            <div class="ss-row ss-muted"><span>Гостей: ${booking.guestCount || 'не указано'}</span><span>${sourceLabels[booking.inquirySource] || sourceLabels.unknown}</span></div>
            <div class="ss-muted mt-2">Заезд: ${escapeHtml(booking.arrivalTime || 'время не указано')} · Выезд: ${escapeHtml(booking.departureTime || 'время не указано')}</div>
            <div class="ss-muted mt-2 mb-3">Уборка: ${cleaningLabels[booking.cleaningStatus] || cleaningLabels.unknown}</div>
            ${booking.notes ? `<div class="text-xs bg-yellow-50 p-3 rounded-lg mb-3 text-left whitespace-pre-line">${escapeHtml(booking.notes)}</div>` : ''}
            <button id="copyBookingButton" class="w-full text-xs p-3 bg-slate-50 rounded-lg">Скопировать для клининга</button></div></details>`;
        if (preparationOpen) $('bookingPrepDetails').open = true;
        $('copyBookingButton').onclick = async event => {
            try {
                await navigator.clipboard.writeText(`Бронь: ${booking.guest || 'Гость'}\nЗаезд: ${booking.checkIn} ${booking.arrivalTime || ''}\nВыезд: ${booking.checkOut} ${booking.departureTime || ''}\nНочей: ${nights}\nГостей: ${booking.guestCount || 'не указано'}\nУборка: ${cleaningLabels[booking.cleaningStatus] || cleaningLabels.unknown}\nЗаметки: ${booking.notes || 'нет'}`);
                event.target.textContent = '✓ Скопировано';
            } catch { showError('Не удалось скопировать. Проверьте разрешение браузера на буфер обмена.'); }
        };
        renderPaymentDetails(booking);
    }
    function fillAdvanceEditor(booking) {
        const payment = D.getAdvancePayment(booking);
        state.advanceBase = JSON.parse(JSON.stringify(booking.advancePayment || null));
        $('modalDepositStatus').value = payment.status;
        $('modalDepositAmount').value = payment.status === 'received' && payment.amountCents !== null ? (payment.amountCents / 100).toFixed(2) : '';
        $('modalDepositDate').value = payment.receivedOn || '';
        refreshAdvanceForm('modal', booking);
    }
    function renderPaymentDetails(booking) {
        const summary = D.getPaymentSummary(booking), advance = D.getAdvancePayment(booking);
        $('paymentSummary').innerHTML = `<div class="ss-row"><span>Стоимость проживания</span><strong class="ss-amount">${D.formatMoney(D.getBookingTotalCents(booking))}</strong></div>
            <div class="ss-row"><span>Получено всего</span><strong>${summary.known ? D.formatMoney(summary.receivedCents) : 'Не уточнено'}</strong></div>
            <div class="ss-row"><span>Осталось доплатить</span><strong>${summary.known ? D.formatMoney(summary.remainingCents) : 'Неизвестно'}</strong></div>
            <div class="ss-pill ${summary.fullyPaid ? 'ss-good' : summary.known ? 'ss-warn' : ''}">${paymentLabel(booking)}</div>`;
        const depositRow = advance.status === 'received' ? `<div class="ss-row payment-entry"><span>Залог${advance.receivedOn ? `<span class="ss-muted"> · ${dateLabel(advance.receivedOn)}</span>` : ''}</span><strong>${advance.amountCents === null ? 'Сумма не указана' : D.formatMoney(advance.amountCents)}</strong></div>` : '';
        $('paymentList').innerHTML = depositRow + summary.entries.map(payment => `<div class="payment-entry"><div class="ss-row"><span>${payment.receivedOn ? dateLabel(payment.receivedOn) : 'Дата не указана'}</span><strong>${D.formatMoney(payment.amountCents)}</strong></div>${payment.note ? `<div class="ss-muted">${escapeHtml(payment.note)}</div>` : ''}<button type="button" data-write data-remove-payment="${escapeHtml(payment.id)}" class="ss-button payment-remove">Удалить запись платежа</button></div>`).join('') || '<p class="ss-muted">Поступления ещё не отмечены.</p>';
        $('paymentBaseHint').textContent = isComplimentaryStay(booking) ? 'Бесплатное проживание: оплата и залог не требуются.' : !summary.known ? 'Уточните статус и сумму залога, чтобы добавить остальные оплаты и рассчитать остаток.' : summary.fullyPaid ? 'Проживание оплачено полностью.' : 'Внесите полученную доплату. Залог уже учтён в общей сумме.';
        $('paymentForm').classList.toggle('hidden', !summary.known || summary.fullyPaid);
    }
    window.openDeleteModal = id => {
        const booking = state.data.bookings.find(record => record.id === id);
        if (!booking) return;
        $('deleteModalError').classList.add('hidden'); $('deleteModalChanged').classList.add('hidden');
        advanceDirty = false; paymentAttempt = null;
        state.selectedBooking = JSON.parse(JSON.stringify(booking));
        $('paymentAmount').value = ''; $('paymentDate').value = ''; $('paymentNote').value = '';
        renderBookingDetails(booking); fillAdvanceEditor(booking);
        $('deleteModal').classList.remove('hidden'); renderSync();
    };
    $('advancePaymentForm').onsubmit = async event => {
        event.preventDefault();
        if (!state.selectedBooking) return;
        const booking = state.selectedBooking;
        let advancePayment;
        try { advancePayment = readAdvanceForm('modal', booking); }
        catch (error) { showError(error); return; }
        if (await runOperation({ type: 'advancePayment', id: booking.id, expectedAdvancePayment: state.advanceBase, advancePayment })) {
            advanceDirty = false; syncSelectedBooking(); renderSync();
        }
    };
    $('paymentForm').onsubmit = async event => {
        event.preventDefault();
        if (!state.selectedBooking) return;
        const booking = state.selectedBooking;
        const input = { amount: $('paymentAmount').value, receivedOn: $('paymentDate').value, note: $('paymentNote').value.trim() };
        const signature = JSON.stringify(input);
        if (!paymentAttempt || paymentAttempt.signature !== signature || paymentAttempt.bookingId !== booking.id) paymentAttempt = { signature, bookingId: booking.id, id: crypto.randomUUID() };
        let payment;
        try { payment = D.buildPayment({ id: paymentAttempt.id, ...input }, booking); }
        catch (error) { showError(error); return; }
        if (await runOperation({ type: 'addPayment', id: booking.id, payment })) {
            $('paymentAmount').value = ''; $('paymentDate').value = ''; $('paymentNote').value = ''; paymentAttempt = null;
            syncSelectedBooking(); renderSync();
        }
    };
    window.removeBookingPayment = async paymentId => {
        const booking = state.selectedBooking, payment = booking?.paymentEntries?.[paymentId];
        if (!payment || !canWrite()) return;
        if (!confirm(`Удалить запись платежа ${D.formatMoney(payment.amountCents)}? Это исправление учёта; остальные оплаты сохранятся.`)) return;
        await runOperation({ type: 'removePayment', id: booking.id, paymentId, expectedPayment: payment });
    };
    $('paymentList').addEventListener('click', event => { const target = event.target.closest('[data-remove-payment]'); if (target) removeBookingPayment(target.dataset.removePayment); });
    window.closeDeleteModal = () => { if (!saving) { $('deleteModal').classList.add('hidden'); state.selectedBooking = null; } };
    $('confirmDeleteBtn').onclick = async () => {
        if (!state.selectedBooking) return;
        const expectedBooking = state.selectedBooking;
        if (await runOperation({ type: 'delete', id: expectedBooking.id, expectedBooking })) closeDeleteModal();
    };
    function changeMonth(delta) { state.currentDate.setDate(1); state.currentDate.setMonth(state.currentDate.getMonth() + delta); render(); }
    $('prevMonth').onclick = () => changeMonth(-1); $('nextMonth').onclick = () => changeMonth(1);
    window.goToToday = () => { state.currentDate = new Date(); render(); };
    document.addEventListener('keydown', event => { if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) { if (event.key === 'ArrowLeft') changeMonth(-1); if (event.key === 'ArrowRight') changeMonth(1); } });
    let touchStart = null;
    $('calendarView').addEventListener('touchstart', event => { touchStart = [event.touches[0].clientX, event.touches[0].clientY]; }, { passive: true });
    $('calendarView').addEventListener('touchend', event => {
        if (!touchStart) return;
        const dx = touchStart[0] - event.changedTouches[0].clientX, dy = touchStart[1] - event.changedTouches[0].clientY;
        if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 40) changeMonth(dx > 0 ? 1 : -1);
        touchStart = null;
    }, { passive: true });
    window.addEventListener('beforeunload', event => { if (saving) { event.preventDefault(); event.returnValue = ''; } });
    window.logout = () => {
        if (saving) { showError('Дождитесь подтверждения сохранения перед выходом.'); return; }
        if (preview) { showError('Это демонстрационный режим. Вход в рабочую базу здесь отключён.'); return; }
        if (confirm('Выйти из системы?')) auth.signOut().catch(showError);
    };

    render(); renderSync();
    if (preview) {
        $('loginScreen').classList.add('hidden'); $('appContainer').classList.remove('hidden'); $('previewBanner').classList.remove('hidden');
        adapter = window.createScaleaPreviewStore(D, { data: receiveData, connected: receiveConnection, error: receiveError });
        $('previewSecond').onclick = () => window.open('preview.html', '_blank', 'noopener');
        $('previewConnection').onclick = () => { const connected = adapter.toggleConnection(); $('previewConnection').textContent = connected ? 'Проверить без связи' : 'Восстановить связь'; };
    } else {
        try {
            firebase.initializeApp(firebaseConfig);
            auth = firebase.auth();
            let authBusy = false;
            const recoveryStatus = $('loginRecoveryStatus'), recoveryButton = $('resetPasswordBtn'), submitButton = $('loginSubmitBtn');
            function setAuthBusy(busy, recovering = false) {
                authBusy = busy;
                [submitButton, recoveryButton, $('emailInput'), $('passwordInput')].forEach(element => { if (element) element.disabled = busy; });
                if (recoveryButton) recoveryButton.textContent = busy && recovering ? 'Отправляем…' : 'Забыли пароль?';
                if (submitButton) submitButton.textContent = busy && !recovering ? 'Входим…' : 'Войти';
            }
            function showRecoveryNotice() {
                if (!recoveryStatus) return;
                recoveryStatus.textContent = 'Если для этой почты есть учётная запись, вы получите письмо с инструкцией. Проверьте входящие и папку «Спам». Затем вернитесь сюда и войдите с новым паролем.';
                recoveryStatus.classList.remove('hidden');
            }
            setAuthBusy(false);
            auth.onAuthStateChanged(user => {
                generation++;
                if (adapter) adapter.dispose();
                adapter = null; loaded = false; online = false; saving = false; readError = false; writeError = false;
                state.data = { bookings: [] }; state.selectedBooking = null; resetForm(); clearError();
                $('deleteModal').classList.add('hidden'); render(); renderSync();
                recoveryStatus?.classList.add('hidden');
                $('loginScreen').classList.toggle('hidden', Boolean(user)); $('appContainer').classList.toggle('hidden', !user);
                if (user) adapter = firebaseAdapter(generation);
            });
            $('loginForm').onsubmit = async event => {
                event.preventDefault();
                if (authBusy) return;
                setAuthBusy(true);
                recoveryStatus?.classList.add('hidden');
                try { await auth.signInWithEmailAndPassword($('emailInput').value.trim(), $('passwordInput').value); $('loginError').classList.add('hidden'); $('passwordInput').value = ''; }
                catch { $('loginError').textContent = 'Не удалось войти. Проверьте данные и соединение.'; $('loginError').classList.remove('hidden'); }
                finally { setAuthBusy(false); }
            };
            if (recoveryButton) recoveryButton.onclick = async () => {
                if (authBusy) return;
                $('loginError').classList.add('hidden');
                recoveryStatus?.classList.add('hidden');
                const email = $('emailInput').value.trim();
                if (!email || !$('emailInput').checkValidity()) {
                    $('loginError').textContent = 'Введите вашу электронную почту в поле выше, чтобы восстановить доступ.';
                    $('loginError').classList.remove('hidden'); $('emailInput').focus(); return;
                }
                setAuthBusy(true, true);
                try {
                    await auth.sendPasswordResetEmail(email);
                    showRecoveryNotice();
                } catch (error) {
                    if (['auth/user-not-found', 'auth/user-disabled'].includes(error?.code)) showRecoveryNotice();
                    else {
                        $('loginError').textContent = error?.code === 'auth/invalid-email' ? 'Проверьте адрес электронной почты в поле выше.'
                            : error?.code === 'auth/too-many-requests' ? 'Слишком много попыток. Подождите немного и повторите восстановление.'
                            : error?.code === 'auth/network-request-failed' ? 'Не удалось отправить запрос. Проверьте интернет и попробуйте снова.'
                            : 'Не удалось запросить восстановление доступа. Попробуйте ещё раз позже.';
                        $('loginError').classList.remove('hidden');
                    }
                } finally { setAuthBusy(false); }
            };
            $('emailInput').addEventListener('input', () => {
                if (!authBusy) { recoveryStatus?.classList.add('hidden'); $('loginError').classList.add('hidden'); }
            });
        } catch {
            ['loginSubmitBtn', 'resetPasswordBtn'].forEach(id => { if ($(id)) $(id).disabled = true; });
            $('loginError').textContent = 'Не удалось загрузить сервис входа. Проверьте интернет и обновите страницу.';
            $('loginError').classList.remove('hidden');
        }
    }
})();
